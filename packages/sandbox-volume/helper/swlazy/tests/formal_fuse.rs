//! Explicit Linux-only mount acceptance. Run with --ignored in a FUSE-capable container.
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use serde_json::json;
type Objects = Arc<Mutex<BTreeMap<String, Vec<u8>>>>;
struct ControlPolicy { token: String, url: String, chunks: std::collections::HashMap<String, swvol_core::ChunkLoc>, packs: std::collections::HashMap<String, String>, requests: Arc<Mutex<Vec<Vec<String>>>> }
struct Storage { url: String, objects: Objects, stop: Arc<AtomicBool>, worker: Option<std::thread::JoinHandle<()>>, control: Arc<Mutex<Option<ControlPolicy>>> }
impl Storage {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let objects = Arc::new(Mutex::new(BTreeMap::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let control = Arc::new(Mutex::new(None));
        let (data, stopped, policy) = (objects.clone(), stop.clone(), control.clone());
        let worker = std::thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &data, &policy),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => panic!("HTTP fixture failed: {error}"),
                }
            }
        });
        Self { url, objects, stop, worker: Some(worker), control }
    }
    fn grant(&self, root: &PathBuf, enabled: bool) {
        let packs: BTreeMap<_, _> = (0..64).filter(|_| enabled).map(|n| (n.to_string(), format!("{}/att/a/p/{n:06}", self.url))).collect();
        let manifests: BTreeMap<_, _> = (1..65).filter(|_| enabled).map(|n| (n.to_string(), format!("{}/att/a/m/1/{n}", self.url))).collect();
        let bytes = serde_json::to_vec(&json!({"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/1/","packs":packs,"manifests":manifests})).unwrap();
        let tmp = root.join(".sourceweft/slots.new");
        fs::write(&tmp, bytes).unwrap();
        fs::rename(tmp, root.join(".sourceweft/slots.json")).unwrap();
    }

}
impl Drop for Storage { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); self.worker.take().unwrap().join().unwrap(); } }
fn serve(mut stream: TcpStream, objects: &Objects, policy: &Arc<Mutex<Option<ControlPolicy>>>) {
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new(); reader.read_line(&mut first).unwrap();
    let mut fields = first.split_whitespace();
    let method = fields.next().unwrap(); let path = fields.next().unwrap().to_owned();
    let mut length = 0;
    let mut range = None;
    let mut authorization = String::new();
    loop {
        let mut line = String::new(); reader.read_line(&mut line).unwrap();
        if line == "\r\n" { break; }
        if let Some((key, value)) = line.split_once(':') { if key.eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap(); }
            if key.eq_ignore_ascii_case("range") { range = Some(value.trim().to_owned()); }
            if key.eq_ignore_ascii_case("authorization") { authorization = value.trim().to_owned(); } }
    }
    let mut body = vec![0; length]; reader.read_exact(&mut body).unwrap();
    let mut map = objects.lock().unwrap();
    let mut range_header = String::new();
    let (status, reply) = if method == "POST" && path == "/v1/sandbox-volumes/a/control" {
        let guard = policy.lock().unwrap(); let control = guard.as_ref().expect("control fixture not configured");
        assert!(authorization == format!("Bearer {}", control.token), "incorrect fixture control credential");
        let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
        control.requests.lock().unwrap().push(request["locatorChunkIds"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect());
        let chunks: std::collections::HashMap<_, _> = request["locatorChunkIds"].as_array().unwrap().iter().map(|id| {
            let id = id.as_str().unwrap(); (id.to_owned(), control.chunks[id].clone())
        }).collect();
        let packs: std::collections::HashMap<_, _> = chunks.values().map(|loc| (loc.0.clone(), control.packs[&loc.0].clone())).collect();
        let pack_slots: BTreeMap<_, _> = (0..64).map(|n| (n.to_string(), format!("{}/att/a/p/{n:06}", control.url))).collect();
        let manifests: BTreeMap<_, _> = (1..65).map(|n| (n.to_string(), format!("{}/att/a/m/1/{n}", control.url))).collect();
        let head = map.keys().filter_map(|key| key.strip_prefix("/att/a/m/1/")?.parse::<u64>().ok()).max().unwrap_or(0);
        (200, serde_json::to_vec(&json!({"head":head,"confirmedSeq":head.min(request["seq"].as_u64().unwrap()),"epoch":1,"hasMore":false,
            "slots":{"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/1/","packs":pack_slots,"manifests":manifests},
            "slotsExpiresAt":"2030-01-01T00:00:00Z","controlExpiresAt":"2030-01-01T00:00:00Z","locators":{"chunks":chunks,"packs":packs}})).unwrap())
    } else if method == "PUT" {
        if map.contains_key(&path) { (412, Vec::new()) }
        else { map.insert(path, body); (201, Vec::new()) }
    } else { match map.get(&path) { Some(data) => {
        if let Some(range) = range {
            let (from, to) = range.strip_prefix("bytes=").unwrap().split_once('-').unwrap();
            let from: usize = from.parse().unwrap(); let to: usize = to.parse().unwrap();
            range_header = format!("Content-Range: bytes {from}-{to}/{}\r\n", data.len());
            (206, data[from..=to].to_vec())
        } else { (200, data.clone()) }
    }, None => (404, Vec::new()) } };
    let response = (|| -> std::io::Result<()> {
        write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\n{range_header}Connection: close\r\n\r\n", reply.len())?;
        stream.write_all(&reply)
    })();
    if let Err(error) = response {
        assert!(matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset), "fixture response failed: {error}");
    }
}

