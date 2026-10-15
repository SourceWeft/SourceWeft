"""Explicit root-only disposable dev-image experiment, never a production adapter.
Only its own verified UUID child cgroup is mutated; the control process stays out.
"""
import ctypes, errno, json, os, pathlib, signal, subprocess, tempfile, time, uuid, shutil
assert os.geteuid()==0, 'dedicated administrative dev image must actually run as root'
mounts=[]
for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
    left,right=line.split(' - ',1)
    if right.split()[0]=='cgroup2': mounts.append(pathlib.Path(left.split()[4]))
assert len(mounts)==1, 'require one explicit cgroup v2 mount'
queue=[(mounts[0],0)]; parent=None; inspected=0
while queue and inspected<128:
    candidate,depth=queue.pop(0); inspected+=1
    try:
        if str(os.getpid()) in (candidate/'cgroup.procs').read_text().split(): parent=candidate; break
        if depth<3: queue.extend((pathlib.Path(entry.path),depth+1) for entry in os.scandir(candidate) if entry.is_dir(follow_symlinks=False))
    except PermissionError: pass
assert parent is not None, 'refuse guessed cgroup membership'
group=parent/('swvol-freezer-boundary-'+uuid.uuid4().hex)
root=pathlib.Path(tempfile.mkdtemp(prefix='swvol-freezer-',dir='/workspace')); os.chmod(root,0o755)
workspace=root/'workload'; workspace.mkdir(); os.chown(workspace,1001,1001); os.chmod(workspace,0o700)
source=root/'writer.c';binary=root/'writer'
source.write_text(r'''
#define _POSIX_C_SOURCE 200809L
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <pthread.h>
#include <sys/wait.h>
#include <string.h>
static const char *counter;
static long millis(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec*1000+t.tv_nsec/1000000;}
static void *write_thread(void *unused){long end=millis()+120;int fd=open(counter,O_WRONLY|O_CREAT|O_APPEND,0600);if(fd<0)_exit(80);struct timespec nap={0,1000000};while(millis()<end){if(write(fd,"x",1)!=1)_exit(81);nanosleep(&nap,NULL);}close(fd);return NULL;}
static void writer(void){struct sigevent event={0};event.sigev_notify=SIGEV_SIGNAL;event.sigev_signo=SIGCONT;timer_t timer;if(timer_create(CLOCK_MONOTONIC,&event,&timer)!=0)_exit(82);struct itimerspec interval={{0,10000000},{0,10000000}};if(timer_settime(timer,0,&interval,NULL)!=0)_exit(83);pthread_t threads[3];for(int i=0;i<3;i++)if(pthread_create(&threads[i],NULL,write_thread,NULL))_exit(84);for(int i=0;i<3;i++)pthread_join(threads[i],NULL);timer_delete(timer);}
int main(int argc,char **argv){if(getuid()!=1001||argc!=4)return 90;counter=argv[1];int fd=open(argv[2],O_WRONLY);int move_errno=errno;if(fd>=0){close(fd);return 91;}if(move_errno!=EACCES&&move_errno!=EPERM&&move_errno!=EROFS)return 92;FILE *proof=fopen(argv[3],"w");if(!proof)return 93;fprintf(proof,"uid=1001 move_denied=%d\n",move_errno);fclose(proof);long end=millis()+20000;int active=0;while(millis()<end){while(waitpid(-1,NULL,WNOHANG)>0)active--;while(active<2){pid_t pid=fork();if(pid<0)return 94;if(pid==0){writer();_exit(0);}active++;}struct timespec nap={0,1000000};nanosleep(&nap,NULL);}while(waitpid(-1,NULL,0)>0){}return 0;}
''')
compiled=subprocess.run(['cc','-O2','-pthread',str(source),'-lrt','-o',str(binary)],capture_output=True,text=True)
assert compiled.returncode==0, 'fixture compiler failed: '+compiled.stderr[-4000:]
processes=[]; group_created=False
libc=ctypes.CDLL(None,use_errno=True)
def preexec(managed):
    def prepare():
        if libc.prctl(1,signal.SIGKILL,0,0,0)!=0: raise OSError(ctypes.get_errno(),'prctl')
        if managed: (group/'cgroup.procs').write_text(str(os.getpid()))
    return prepare
