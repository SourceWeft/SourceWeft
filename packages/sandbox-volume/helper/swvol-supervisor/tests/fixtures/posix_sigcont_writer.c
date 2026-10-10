
#define _POSIX_C_SOURCE 200809L
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  if (getuid()!=65534) return 90;
  struct sigevent event={0}; event.sigev_notify=SIGEV_SIGNAL; event.sigev_signo=SIGCONT;
  timer_t timer;
  if(timer_create(CLOCK_MONOTONIC,&event,&timer)!=0) {perror("timer_create"); return 91;}
  struct itimerspec interval={0}; interval.it_value.tv_nsec=100000000; interval.it_interval.tv_nsec=100000000;
  if(timer_settime(timer,0,&interval,NULL)!=0) {perror("timer_settime"); return 92;}
  int fd=open("counter",O_WRONLY|O_CREAT|O_APPEND,0600); if(fd<0)return 93;
  struct timespec begin, now, pause={0,1000000}; clock_gettime(CLOCK_MONOTONIC,&begin);
  do { if(write(fd,"x",1)!=1)return 94; nanosleep(&pause,NULL); clock_gettime(CLOCK_MONOTONIC,&now); } while(now.tv_sec-begin.tv_sec<5);
  timer_delete(timer); close(fd); return 0;
}