struct Mounts { base: PathBuf, child: Option<Child>, overlay: bool }
impl Drop for Mounts {
    fn drop(&mut self) {
        if self.overlay { let _ = Command::new("umount").arg(self.base.join("workspace")).status(); }
        let lower = self.base.join("lower");
        if fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!(" {} ", lower.display())) {
            let _ = Command::new("umount").arg(&lower).status();
        }
        if let Some(mut child) = self.child.take() { let _ = child.kill(); let _ = child.wait(); }
        let _ = fs::remove_dir_all(&self.base);
    }
}
fn random_bytes(seed: u32, size: usize) -> Vec<u8> {
    let mut seed = seed;
    (0..size).map(|_| { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed as u8 }).collect()
}
fn swvol(root: &Path, args: &[&str]) {
    let binary = std::env::var("SWVOL_SYNC_BIN").expect("SWVOL_SYNC_BIN must name the freshly built sync helper");
    let output = Command::new(binary).args(args).arg("--root").arg(root).output().unwrap();
    assert!(output.status.success(), "sync helper failed: {}", String::from_utf8_lossy(&output.stdout));
}
#[test]
#[ignore = "requires real /dev/fuse and mount privileges; run explicit Linux acceptance command"]
fn formal_sync_objects_mount_lazily_and_overlay_keeps_lower_immutable() {
    assert!(Path::new("/dev/fuse").exists(), "real FUSE device is required");
    let base = PathBuf::from(format!("/test/swvol-fuse-{}", std::process::id()));
    let mut mounts = Mounts { base: base.clone(), child: None, overlay: false };
    for dir in ["source", "cache", "lower", "upper", "work", "workspace"] { fs::create_dir_all(base.join(dir)).unwrap(); }
    let source = base.join("source"); let storage = Storage::new();
    let empty = base.join("empty.json");
    fs::write(&empty, serde_json::to_vec(&json!({"volume":"v","attachment":"a","seq":0,"entries":[],"chunks":{},"packs":{}})).unwrap()).unwrap();
    swvol(&source, &["restore", "--plan", empty.to_str().unwrap()]); storage.grant(&source, true);
    fs::create_dir(source.join("nested")).unwrap();
    let a = random_bytes(41, 6 * 1024 * 1024); let b = random_bytes(97, 6 * 1024 * 1024); let bad = random_bytes(199, 6 * 1024 * 1024);
    fs::write(source.join("nested/a.bin"), &a).unwrap(); fs::write(source.join("b.bin"), &b).unwrap(); fs::write(source.join("bad.bin"), &bad).unwrap();
    std::os::unix::fs::symlink("nested/a.bin", source.join("link")).unwrap();
    swvol(&source, &["flush"]);
    let objects = storage.objects.lock().unwrap();
    let manifest_bytes = objects.get("/att/a/m/1/1").expect("sync emitted a formal manifest");
    let manifest = swvol_core::decode_manifest(manifest_bytes, 1024 * 1024).unwrap();
    let urls = objects.keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect();
    drop(objects);
    let plan = swvol_core::RestorePlan { volume: "v".into(), attachment: "a".into(), seq: manifest.seq, entries: manifest.upserts, chunks: manifest.chunks.into_iter().collect(), packs: urls };
    plan.validate().unwrap();
    let plan_path = base.join("plan.json"); fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    mounts.child = Some(Command::new(env!("CARGO_BIN_EXE_swlazy")).arg("mount-volume").arg(&plan_path).arg(base.join("cache")).arg(base.join("lower")).args(["--cap-mb", "4"]).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(mounts.child.as_mut().unwrap().try_wait().unwrap().is_none(), "FUSE process exited before mount");
        if fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!(" {} ", base.join("lower").display())) { break; }
        assert!(Instant::now() < deadline, "FUSE mount did not become ready"); std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read_dir(base.join("cache")).unwrap().filter(|item| item.as_ref().unwrap().file_name() != ".lock").count(), 0, "mount must not download file data");
    assert_eq!(fs::read_link(base.join("lower/link")).unwrap(), PathBuf::from("nested/a.bin"));
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| assert_eq!(fs::read(base.join("lower/nested/a.bin")).unwrap(), a));
            scope.spawn(|| assert_eq!(fs::read(base.join("lower/b.bin")).unwrap(), b));
        }
    });
    let cache_bytes: u64 = fs::read_dir(base.join("cache")).unwrap().map(|entry| entry.unwrap().metadata().unwrap().len()).sum();
    assert!(cache_bytes <= 4 * 1024 * 1024, "disk cache exceeded its budget: {cache_bytes}");
    let mount = Command::new("mount").args(["-t", "overlay", "overlay", "-o"]).arg(format!("lowerdir={},upperdir={},workdir={}", base.join("lower").display(), base.join("upper").display(), base.join("work").display())).arg(base.join("workspace")).output().unwrap();
    assert!(mount.status.success(), "overlay mount failed: {}", String::from_utf8_lossy(&mount.stderr)); mounts.overlay = true;
    fs::write(base.join("workspace/nested/a.bin"), "upper write").unwrap(); fs::remove_file(base.join("workspace/b.bin")).unwrap();
    assert_eq!(fs::read_to_string(base.join("workspace/nested/a.bin")).unwrap(), "upper write");
    assert_eq!(fs::read(base.join("lower/nested/a.bin")).unwrap(), a);
    assert_eq!(fs::read(base.join("lower/b.bin")).unwrap(), b);
    // Corrupt an unread immutable object chunk. The FUSE reply must fail, never return corrupt bytes.
    let bad_ref = &plan.entries.iter().find(|entry| entry.p == "bad.bin").unwrap().c[0];
    let loc = &plan.chunks[&bad_ref.0];
    storage.objects.lock().unwrap().get_mut(&format!("/{}", loc.0)).unwrap()[loc.1 as usize] ^= 0xff;
    assert!(fs::read(base.join("lower/bad.bin")).is_err(), "corrupt compressed chunk must cause EIO");
}

