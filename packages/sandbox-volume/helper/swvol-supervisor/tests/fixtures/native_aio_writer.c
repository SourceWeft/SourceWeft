
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
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/un.h>
static void ready(const char*path,long submitted,int err){char tmp[1024];snprintf(tmp,sizeof(tmp),"%s.tmp",path);FILE*f=fopen(tmp,"w");if(!f)_exit(90);fprintf(f,"{\"submitted\":%ld,\"errno\":%d}",submitted,err);fclose(f);rename(tmp,path);}
int main(int argc,char**argv){if(argc!=4||getuid()!=65534)return 91;int completionfd=eventfd(0,EFD_NONBLOCK|EFD_CLOEXEC);int socketfd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);struct sockaddr_un address={.sun_family=AF_UNIX};snprintf(address.sun_path,sizeof(address.sun_path),"%s",argv[1]);if(connect(socketfd,(struct sockaddr*)&address,sizeof(address)))return 96;char byte='e';struct iovec vector={.iov_base=&byte,.iov_len=1};char control[CMSG_SPACE(sizeof(int))]={0};struct msghdr message={.msg_iov=&vector,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof(control)};struct cmsghdr*header=CMSG_FIRSTHDR(&message);header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;header->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(header),&completionfd,sizeof(int));if(sendmsg(socketfd,&message,0)!=1)return 97;close(socketfd);int fd=open(argv[2],O_CREAT|O_TRUNC|O_RDWR|O_DIRECT,0600);if(fd<0){ready(argv[3],-1,errno);return 77;}int allocation=posix_fallocate(fd,0,256*1024*1024);if(allocation){ready(argv[3],-1,allocation);close(fd);return 76;}aio_context_t ctx=0;if(syscall(__NR_io_setup,64,&ctx)){ready(argv[3],-1,errno);close(fd);return 78;}const size_t bytes=4*1024*1024;void*buffer=NULL;if(posix_memalign(&buffer,4096,bytes))return 92;memset(buffer,'A',bytes);struct iocb blocks[64],*requests[64];memset(blocks,0,sizeof(blocks));for(int i=0;i<64;i++){blocks[i].aio_fildes=fd;blocks[i].aio_lio_opcode=IOCB_CMD_PWRITE;blocks[i].aio_buf=(uintptr_t)buffer;blocks[i].aio_nbytes=bytes;blocks[i].aio_offset=(int64_t)i*bytes;blocks[i].aio_data=i+1;blocks[i].aio_flags=IOCB_FLAG_RESFD;blocks[i].aio_resfd=completionfd;requests[i]=&blocks[i];}errno=0;long submitted=syscall(__NR_io_submit,ctx,64,requests);ready(argv[3],submitted,submitted<0?errno:0);char release[1024];snprintf(release,sizeof(release),"%s.release",argv[3]);struct timespec poll={0,1000000};for(int i=0;access(release,F_OK)!=0;i++){if(i>20000)return 98;nanosleep(&poll,NULL);}struct io_event events[64];struct timespec timeout={3,0};long completed=submitted>0?syscall(__NR_io_getevents,ctx,submitted,64,events,&timeout):0;long successful=0;unsigned long long total=0;for(long i=0;i<completed;i++){if(events[i].res==(long long)bytes&&events[i].res2==0)successful++;if(events[i].res>0)total+=events[i].res;}long drained=syscall(__NR_io_destroy,ctx);printf("{\"destroyResult\":%ld,\"errno\":%d,\"completed\":%ld,\"successfulWrites\":%ld,\"writtenBytes\":%llu}\n",drained,drained<0?errno:0,completed,successful,total);free(buffer);close(fd);return drained==0&&successful==submitted?0:1;}
