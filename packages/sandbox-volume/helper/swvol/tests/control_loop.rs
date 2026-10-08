//! Independent authenticated renewal while a real background writer is still running.
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde_json::{json, Value};

struct Fixture { base: PathBuf, daemon: Option<Child>, writer: Option<Child>, stop: Arc<AtomicBool>, server: Option<std::thread::JoinHandle<()>> }
impl Drop for Fixture {
    fn drop(&mut self) {
        for child in [&mut self.daemon, &mut self.writer] { if let Some(child) = child { let _ = child.kill(); let _ = child.wait(); } }
        self.stop.store(true, Ordering::Relaxed); if let Some(server) = self.server.take() { server.join().unwrap(); }
        let _ = fs::remove_dir_all(&self.base);
    }
}
fn private_write(path: PathBuf, bytes: &[u8]) { fs::write(&path, bytes).unwrap(); fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap(); }
fn serve(mut stream: TcpStream, url: &str, token: &str, objects: &Arc<Mutex<BTreeMap<String, Vec<u8>>>>, requests: &Arc<Mutex<Vec<Value>>>) {
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap()); let mut first = String::new(); reader.read_line(&mut first).unwrap();
    let mut fields = first.split_whitespace(); let method = fields.next().unwrap(); let path = fields.next().unwrap();
    let mut length = 0; let mut authorization = String::new();
    loop {
        let mut line = String::new(); reader.read_line(&mut line).unwrap(); if line == "\r\n" { break; }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap(); }
            if key.eq_ignore_ascii_case("authorization") { authorization = value.trim().to_owned(); }
        }
    }
    let mut bytes = vec![0; length]; reader.read_exact(&mut bytes).unwrap();
    let (status, response) = if method == "POST" && path == "/v1/sandbox-volumes/a/control" {
        assert!(authorization == format!("Bearer {token}"), "fixture received an incorrect scoped credential");
        let request: Value = serde_json::from_slice(&bytes).unwrap(); let next = request["nextPack"].as_u64().unwrap();
        requests.lock().unwrap().push(request.clone());
        // Only one pack is granted at a time. The 40MiB file requires renewal
        // inside a single capture, not merely between flush commands.
        let packs: BTreeMap<_, _> = [(next.to_string(), format!("{url}/att/a/p/{next:06}"))].into_iter().collect();
        let manifests: BTreeMap<_, _> = (1..=8).map(|seq| (seq.to_string(), format!("{url}/att/a/m/1/{seq}"))).collect();
        let head = objects.lock().unwrap().keys().filter_map(|key| key.strip_prefix("/att/a/m/1/")?.parse::<u64>().ok()).max().unwrap_or(0);
        let body = json!({"head":head,"confirmedSeq":head.min(request["seq"].as_u64().unwrap()),"epoch":1,"hasMore":false,
            "slots":{"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/1/","packs":packs,"manifests":manifests},
            "slotsExpiresAt":"2030-01-01T00:00:00Z","controlExpiresAt":"2030-01-01T00:00:00Z","locators":{"chunks":{},"packs":{}}});
        (200, serde_json::to_vec(&body).unwrap())
    } else if method == "PUT" {
        let mut data = objects.lock().unwrap();
        if data.contains_key(path) { (412, Vec::new()) } else { data.insert(path.into(), bytes); (201, Vec::new()) }
    } else { (404, Vec::new()) };
    write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap(); stream.write_all(&response).unwrap();
}
#[test]
fn protected_control_renews_during_capture_without_waiting_for_command_completion() {
    let base = std::env::temp_dir().join(format!("swvol-control-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let root = base.join("workspace"); let state = base.join("state"); fs::create_dir_all(&root).unwrap(); fs::create_dir(&state).unwrap(); fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let mut fixture = Fixture { base: base.clone(), daemon: None, writer: None, stop: stop.clone(), server: None };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap(); listener.set_nonblocking(true).unwrap(); let url = format!("http://{}", listener.local_addr().unwrap());
    let objects = Arc::new(Mutex::new(BTreeMap::new())); let requests = Arc::new(Mutex::new(Vec::new()));
    let token = format!("svctl_{}", "x".repeat(43)); let (data, calls, endpoint, credential) = (objects.clone(), requests.clone(), url.clone(), token.clone());
    fixture.server = Some(std::thread::spawn(move || while !stop.load(Ordering::Relaxed) {
        match listener.accept() { Ok((stream, _)) => serve(stream, &endpoint, &credential, &data, &calls), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)), Err(error) => panic!("fixture HTTP: {error}") }
    }));
    let plan = base.join("plan.json"); fs::write(&plan, serde_json::to_vec(&json!({"volume":"v","attachment":"a","seq":0,"entries":[],"chunks":{},"packs":{}})).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_swvol")).args(["restore", "--root"]).arg(&root).arg("--state-dir").arg(&state).arg("--plan").arg(&plan).output().unwrap(); assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    private_write(state.join("slots.json"), &serde_json::to_vec(&json!({"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/1/","packs":{"0":format!("{url}/att/a/p/000000")},"manifests":{"1":format!("{url}/att/a/m/1/1")}})).unwrap());
    private_write(state.join("control.json"), &serde_json::to_vec(&json!({"url":format!("{url}/v1/sandbox-volumes/a/control"),"token":token,"attachment":"a","bootId":fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim()})).unwrap());
    // HTTP without the explicit test switch is refused before any credential is sent.
    let denied = Command::new(env!("CARGO_BIN_EXE_swvol")).args(["daemon", "--root"]).arg(&root).arg("--state-dir").arg(&state).output().unwrap();
    assert!(!denied.status.success()); assert!(requests.lock().unwrap().is_empty()); assert!(!String::from_utf8_lossy(&denied.stdout).contains(&token));
    fixture.daemon = Some(Command::new(env!("CARGO_BIN_EXE_swvol")).args(["daemon", "--control-allow-http", "--root"]).arg(&root).arg("--state-dir").arg(&state).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5); while !state.join("sock").exists() { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10)); }
    // This shell is still executing sleep when independent control confirms its output.
    let script = format!("dd if=/dev/urandom of='{}' bs=1048576 count=40 status=none; exec sleep 60", root.join("generated.bin").display());
    fixture.writer = Some(Command::new("sh").args(["-c", &script]).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let confirmed = fs::read(state.join("control-status.json")).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).and_then(|status| status["confirmedSeq"].as_u64()).unwrap_or(0);
        if confirmed >= 1 { break; }
        assert!(fixture.daemon.as_mut().unwrap().try_wait().unwrap().is_none(), "daemon exited during renewal");
        assert!(Instant::now() < deadline, "control never confirmed the background capture"); std::thread::sleep(Duration::from_millis(100));
    }
    assert!(fixture.writer.as_mut().unwrap().try_wait().unwrap().is_none(), "confirmation must precede command completion");
    assert!(requests.lock().unwrap().iter().any(|request| request["nextPack"].as_u64().unwrap() >= 2));
    assert!(objects.lock().unwrap().keys().filter(|key| key.contains("/p/")).count() >= 3);
    assert!(!root.join(".sourceweft").exists(), "control state must remain outside workspace");
    assert_eq!(fs::metadata(root.join("generated.bin")).unwrap().len(), 40 * 1024 * 1024);
}