#[test]
#[ignore = "requires real FUSE and SIGKILL worker fault injection in a disposable Linux container"]
fn content_worker_sigkill_retries_same_read_and_preserves_overlay_upper() {
    let base = PathBuf::from(format!("/test/swvol-worker-recovery-{}", std::process::id()));
    let mut mounts = Mounts { base: base.clone(), child: None, overlay: false };
    for dir in ["source", "cache", "lower", "upper", "work", "workspace", "faults"] { fs::create_dir_all(base.join(dir)).unwrap(); }
    let source = base.join("source"); let storage = Storage::new();
    let empty = base.join("empty.json");
    fs::write(&empty, serde_json::to_vec(&json!({"volume":"v","attachment":"a","seq":0,"entries":[],"chunks":{},"packs":{}})).unwrap()).unwrap();
    swvol(&source, &["restore", "--plan", empty.to_str().unwrap()]); storage.grant(&source, true);
    let points = ["before-fetch", "after-download", "after-decode", "mid-response"];
    let mut expected = BTreeMap::new();
    for (index, point) in points.iter().enumerate() {
        let bytes = random_bytes(51 + index as u32, 2 * 1024 * 1024);
        fs::write(source.join(point), &bytes).unwrap(); expected.insert(*point, bytes);
    }
    fs::write(source.join("never-read"), random_bytes(201, 1024 * 1024)).unwrap();
    swvol(&source, &["flush"]);
    let objects = storage.objects.lock().unwrap();
    let manifest = swvol_core::decode_manifest(objects.get("/att/a/m/1/1").unwrap(), 1024 * 1024).unwrap();
    let urls = objects.keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect(); drop(objects);
    let plan = swvol_core::RestorePlan { volume: "v".into(), attachment: "a".into(), seq: manifest.seq, entries: manifest.upserts, chunks: manifest.chunks.into_iter().collect(), packs: urls };
    let plan_path = base.join("plan.json"); fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    mounts.child = Some(Command::new(env!("CARGO_BIN_EXE_swlazy")).arg("mount-volume").arg(&plan_path).arg(base.join("cache")).arg(base.join("lower"))
        .args(["--cap-mb", "4"]).env("SWVOL_WORKER_TEST_FAULT_DIR", base.join("faults")).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
    let dispatch = mounts.child.as_ref().unwrap().id();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!(" {} ", base.join("lower").display())) {
        assert!(mounts.child.as_mut().unwrap().try_wait().unwrap().is_none()); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(20));
    }
    let mount = Command::new("mount").args(["-t", "overlay", "overlay", "-o"]).arg(format!("lowerdir={},upperdir={},workdir={}", base.join("lower").display(), base.join("upper").display(), base.join("work").display())).arg(base.join("workspace")).output().unwrap();
    assert!(mount.status.success(), "{}", String::from_utf8_lossy(&mount.stderr)); mounts.overlay = true;
    fs::write(base.join("workspace/generated.txt"), "local dirty output must survive read-worker crashes").unwrap();
    for point in points {
        fs::write(base.join("faults").join(format!("arm-{point}")), b"armed").unwrap();
        let path = base.join("workspace").join(point);
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || { let _ = tx.send(fs::read(path)); });
        let marker = base.join("faults").join(format!("observed-{point}"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() { assert!(Instant::now() < deadline, "fault boundary {point} not reached"); std::thread::sleep(Duration::from_millis(10)); }
        let pid: i32 = fs::read_to_string(&marker).unwrap().parse().unwrap();
        let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
        let parent: u32 = status.lines().find_map(|line| line.strip_prefix("PPid:")).unwrap().trim().parse().unwrap();
        assert_eq!(parent, dispatch, "kill only a verified child of this FUSE dispatch");
        assert_eq!(status.lines().find_map(|line| line.strip_prefix("NoNewPrivs:")).unwrap().trim(), "1");
        for descriptor in fs::read_dir(format!("/proc/{pid}/fd")).unwrap() {
            if let Ok(target) = fs::read_link(descriptor.unwrap().path()) {
                assert_ne!(target, PathBuf::from("/dev/fuse"), "content worker must not inherit the FUSE connection");
            }
        }
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        let bytes = rx.recv_timeout(Duration::from_secs(10)).expect("original read did not recover").unwrap(); reader.join().unwrap();
        assert_eq!(bytes, expected[point]);
        assert!(mounts.child.as_mut().unwrap().try_wait().unwrap().is_none(), "FUSE dispatch must survive worker failure");
        assert_eq!(fs::read_to_string(base.join("workspace/generated.txt")).unwrap(), "local dirty output must survive read-worker crashes");
        assert_eq!(fs::read_to_string(base.join("upper/generated.txt")).unwrap(), "local dirty output must survive read-worker crashes");
        eprintln!("WORKER_RECOVERY_OK point={point} original_read_completed=true dispatch_unchanged=true upper_preserved=true");
    }
    // Losing dispatch is a different failure boundary. Never remount or replay
    // user commands here; preserve upper for the host's quiesced recovery path.
    mounts.child.as_mut().unwrap().kill().unwrap(); mounts.child.as_mut().unwrap().wait().unwrap();
    assert_eq!(fs::read_to_string(base.join("upper/generated.txt")).unwrap(), "local dirty output must survive read-worker crashes");
    assert!(fs::read(base.join("lower/never-read")).is_err(), "an uncached lookup must fail after dispatch exits");
    eprintln!("DISPATCH_FAILURE_RESULT mount_ready=false upper_preserved=true user_command_replayed=false");
}

