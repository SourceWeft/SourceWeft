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
        let bytes = serde_json::to_vec(&json!({"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/1/","packs":packs,"manifests":manifests,"manifest_reads":manifests})).unwrap();
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
    let mut first = String::new();
    match reader.read_line(&mut first) { Ok(0) => return, Ok(_) => {}, Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => return, Err(error) => panic!("fixture request header: {error}") }
    let mut fields = first.split_whitespace();
    let method = fields.next().unwrap(); let path = fields.next().unwrap().to_owned();
    let mut length = 0;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) { Ok(0) => return, Ok(_) => {}, Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => return, Err(error) => panic!("fixture request header: {error}") }
        if line == "\r\n" { break; }
        if let Some((key, value)) = line.split_once(':') { if key.eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap(); } }
    }
    let mut body = vec![0; length];
    if let Err(error) = reader.read_exact(&mut body) { assert!(matches!(error.kind(), std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset), "fixture body read: {error}"); return; }
    let mut map = objects.lock().unwrap();
    let (status, reply) = if method == "PUT" {
        if map.contains_key(&path) { (412, Vec::new()) }
        else { map.insert(path, body); (201, Vec::new()) }
    } else { match map.get(&path) { Some(data) => (200, data.clone()), None => (404, Vec::new()) } };
    let sent = (|| -> std::io::Result<()> { write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len())?; stream.write_all(&reply) })();
    if let Err(error) = sent { assert!(matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset), "fixture response: {error}"); }
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
    let original_capture_scope = fs::read(f.root.join(".sourceweft/capture/scope.json")).unwrap();
    let slot_path = f.root.join(".sourceweft/slots.json");
    let mut grant: Value = serde_json::from_slice(&fs::read(&slot_path).unwrap()).unwrap();
    grant["manifest_prefix"] = "att/a/m/2/".into();
    for (seq, url) in grant["manifests"].as_object_mut().unwrap() { *url = format!("{}/att/a/m/2/{seq}", storage.url).into(); }
    for (seq, url) in grant["manifest_reads"].as_object_mut().unwrap() { *url = format!("{}/att/a/m/2/{seq}", storage.url).into(); }
    fs::write(slot_path, serde_json::to_vec(&grant).unwrap()).unwrap();
    let denied = f.run(&["flush"]); assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stdout).contains("PENDING_EPOCH_MISMATCH"));
    assert!(storage.objects.lock().unwrap().is_empty(), "old pending must not reach the new epoch");
    let rebased = f.run(&["flush", "--rebase", "0"]); assert!(rebased.status.success(), "{}", String::from_utf8_lossy(&rebased.stdout));
    let archives: Vec<_> = fs::read_dir(f.root.join(".sourceweft/recovery")).unwrap().map(|entry| entry.unwrap().path()).collect();
    let pending: Vec<_> = archives.iter().filter(|path| path.is_file() && path.file_name().unwrap().to_str().unwrap().starts_with("pending-")).collect();
    assert_eq!(pending.len(), 1); assert_eq!(fs::read(pending[0]).unwrap(), original);
    let captures: Vec<_> = archives.iter().filter(|path| path.is_dir() && path.file_name().unwrap().to_str().unwrap().starts_with("capture-rebase-")).collect();
    assert_eq!(captures.len(), 1); assert_eq!(fs::read(captures[0].join("scope.json")).unwrap(), original_capture_scope);
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

#[test]
fn distinct_non_utf8_names_never_collapse_into_a_confirmed_lossy_path() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    let storage = Storage::new(); let f = Fixture::new(); storage.grant(&f.root, true);
    let first = f.root.join(OsString::from_vec(vec![b'x', 0xff]));
    let second = f.root.join(OsString::from_vec(vec![b'x', 0xfe]));
    let unicode = f.root.join("x\u{fffd}");
    fs::write(&first, b"invalid ff remains separate").unwrap(); fs::write(&second, b"invalid fe remains separate").unwrap(); fs::write(&unicode, b"real UTF-8 replacement character").unwrap();
    let state_before = fs::read(f.root.join(".sourceweft/state.bin")).unwrap();
    for args in [&["flush", "--full"][..], &["treehash"][..]] {
        let output = f.run(args);
        assert!(!output.status.success(), "unsupported bytes must fail instead of acknowledging a lossy tree");
        let report: Value = serde_json::from_slice(&output.stdout).unwrap(); assert_eq!(report["ok"], false);
        assert!(report["error"].as_str().unwrap().contains("non-UTF-8"));
    }
    assert!(storage.objects.lock().unwrap().is_empty(), "an incomplete snapshot must not create a manifest");
    assert_eq!(fs::read(f.root.join(".sourceweft/state.bin")).unwrap(), state_before);
    assert_eq!(fs::read(first).unwrap(), b"invalid ff remains separate");
    assert_eq!(fs::read(second).unwrap(), b"invalid fe remains separate");
    assert_eq!(fs::read(unicode).unwrap(), b"real UTF-8 replacement character");
}

