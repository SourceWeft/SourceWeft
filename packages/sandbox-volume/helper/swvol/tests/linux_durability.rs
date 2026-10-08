//! Real helper processes, Linux inotify, immutable HTTP objects and eager restore.
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde_json::{json, Value};

type Objects = Arc<Mutex<BTreeMap<String, Vec<u8>>>>;
struct Storage { url: String, objects: Objects, stop: Arc<AtomicBool>, worker: Option<std::thread::JoinHandle<()>> }
impl Storage {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let objects = Arc::new(Mutex::new(BTreeMap::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (data, stopped) = (objects.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &data),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => panic!("HTTP fixture failed: {error}"),
                }
            }
        });
        Self { url, objects, stop, worker: Some(worker) }
    }
    fn grant(&self, root: &PathBuf, enabled: bool) {
        let packs: BTreeMap<_, _> = (0..64).filter(|_| enabled).map(|n| (n.to_string(), format!("{}/att/a/p/{n:06}", self.url))).collect();
        let manifests: BTreeMap<_, _> = (1..65).filter(|_| enabled).map(|n| (n.to_string(), format!("{}/att/a/m/1/{n}", self.url))).collect();
        let bytes = serde_json::to_vec(&json!({"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/1/","packs":packs,"manifests":manifests})).unwrap();
        let tmp = root.join(".sourceweft/slots.new");
        fs::write(&tmp, bytes).unwrap();
        fs::rename(tmp, root.join(".sourceweft/slots.json")).unwrap();
    }
    fn manifests(&self) -> Vec<Value> {
        self.objects.lock().unwrap().iter().filter(|(key, _)| key.contains("/m/")).map(|(_, body)| {
            assert_eq!(&body[..8], b"SWVOLM1\n");
            let offset = 16 + u64::from_le_bytes(body[8..16].try_into().unwrap()) as usize;
            serde_json::from_slice(&zstd::stream::decode_all(&body[offset..]).unwrap()).unwrap()
        }).collect()
    }
}
impl Drop for Storage { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); self.worker.take().unwrap().join().unwrap(); } }
fn serve(mut stream: TcpStream, objects: &Objects) {
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new(); reader.read_line(&mut first).unwrap();
    let mut fields = first.split_whitespace();
    let method = fields.next().unwrap(); let path = fields.next().unwrap().to_owned();
    let mut length = 0;
    loop {
        let mut line = String::new(); reader.read_line(&mut line).unwrap();
        if line == "\r\n" { break; }
        if let Some((key, value)) = line.split_once(':') { if key.eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap(); } }
    }
    let mut body = vec![0; length]; reader.read_exact(&mut body).unwrap();
    let mut map = objects.lock().unwrap();
    let (status, reply) = if method == "PUT" {
        if map.contains_key(&path) { (412, Vec::new()) }
        else { map.insert(path, body); (201, Vec::new()) }
    } else { match map.get(&path) { Some(data) => (200, data.clone()), None => (404, Vec::new()) } };
    write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len()).unwrap();
    stream.write_all(&reply).unwrap();
}
struct Fixture { root: PathBuf, restored: PathBuf, daemon: Option<Child> }
impl Fixture {
    fn new() -> Self {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::var_os("SWVOL_TEST_ROOT").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let root = directory.join(format!("swvol-process-{}-{unique}", std::process::id()));
        let restored = root.with_extension("restore");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".sourceweft-plan"), serde_json::to_vec(&json!({"volume":"v","attachment":"a","seq":0,"entries":[],"chunks":{},"packs":{}})).unwrap()).unwrap();
        let f = Self { root, restored, daemon: None };
        assert!(f.run(&["restore", "--plan", f.root.join(".sourceweft-plan").to_str().unwrap()]).status.success());
        f
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_swvol")).args(args).arg("--root").arg(&self.root).output().unwrap()
    }
    fn start(&mut self) {
        self.daemon = Some(Command::new(env!("CARGO_BIN_EXE_swvol")).args(["daemon", "--root"]).arg(&self.root).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.root.join(".sourceweft/sock").exists() { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10)); }
    }
    fn flush(&self) -> Value {
        let output = self.run(&["flush"]);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
        serde_json::from_slice(&output.stdout).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.daemon.take() { let _ = child.kill(); let _ = child.wait(); }
        let _ = fs::remove_dir_all(&self.root); let _ = fs::remove_dir_all(&self.restored);
    }
}
#[test]
fn deep_changes_survive_barriers_slot_exhaustion_background_scan_and_restore() {
    let store = Storage::new(); let mut f = Fixture::new();
    store.grant(&f.root, true);
    let file = f.root.join("node_modules/pkg/deep/data.txt");
    fs::create_dir_all(file.parent().unwrap()).unwrap(); fs::write(&file, "initial").unwrap();
    f.start(); f.flush();
    fs::write(&file, "after barrier").unwrap();
    let rep = f.flush(); assert_eq!(rep["scope"], "full");
    assert!(store.manifests().iter().any(|m| m["upserts"].as_array().unwrap().iter().any(|e| e["p"] == "node_modules/pkg/deep/data.txt" && e["s"] == 13)));
    store.grant(&f.root, false); fs::write(&file, "after renewed slots").unwrap();
    let failed = f.run(&["flush"]); assert_eq!(failed.status.code(), Some(76));
    let report: Value = serde_json::from_slice(&failed.stdout).unwrap(); assert_eq!(report["exit_code"], 76);
    assert!(f.daemon.as_mut().unwrap().try_wait().unwrap().is_none());
    store.grant(&f.root, true); f.flush();
    let before = store.manifests().len(); fs::write(&file, "background captured").unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while store.manifests().len() == before { assert!(Instant::now() < deadline, "deep write was never captured without a flush"); std::thread::sleep(Duration::from_millis(100)); }
    let mut entries = BTreeMap::new(); let mut chunks = BTreeMap::new(); let mut head = 0;
    let mut manifests = store.manifests(); manifests.sort_by_key(|m| m["seq"].as_u64().unwrap());
    for manifest in manifests {
        head = manifest["seq"].as_u64().unwrap();
        for entry in manifest["upserts"].as_array().unwrap() { entries.insert(entry["p"].as_str().unwrap().to_owned(), entry.clone()); }
        for path in manifest["deletes"].as_array().unwrap() { entries.remove(path.as_str().unwrap()); }
        for (id, loc) in manifest["chunks"].as_object().unwrap() { chunks.insert(id.clone(), loc.clone()); }
    }
    let packs: BTreeMap<_, _> = store.objects.lock().unwrap().keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", store.url))).collect();
    let plan = f.root.join(".sourceweft-restore-plan");
    fs::write(&plan, serde_json::to_vec(&json!({"volume":"v","attachment":"b","seq":head,"entries":entries.values().collect::<Vec<_>>(),"chunks":chunks,"packs":packs})).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_swvol")).arg("restore").arg("--root").arg(&f.restored).arg("--plan").arg(plan).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    assert_eq!(fs::read_to_string(f.restored.join("node_modules/pkg/deep/data.txt")).unwrap(), "background captured");
}

#[test]
fn pending_replay_is_idempotent_after_manifest_upload_crash() {
    let storage = Storage::new(); let f = Fixture::new(); storage.grant(&f.root, true);
    fs::write(f.root.join("durable"), "already uploaded before process died").unwrap();
    let crashed = Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush", "--root"]).arg(&f.root).env("SWVOL_FAULT", "after_manifest_put").output().unwrap();
    assert_eq!(crashed.status.code(), Some(137));
    assert!(f.root.join(".sourceweft/pending.manifest").exists());
    let original = storage.objects.lock().unwrap().get("/att/a/m/1/1").unwrap().clone();
    let reply = f.flush(); assert_eq!(reply["seq"], 1);
    assert!(!f.root.join(".sourceweft/pending.manifest").exists());
    assert_eq!(storage.objects.lock().unwrap().get("/att/a/m/1/1").unwrap(), &original);
    assert_eq!(storage.manifests().len(), 1);
}

#[test]
fn changed_epoch_requires_explicit_rebase_and_archives_crashed_pending() {
    let storage = Storage::new(); let f = Fixture::new(); storage.grant(&f.root, true);
    fs::write(f.root.join("durable"), "preserve me across rejected epoch").unwrap();
    let crashed = Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush", "--root"]).arg(&f.root).env("SWVOL_FAULT", "before_manifest_put").output().unwrap();
    assert_eq!(crashed.status.code(), Some(137));
    let original = fs::read(f.root.join(".sourceweft/pending.manifest")).unwrap();
    let slot_path = f.root.join(".sourceweft/slots.json");
    let mut grant: Value = serde_json::from_slice(&fs::read(&slot_path).unwrap()).unwrap();
    grant["manifest_prefix"] = "att/a/m/2/".into();
    for (seq, url) in grant["manifests"].as_object_mut().unwrap() { *url = format!("{}/att/a/m/2/{seq}", storage.url).into(); }
    fs::write(slot_path, serde_json::to_vec(&grant).unwrap()).unwrap();
    let denied = f.run(&["flush"]); assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stdout).contains("PENDING_EPOCH_MISMATCH"));
    assert!(storage.objects.lock().unwrap().is_empty(), "old pending must not reach the new epoch");
    let rebased = f.run(&["flush", "--rebase", "0"]); assert!(rebased.status.success(), "{}", String::from_utf8_lossy(&rebased.stdout));
    let archive = fs::read_dir(f.root.join(".sourceweft/recovery")).unwrap().next().unwrap().unwrap().path();
    assert_eq!(fs::read(archive).unwrap(), original);
    let manifests = storage.manifests(); assert_eq!(manifests.len(), 1); assert_eq!(manifests[0]["full"], true);
    assert!(storage.objects.lock().unwrap().contains_key("/att/a/m/2/1"));
}