#[test]
#[ignore = "requires root bootstrap to pass a fresh FUSE fd to an unprivileged dispatch"]
fn fresh_fuse_fd_bootstrap_runs_dispatch_and_content_workers_without_root() {
    use std::os::fd::{AsFd, AsRawFd};
    use std::os::unix::process::CommandExt;
    use std::os::unix::fs::PermissionsExt;
    struct MountOnly;
    impl fuser::Filesystem for MountOnly {}
    let base = PathBuf::from(format!("/test/swvol-unprivileged-{}", std::process::id()));
    let mut mounts = Mounts { base: base.clone(), child: None, overlay: false };
    for dir in ["source", "cache", "lower", "faults"] { fs::create_dir_all(base.join(dir)).unwrap(); }
    let source = base.join("source"); let storage = Storage::new();
    let empty = base.join("empty.json"); fs::write(&empty, serde_json::to_vec(&json!({"volume":"v","attachment":"a","seq":0,"entries":[],"chunks":{},"packs":{}})).unwrap()).unwrap();
    swvol(&source, &["restore", "--plan", empty.to_str().unwrap()]); storage.grant(&source, true);
    let expected = random_bytes(113, 1024 * 1024); fs::write(source.join("data"), &expected).unwrap(); fs::set_permissions(source.join("data"), fs::Permissions::from_mode(0o600)).unwrap(); swvol(&source, &["flush"]);
    let objects = storage.objects.lock().unwrap(); let manifest = swvol_core::decode_manifest(objects.get("/att/a/m/1/1").unwrap(), 1024 * 1024).unwrap();
    let urls = objects.keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect(); drop(objects);
    let plan = swvol_core::RestorePlan { volume: "v".into(), attachment: "a".into(), seq: manifest.seq, entries: manifest.upserts, chunks: manifest.chunks.into_iter().collect(), packs: urls };
    let plan_path = base.join("plan.json"); fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    for path in [base.join("cache"), base.join("faults"), plan_path.clone()] {
        let c = std::ffi::CString::new(path.to_str().unwrap()).unwrap(); assert_eq!(unsafe { libc::chown(c.as_ptr(), 65534, 65534) }, 0);
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    // Root mounts once and retains its guard; only the child consumes INIT.
    let mut bootstrap = fuser::Session::new(MountOnly, base.join("lower"), &[fuser::MountOption::RO, fuser::MountOption::AllowOther, fuser::MountOption::DefaultPermissions, fuser::MountOption::FSName("swvol-unprivileged-test".into())]).unwrap();
    let fd = bootstrap.as_fd().try_clone_to_owned().unwrap(); let raw = fd.as_raw_fd();
    let mut command = Command::new(env!("CARGO_BIN_EXE_swlazy"));
    command.arg("mount-volume").arg(&plan_path).arg(base.join("cache")).arg(base.join("lower")).args(["--cap-mb", "4", "--initial-fuse-fd", &raw.to_string()])
        .env("SWLAZY_UID", "65534").env("SWLAZY_GID", "65534").env("SWVOL_WORKER_TEST_FAULT_DIR", base.join("faults")).uid(65534).gid(65534).stdout(Stdio::null()).stderr(Stdio::inherit());
    unsafe { command.pre_exec(move || { if libc::fcntl(raw, libc::F_SETFD, 0) < 0 { return Err(std::io::Error::last_os_error()); } Ok(()) }); }
    mounts.child = Some(command.spawn().unwrap());
    let dispatch = mounts.child.as_ref().unwrap().id();
    fs::write(base.join("faults/arm-after-download"), b"armed").unwrap();
    let path = base.join("lower/data"); let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || { let _ = tx.send(fs::read(path)); });
    let marker = base.join("faults/observed-after-download"); let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() { assert!(mounts.child.as_mut().unwrap().try_wait().unwrap().is_none(), "unprivileged dispatch exited"); assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10)); }
    let worker: i32 = fs::read_to_string(marker).unwrap().parse().unwrap();
    for pid in [dispatch as i32, worker] {
        let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
        assert_eq!(status.lines().find_map(|line| line.strip_prefix("Uid:")).unwrap().split_whitespace().next().unwrap(), "65534");
        assert_eq!(u64::from_str_radix(status.lines().find_map(|line| line.strip_prefix("CapEff:")).unwrap().trim(), 16).unwrap(), 0);
    }
    assert_eq!(unsafe { libc::kill(worker, libc::SIGKILL) }, 0);
    assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap().unwrap(), expected); reader.join().unwrap();
    assert!(mounts.child.as_mut().unwrap().try_wait().unwrap().is_none());
    bootstrap.unmount(); drop(bootstrap); drop(fd);
    eprintln!("UNPRIVILEGED_FUSE_OK dispatch_uid=65534 worker_uid=65534 effective_caps=0 worker_recovery=true");
}