#[test]
#[ignore = "resource-bounded Linux stress: seed 0x48de1200, 12000x4KiB files, depth48, 2048 mutations; run with 2CPU/512MiB/tmpfs256MiB"]
fn deep_heavy_tree_concurrent_mutations_and_manifest_crash_restore_exactly() {
    use std::os::unix::fs::{PermissionsExt, MetadataExt};
    const SEED: u32 = 0x48de_1200;
    const FILES: usize = 12_000;
    const BUCKETS: usize = 120;
    const DEPTH: usize = 48;
    const MUTATIONS: usize = 2_048;
    fn bytes(index: usize, revision: usize) -> Vec<u8> {
        let mut state = SEED ^ (index as u32).wrapping_mul(0x9e37_79b9) ^ (revision as u32).wrapping_mul(0x85eb_ca6b);
        (0..4096).map(|_| { state ^= state << 13; state ^= state >> 17; state ^= state << 5; state as u8 }).collect()
    }
    let storage = Storage::new(); let mut f = Fixture::new(); storage.grant(&f.root, true);
    let started = Instant::now();
    let mut parents = Vec::new();
    for bucket in 0..BUCKETS {
        let mut path = format!("node_modules/pkg-{bucket:03}");
        for depth in 0..DEPTH { path.push_str(&format!("/d{depth:02}")); }
        fs::create_dir_all(f.root.join(&path)).unwrap(); parents.push(path);
    }
    let mut names = Vec::new();
    let mut expected = BTreeMap::<String, (String, u32)>::new();
    for index in 0..FILES {
        let name = format!("{}/file-{index:05}", parents[index % BUCKETS]); let data = bytes(index, 0);
        fs::write(f.root.join(&name), &data).unwrap(); fs::set_permissions(f.root.join(&name), fs::Permissions::from_mode(0o640)).unwrap();
        expected.insert(name.clone(), (blake3::hash(&data).to_hex().to_string(), 0o640)); names.push(name);
    }
    eprintln!("DEEP_PHASE populated_ms={}", started.elapsed().as_millis());
    f.start(); f.flush();
    eprintln!("DEEP_PHASE initial_capture_ms={}", started.elapsed().as_millis());
    let source = f.root.clone();
    let changed = std::thread::spawn(move || {
        let mut seed = SEED;
        let mut recreated = 0;
        for operation in 0..MUTATIONS {
            seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
            let index = seed as usize % FILES; let name = names[index].clone();
            if operation % 4 != 0 && !expected.contains_key(&name) {
                let data = bytes(index, operation + 1); fs::write(source.join(&name), &data).unwrap();
                fs::set_permissions(source.join(&name), fs::Permissions::from_mode(0o640)).unwrap();
                expected.insert(name.clone(), (blake3::hash(&data).to_hex().to_string(), 0o640)); recreated += 1;
            }
            match operation % 4 {
                0 => {
                    let data = bytes(index, operation + 1); fs::write(source.join(&name), &data).unwrap();
                    fs::set_permissions(source.join(&name), fs::Permissions::from_mode(0o640)).unwrap();
                    expected.insert(name, (blake3::hash(&data).to_hex().to_string(), 0o640));
                }
                1 if expected.contains_key(&name) => {
                    let target = format!("{}/renamed-{index:05}-{operation}", parents[index % BUCKETS]);
                    fs::rename(source.join(&name), source.join(&target)).unwrap();
                    let value = expected.remove(&name).unwrap(); expected.insert(target.clone(), value); names[index] = target;
                }
                2 if expected.contains_key(&name) => { fs::remove_file(source.join(&name)).unwrap(); expected.remove(&name); },
                3 if expected.contains_key(&name) => { fs::set_permissions(source.join(&name), fs::Permissions::from_mode(0o600)).unwrap(); expected.get_mut(&name).unwrap().1 = 0o600; },
                _ => {},
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        (expected, recreated)
    });
    let mut transient_failures = 0;
    for _ in 0..3 {
        let output = f.run(&["flush", "--full"]);
        if !output.status.success() { assert_eq!(output.status.code(), Some(1), "{}", String::from_utf8_lossy(&output.stdout)); transient_failures += 1; }
    }
    let (mut expected, recreated) = changed.join().unwrap(); f.flush();
    eprintln!("DEEP_PHASE settled_capture_ms={}", started.elapsed().as_millis());
    // Exercise a real interrupted publication after a stable concurrent run.
    if let Some(mut daemon) = f.daemon.take() { daemon.kill().unwrap(); daemon.wait().unwrap(); }
    let last = "final-after-crash"; let last_data = bytes(99_999, 7); fs::write(f.root.join(last), &last_data).unwrap();
    fs::set_permissions(f.root.join(last), fs::Permissions::from_mode(0o640)).unwrap(); expected.insert(last.into(), (blake3::hash(&last_data).to_hex().to_string(), 0o640));
    let crashed = Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush", "--root"]).arg(&f.root).env("SWVOL_FAULT", "after_manifest_put").output().unwrap();
    assert_eq!(crashed.status.code(), Some(137), "{}", String::from_utf8_lossy(&crashed.stdout)); f.flush();
    let mut entries = BTreeMap::new(); let mut chunks = BTreeMap::new(); let mut head = 0;
    let mut manifests = storage.manifests(); manifests.sort_by_key(|manifest| manifest["seq"].as_u64().unwrap());
    for manifest in manifests {
        head = manifest["seq"].as_u64().unwrap();
        for entry in manifest["upserts"].as_array().unwrap() { entries.insert(entry["p"].as_str().unwrap().to_owned(), entry.clone()); }
        for path in manifest["deletes"].as_array().unwrap() { entries.remove(path.as_str().unwrap()); }
        for (id, loc) in manifest["chunks"].as_object().unwrap() { chunks.insert(id.clone(), loc.clone()); }
    }
    let packs: BTreeMap<_, _> = storage.objects.lock().unwrap().keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect();
    let plan = f.root.join(".sourceweft-stress-plan"); fs::write(&plan, serde_json::to_vec(&json!({"volume":"v","attachment":"b","seq":head,"entries":entries.values().collect::<Vec<_>>(),"chunks":chunks,"packs":packs})).unwrap()).unwrap();
    eprintln!("DEEP_PHASE before_restore_ms={}", started.elapsed().as_millis());
    let restored = Command::new(env!("CARGO_BIN_EXE_swvol")).arg("restore").arg("--root").arg(&f.restored).arg("--plan").arg(plan).output().unwrap();
    assert!(restored.status.success(), "{}", String::from_utf8_lossy(&restored.stdout));
    eprintln!("DEEP_PHASE restored_ms={}", started.elapsed().as_millis());
    let mut actual = BTreeMap::new(); let mut pending = vec![f.restored.clone()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).unwrap() {
            let entry = entry.unwrap(); if directory == f.restored && entry.file_name() == ".sourceweft" { continue; }
            if entry.file_type().unwrap().is_dir() { pending.push(entry.path()); }
            else { let path = entry.path(); let name = path.strip_prefix(&f.restored).unwrap().to_str().unwrap().to_owned(); let data = fs::read(&path).unwrap(); actual.insert(name, (blake3::hash(&data).to_hex().to_string(), fs::metadata(path).unwrap().mode() & 0o7777)); }
        }
    }
    assert_eq!(actual, expected, "restored tree must match the independent mutation ledger");
    for name in entries.keys() {
        let source = fs::symlink_metadata(f.root.join(name)).unwrap();
        let restored = fs::symlink_metadata(f.restored.join(name)).unwrap();
        assert_eq!((restored.mode() & 0o7777, restored.mtime(), restored.mtime_nsec()),
            (source.mode() & 0o7777, source.mtime(), source.mtime_nsec()), "full metadata differs at {name}");
    }
    let peak = fs::read_to_string("/sys/fs/cgroup/memory.peak").ok().map(|value| value.trim().to_owned());
    eprintln!("DEEP_CAPTURE_RESULT seed={SEED:#x} initial_files={FILES} file_bytes=4096 buckets={BUCKETS} depth={DEPTH} mutation_steps={MUTATIONS} recreated_deleted_paths={recreated} final_files={} transient_capture_errors={transient_failures} cpu_limit=2 memory_limit_mib=512 tmpfs_mib=256 memory_peak_bytes={peak:?} elapsed_ms={}", actual.len(), started.elapsed().as_millis());
    assert!(started.elapsed() < Duration::from_secs(180), "resource-bounded scenario exceeded the declared 180-second budget");
}


#[test]
fn treehash_and_capture_refuse_non_utf8_link_targets_without_bad_filenames() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    let storage = Storage::new(); let f = Fixture::new(); storage.grant(&f.root, true);
    std::os::unix::fs::symlink(OsString::from_vec(vec![b'x', 0xff]), f.root.join("link-ff")).unwrap();
    std::os::unix::fs::symlink(OsString::from_vec(vec![b'x', 0xfe]), f.root.join("link-fe")).unwrap();
    let before = fs::read(f.root.join(".sourceweft/state.bin")).unwrap();
    for args in [&["treehash"][..], &["flush", "--full"][..]] {
        let output = f.run(args); assert!(!output.status.success());
        let report: Value = serde_json::from_slice(&output.stdout).unwrap(); assert_eq!(report["ok"], false);
        assert!(report["error"].as_str().unwrap().contains("non-UTF-8"));
    }
    assert!(storage.objects.lock().unwrap().is_empty()); assert_eq!(fs::read(f.root.join(".sourceweft/state.bin")).unwrap(), before);
    assert_eq!(fs::read_link(f.root.join("link-ff")).unwrap().into_os_string().into_vec(), vec![b'x', 0xff]);
    assert_eq!(fs::read_link(f.root.join("link-fe")).unwrap().into_os_string().into_vec(), vec![b'x', 0xfe]);
}


