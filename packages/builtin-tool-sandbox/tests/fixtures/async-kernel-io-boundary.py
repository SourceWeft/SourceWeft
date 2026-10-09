"""Own-child-cgroup io_uring counterexample. Never writes a parent freezer/procs.
A root controller releases a pipe after freezing an unprivileged submitter; linked
kernel I/O may then write only the fixture's fixed 4 KiB file.
"""
import ctypes,json,os,pathlib,signal,subprocess,tempfile,time,uuid,shutil
assert os.geteuid()==0,'requires an explicitly approved isolated administrative image'
mounts=[]
for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
    left,right=line.split(' - ',1)
    if right.split()[0]=='cgroup2':mounts.append(pathlib.Path(left.split()[4]))
assert len(mounts)==1
queue=[(mounts[0],0)];parent=None
for _ in range(128):
    if not queue:break
    p,depth=queue.pop(0)
    if str(os.getpid()) in (p/'cgroup.procs').read_text().split():parent=p;break
    if depth<3:queue.extend((pathlib.Path(e.path),depth+1) for e in os.scandir(p) if e.is_dir(follow_symlinks=False))
assert parent is not None,'cannot verify own parent membership'
root=pathlib.Path(tempfile.mkdtemp(prefix='swvol-uring-boundary-',dir='/workspace'));os.chmod(root,0o755)
work=root/'work';work.mkdir();os.chown(work,1001,1001);os.chmod(work,0o700)
source=root/'probe.c';binary=root/'probe'
source.write_text(r'''
#define _GNU_SOURCE
#include <linux/io_uring.h>
#include <sys/syscall.h>
#include <sys/mman.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
static void ready(const char*path,int err,int submitted,unsigned completed){char tmp[1024];snprintf(tmp,sizeof(tmp),"%s.tmp",path);FILE*f=fopen(tmp,"w");if(!f)_exit(90);fprintf(f,"{\"errno\":%d,\"submitted\":%d,\"completionsBeforeFreeze\":%u}",err,submitted,completed);fclose(f);rename(tmp,path);}
int main(int argc,char**argv){if(argc!=5||getuid()!=1001)return 91;int pipefd=atoi(argv[1]),sqpoll=atoi(argv[2]);struct io_uring_params p={0};p.flags=sqpoll?IORING_SETUP_SQPOLL:0;p.sq_thread_idle=1000;int fd=syscall(__NR_io_uring_setup,8,&p);if(fd<0){ready(argv[4],errno,0,0);return 77;}
size_t sq_size=p.sq_off.array+p.sq_entries*sizeof(unsigned),cq_size=p.cq_off.cqes+p.cq_entries*sizeof(struct io_uring_cqe);if(p.features&IORING_FEAT_SINGLE_MMAP){if(cq_size>sq_size)sq_size=cq_size;cq_size=sq_size;}
void*sq=mmap(NULL,sq_size,PROT_READ|PROT_WRITE,MAP_SHARED,fd,IORING_OFF_SQ_RING);void*cq=(p.features&IORING_FEAT_SINGLE_MMAP)?sq:mmap(NULL,cq_size,PROT_READ|PROT_WRITE,MAP_SHARED,fd,IORING_OFF_CQ_RING);struct io_uring_sqe*entries=mmap(NULL,p.sq_entries*sizeof(*entries),PROT_READ|PROT_WRITE,MAP_SHARED,fd,IORING_OFF_SQES);if(sq==MAP_FAILED||cq==MAP_FAILED||entries==MAP_FAILED){ready(argv[4],errno,0,0);close(fd);return 78;}
unsigned*tail=(unsigned*)((char*)sq+p.sq_off.tail);unsigned*mask=(unsigned*)((char*)sq+p.sq_off.ring_mask);unsigned*array=(unsigned*)((char*)sq+p.sq_off.array);unsigned*cq_head=(unsigned*)((char*)cq+p.cq_off.head);unsigned*cq_tail=(unsigned*)((char*)cq+p.cq_off.tail);unsigned*cq_mask=(unsigned*)((char*)cq+p.cq_off.ring_mask);struct io_uring_cqe*cqes=(void*)((char*)cq+p.cq_off.cqes);
int file=open(argv[3],O_RDWR|O_CREAT|O_TRUNC,0600);if(file<0||ftruncate(file,4096))return 92;char input=0,output[4096];memset(output,'Z',sizeof(output));memset(entries,0,2*sizeof(*entries));entries[0].opcode=IORING_OP_READ;entries[0].fd=pipefd;entries[0].addr=(uintptr_t)&input;entries[0].len=1;entries[0].off=(uint64_t)-1;entries[0].flags=IOSQE_IO_LINK;entries[0].user_data=1;entries[1].opcode=IORING_OP_WRITE;entries[1].fd=file;entries[1].addr=(uintptr_t)output;entries[1].len=sizeof(output);entries[1].off=0;entries[1].user_data=2;unsigned index=__atomic_load_n(tail,__ATOMIC_RELAXED);array[index&*mask]=0;array[(index+1)&*mask]=1;__atomic_store_n(tail,index+2,__ATOMIC_RELEASE);
int submitted=syscall(__NR_io_uring_enter,fd,2,0,sqpoll?IORING_ENTER_SQ_WAKEUP:0,NULL,0);if(submitted<0){ready(argv[4],errno,submitted,0);close(fd);return 79;}struct timespec pause={0,100000000};nanosleep(&pause,NULL);unsigned complete=__atomic_load_n(cq_tail,__ATOMIC_ACQUIRE)-__atomic_load_n(cq_head,__ATOMIC_ACQUIRE);ready(argv[4],0,submitted,complete);char done;read(STDIN_FILENO,&done,1);
unsigned head=__atomic_load_n(cq_head,__ATOMIC_ACQUIRE),end=__atomic_load_n(cq_tail,__ATOMIC_ACQUIRE);printf("{\"mode\":\"%s\",\"completions\":[",sqpoll?"sqpoll":"normal");for(unsigned n=head;n<end&&n<head+8;n++){struct io_uring_cqe*event=&cqes[n&*cq_mask];printf("%s{\"id\":%llu,\"result\":%d}",n==head?"":",",(unsigned long long)event->user_data,event->res);}printf("]}\n");close(file);close(fd);return 0;}
''')
compiled=subprocess.run(['cc','-O2',str(source),'-o',str(binary)],capture_output=True,text=True)
assert compiled.returncode==0,'fixture compiler failed: '+compiled.stderr[-4000:]
libc=ctypes.CDLL(None,use_errno=True);results=[]
def wait_for(predicate,timeout=5):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        if predicate():return True
        time.sleep(.005)
    return False