#[test]
#[ignore = "requires real FUSE plus independent authenticated HTTP control fixture"]
fn independent_control_refreshes_expired_lower_urls_without_changing_inodes() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    struct Process(Child);
    impl Drop for Process { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
    let base = PathBuf::from(format!("/test/swvol-locator-control-{}", std::process::id()));
    let mut mounts = Mounts { base: base.clone(), child: None, overlay: false };
    for dir in ["source", "state", "cache", "lower"] { fs::create_dir_all(base.join(dir)).unwrap(); }
    let state = base.join("state"); fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let source = base.join("source"); let storage = Storage::new();
    let empty = base.join("empty.json"); fs::write(&empty, serde_json::to_vec(&json!({"volume":"v","attachment":"a","seq":0,"entries":[],"chunks":{},"packs":{}})).unwrap()).unwrap();
    swvol(&source, &["restore", "--plan", empty.to_str().unwrap()]); storage.grant(&source, true);
    let expected = random_bytes(59, 1024 * 1024); fs::write(source.join("data"), &expected).unwrap(); swvol(&source, &["flush"]);
    let objects = storage.objects.lock().unwrap(); let manifest = swvol_core::decode_manifest(objects.get("/att/a/m/1/1").unwrap(), 1024 * 1024).unwrap();
    let urls = objects.keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect(); drop(objects);
    let mut plan = swvol_core::RestorePlan { volume: "v".into(), attachment: "a".into(), seq: manifest.seq, entries: manifest.upserts, chunks: manifest.chunks.into_iter().collect(), packs: urls };
    let plan_path = base.join("plan.json"); fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    let sync_binary = std::env::var("SWVOL_SYNC_BIN").unwrap();
    let prepared = Command::new(&sync_binary).args(["restore", "--index-only", "--root"]).arg(&source).arg("--state-dir").arg(&state).arg("--plan").arg(&plan_path).output().unwrap();
    assert!(prepared.status.success(), "{}", String::from_utf8_lossy(&prepared.stdout));
    fs::copy(source.join(".sourceweft/slots.json"), state.join("slots.json")).unwrap();
    let token = format!("svctl_{}", "t".repeat(43));
    *storage.control.lock().unwrap() = Some(ControlPolicy { token: token.clone(), url: storage.url.clone(), chunks: plan.chunks.clone(), packs: plan.packs.clone(), requests: Arc::new(Mutex::new(Vec::new())) });
    fs::write(state.join("control.json"), serde_json::to_vec(&json!({"url":format!("{}/v1/sandbox-volumes/a/control",storage.url),"token":token,"attachment":"a","bootId":fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim()})).unwrap()).unwrap();
    fs::set_permissions(state.join("control.json"), fs::Permissions::from_mode(0o600)).unwrap();
    for (key, url) in &mut plan.packs { *url = format!("{}/expired/{key}", storage.url); }
    fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    mounts.child = Some(Command::new(env!("CARGO_BIN_EXE_swlazy")).arg("mount-volume").arg(&plan_path).arg(base.join("cache")).arg(base.join("lower")).arg("--state-dir").arg(&state).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!(" {} ", base.join("lower").display())) { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10)); }
    let inode = fs::metadata(base.join("lower/data")).unwrap().ino();
    let mut long_command = Process(Command::new("sleep").arg("60").spawn().unwrap());
    let _daemon = Process(Command::new(&sync_binary).args(["daemon", "--control-allow-http", "--root"]).arg(&source).arg("--state-dir").arg(&state).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = fs::read(state.join("read-locators-status.json")).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if status.as_ref().map(|status| status["ok"] == true).unwrap_or(false) { break; }
        assert!(Instant::now() < deadline, "FUSE never applied the independent signed URL update"); std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read(base.join("lower/data")).unwrap(), expected);
    assert_eq!(fs::metadata(base.join("lower/data")).unwrap().ino(), inode);
    assert!(long_command.0.try_wait().unwrap().is_none());
    eprintln!("LOCATOR_REFRESH_OK command_running=true fixed_inode=true expired_url_replaced=true");
}

