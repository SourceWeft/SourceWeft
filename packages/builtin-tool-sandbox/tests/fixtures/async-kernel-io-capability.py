"""Bounded setup-only syscall probe. No I/O is submitted and no cgroup is changed."""
import json,os,pathlib,subprocess,tempfile,shutil
root=pathlib.Path(tempfile.mkdtemp(prefix='swvol-async-cap-',dir='/workspace'))
try:
    source=root/'probe.c';binary=root/'probe'
    source.write_text(r'''
#define _GNU_SOURCE
#include <linux/io_uring.h>
#include <linux/aio_abi.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
static void ring(unsigned flags,const char *name){struct io_uring_params params={0};params.flags=flags;params.sq_thread_idle=100;errno=0;long fd=syscall(__NR_io_uring_setup,8,&params);int error=fd<0?errno:0;if(fd>=0)close(fd);printf("\"%s\":{\"allowed\":%s,\"errno\":%d}",name,fd>=0?"true":"false",error);}
int main(void){printf("{");ring(0,"io_uring_setup");printf(",");ring(IORING_SETUP_SQPOLL,"io_uring_sqpoll");aio_context_t ctx=0;errno=0;long rc=syscall(__NR_io_setup,8,&ctx);int error=rc<0?errno:0;long cleanup=rc==0?syscall(__NR_io_destroy,ctx):0;printf(",\"io_setup\":{\"allowed\":%s,\"errno\":%d,\"cleanupSucceeded\":%s}}\n",rc==0?"true":"false",error,cleanup==0?"true":"false");return cleanup==0?0:1;}
''')
    compiled=subprocess.run(['cc','-O2',str(source),'-o',str(binary)],capture_output=True,text=True)
    assert compiled.returncode==0,'syscall capability compiler failed: '+compiled.stderr[-4000:]
    tested=subprocess.run([str(binary)],capture_output=True,text=True,timeout=10)
    assert tested.returncode==0,'syscall setup cleanup failed: '+tested.stderr[-2000:]
    status={}
    for line in pathlib.Path('/proc/self/status').read_text().splitlines():
        key,_,value=line.partition(':')
        if key in ['Uid','Gid','CapEff','CapBnd','Seccomp','NoNewPrivs']:status[key]=value.strip()
    knob=pathlib.Path('/proc/sys/kernel/io_uring_disabled')
    print(json.dumps({'test':'async-kernel-io-setup-only','status':status,'kernel':os.uname().release,'ioUringDisabled':knob.read_text().strip() if knob.exists() else None,'syscalls':json.loads(tested.stdout),'submittedIO':False,'freezeQualified':False}),flush=True)
finally:
    shutil.rmtree(root)