#[test]
#[ignore = "requires a dedicated bounded tmpfs via SWVOL_TEST_ROOT; run explicit ENOSPC acceptance"]
fn real_enospc_keeps_daemon_alive_and_recovers_after_space_is_freed() {
    let storage = Storage::new(); let mut f = Fixture::new();
    let bounded = PathBuf::from(std::env::var("SWVOL_TEST_ROOT").expect("dedicated bounded test tmpfs is required"));
    assert!(f.root.starts_with(&bounded));
    storage.grant(&f.root, true); fs::write(f.root.join("data"), "before storage full").unwrap();
    f.start(); f.flush(); fs::write(f.root.join("data"), "after storage full").unwrap();
    let filler_path = bounded.join("fill-space");
    let mut filler = fs::File::create(&filler_path).unwrap();
    let bytes = vec![0u8; 1024 * 1024];
    loop {
        match filler.write_all(&bytes) {
            Ok(()) => {},
            Err(error) => { assert_eq!(error.raw_os_error(), Some(28)); break; },
        }
    }
    let failed = f.run(&["flush"]);
    // Free space even when an assertion below fails so cleanup cannot deadlock.
    drop(filler); fs::remove_file(filler_path).unwrap();
    assert_eq!(failed.status.code(), Some(78), "{}", String::from_utf8_lossy(&failed.stdout));
    assert!(f.daemon.as_mut().unwrap().try_wait().unwrap().is_none());
    let recovered = f.flush(); assert!(recovered["seq"].as_u64().unwrap() >= 2);
    assert_eq!(fs::read_to_string(f.root.join("data")).unwrap(), "after storage full");
}