#[test]
#[ignore = "requires real FUSE and >256-chunk independent authenticated renewal"]
fn six_hundred_chunk_patches_publish_incrementally_and_prioritize_blocked_cold_reads() {
    use std::collections::HashSet;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    struct Process(Child);
    impl Drop for Process { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
    let base = PathBuf::from(format!("/test/swvol-many-locators-{}", std::process::id()));
    let mut mounts = Mounts { base: base.clone(), child: None, overlay: false };
    for dir in ["source", "state", "cache", "lower"] { fs::create_dir_all(base.join(dir)).unwrap(); }
    let state = base.join("state"); fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let source = base.join("source"); let storage = Storage::new();
    let empty = base.join("empty.json"); fs::write(&empty, serde_json::to_vec(&json!({"volume":"v","attachment":"a","seq":0,"entries":[],"chunks":{},"packs":{}})).unwrap()).unwrap();
    swvol(&source, &["restore", "--plan", empty.to_str().unwrap()]); storage.grant(&source, true);
    for index in 0..600 { fs::write(source.join(format!("file-{index:04}")), random_bytes(index + 1, 1024)).unwrap(); }
    swvol(&source, &["flush"]);
    let mut objects = storage.objects.lock().unwrap(); let manifest = swvol_core::decode_manifest(objects.get("/att/a/m/1/1").unwrap(), 1024 * 1024).unwrap();
    let urls = objects.keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect();
    let mut plan = swvol_core::RestorePlan { volume: "v".into(), attachment: "a".into(), seq: manifest.seq, entries: manifest.upserts, chunks: manifest.chunks.into_iter().collect(), packs: urls };
    assert_eq!(plan.chunks.len(), 600);
    // Copy actual sync-produced compressed ranges to immutable repair objects.
    // Each updated ID now needs its own locator patch, rather than one shared
    // pack URL accidentally refreshing all 600 files in the first batch.
    let mut repaired = std::collections::HashMap::new(); let mut repaired_urls = std::collections::HashMap::new();
    for (id, loc) in &plan.chunks {
        let bytes = objects[&format!("/{}", loc.0)][loc.1 as usize..loc.1 as usize + loc.2 as usize].to_vec();
        let key = format!("repair/{id}"); objects.insert(format!("/{key}"), bytes);
        repaired.insert(id.clone(), swvol_core::ChunkLoc(key.clone(), 0, loc.2, loc.3)); repaired_urls.insert(key.clone(), format!("{}/{key}", storage.url));
    }
    drop(objects);
    let plan_path = base.join("plan.json"); fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    let sync_binary = std::env::var("SWVOL_SYNC_BIN").unwrap();
    let prepared = Command::new(&sync_binary).args(["restore", "--index-only", "--root"]).arg(&source).arg("--state-dir").arg(&state).arg("--plan").arg(&plan_path).output().unwrap(); assert!(prepared.status.success());
    fs::copy(source.join(".sourceweft/slots.json"), state.join("slots.json")).unwrap();
    let calls = Arc::new(Mutex::new(Vec::new())); let token = format!("svctl_{}", "u".repeat(43));
    *storage.control.lock().unwrap() = Some(ControlPolicy { token: token.clone(), url: storage.url.clone(), chunks: repaired, packs: repaired_urls, requests: calls.clone() });
    fs::write(state.join("control.json"), serde_json::to_vec(&json!({"url":format!("{}/v1/sandbox-volumes/a/control",storage.url),"token":token,"attachment":"a","bootId":fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim()})).unwrap()).unwrap(); fs::set_permissions(state.join("control.json"), fs::Permissions::from_mode(0o600)).unwrap();
    for (key, url) in &mut plan.packs { *url = format!("{}/expired/{key}", storage.url); }
    fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    mounts.child = Some(Command::new(env!("CARGO_BIN_EXE_swlazy")).arg("mount-volume").arg(&plan_path).arg(base.join("cache")).arg(base.join("lower")).arg("--state-dir").arg(&state).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!(" {} ", base.join("lower").display())) { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10)); }
    let mut ids: Vec<_> = plan.chunks.keys().cloned().collect(); ids.sort();
    let path_for = |id: &str| plan.entries.iter().find(|entry| entry.c.iter().any(|chunk| chunk.0 == id)).unwrap().p.clone();
    let hot = path_for(&ids[0]); let cold = path_for(&ids[599]); let inode = fs::metadata(base.join("lower").join(&cold)).unwrap().ino();
    let mut running = Process(Command::new("sleep").arg("60").spawn().unwrap());
    let _daemon = Process(Command::new(&sync_binary).args(["daemon", "--control-allow-http", "--root"]).arg(&source).arg("--state-dir").arg(&state).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
    let started = Instant::now();
    loop {
        let status = fs::read(state.join("read-locators-status.json")).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if status.as_ref().map(|value| value["ok"] == true).unwrap_or(false) { break; }
        assert!(started.elapsed() < Duration::from_secs(10)); std::thread::sleep(Duration::from_millis(10));
    }
    assert!(calls.lock().unwrap().len() < 3, "first patch must apply before the whole tree was refreshed");
    let expected_hot = fs::read(source.join(&hot)).unwrap(); assert_eq!(fs::read(base.join("lower").join(&hot)).unwrap(), expected_hot);
    // The last sorted ID is outside the next background batch. Its blocked read
    // must cause a priority request and complete without user intervention.
    assert_eq!(fs::read(base.join("lower").join(&cold)).unwrap(), fs::read(source.join(&cold)).unwrap());
    assert!(calls.lock().unwrap()[1].contains(&ids[599]), "cold read was not prioritized ahead of background rotation");
    loop {
        let covered: HashSet<_> = calls.lock().unwrap().iter().flatten().cloned().collect();
        if covered.len() == 600 { break; }
        assert!(started.elapsed() < Duration::from_secs(10), "subset renewal was delayed until a whole-tree interval");
        assert_eq!(fs::read(base.join("lower").join(&hot)).unwrap(), expected_hot);
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(calls.lock().unwrap().iter().all(|batch| batch.len() <= 256));
    assert_eq!(fs::metadata(base.join("lower").join(&cold)).unwrap().ino(), inode);
    assert!(running.0.try_wait().unwrap().is_none());
    eprintln!("LOCATOR_BATCH_RECOVERY_OK chunks=600 first_patch_before_complete=true cold_read_priority=true inode_unchanged=true command_running=true elapsed_ms={}", started.elapsed().as_millis());
}
