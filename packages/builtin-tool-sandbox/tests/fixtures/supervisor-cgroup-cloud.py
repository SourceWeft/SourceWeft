"""Administrative dev-image acceptance of the exact installed supervisor.
Embedded sources and expected binary hash are supplied by the explicit host runner.
No production adapter or kernel-I/O quiescence is certified by this script.
"""
import array,hashlib,json,os,pathlib,signal,socket,subprocess,tempfile,time,uuid,shutil
assert os.geteuid()==0,'isolated root dev image required'
binary=pathlib.Path('/usr/local/sbin/swvol-supervisor')
assert hashlib.sha256(binary.read_bytes()).hexdigest()==EXPECTED_SUPERVISOR_SHA,'installed supervisor differs from reviewed post-AIO receipt'
mounts=[]
for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
    left,right=line.split(' - ',1)
    if right.split()[0]=='cgroup2':mounts.append(pathlib.Path(left.split()[4]))
assert len(mounts)==1
queue=[(mounts[0],0)];parent=None
for _ in range(128):
    if not queue:break
    path,depth=queue.pop(0)
    if str(os.getpid()) in (path/'cgroup.procs').read_text().split():parent=path;break
    if depth<3:queue.extend((pathlib.Path(e.path),depth+1) for e in os.scandir(path) if e.is_dir(follow_symlinks=False))
assert parent is not None,'refuse guessed cgroup delegation'
root=pathlib.Path(tempfile.mkdtemp(prefix='swvol-supervisor-cloud-',dir='/workspace'));os.chmod(root,0o755)
state=root/'state';state.mkdir(mode=0o700)
work=root/'work';work.mkdir();os.chown(work,1001,1001);os.chmod(work,0o700)
sock=root/'control.sock';server=None;mounted=False;eventfd=None;listener=None;nonce=None
report={'test':'actual-supervisor-diagnostic-boundary','binarySha256':EXPECTED_SUPERVISOR_SHA,'kernel':os.uname().release,'productionAdapterQualified':False,'kernelIOQuiescenceQualified':False,'parent':str(parent),'stateTmpfsForIoIsolation':True}
def wait_for(predicate,label,seconds=8):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if predicate():return
        time.sleep(.001)
    raise AssertionError(label)
def request(op,**params):
    payload={'op':op,**params}
    if op!='identity':payload['expected_nonce']=nonce
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(10);client.connect(str(sock));client.sendall((json.dumps(payload)+'\n').encode());line=b''
        while b'\n' not in line:
            data=client.recv(65536)
            if not data:raise RuntimeError('supervisor control EOF')
            line+=data
    return json.loads(line)
def ok(op,**params):
    result=request(op,**params);assert result['ok'],result
    return result['result']
def start_server():
    global server,nonce
    stderr=(root/'supervisor.log').open('ab')
    server=subprocess.Popen([str(binary),'serve',str(sock),str(state),str(work),'1001','1000','--cgroup-parent',str(parent)],stdout=subprocess.DEVNULL,stderr=stderr);stderr.close()
    deadline=time.monotonic()+10
    while True:
        if server.poll() is not None:raise RuntimeError((root/'supervisor.log').read_text()[-4000:])
        try:identity=request('identity');break
        except (FileNotFoundError,ConnectionRefusedError):
            assert time.monotonic()<deadline,'supervisor readiness timed out';time.sleep(.01)
    assert identity['ok'];nonce=identity['result']['identity']['supervisor_nonce'];assert identity['result']['identity']['stable_freeze'] is False
    assert identity['result']['identity']['kernel_io_quiescence']=='unqualified'
    return identity['result']
def start(execution_id,command):return ok('start',launch={'execution_id':execution_id,'command':command,'cwd':str(work)})
def size(name):
    path=work/name;return path.stat().st_size if path.exists() else 0
def collect_events():
    count=0
    while True:
        try:count+=os.eventfd_read(eventfd)
        except BlockingIOError:return count