#[test]
fn restore_refuses_dirty_target_before_touching_identity_or_following_symlinks() {
    let f = Fixture::new(); let outside = f.root.with_extension("outside"); fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("sentinel"), "outside remains intact").unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join("parent")).unwrap();
    let identity = fs::read(f.root.join(".sourceweft/identity")).unwrap();
    let plan = f.root.join(".sourceweft-attack-plan");
    fs::write(&plan, serde_json::to_vec(&json!({"volume":"v","attachment":"b","seq":0,"entries":[{"p":"parent","k":"d","m":493,"t":"0","s":0},{"p":"parent/sentinel","k":"f","m":384,"t":"0","s":0}],"chunks":{},"packs":{}})).unwrap()).unwrap();
    let output = f.run(&["restore", "--plan", plan.to_str().unwrap()]);
    assert!(!output.status.success()); assert!(String::from_utf8_lossy(&output.stdout).contains("RESTORE_TARGET_NOT_EMPTY"));
    assert_eq!(fs::read_to_string(outside.join("sentinel")).unwrap(), "outside remains intact");
    assert_eq!(fs::read(f.root.join(".sourceweft/identity")).unwrap(), identity);
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn empty_restore_preserves_stock_platform_empty_directories() {
    let f = Fixture::new();
    for name in ["input", "output", "work"] { fs::create_dir(f.root.join(name)).unwrap(); }
    let output = f.run(&["restore", "--plan", f.root.join(".sourceweft-plan").to_str().unwrap()]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    for name in ["input", "output", "work"] {
        assert!(fs::symlink_metadata(f.root.join(name)).unwrap().file_type().is_dir());
        assert_eq!(fs::read_dir(f.root.join(name)).unwrap().count(), 0);
    }
}

#[test]
fn restore_replaces_only_matching_empty_platform_directory() {
    let f = Fixture::new();
    for name in ["input", "output", "work"] { fs::create_dir(f.root.join(name)).unwrap(); }
    let plan = f.root.join(".sourceweft-stock-plan");
    fs::write(&plan, serde_json::to_vec(&json!({"volume":"v","attachment":"b","seq":0,"entries":[{"p":"input","k":"d","m":493,"t":"0","s":0},{"p":"input/restored.txt","k":"f","m":384,"t":"0","s":0}],"chunks":{},"packs":{}})).unwrap()).unwrap();
    let output = f.run(&["restore", "--plan", plan.to_str().unwrap()]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    assert!(f.root.join("input/restored.txt").is_file());
    for name in ["output", "work"] { assert_eq!(fs::read_dir(f.root.join(name)).unwrap().count(), 0); }
}

#[test]
fn restore_preserves_nonempty_or_linked_platform_entries_and_unknown_empty_dirs() {
    let f = Fixture::new();
    let plan = f.root.join(".sourceweft-plan");
    let identity = fs::read(f.root.join(".sourceweft/identity")).unwrap();
    fs::create_dir(f.root.join("input")).unwrap(); fs::write(f.root.join("input/user.txt"), "preserve me").unwrap();
    let output = f.run(&["restore", "--plan", plan.to_str().unwrap()]);
    assert!(!output.status.success());
    assert_eq!(fs::read_to_string(f.root.join("input/user.txt")).unwrap(), "preserve me");
    assert_eq!(fs::read(f.root.join(".sourceweft/identity")).unwrap(), identity);
    fs::remove_file(f.root.join("input/user.txt")).unwrap(); fs::remove_dir(f.root.join("input")).unwrap();
    std::os::unix::fs::symlink(".sourceweft", f.root.join("input")).unwrap();
    let output = f.run(&["restore", "--plan", plan.to_str().unwrap()]);
    assert!(!output.status.success()); assert!(fs::symlink_metadata(f.root.join("input")).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(f.root.join(".sourceweft/identity")).unwrap(), identity);
    fs::remove_file(f.root.join("input")).unwrap(); fs::create_dir(f.root.join("user-empty-directory")).unwrap();
    let output = f.run(&["restore", "--plan", plan.to_str().unwrap()]);
    assert!(!output.status.success()); assert!(f.root.join("user-empty-directory").is_dir());
    assert_eq!(fs::read(f.root.join(".sourceweft/identity")).unwrap(), identity);
}

#[test]
fn restored_publication_metadata_and_symlink_time_do_not_create_a_spurious_commit() {
    use std::os::unix::fs::MetadataExt;
    let storage = Storage::new(); let f = Fixture::new(); storage.grant(&f.root, true);
    fs::write(f.root.join("file"), "published content").unwrap(); fs::create_dir(f.root.join("nested")).unwrap(); fs::write(f.root.join("nested/file"), "nested content").unwrap();
    std::os::unix::fs::symlink("file", f.root.join("link")).unwrap();
    let timestamp = filetime::FileTime::from_unix_time(1_600_000_000, 123_456_789);
    filetime::set_symlink_file_times(f.root.join("link"), timestamp, timestamp).unwrap();
    f.flush();
    let manifest = storage.manifests().into_iter().max_by_key(|manifest| manifest["seq"].as_u64().unwrap()).unwrap();
    let head = manifest["seq"].as_u64().unwrap();
    let packs: BTreeMap<_, _> = storage.objects.lock().unwrap().keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect();
    let plan = f.root.join(".sourceweft-publication-plan");
    fs::write(&plan, serde_json::to_vec(&json!({"volume":"v","attachment":"b","seq":head,"entries":manifest["upserts"],"chunks":manifest["chunks"],"packs":packs})).unwrap()).unwrap();
    let restored = Command::new(env!("CARGO_BIN_EXE_swvol")).arg("restore").arg("--root").arg(&f.restored).arg("--plan").arg(&plan).output().unwrap();
    assert!(restored.status.success(), "{}", String::from_utf8_lossy(&restored.stdout));
    let link = fs::symlink_metadata(f.restored.join("link")).unwrap();
    assert_eq!(link.mtime() * 1_000_000_000 + link.mtime_nsec(), 1_600_000_000_123_456_789);
    // No slots are available: a correct unchanged flush needs no new object.
    fs::write(f.restored.join(".sourceweft/slots.json"), serde_json::to_vec(&json!({"volume":"v","attachment":"b","pack_prefix":"att/b/p/","manifest_prefix":"att/b/m/1/","packs":{},"manifests":{}})).unwrap()).unwrap();
    let flushed = Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush", "--full", "--root"]).arg(&f.restored).output().unwrap();
    assert!(flushed.status.success(), "{}", String::from_utf8_lossy(&flushed.stdout));
    let report: Value = serde_json::from_slice(&flushed.stdout).unwrap();
    assert_eq!(report["seq"], head); assert_eq!(report["upserts"], 0); assert_eq!(report["deletes"], 0); assert_eq!(report["committed"], false);
    assert_eq!(storage.manifests().len(), 1);
}
