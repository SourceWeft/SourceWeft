# Probe only this disposable sandbox's delegated cgroup and one unique empty child.
# Never write cgroup.freeze/procs in the current or any ancestor cgroup.
import json, os, pathlib, re, uuid

def read(path):
    try: return pathlib.Path(path).read_text().strip()
    except OSError as error: return {"error":error.errno,"kind":type(error).__name__}
def describe(path):
    try:
        st=path.stat()
        return {"path":str(path),"uid":st.st_uid,"gid":st.st_gid,"mode":oct(st.st_mode & 0o777),"writable":os.access(path,os.W_OK)}
    except OSError as error: return {"path":str(path),"error":error.errno}
def unescape(value): return re.sub(r"\\([0-7]{3})",lambda match:chr(int(match[1],8)),value)
status={}
for line in pathlib.Path('/proc/self/status').read_text().splitlines():
    key,_,value=line.partition(':')
    if key in ['Uid','Gid','CapEff','CapBnd','NoNewPrivs','Seccomp']: status[key]=value.strip()
mounts=[]
for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
    left,right=line.split(' - ',1); fields=left.split(); details=right.split()
    if details[0] in ['cgroup','cgroup2']:
        mounts.append({'type':details[0],'root':unescape(fields[3]),'mountpoint':unescape(fields[4]),'mountOptions':fields[5],'superOptions':details[2]})
membership=read('/proc/self/cgroup')
result={'schema':1,'status':status,'uname':list(os.uname()),'namespaces':{name:os.readlink('/proc/self/ns/'+name) for name in ['pid','user','mnt','cgroup']},'membership':membership,'mounts':mounts,'delegation':{'available':False},'stableFreezeValidated':False,'kernelCounterexamplesRun':False}
v2=next((mount for mount in mounts if mount['type']=='cgroup2'),None)
entry=next((line[3:] for line in membership.splitlines() if line.startswith('0::')),None) if isinstance(membership,str) else None
if v2 is None or entry is None:
    result['delegation']['blocker']='cgroup v2 mount/membership missing'
else:
    mount_root=pathlib.Path(v2['mountpoint'])
    result['delegation']['mountRoot']=describe(mount_root)
    base=pathlib.PurePosixPath(v2['root']); current=pathlib.PurePosixPath(entry)
    parent=None
    if current.is_relative_to(base):
        candidate=mount_root.joinpath(current.relative_to(base))
        procs=read(candidate/'cgroup.procs')
        if isinstance(procs,str) and str(os.getpid()) in procs.split(): parent=candidate
    if parent is None:
        # A mount made outside this cgroup namespace may report root /.. . Do not
        # guess its relationship: locate only the kernel's actual own PID entry.
        queue=[(mount_root,0)]; inspected=0; errors=[]
        while queue and inspected<128:
            candidate,depth=queue.pop(0); inspected+=1
            procs=read(candidate/'cgroup.procs')
            if isinstance(procs,str) and str(os.getpid()) in procs.split():
                parent=candidate; break
            if depth<3:
                try:
                    queue.extend((pathlib.Path(item.path),depth+1) for item in os.scandir(candidate) if item.is_dir(follow_symlinks=False))
                except OSError as error: errors.append({'path':str(candidate),'errno':error.errno})
        result['delegation']['ownMembershipSearch']={'inspected':inspected,'errors':errors,'matchedOwnPid':parent is not None}
    if parent is None:
        result['delegation']['blocker']='could not verify own PID in a visible cgroup; refusing guessed parent'
    elif read('/proc/self/cgroup')!=membership:
        result['delegation']['blocker']='membership changed during inspection'
    else:
        result['delegation'].update({'parent':describe(parent),'controllers':read(parent/'cgroup.controllers'),'events':read(parent/'cgroup.events'),'freeze':describe(parent/'cgroup.freeze'),'procs':describe(parent/'cgroup.procs')})
        child=parent/('swvol-freeze-probe-'+uuid.uuid4().hex)
        created=False
        try:
            child.mkdir(); created=True
            result['delegation']['child']=describe(child)
            result['delegation']['childFreeze']=describe(child/'cgroup.freeze')
            result['delegation']['available']=(child/'cgroup.freeze').exists() and os.access(child/'cgroup.freeze',os.W_OK) and os.access(child/'cgroup.procs',os.W_OK)
            result['delegation']['blocker']=None if result['delegation']['available'] else 'child freezer/procs unavailable or not writable'
        except OSError as error:
            result['delegation'].update({'blocker':'create own delegated child failed','errno':error.errno,'error':type(error).__name__})
        finally:
            if created:
                try: child.rmdir(); result['delegation']['childCleaned']=True
                except OSError as error: result['delegation']['cleanupError']={'errno':error.errno,'kind':type(error).__name__}
print(json.dumps(result,sort_keys=True))
