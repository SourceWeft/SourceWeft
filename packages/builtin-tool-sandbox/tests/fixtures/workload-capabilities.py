import json,os,pathlib,subprocess
fields=['Name','Uid','Gid','CapEff','CapBnd','NoNewPrivs','State','PPid']
def status(pid):
 out={}
 for line in pathlib.Path('/proc/'+str(pid)+'/status').read_text().splitlines():
  key,_,val=line.partition(':')
  if key in fields:out[key]=val.strip()
 return out
probes={}
commands={
 'pid_namespace':['unshare','--pid','--fork','true'],
 'user_pid_namespace':['unshare','--user','--map-root-user','--pid','--fork','true'],
 'dedicated_uid':['setpriv','--reuid=65534','--regid=65534','--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','id'],
}
for name,args in commands.items():
 try:
  r=subprocess.run(args,capture_output=True,text=True,timeout=5)
  probes[name]={'exitCode':r.returncode,'stdout':r.stdout.strip(),'stderr':r.stderr.strip()}
 except Exception as e:probes[name]={'error':type(e).__name__}
print(json.dumps({'self':status('self'),'pid1':status(1),'cgroup':pathlib.Path('/proc/self/cgroup').read_text(),'cgroup_writable':os.access('/sys/fs/cgroup',os.W_OK),'probes':probes}))
