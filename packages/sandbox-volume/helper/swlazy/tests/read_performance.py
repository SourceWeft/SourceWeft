#!/usr/bin/env python3
"""Manual paired replay, using the unchanged swvol/tests/linux_gib.rs fixture.
Run only in the pinned privileged Linux container: 2 CPUs, 1GiB/no swap,
512 PIDs, /gib retained data read-only, and /profile private output.
This retains the rejected raw-sharing experiment; the product has no such pool.
This does not qualify a fresh capture/restore roundtrip or production Freeze.
"""
import hashlib
import json
import os
import platform
import resource
from pathlib import Path
import signal
import subprocess
import sys
import time

RSS_LIMIT_KIB = 160 * 1024
GROUP_TIMEOUT = 300  # Existing replay command budget; each group has three trials.
ORDER = ["baseline-1", "candidate-1", "baseline-2", "candidate-2", "baseline-3", "candidate-3"]

def tree_usage(root, observed=None):
    pending, seen, rss, hwm = [root], set(), 0, 0
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        try:
            status = Path(f"/proc/{pid}/status").read_text()
            values = {line.split(":", 1)[0]: int(line.split()[1]) for line in status.splitlines() if line.startswith(("VmRSS:", "VmHWM:"))}
            if observed is not None:
                observed.append(pid)
            rss += values.get("VmRSS", 0)
            hwm += values.get("VmHWM", 0)
            # Linux associates children with the thread which spawned them.
            # libtest and FUSE worker threads must not disappear from the quota.
            for task in Path(f"/proc/{pid}/task").iterdir():
                try:
                    pending.extend(int(n) for n in (task / "children").read_text().split())
                except FileNotFoundError:
                    pass
        except (FileNotFoundError, ProcessLookupError):
            pass
    return rss, hwm

def read_metric(path):
    try:
        return Path(path).read_text()
    except OSError as error:
        return {"unavailable": str(error)}

def cpu_io_observation(pids, fixture, started):
    processes = []
    for pid in sorted(set(pids + [os.getpid()])):
        try:
            raw = Path(f"/proc/{pid}/stat").read_text()
            end = raw.rfind(")")
            fields = raw[end + 2:].split()
            processes.append({"pid": pid, "name": raw[raw.find("(") + 1:end], "parent": int(fields[1]), "startTicks": int(fields[19]), "userTicks": int(fields[11]), "systemTicks": int(fields[12]), "state": fields[0], "io": read_metric(f"/proc/{pid}/io")})
        except OSError as error:
            processes.append({"pid": pid, "unavailable": str(error), "gone": isinstance(error, (FileNotFoundError, ProcessLookupError))})
    dispatches = {item["pid"] for item in processes if item.get("parent") == fixture and item.get("name") in {"baseline", "candidate"}}
    for item in processes:
        item["role"] = ("observer" if item["pid"] == os.getpid() else "fixture" if item["pid"] == fixture else "oracle" if item.get("name") == "sha256sum" else "dispatch" if item["pid"] in dispatches else "worker" if item.get("parent") in dispatches else "auxiliary-or-exited")
    names = ["cpu.stat", "io.stat", "memory.stat", "memory.current", "memory.events", "cpu.pressure", "io.pressure", "memory.pressure"]
    return {"timeNs": time.time_ns(), "elapsedSeconds": time.monotonic() - started, "clockTicksPerSecond": os.sysconf("SC_CLK_TCK"), "processes": processes, "cgroup": {name: read_metric(f"/sys/fs/cgroup/{name}") for name in names}, "vmGlobal": {name: read_metric(f"/proc/{name}") for name in ["pressure/cpu", "pressure/io", "pressure/memory", "diskstats", "vmstat"]}}