#[test]
fn framed_treehash_distinguishes_delimiters_and_preserved_symlink_metadata() {
    let f = Fixture::new(); fs::create_dir_all(&f.restored).unwrap();
    std::os::unix::fs::symlink("b -> c", f.root.join("a")).unwrap();
    std::os::unix::fs::symlink("c", f.restored.join("a -> b")).unwrap();
    let timestamp = filetime::FileTime::from_unix_time(1_600_000_000, 123_456_789);
    filetime::set_symlink_file_times(f.root.join("a"), timestamp, timestamp).unwrap();
    filetime::set_symlink_file_times(f.restored.join("a -> b"), timestamp, timestamp).unwrap();
    let first: Value = serde_json::from_slice(&f.run(&["treehash"]).stdout).unwrap();
    let other = Command::new(env!("CARGO_BIN_EXE_swvol")).args(["treehash", "--root"]).arg(&f.restored).output().unwrap();
    let second: Value = serde_json::from_slice(&other.stdout).unwrap();
    assert_eq!(first["treehash_version"], 2); assert_eq!(first["algorithm"], "blake3-framed-json-v2");
    assert_ne!(first["treehash"], second["treehash"], "unambiguous fields must distinguish valid names/targets");
    let later = filetime::FileTime::from_unix_time(1_600_000_001, 123_456_789);
    filetime::set_symlink_file_times(f.root.join("a"), later, later).unwrap();
    let third: Value = serde_json::from_slice(&f.run(&["treehash"]).stdout).unwrap();
    assert_ne!(first["treehash"], third["treehash"], "the oracle must include persisted symlink mtime");
}