try:
    # This isolates journal fsync from the data filesystem; it is not a claim of
    # control-state survival across a VM loss. Daemon restarts retain this mount.
    mounted_result=subprocess.run(['mount','-t','tmpfs','-o','size=8m,mode=0700','tmpfs',str(state)],capture_output=True,text=True)
    assert mounted_result.returncode==0,'independent control journal mount unavailable: '+mounted_result.stderr
    mounted=True
    for name,source in [('timer',TIMER_SOURCE.replace('getuid()!=65534','getuid()!=1001')),('aio',AIO_SOURCE.replace('getuid()!=65534','getuid()!=1001'))]:
        path=root/(name+'.c');path.write_text(source)
        built=subprocess.run(['cc','-O2',str(path),'-lrt','-o',str(root/name)],capture_output=True,text=True)
        assert built.returncode==0,'fixture compilation failed: '+built.stderr[-4000:]
    report['identity']=start_server()['identity']
    rejected=request('freeze',freeze_id='must-reject')
    assert rejected['ok'] is False and 'KERNEL_IO_QUIESCENCE_UNQUALIFIED' in rejected['error'];report['productionFreezeRejected']=True
    ok('open',drain_id=None);start('timer','exec '+str(root/'timer'))
    wait_for(lambda:size('counter')>10,'timer did not write')
    pause=ok('pause_kernel',pause_id='timer-pause');assert pause['user_threads_frozen'] and pause['kernel_io_quiescence']=='unqualified';assert 'all_writers_stopped' not in pause
    before=size('counter');time.sleep(.35);assert size('counter')==before
    ok('thaw',pause_id='timer-pause');wait_for(lambda:size('counter')>before,'timer failed to resume')
    report['sigcontUserThreadPause']={'counterAtPause':before,'counterAfter350ms':before,'resumed':True}
    ok('drain',drain_id='timer-finished');ok('open',drain_id='timer-finished')
    event_socket=work/'events.sock';listener=socket.socket(socket.AF_UNIX);listener.bind(str(event_socket));os.chmod(event_socket,0o666);listener.listen(1);listener.settimeout(10)
    ready=work/'aio-ready';target=work/'aio-data';assert shutil.disk_usage(work).free>512*1024*1024
    start('native-aio',f'exec {root / "aio"} {event_socket} {target} {ready}')
    wait_for(lambda:ready.exists(),'native AIO readiness timed out',15)
    submission=json.loads(ready.read_text());assert submission['errno']==0 and submission['submitted']==64,submission
    peer,_=listener.accept()
    with peer:
        body,ancillary,flags,address=peer.recvmsg(1,socket.CMSG_SPACE(array.array('i').itemsize))
        assert body==b'e'
        descriptors=array.array('i')
        for level,kind,data in ancillary:
            if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:descriptors.frombytes(data[:len(data)-(len(data)%descriptors.itemsize)])
        assert len(descriptors)==1;eventfd=descriptors[0]
    initial=collect_events();pause=ok('pause_kernel',pause_id='aio-pause');assert 'all_writers_stopped' not in pause
    at_ack=initial+collect_events();time.sleep(.35);after=at_ack+collect_events()
    journal=json.loads((state/'cgroup.json').read_text());assert 'frozen 1' in (pathlib.Path(journal['tree'])/'cgroup.events').read_text()
    ok('thaw',pause_id='aio-pause');pathlib.Path(str(ready)+'.release').write_text('release')
    result=None
    def completed():
        global result
        result=ok('status',execution_id='native-aio');return result['completion'] is not None
    wait_for(completed,'AIO completion missing')
    assert result['completion']['exit_code']==0;verified=json.loads(result['stdout']);assert verified['successfulWrites']==64 and verified['writtenBytes']==268435456
    report['nativeAio']={'submission':submission,'completionsAtDiagnosticPause':at_ack,'completionsAfter350ms':after,'pendingAtAck':64-at_ack,'completedWhilePaused':after-at_ack,'inconclusiveNoPendingAtAck':at_ack==64,'verified':verified}
    # Preserve fixed data and prove a daemon crash does not replay an old command.
    start('once','echo once >> once; printf completed')
    wait_for(lambda:ok('status',execution_id='once')['completion'] is not None,'once command did not finish')
    old_nonce=nonce;server.kill();server.wait(timeout=10);new=start_server();assert nonce!=old_nonce
    assert new['open'] is False and (work/'once').read_text()=='once\n'
    recovered=ok('status',execution_id='once');assert recovered['completion']['exit_code']==0 and recovered['stdout']=='completed'
    report['daemonRecovery']={'newIdentity':True,'admissionClosed':True,'completedResultPreserved':True,'commandNotReplayed':True,'workspaceFilePreserved':True}
    ok('drain',drain_id='test-cleanup')
    print(json.dumps(report),flush=True)
finally:
    if server is not None:
        if server.poll() is None:server.kill()
        server.wait(timeout=10)
    if eventfd is not None:os.close(eventfd)
    if listener is not None:listener.close()
    if mounted:subprocess.run(['umount','--lazy',str(state)],check=True,capture_output=True)
    shutil.rmtree(root)
