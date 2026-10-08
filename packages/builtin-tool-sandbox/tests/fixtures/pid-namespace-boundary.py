"""Disposable Linux experiment; kills only pidfd-owned unshare children."""
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import time

root = pathlib.Path(tempfile.mkdtemp(prefix="swvol-pidns-", dir="/workspace"))
(root / "sentinel").write_text("preserve-dirty-files")
outer_namespace = os.readlink("/proc/self/ns/pid")
child_code = r'''
import json,os,pathlib,signal,sys,time
root=pathlib.Path(sys.argv[1]); tag=sys.argv[2]
assert os.getpid()==1, "runner must be PID namespace init"
(root/(tag+".identity")).write_text(json.dumps({"pid":os.getpid(),"namespace":os.readlink("/proc/self/ns/pid")}))
child=os.fork()
if child==0:
 os.setsid()
 if os.fork()!=0: os._exit(0)
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 while True:
  with (root/(tag+".writes")).open("a") as f:
   f.write("dirty\\n"); f.flush(); os.fsync(f.fileno())
  time.sleep(0.05)
os.waitpid(child,0)
(root/(tag+".command-completed")).write_text("0")
while True:
 try: os.waitpid(-1,os.WNOHANG)
 except ChildProcessError: pass
 time.sleep(0.02)
'''
children = []

def wait_until(predicate, label, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(label)

def size(tag):
    return (root / (tag + ".writes")).stat().st_size

def stop(child):
    proc, pidfd = child
    if proc.poll() is None:
        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
    proc.wait(timeout=10)

try:
    for tag in ["a", "b"]:
        log = (root / (tag + ".log")).open("w")
        proc = subprocess.Popen([
            "unshare", "--user", "--map-root-user", "--pid", "--fork",
            "--mount-proc", "--kill-child=KILL", "python3", "-c", child_code,
            str(root), tag,
        ], stdout=log, stderr=log, stdin=subprocess.DEVNULL)
        log.close()
        children.append((proc, os.pidfd_open(proc.pid)))
        wait_until(lambda: (root / (tag + ".command-completed")).exists() or proc.poll() is not None,
                   "namespace command did not start")
        assert proc.poll() is None, (root / (tag + ".log")).read_text()
        identity = json.loads((root / (tag + ".identity")).read_text())
        assert identity["pid"] == 1 and identity["namespace"] != outer_namespace
        wait_until(lambda: (root / (tag + ".writes")).exists(), "background did not start")
    before = [size("a"), size("b")]
    time.sleep(0.3)
    assert size("a") > before[0] and size("b") > before[1], "background must survive command completion"
    stop(children[0])
    time.sleep(0.3)
    stopped = size("a")
    sibling_before = size("b")
    time.sleep(0.5)
    assert size("a") == stopped, "detached double-fork child survived PID namespace exit"
    assert size("b") > sibling_before, "sibling namespace was interrupted"
    assert (root / "sentinel").read_text() == "preserve-dirty-files"
    stop(children[1])
    os.sync()
    print(json.dumps({
        "pidNamespaceIsolated": True, "completedCommandBackgroundSurvived": True,
        "setsidDoubleForkTermIgnoringChildStopped": True, "siblingSurvived": True,
        "diskPreserved": True, "controllerSurvived": True,
    }))
finally:
    for child in children:
        try:
            stop(child)
        finally:
            os.close(child[1])