def start(tag,managed):
    log=(root/(tag+'.log')).open('wb')
    process=subprocess.Popen(['setpriv','--reuid=1001','--regid=1001','--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all',str(binary),str(workspace/(tag+'.counter')),str(parent/'cgroup.procs'),str(workspace/(tag+'.proof'))],preexec_fn=preexec(managed),start_new_session=True,stdout=log,stderr=log,env={'PATH':'/usr/bin:/bin'},cwd=workspace)
    log.close();processes.append((process,os.pidfd_open(process.pid)));return process
def count(tag):
    path=workspace/(tag+'.counter');return path.stat().st_size if path.exists() else 0
def until(predicate,label,seconds=5):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if predicate():return
        time.sleep(.005)
    raise AssertionError(label)
def frozen(): return dict(line.split() for line in (group/'cgroup.events').read_text().splitlines())['frozen']=='1'
try:
    group.mkdir(mode=0o755);group_created=True
    assert (group/'cgroup.kill').exists(), 'need own-group kernel cleanup capability before starting writers'
    assert str(os.getpid()) not in (group/'cgroup.procs').read_text().split(), 'control-plane must stay outside frozen child'
    managed=start('managed',True);sibling=start('sibling',False)
    until(lambda:count('managed')>20 and count('sibling')>20,'writers failed to start')
    assert str(managed.pid) in (group/'cgroup.procs').read_text().split(), 'managed writer missing from own child cgroup'
    rounds=[]
    for index in range(5):
        (group/'cgroup.freeze').write_text('1');until(frozen,'kernel did not acknowledge frozen state')
        before=count('managed');sibling_before=count('sibling')
        # Also send external SIGCONT to the owned process while its kernel timer runs.
        signal.pidfd_send_signal(processes[0][1],signal.SIGCONT)
        time.sleep(.35);after=count('managed');sibling_after=count('sibling')
        assert after==before,'writer escaped acknowledged kernel freezer'
        assert sibling_after>sibling_before,'sibling/control-plane were frozen'
        assert frozen(),'kernel freeze state unexpectedly cleared'
        assert str(os.getpid()) not in (group/'cgroup.procs').read_text().split()
        (group/'cgroup.freeze').write_text('0');until(lambda:not frozen(),'kernel did not thaw')
        until(lambda:count('managed')>after,'managed writer failed to resume')
        rounds.append({'round':index+1,'frozenCounter':before,'after350ms':after,'siblingProgress':sibling_after-sibling_before,'resumed':True})
    print(json.dumps({'test':'own-child-cgroup-freezer','providerImageExperimentOnly':True,'productionAdapterVerified':False,'stableFreezeKernelProbePassed':True,'controlUid':os.getuid(),'workloadUid':1001,'parent':str(parent),'child':str(group),'childMode':oct(group.stat().st_mode&0o777),'kernel':os.uname().release,'rounds':rounds,'workloadMoveDenied':(workspace/'managed.proof').read_text().strip(),'selfNamespace':{name:os.readlink('/proc/self/ns/'+name) for name in ['pid','user','mnt','cgroup']}}),flush=True)
finally:
    if group_created:
        if (group/'cgroup.freeze').exists(): (group/'cgroup.freeze').write_text('0')
        if (group/'cgroup.kill').exists(): (group/'cgroup.kill').write_text('1')
    for process,pidfd in processes:
        if process.poll() is None:
            assert os.getpgid(process.pid)==process.pid, 'cleanup only the dedicated test process group'
            os.killpg(process.pid,signal.SIGKILL)
        process.wait(timeout=10);os.close(pidfd)
    if group_created:
        until(lambda:(group/'cgroup.events').read_text().split('populated ')[1].splitlines()[0]=='0','owned group cleanup did not finish')
        group.rmdir()
    shutil.rmtree(root)