#[test]
fn directory_mtime_touch_is_committed_and_restored_exactly() {
    use std::os::unix::fs::MetadataExt;
    let storage = Storage::new(); let f = Fixture::new(); storage.grant(&f.root, true);
    fs::create_dir(f.root.join("directory")).unwrap(); fs::write(f.root.join("directory/data"), "stable child content").unwrap(); f.flush();
    let before: Value = serde_json::from_slice(&f.run(&["treehash"]).stdout).unwrap();
    let timestamp = filetime::FileTime::from_unix_time(1_600_000_042, 987_654_321);
    filetime::set_file_mtime(f.root.join("directory"), timestamp).unwrap();
    let after: Value = serde_json::from_slice(&f.run(&["treehash"]).stdout).unwrap();
    assert_ne!(before["treehash"], after["treehash"], "treehash must verify directory mtime");
    let report = f.flush(); assert_eq!(report["committed"], true, "a directory-only mtime change must be captured");
    let mut entries = BTreeMap::new(); let mut chunks = BTreeMap::new(); let mut head = 0;
    let mut manifests = storage.manifests(); manifests.sort_by_key(|manifest| manifest["seq"].as_u64().unwrap());
    for manifest in manifests {
        head = manifest["seq"].as_u64().unwrap();
        for entry in manifest["upserts"].as_array().unwrap() { entries.insert(entry["p"].as_str().unwrap().to_owned(), entry.clone()); }
        for (id, loc) in manifest["chunks"].as_object().unwrap() { chunks.insert(id.clone(), loc.clone()); }
    }
    assert_eq!(entries["directory"]["t"], "1600000042987654321");
    let packs: BTreeMap<_, _> = storage.objects.lock().unwrap().keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect();
    let plan = f.root.join(".sourceweft-directory-time-plan"); fs::write(&plan, serde_json::to_vec(&json!({"volume":"v","attachment":"b","seq":head,"entries":entries.values().collect::<Vec<_>>(),"chunks":chunks,"packs":packs})).unwrap()).unwrap();
    let restored = Command::new(env!("CARGO_BIN_EXE_swvol")).arg("restore").arg("--root").arg(&f.restored).arg("--plan").arg(plan).output().unwrap(); assert!(restored.status.success(), "{}", String::from_utf8_lossy(&restored.stdout));
    let metadata = fs::metadata(f.restored.join("directory")).unwrap();
    assert_eq!(metadata.mtime() * 1_000_000_000 + metadata.mtime_nsec(), 1_600_000_042_987_654_321);
    assert_eq!(fs::read_to_string(f.restored.join("directory/data")).unwrap(), "stable child content");
    fs::write(f.restored.join(".sourceweft/slots.json"), serde_json::to_vec(&json!({"volume":"v","attachment":"b","pack_prefix":"att/b/p/","manifest_prefix":"att/b/m/1/","packs":{},"manifests":{}})).unwrap()).unwrap();
    let unchanged = Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush", "--full", "--root"]).arg(&f.restored).output().unwrap(); assert!(unchanged.status.success(), "{}", String::from_utf8_lossy(&unchanged.stdout));
    let unchanged: Value = serde_json::from_slice(&unchanged.stdout).unwrap(); assert_eq!(unchanged["seq"], head); assert_eq!(unchanged["committed"], false);
}