def main():
    if len(sys.argv) != 5:
        raise SystemExit("usage: read_performance.py FIXTURE_EXECUTABLE BASELINE_BINARY CANDIDATE_BINARY RETAINED_8G_BASE")
    fixture, baseline, candidate, retained = map(Path, sys.argv[1:])
    for p in [fixture, baseline, candidate]:
        assert p.is_file(), p
    assert retained.is_dir()
    cgroup = Path("/sys/fs/cgroup")
    quota, period = (cgroup / "cpu.max").read_text().split()
    assert quota != "max" and int(quota) == 2 * int(period), "original 2-CPU limit required"
    assert int((cgroup / "memory.max").read_text()) == 1024 * 1024 * 1024
    assert int((cgroup / "memory.swap.max").read_text()) == 0
    assert int((cgroup / "pids.max").read_text()) == 512
    group = Path(f"/profile/paired-read-{time.time_ns()}")
    group.mkdir()
    print(f"PAIRED_READ_OUTPUT {group}", flush=True)
    large_stat = (retained / "source/d00/large.bin").stat()
    assert large_stat.st_size == 8 * 1024**3 and large_stat.st_blocks * 512 >= large_stat.st_size
    metadata = {"mountInfo": [line for line in Path("/proc/self/mountinfo").read_text().splitlines() if line.split()[4] in {"/gib", "/profile", "/exec"}], "seed": "0x228003005eed8a71", "sourceBytes": large_stat.st_size, "sourceAllocatedBytes": large_stat.st_blocks * 512, "readerCount": 8, "reads": 128, "readBytes": 1024**2, "diskCacheBytes": 8 * 1024**2, "uname": platform.uname()._asdict(), "cgroup": {name: (cgroup / name).read_text().strip() for name in ["cpu.max", "memory.max", "memory.swap.max", "pids.max"]}}
    (group / "environment.json").write_text(json.dumps(metadata, indent=2))
    print("PAIRED_READ_ENV " + json.dumps(metadata), flush=True)
    binaries = {"baseline": str(baseline), "candidate": str(candidate)}
    (group / "binaries.json").write_text(json.dumps({k: {"path": p, "sha256": hashlib.sha256(Path(p).read_bytes()).hexdigest()} for k, p in binaries.items()}, indent=2))
    selector = group / "select.py"
    selector.write_text("""#!/usr/bin/env python3
import fcntl,json,os,sys,time
from pathlib import Path
root=Path(__file__).parent
with open(root/'launch-count','a+') as count:
 fcntl.flock(count,fcntl.LOCK_EX); count.seek(0); text=count.read(); index=int(text or '0')
 assert index<6,'unexpected extra mount invocation'
 names=['baseline-1','candidate-1','baseline-2','candidate-2','baseline-3','candidate-3']
 name=names[index]; binary=json.loads((root/'binaries.json').read_text())[name.split('-')[0]]['path']
 count.seek(0);count.truncate();count.write(str(index+1));count.flush();os.fsync(count.fileno())
 with open(root/'launches.jsonl','a') as log: log.write(json.dumps({'index':index,'name':name,'binary':binary,'pid':os.getpid(),'timeNs':time.time_ns()})+'\\n')
os.execv(binary,[binary]+sys.argv[1:])
""")
    selector.chmod(0o700)
    reports, sensors = [], []
    env = os.environ.copy()
    env.update(SWVOL_GIB_REPLAY_BASE=str(retained), SWVOL_LAZY_BIN=str(selector))
    for run in range(2):
        log_path = group / f"fixture-{run + 1}.log"
        started = time.monotonic()
        peak_rss = peak_hwm = peak_observer_rss = peak_complete_rss = 0
        failure = None
        self_before = resource.getrusage(resource.RUSAGE_SELF)
        children_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        next_observation = started
        last_guard = started
        max_guard_interval = 0.0
        with log_path.open("w") as log, (group / f"telemetry-{run + 1}.jsonl").open("w") as telemetry, log_path.open("r") as progress:
            partial_line = ""
            child = subprocess.Popen([str(fixture), "--exact", "gib_read_replay_profile", "--ignored", "--nocapture"], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            while child.poll() is None:
                tick = time.monotonic()
                max_guard_interval = max(max_guard_interval, tick - last_guard)
                last_guard = tick
                observed = [] if tick >= next_observation else None
                rss, hwm = tree_usage(child.pid, observed)
                own_status = Path("/proc/self/status").read_text()
                observer_rss = next(int(line.split()[1]) for line in own_status.splitlines() if line.startswith("VmRSS:"))
                peak_rss, peak_hwm = max(peak_rss, rss), max(peak_hwm, hwm)
                peak_observer_rss = max(peak_observer_rss, observer_rss)
                peak_complete_rss = max(peak_complete_rss, rss + observer_rss)
                if max(rss + observer_rss, hwm) > RSS_LIMIT_KIB:
                    failure = f"RSS/HWM hard acceptance limit exceeded: complete_rss={rss + observer_rss} data_tree_hwm={hwm} limit={RSS_LIMIT_KIB}KiB"
                elif time.monotonic() - started > GROUP_TIMEOUT:
                    failure = f"original {GROUP_TIMEOUT}s replay budget exceeded"
                if observed is not None:
                    record = cpu_io_observation(observed, child.pid, started)
                    record["rss"] = {"dataTreeKiB": rss, "observerKiB": observer_rss, "completeKiB": rss + observer_rss, "dataTreeHwmKiB": hwm}
                    telemetry.write(json.dumps(record) + "\n")
                    telemetry.flush()
                    partial_line += progress.read()
                    lines = partial_line.split("\n")
                    partial_line = lines.pop()
                    for line in lines:
                        print(f"FIXTURE_LOG group={run + 1} {line}", flush=True)
                    next_observation = time.monotonic() + 1.0
                if failure:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    break
                time.sleep(0.05)
        self_after = resource.getrusage(resource.RUSAGE_SELF)
        children_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        sensor = {"observerCpuSeconds": {"user": self_after.ru_utime - self_before.ru_utime, "system": self_after.ru_stime - self_before.ru_stime}, "reapedChildrenCpuSeconds": {"user": children_after.ru_utime - children_before.ru_utime, "system": children_after.ru_stime - children_before.ru_stime}, "maxObservedGuardIntervalMs": max_guard_interval * 1000, "group": run + 1, "exitCode": child.returncode, "maxTreeRssKiB": peak_rss, "maxObserverRssKiB": peak_observer_rss, "maxCompleteRssKiB": peak_complete_rss, "maxContemporaneousTreeHwmKiB": peak_hwm, "limitKiB": RSS_LIMIT_KIB, "sampleMs": 50, "timeoutSeconds": GROUP_TIMEOUT, "failure": failure, "elapsedSeconds": time.monotonic() - started}
        sensors.append(sensor)
        (group / "resource-guard.json").write_text(json.dumps(sensors, indent=2))
        print("PAIRED_RESOURCE_GUARD " + json.dumps(sensor), flush=True)
        if failure or child.returncode != 0:
            raise RuntimeError(f"replay failed; raw evidence retained at {group}: {failure or child.returncode}")
        batch = [json.loads(line.split("GIB_READ_PROFILE ", 1)[1]) for line in log_path.read_text().splitlines() if line.startswith("GIB_READ_PROFILE ")]
        assert len(batch) == 3
        for report in batch:
            report["pairLabel"] = ORDER[len(reports)]
            assert report["verifiedReadBytes"] == 128 * 1024 * 1024
            assert report["diskCacheLimitBytes"] == 8 * 1024 * 1024
            assert report["peaks"]["cache_bytes"] <= 8 * 1024 * 1024
            trace = Path(report["trace"]).read_text().splitlines()
            hits, shared_peak = {}, 0
            for line in trace:
                if line.startswith("SWVOL_CHUNK "):
                    fields = dict(part.split("=", 1) for part in line.split()[1:])
                    hits[fields["source"]] = hits.get(fields["source"], 0) + 1
                    shared_peak = max(shared_peak, int(fields["shared_peak"]))
            report["chunkSources"], report["sharedRawAllocationPeakBytes"] = hits, shared_peak
            assert shared_peak <= 16 * 1024 * 1024
            if report["pairLabel"].startswith("candidate"):
                assert hits.get("shared", 0) > 0, "candidate did not exercise cross-request raw sharing"
            reports.append(report)
            print("PAIRED_READ_PROFILE " + json.dumps(report), flush=True)
    assert len(reports) == 6 and int((group / "launch-count").read_text()) == 6
    result = {"qualification": "read-stage-only, six cold-cache paired trials", "order": ORDER, "rssHardAcceptanceKiB": RSS_LIMIT_KIB, "sharedRawAllocationLimitBytes": 16 * 1024 * 1024, "reports": reports, "resources": sensors}
    (group / "summary.json").write_text(json.dumps(result, indent=2))
    print(f"PAIRED_READ_DONE output={group}", flush=True)

if __name__ == "__main__":
    main()