try:
    for mode in [0,1]:
        group=parent/('swvol-uring-'+uuid.uuid4().hex);group.mkdir();child=None;readfd=writefd=None
        try:
            assert (group/'cgroup.kill').exists()
            readfd,writefd=os.pipe2(os.O_CLOEXEC)
            target=work/('target-'+str(mode));ready=work/('ready-'+str(mode))
            def before_exec():
                if libc.prctl(1,signal.SIGKILL,0,0,0)!=0:raise OSError(ctypes.get_errno(),'prctl')
                (group/'cgroup.procs').write_text(str(os.getpid()))
            child=subprocess.Popen(['setpriv','--reuid=1001','--regid=1001','--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all',str(binary),str(readfd),str(mode),str(target),str(ready)],preexec_fn=before_exec,pass_fds=(readfd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin'},cwd=work)
            os.close(readfd);readfd=None
            assert wait_for(lambda:ready.exists() or child.poll() is not None),'submitter readiness timed out'
            info=json.loads(ready.read_text()) if ready.exists() else {'error':'submitter exited before readiness'}
            result={'mode':'sqpoll' if mode else 'normal','workloadUid':1001,'submission':info,'freezeQualified':False}
            if info.get('errno')!=0 or info.get('completionsBeforeFreeze')!=0:
                result['blocked']='setup/submission failed or linked operation completed before external pipe event';results.append(result);continue
            assert target.read_bytes()==bytes(4096),'target changed before pipe release'
            assert str(os.getpid()) not in (group/'cgroup.procs').read_text().split()
            (group/'cgroup.freeze').write_text('1')
            acknowledged=wait_for(lambda:'frozen 1' in (group/'cgroup.events').read_text())
            result['freezeAcknowledged']=acknowledged
            if acknowledged:
                os.write(writefd,b'x');time.sleep(.35)
                result['fileChangedWhileUserThreadsFrozen']=target.read_bytes()!=bytes(4096)
                result['kernelStillReportsFrozen']='frozen 1' in (group/'cgroup.events').read_text()
            else:result['blocked']='pending kernel I/O prevented a bounded frozen acknowledgement'
            (group/'cgroup.freeze').write_text('0')
            if not acknowledged:os.write(writefd,b'x')
            assert wait_for(lambda:target.read_bytes()==b'Z'*4096),'linked write did not complete after thaw; experiment is inconclusive'
            child.stdin.write(b'd');child.stdin.flush();stdout,stderr=child.communicate(timeout=5)
            assert child.returncode==0,stderr.decode()[-2000:]
            result['completion']=json.loads(stdout);result['linkedWriteAfterThawVerified']=True;results.append(result)
        finally:
            (group/'cgroup.freeze').write_text('0');(group/'cgroup.kill').write_text('1')
            if child is not None:
                child.wait(timeout=5)
            for fd in [readfd,writefd]:
                if fd is not None:os.close(fd)
            assert wait_for(lambda:'populated 0' in (group/'cgroup.events').read_text()),'own test group remained populated'
            group.rmdir()
    print(json.dumps({'test':'io_uring-linked-pipe-to-fixed-file','kernel':os.uname().release,'parent':str(parent),'cases':results,'productionAdapterVerified':False,'kernelIOQuiescenceQualified':False}),flush=True)
finally:shutil.rmtree(root)