#[test]
#[ignore = "requires dedicated Linux tmpfs via SWVOL_TEST_ROOT to preserve the full signed-i64 nanosecond range"]
fn signed_timestamp_boundaries_roundtrip_and_out_of_range_never_confirm() {
    use std::os::unix::fs::MetadataExt;
    fn timestamp(ns: i128) -> filetime::FileTime { filetime::FileTime::from_unix_time(ns.div_euclid(1_000_000_000).try_into().unwrap(), ns.rem_euclid(1_000_000_000) as u32) }
    fn actual(path: &std::path::Path) -> i128 { let md = fs::symlink_metadata(path).unwrap(); md.mtime() as i128 * 1_000_000_000 + md.mtime_nsec() as i128 }
    assert!(std::env::var_os("SWVOL_TEST_ROOT").is_some(), "run on a dedicated tmpfs");
    let storage = Storage::new(); let f = Fixture::new(); storage.grant(&f.root, true);
    let cases = [("min", i64::MIN as i128), ("max", i64::MAX as i128), ("negative", -1i128)];
    for (name, ns) in cases {
        fs::write(f.root.join(name), name).unwrap(); filetime::set_file_mtime(f.root.join(name), timestamp(ns)).unwrap();
        assert_eq!(actual(&f.root.join(name)), ns, "filesystem must support the requested boundary");
    }
    fs::create_dir(f.root.join("directory")).unwrap(); filetime::set_file_mtime(f.root.join("directory"), timestamp(i64::MIN as i128)).unwrap();
    std::os::unix::fs::symlink("negative", f.root.join("link")).unwrap(); filetime::set_symlink_file_times(f.root.join("link"), timestamp(-1), timestamp(-1)).unwrap();
    f.flush();
    let manifest = storage.manifests().pop().unwrap();
    for (name, ns) in cases { let entry = manifest["upserts"].as_array().unwrap().iter().find(|entry| entry["p"] == name).unwrap(); assert_eq!(entry["t"], ns.to_string()); }
    let packs: BTreeMap<_, _> = storage.objects.lock().unwrap().keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect();
    let plan = f.root.join(".sourceweft-time-plan"); fs::write(&plan, serde_json::to_vec(&json!({"volume":"v","attachment":"b","seq":1,"entries":manifest["upserts"],"chunks":manifest["chunks"],"packs":packs})).unwrap()).unwrap();
    let restored = Command::new(env!("CARGO_BIN_EXE_swvol")).arg("restore").arg("--root").arg(&f.restored).arg("--plan").arg(plan).output().unwrap(); assert!(restored.status.success(), "{}", String::from_utf8_lossy(&restored.stdout));
    for (name, ns) in cases { assert_eq!(actual(&f.restored.join(name)), ns); assert_eq!(fs::read_to_string(f.restored.join(name)).unwrap(), name); }
    assert_eq!(actual(&f.restored.join("directory")), i64::MIN as i128); assert_eq!(actual(&f.restored.join("link")), -1);
    for ns in [i64::MAX as i128 + 1, i64::MIN as i128 - 1] {
        let before = fs::read(f.root.join(".sourceweft/state.bin")).unwrap(); let manifests = storage.manifests().len();
        filetime::set_file_mtime(f.root.join("negative"), timestamp(ns)).unwrap(); assert_eq!(actual(&f.root.join("negative")), ns);
        let output = f.run(&["flush", "--full"]); assert_eq!(output.status.code(), Some(1), "out-of-range timestamp must fail: {}", String::from_utf8_lossy(&output.stdout));
        let error: Value = serde_json::from_slice(&output.stdout).unwrap(); assert!(error["error"].as_str().unwrap().contains("timestamp outside signed-i64 nanosecond range"), "{error}");
        assert_eq!(fs::read(f.root.join(".sourceweft/state.bin")).unwrap(), before); assert_eq!(storage.manifests().len(), manifests);
        assert_eq!(actual(&f.root.join("negative")), ns); assert_eq!(fs::read_to_string(f.root.join("negative")).unwrap(), "negative");
    }
    eprintln!("SIGNED_TIMESTAMP_OK min={} max={} before_epoch=-1 beyond_min_rejected=true beyond_max_rejected=true original_preserved=true", i64::MIN, i64::MAX);
}

#[test]
fn restore_refuses_ready_identity_when_filesystem_clamps_requested_mtime() {
    use std::os::unix::fs::MetadataExt;
    for kind in ['f', 'd', 'l'] {
        let f = Fixture::new(); let probe = f.root.join("timestamp-capability-probe"); fs::write(&probe, "probe").unwrap();
        let requested = i64::MIN;
        filetime::set_file_mtime(&probe, filetime::FileTime::from_unix_time(requested.div_euclid(1_000_000_000), requested.rem_euclid(1_000_000_000) as u32)).unwrap();
        let md = fs::metadata(&probe).unwrap(); let supported = md.mtime() as i128 * 1_000_000_000 + md.mtime_nsec() as i128 == requested as i128;
        let plan = f.root.join(".sourceweft-clamping-plan"); let bytes = serde_json::to_vec(&json!({"volume":"v","attachment":"b","seq":1,"entries":[{"p":"entry","k":kind,"m":if kind=='l' {0o777} else {0o700},"t":requested.to_string(),"s":0,"l":if kind=='l' {Some("untouched-target")} else {None},"c":[]}],"chunks":{},"packs":{}})).unwrap(); fs::write(&plan, &bytes).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_swvol")).arg("restore").arg("--root").arg(&f.restored).arg("--plan").arg(&plan).output().unwrap();
        assert!(!supported, "this fixture requires the pinned builder overlay timestamp limit; use the separate tmpfs test for full-range support");
            assert_eq!(output.status.code(), Some(1), "clamped {kind} must never be declared ready: {}", String::from_utf8_lossy(&output.stdout));
            let error: Value = serde_json::from_slice(&output.stdout).unwrap(); assert!(error["error"].as_str().unwrap().contains("filesystem cannot preserve requested mtime"), "{error}");
            assert!(!f.restored.join(".sourceweft/identity").exists()); assert!(!f.restored.join(".sourceweft/state.bin").exists());
            assert!(f.restored.join("entry").symlink_metadata().is_ok(), "failed restore content remains inspectable");
        assert_eq!(fs::read(&plan).unwrap(), bytes);
        eprintln!("RESTORE_MTIME_CAPABILITY kind={kind} full_i64_supported={supported} false_ready=false");
    }
}

