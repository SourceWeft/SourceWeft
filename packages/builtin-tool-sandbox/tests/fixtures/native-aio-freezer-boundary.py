"""Bounded native Linux AIO O_DIRECT probe; only a private 256 MiB file and own cgroup.
Eventfd completion observations distinguish user-thread freeze from pending kernel I/O.
"""
import ctypes,json,os,pathlib,signal,struct,subprocess,tempfile,time,uuid,shutil
assert os.geteuid()==0
assert shutil.disk_usage('/workspace').free>512*1024*1024,'native AIO probe requires 512 MiB free; do not reduce workload silently'
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
assert parent is not None
root=pathlib.Path(tempfile.mkdtemp(prefix='swvol-native-aio-',dir='/workspace'));os.chmod(root,0o755)
work=root/'work';work.mkdir();os.chown(work,1001,1001);os.chmod(work,0o700)
source=root/'aio.c';binary=root/'aio'
source.write_text(r'''
#define _GNU_SOURCE
#include <linux/aio_abi.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
static void ready(const char*path,long submitted,int err){char tmp[1024];snprintf(tmp,sizeof(tmp),"%s.tmp",path);FILE*f=fopen(tmp,"w");if(!f)_exit(90);fprintf(f,"{\"submitted\":%ld,\"errno\":%d}",submitted,err);fclose(f);rename(tmp,path);}
int main(int argc,char**argv){if(argc!=4||getuid()!=1001)return 91;int eventfd=atoi(argv[1]);int fd=open(argv[2],O_CREAT|O_TRUNC|O_RDWR|O_DIRECT,0600);if(fd<0){ready(argv[3],-1,errno);return 77;}int allocation=posix_fallocate(fd,0,256*1024*1024);if(allocation){ready(argv[3],-1,allocation);close(fd);return 76;}aio_context_t ctx=0;if(syscall(__NR_io_setup,64,&ctx)){ready(argv[3],-1,errno);close(fd);return 78;}const size_t bytes=4*1024*1024;void*buffer=NULL;if(posix_memalign(&buffer,4096,bytes))return 92;memset(buffer,'A',bytes);struct iocb blocks[64],*requests[64];memset(blocks,0,sizeof(blocks));for(int i=0;i<64;i++){blocks[i].aio_fildes=fd;blocks[i].aio_lio_opcode=IOCB_CMD_PWRITE;blocks[i].aio_buf=(uintptr_t)buffer;blocks[i].aio_nbytes=bytes;blocks[i].aio_offset=(int64_t)i*bytes;blocks[i].aio_data=i+1;blocks[i].aio_flags=IOCB_FLAG_RESFD;blocks[i].aio_resfd=eventfd;requests[i]=&blocks[i];}errno=0;long submitted=syscall(__NR_io_submit,ctx,64,requests);ready(argv[3],submitted,submitted<0?errno:0);char done;read(STDIN_FILENO,&done,1);struct io_event events[64];struct timespec timeout={3,0};long completed=submitted>0?syscall(__NR_io_getevents,ctx,submitted,64,events,&timeout):0;long successful=0;unsigned long long total=0;for(long i=0;i<completed;i++){if(events[i].res==(long long)bytes&&events[i].res2==0)successful++;if(events[i].res>0)total+=events[i].res;}long drained=syscall(__NR_io_destroy,ctx);printf("{\"destroyResult\":%ld,\"errno\":%d,\"completed\":%ld,\"successfulWrites\":%ld,\"writtenBytes\":%llu}\n",drained,drained<0?errno:0,completed,successful,total);free(buffer);close(fd);return drained==0&&successful==submitted?0:1;}
''')
compiled=subprocess.run(['cc','-O2',str(source),'-o',str(binary)],capture_output=True,text=True)
assert compiled.returncode==0,'AIO fixture compiler failed: '+compiled.stderr[-4000:]
group=parent/('swvol-aio-'+uuid.uuid4().hex);group.mkdir();eventfd=os.eventfd(0,os.EFD_CLOEXEC|os.EFD_NONBLOCK);child=None;libc=ctypes.CDLL(None,use_errno=True)
def wait_for(predicate,timeout=5):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if predicate():return True
        time.sleep(.001)
    return False
def completions():
    total=0
    while True:
        try:total+=os.eventfd_read(eventfd)
        except BlockingIOError:return total
try:
    assert (group/'cgroup.kill').exists()
    target=work/'direct-file';ready=work/'ready'
    def prepare():
        if libc.prctl(1,signal.SIGKILL,0,0,0)!=0:raise OSError(ctypes.get_errno(),'prctl')
        (group/'cgroup.procs').write_text(str(os.getpid()))
    child=subprocess.Popen(['setpriv','--reuid=1001','--regid=1001','--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all',str(binary),str(eventfd),str(target),str(ready)],preexec_fn=prepare,pass_fds=(eventfd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin'},cwd=work)
    assert wait_for(lambda:ready.exists() or child.poll() is not None,10),'AIO submission exceeded bounded readiness deadline'
    info=json.loads(ready.read_text()) if ready.exists() else {'error':'submitter exited before ready'}
    result={'test':'native-linux-aio-direct-write','kernel':os.uname().release,'workloadUid':1001,'requestedBytes':256*1024*1024,'preallocated':True,'submission':info,'kernelIOQuiescenceQualified':False}
    if info.get('submitted',0)>0:
        before=completions();(group/'cgroup.freeze').write_text('1');ack=wait_for(lambda:'frozen 1' in (group/'cgroup.events').read_text());at_ack=before+completions();time.sleep(.35);later=at_ack+completions()
        result.update({'freezeAcknowledged':ack,'completionsBeforeFreeze':before,'completionsAtFreezeAck':at_ack,'completionsAfter350ms':later,'pendingAtFreezeAck':info['submitted']-at_ack,'completedWhileFrozen':later-at_ack if ack else None,'kernelStillReportsFrozen':'frozen 1' in (group/'cgroup.events').read_text(),'inconclusiveNoPendingAtAck':at_ack>=info['submitted']})
        (group/'cgroup.freeze').write_text('0');child.stdin.write(b'd');child.stdin.flush();stdout,stderr=child.communicate(timeout=10);assert child.returncode==0,stderr.decode()[-2000:];result['cleanup']=json.loads(stdout);result['fileBytes']=target.stat().st_size
    else:result['blocked']='native direct I/O submission failed; no buffered-I/O fallback'
    print(json.dumps(result),flush=True)
finally:
    (group/'cgroup.freeze').write_text('0');(group/'cgroup.kill').write_text('1')
    if child is not None:child.wait(timeout=10)
    os.close(eventfd);assert wait_for(lambda:'populated 0' in (group/'cgroup.events').read_text());group.rmdir();shutil.rmtree(root)