#[test]
fn restore_refuses_ready_identity_for_unrepresentable_symlink_mode() {
    let f = Fixture::new();
    let plan = f.root.join(".sourceweft-link-mode-plan");
    fs::write(&plan, serde_json::to_vec(&json!({"volume":"v","attachment":"b","seq":1,"entries":[{"p":"link","k":"l","m":0o600,"t":"0","s":0,"l":"untouched-target","c":[]}],"chunks":{},"packs":{}})).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_swvol")).arg("restore").arg("--root").arg(&f.restored).arg("--plan").arg(plan).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    let error: Value = serde_json::from_slice(&output.stdout).unwrap(); assert!(error["error"].as_str().unwrap().contains("filesystem cannot preserve requested mode"), "{error}");
    assert!(!f.restored.join(".sourceweft/identity").exists()); assert!(!f.restored.join(".sourceweft/state.bin").exists());
    assert_eq!(fs::read_link(f.restored.join("link")).unwrap(), std::path::Path::new("untouched-target"));
}

fn receipt_fixture_data() -> Vec<u8> {
    let mut seed=0x2280_0300u32;
    (0..20*1024*1024).map(|_| { seed^=seed<<13; seed^=seed>>17; seed^=seed<<5; seed as u8 }).collect()
}
#[test]
fn failed_pack_put_never_creates_a_reusable_receipt() {
    let storage=Storage::new(); let f=Fixture::new(); storage.grant(&f.root,true);
    storage.objects.lock().unwrap().insert("/att/a/p/000000".into(),b"occupied immutable object".to_vec());
    fs::write(f.root.join("data"),receipt_fixture_data()).unwrap();
    let before=fs::read(f.root.join(".sourceweft/state.bin")).unwrap();
    let output=f.run(&["flush","--full"]); assert_eq!(output.status.code(),Some(1));
    assert!(String::from_utf8_lossy(&output.stdout).contains("PACK_SLOT_TAKEN"));
    assert!(!f.root.join(".sourceweft/capture/pack-000000.json").exists());
    assert_eq!(fs::read(f.root.join(".sourceweft/state.bin")).unwrap(),before);
    assert_eq!(f.flush()["committed"],true);
    for manifest in storage.manifests() { for loc in manifest["chunks"].as_object().unwrap().values() { assert_ne!(loc[0],"att/a/p/000000"); } }
    assert_eq!(storage.objects.lock().unwrap()["/att/a/p/000000"],b"occupied immutable object");
}
#[test]
fn uploaded_receipts_survive_process_crash_before_any_manifest() {
    let storage=Storage::new(); let f=Fixture::new(); storage.grant(&f.root,true);
    fs::write(f.root.join("data"),receipt_fixture_data()).unwrap();
    let before=fs::read(f.root.join(".sourceweft/state.bin")).unwrap();
    let output=Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush","--full","--root"]).arg(&f.root).env("SWVOL_FAULT","after_capture_receipt").output().unwrap();
    assert_eq!(output.status.code(),Some(137)); assert!(String::from_utf8_lossy(&output.stderr).contains("injected fault at after_capture_receipt"));
    assert!(storage.manifests().is_empty()); assert_eq!(fs::read(f.root.join(".sourceweft/state.bin")).unwrap(),before);
    let mut recorded=BTreeMap::new();
    for entry in fs::read_dir(f.root.join(".sourceweft/capture")).unwrap() {
        let entry=entry.unwrap(); if !entry.file_name().to_str().unwrap().starts_with("pack-") {continue;}
        let value:Value=serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
        for (id,loc) in value["body"]["chunks"].as_object().unwrap() {recorded.insert(id.clone(),loc.clone());}
    }
    assert!(!recorded.is_empty()); assert_eq!(f.flush()["committed"],true);
    let manifests=storage.manifests(); assert_eq!(manifests.len(),1);
    for (id,loc) in recorded {assert_eq!(manifests[0]["chunks"][&id],loc,"durable receipt must be reused, not reuploaded to another key");}
    assert!(!f.root.join(".sourceweft/capture").exists());
}

#[test]
fn conflicting_manifest_recovery_never_confirms_different_local_bytes() {
    let storage=Storage::new(); let first=Fixture::new(); storage.grant(&first.root,true);
    fs::write(first.root.join("data"),"remote version A").unwrap(); assert_eq!(first.flush()["seq"],1);
    let remote=storage.objects.lock().unwrap()["/att/a/m/1/1"].clone();
    let second=Fixture::new(); storage.grant(&second.root,true);
    fs::write(second.root.join("data"),"unconfirmed local version B").unwrap();
    let before=fs::read(second.root.join(".sourceweft/state.bin")).unwrap();
    let rejected=second.run(&["flush","--full"]); assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stdout).contains("MANIFEST_SLOT_TAKEN"));
    let pending=fs::read(second.root.join(".sourceweft/pending.manifest")).unwrap();
    let recovered=second.run(&["flush","--full"]);
    assert!(!recovered.status.success(),"different bytes must never become locally confirmed merely because PUT returns 412: {}",String::from_utf8_lossy(&recovered.stdout));
    assert_eq!(fs::read(second.root.join(".sourceweft/state.bin")).unwrap(),before);
    assert_eq!(fs::read(second.root.join(".sourceweft/pending.manifest")).unwrap(),pending);
    assert_eq!(storage.objects.lock().unwrap()["/att/a/m/1/1"],remote);
    assert_eq!(fs::read_to_string(second.root.join("data")).unwrap(),"unconfirmed local version B");
}

#[test]
fn pending_recovery_matches_existing_bytes_with_only_a_read_slot() {
    let storage=Storage::new(); let f=Fixture::new(); storage.grant(&f.root,true); fs::write(f.root.join("data"),"lost acknowledgement").unwrap();
    let crashed=Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush","--root"]).arg(&f.root).env("SWVOL_FAULT","after_manifest_put").output().unwrap(); assert_eq!(crashed.status.code(),Some(137));
    let path=f.root.join(".sourceweft/slots.json"); let mut slots:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap(); slots["manifests"].as_object_mut().unwrap().remove("1"); fs::write(&path,serde_json::to_vec(&slots).unwrap()).unwrap();
    assert_eq!(f.flush()["seq"],1); assert!(!f.root.join(".sourceweft/pending.manifest").exists()); assert_eq!(storage.manifests().len(),1);
}
#[test]
fn pending_verification_missing_read_slot_stays_unconfirmed_without_empty_progress() {
    let storage=Storage::new(); let f=Fixture::new(); storage.grant(&f.root,true); fs::write(f.root.join("data"),"lost acknowledgement").unwrap();
    let crashed=Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush","--root"]).arg(&f.root).env("SWVOL_FAULT","after_manifest_put").output().unwrap(); assert_eq!(crashed.status.code(),Some(137));
    let before=fs::read(f.root.join(".sourceweft/state.bin")).unwrap(); let pending=fs::read(f.root.join(".sourceweft/pending.manifest")).unwrap();
    let path=f.root.join(".sourceweft/slots.json"); let mut slots:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap(); slots.as_object_mut().unwrap().remove("manifest_reads"); fs::write(&path,serde_json::to_vec(&slots).unwrap()).unwrap();
    let result=f.run(&["flush"]); assert_eq!(result.status.code(),Some(76)); let report:Value=serde_json::from_slice(&result.stdout).unwrap(); assert!(report.get("capture_progress").is_none(),"zero uploaded packs must use the bounded legacy renewal path");
    assert_eq!(fs::read(f.root.join(".sourceweft/state.bin")).unwrap(),before); assert_eq!(fs::read(f.root.join(".sourceweft/pending.manifest")).unwrap(),pending);
    storage.grant(&f.root,true); assert_eq!(f.flush()["seq"],1);
}
#[test]
fn manifest_get_oversize_short_different_and_network_failures_never_confirm() {
    for mode in ["oversize","short","different","not-found","http-error","transport"] {
        let storage=Storage::new(); let f=Fixture::new(); storage.grant(&f.root,true); fs::write(f.root.join("data"),"bounded manifest verification").unwrap();
        let crashed=Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush","--root"]).arg(&f.root).env("SWVOL_FAULT","after_manifest_put").output().unwrap(); assert_eq!(crashed.status.code(),Some(137));
        let original=storage.objects.lock().unwrap()["/att/a/m/1/1"].clone(); let before=fs::read(f.root.join(".sourceweft/state.bin")).unwrap(); let pending=fs::read(f.root.join(".sourceweft/pending.manifest")).unwrap();
        let listener=TcpListener::bind("127.0.0.1:0").unwrap(); listener.set_nonblocking(true).unwrap(); let url=format!("http://{}/read",listener.local_addr().unwrap());
        let server=std::thread::spawn(move||{
            let deadline=Instant::now()+Duration::from_secs(5);
            let mut stream=loop{match listener.accept(){Ok((stream,_))=>break stream,Err(error)if error.kind()==std::io::ErrorKind::WouldBlock=>{assert!(Instant::now()<deadline,"GET proof was not requested");std::thread::sleep(Duration::from_millis(5));},Err(error)=>panic!("GET proof fixture: {error}")}};
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap(); let mut request=BufReader::new(stream.try_clone().unwrap()); let mut line=String::new();request.read_line(&mut line).unwrap();assert!(line.starts_with("GET /read "));
            loop{line.clear();request.read_line(&mut line).unwrap();if line=="\r\n"{break;}}
            let result=(||->std::io::Result<()>{
                match mode {
                    "oversize"=>{write!(stream,"HTTP/1.1 200 Fixture\r\nConnection: close\r\n\r\n")?;stream.write_all(&original)?;stream.write_all(&vec![0u8;1024*1024])?;},
                    "short"=>{write!(stream,"HTTP/1.1 200 Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",original.len())?;stream.write_all(&original[..original.len()/2])?;},
                    "different"=>{let mut changed=original.clone();changed[0]^=1;write!(stream,"HTTP/1.1 200 Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",changed.len())?;stream.write_all(&changed)?;},
                    "not-found"=>{write!(stream,"HTTP/1.1 404 Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;},
                    "http-error"=>{write!(stream,"HTTP/1.1 503 Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;},
                    "transport"=>{}, _=>unreachable!()
                }Ok(())})();
            if let Err(error)=result{assert!(matches!(error.kind(),std::io::ErrorKind::BrokenPipe|std::io::ErrorKind::ConnectionReset),"{error}");}
        });
        let path=f.root.join(".sourceweft/slots.json");let mut slots:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();slots["manifest_reads"]["1"]=url.into();fs::write(path,serde_json::to_vec(&slots).unwrap()).unwrap();
        let response=f.run(&["flush"]);server.join().unwrap();assert!(!response.status.success(),"{mode} GET incorrectly confirmed: {}",String::from_utf8_lossy(&response.stdout));
        assert_eq!(fs::read(f.root.join(".sourceweft/state.bin")).unwrap(),before);assert_eq!(fs::read(f.root.join(".sourceweft/pending.manifest")).unwrap(),pending);assert_eq!(fs::read_to_string(f.root.join("data")).unwrap(),"bounded manifest verification");
    }
}

#[test]
fn nonempty_capture_missing_manifest_read_uses_ordinary_renewal_after_remote_head_advances() {
    let storage=Storage::new(); let f=Fixture::new(); storage.grant(&f.root,true);
    let data=receipt_fixture_data(); fs::write(f.root.join("data"),&data).unwrap();
    let crashed=Command::new(env!("CARGO_BIN_EXE_swvol")).args(["flush","--full","--root"]).arg(&f.root).env("SWVOL_FAULT","after_manifest_put").output().unwrap();
    assert_eq!(crashed.status.code(),Some(137));
    assert!(f.root.join(".sourceweft/capture/pack-000000.json").exists());
    let before=fs::read(f.root.join(".sourceweft/state.bin")).unwrap(); let pending=fs::read(f.root.join(".sourceweft/pending.manifest")).unwrap();
    let remote=storage.objects.lock().unwrap().clone();
    let path=f.root.join(".sourceweft/slots.json"); let mut slots:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    // The host has applied seq 1: new writes begin at 2, but the first refreshed
    // grant is missing the separately signed head-1 GET authorization.
    slots["manifests"].as_object_mut().unwrap().remove("1"); slots.as_object_mut().unwrap().remove("manifest_reads");
    fs::write(&path,serde_json::to_vec(&slots).unwrap()).unwrap();
    let result=f.run(&["flush"]); assert_eq!(result.status.code(),Some(76));
    let report:Value=serde_json::from_slice(&result.stdout).unwrap();
    assert!(report.get("capture_progress").is_none(),"manifest authorization renewal must not advertise stale base-0 upload progress after the host applies seq 1: {report}");
    assert_eq!(fs::read(f.root.join(".sourceweft/state.bin")).unwrap(),before); assert_eq!(fs::read(f.root.join(".sourceweft/pending.manifest")).unwrap(),pending);
    // Ordinary bounded renewal supplies GET for head 1; never reissues its PUT.
    slots["manifest_reads"]=json!({"1":format!("{}/att/a/m/1/1",storage.url)});
    fs::write(&path,serde_json::to_vec(&slots).unwrap()).unwrap();
    assert_eq!(f.flush()["seq"],1); assert!(!f.root.join(".sourceweft/pending.manifest").exists());
    assert_eq!(*storage.objects.lock().unwrap(),remote,"proof-only recovery must not reupload packs or a new manifest");
    assert_eq!(fs::read(f.root.join("data")).unwrap(),data);
}

#[test]
fn rebase_state_save_failure_then_pending_recovery_drops_unregistered_inline_locations() {
    let storage=Storage::new(); let f=Fixture::new(); storage.grant(&f.root,true);
    for n in 1..=9 { fs::write(f.root.join("marker"),format!("original marker {n}")).unwrap(); assert_eq!(f.flush()["seq"],n); }
    let victim=b"only present in the rejected old epoch sequence ten";
    fs::write(f.root.join("victim"),victim).unwrap(); assert_eq!(f.flush()["seq"],10);
    let rejected=storage.manifests().into_iter().find(|m|m["seq"]==10).unwrap();
    let id=rejected["upserts"].as_array().unwrap().iter().find(|e|e["p"]=="victim").unwrap()["c"][0][0].as_str().unwrap().to_owned();
    assert!(rejected["chunks"].get(&id).is_some());
    fs::remove_file(f.root.join("victim")).unwrap();
    let path=f.root.join(".sourceweft/slots.json"); let mut slots:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    slots["manifest_prefix"]="att/a/m/2/".into();
    for field in ["manifests","manifest_reads"] { for (n,url) in slots[field].as_object_mut().unwrap(){*url=format!("{}/att/a/m/2/{n}",storage.url).into();} }
    fs::write(&path,serde_json::to_vec(&slots).unwrap()).unwrap();
    let before=fs::read(f.root.join(".sourceweft/state.bin")).unwrap();
    // A real filesystem publication failure occurs after the new manifest PUT.
    let obstruction=f.root.join(".sourceweft/state.tmp"); fs::create_dir(&obstruction).unwrap();
    let failed=f.run(&["flush","--rebase","3"]); assert!(!failed.status.success());
    assert!(f.root.join(".sourceweft/pending.manifest").exists());
    assert!(storage.objects.lock().unwrap().contains_key("/att/a/m/2/4"));
    assert_eq!(fs::read(f.root.join(".sourceweft/state.bin")).unwrap(),before);
    fs::remove_dir(obstruction).unwrap();
    assert_eq!(f.flush()["seq"],4,"ordinary recovery must apply the durable rebase journal");
    // Progress the accepted new epoch past the old sequence, so a later rebase
    // cannot accidentally repair this by testing only numeric sequence > head.
    for n in 5..=10 {fs::write(f.root.join("marker"),format!("accepted marker {n}")).unwrap();assert_eq!(f.flush()["seq"],n);}
    fs::write(f.root.join("victim"),victim).unwrap(); assert_eq!(f.flush()["seq"],11);
    let objects=storage.objects.lock().unwrap(); let body=&objects["/att/a/m/2/11"];
    let offset=16+u64::from_le_bytes(body[8..16].try_into().unwrap())as usize;
    let latest:Value=serde_json::from_slice(&zstd::stream::decode_all(&body[offset..]).unwrap()).unwrap();
    assert!(latest["chunks"].get(&id).is_some(),"recreated content must publish a fresh registered location, not reuse rejected old-epoch inline bytes: {latest}");
    assert_eq!(latest["chunks"][&id][0],"att/a/m/2/11");
    assert_eq!(fs::read(f.root.join("victim")).unwrap(),victim);
}
