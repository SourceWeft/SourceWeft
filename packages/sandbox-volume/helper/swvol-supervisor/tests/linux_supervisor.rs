#![cfg(target_os = "linux")]
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Fixture {
    root: PathBuf,
    socket: PathBuf,
    server: Child,
    nonce: String,
}
impl Fixture {
    fn new() -> Self {
        assert_eq!(
            unsafe { libc::geteuid() },
            0,
            "run in an isolated privileged Linux test container"
        );
        let root = std::env::temp_dir().join(format!(
            "swvol-supervisor-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir(root.join("state")).unwrap();
        fs::set_permissions(root.join("state"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.join("workspace")).unwrap();
        fs::set_permissions(root.join("workspace"), fs::Permissions::from_mode(0o777)).unwrap();
        let socket = root.join("control.sock");
        let server = Command::new(env!("CARGO_BIN_EXE_swvol-supervisor"))
            .arg("serve")
            .arg(&socket)
            .arg(root.join("state"))
            .arg(root.join("workspace"))
            .args(["65534", "65533"])
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !socket.exists() {
            assert!(Instant::now() < deadline, "daemon did not bind");
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut out = Self {
            root,
            socket,
            server,
            nonce: String::new(),
        };
        out.nonce = out.ok(json!({"op":"identity"}))["identity"]["supervisor_nonce"]
            .as_str()
            .unwrap()
            .into();
        out
    }
    fn request(&self, value: Value) -> Value {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(40)))
            .unwrap();
        writeln!(stream, "{value}").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn ok(&self, value: Value) -> Value {
        let response = self.request(value);
        assert_eq!(response["ok"], true, "{response}");
        response["result"].clone()
    }
    fn open(&self) {
        self.ok(json!({"op":"open","expected_nonce":self.nonce,"drain_id":null}));
    }
    fn start(&self, id: &str, command: String) {
        self.ok(json!({"op":"start","expected_nonce":self.nonce,"launch":{"execution_id":id,"command":command,"cwd":self.root.join("workspace")}}));
    }
    fn completion(&self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let value =
                self.ok(json!({"op":"status","expected_nonce":self.nonce,"execution_id":id}));
            if !value["completion"].is_null() {
                return value;
            }
            assert!(Instant::now() < deadline, "command did not complete");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn size(&self, name: &str) -> u64 {
        fs::metadata(self.root.join("workspace").join(name))
            .map(|x| x.len())
            .unwrap_or(0)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
#[ignore = "requires an isolated privileged Linux container, no network"]
fn namespace_descendants_background_disk_and_peer_permissions() {
    let f = Fixture::new();
    assert_eq!(f.request(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"closed","command":"true","cwd":f.root.join("workspace")}}))["ok"],false);
    f.open();
    for id in ["a", "b"] {
        // setsid + a shell that exits after forking + TERM-ignoring background child.
        f.start(id,format!("setsid sh -c '(trap \\\"\\\" TERM; while :; do echo dirty >> {id}; sleep 0.05; done) >/dev/null 2>&1 &' ; echo completed"));
        assert_eq!(f.completion(id)["completion"]["exit_code"], 0);
    }
    std::thread::sleep(Duration::from_millis(250));
    let a = f.size("a");
    let b = f.size("b");
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        f.size("a") > a && f.size("b") > b,
        "background children must survive command completion"
    );
    let freeze = f.ok(json!({"op":"freeze","expected_nonce":f.nonce,"freeze_id":"barrier-1"}));
    assert_eq!(freeze["all_writers_stopped"], true);
    let a_frozen = f.size("a");
    let b_frozen = f.size("b");
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(f.size("a"), a_frozen);
    assert_eq!(f.size("b"), b_frozen);
    assert_eq!(f.request(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"during-freeze","command":"echo bad","cwd":f.root.join("workspace")}}))["ok"],false);
    f.ok(json!({"op":"resume","expected_nonce":f.nonce,"freeze_id":"barrier-1"}));
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        f.size("a") > a_frozen && f.size("b") > b_frozen,
        "freeze/resume must preserve background services"
    );
    f.ok(json!({"op":"cancel","expected_nonce":f.nonce,"execution_id":"a"}));
    let stopped = f.size("a");
    let sibling = f.size("b");
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(f.size("a"), stopped);
    assert!(f.size("b") > sibling);
    assert_eq!(f.request(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"a","command":"echo replayed > wrong","cwd":f.root.join("workspace")}}))["ok"],false);
    assert!(!f.root.join("workspace/wrong").exists());
    // Neither the workload nor one of its children can invoke the control socket or read the gate.
    f.start(
        "forbidden",
        format!(
            "{} request {} <<'JSON'\n{{\"op\":\"identity\"}}\nJSON",
            env!("CARGO_BIN_EXE_swvol-supervisor"),
            f.socket.display()
        ),
    );
    assert_ne!(f.completion("forbidden")["completion"]["exit_code"], 0);
    f.start(
        "private",
        format!("cat {}/state/gate.json", f.root.display()),
    );
    assert_ne!(f.completion("private")["completion"]["exit_code"], 0);
    let drain = f.ok(json!({"op":"drain","expected_nonce":f.nonce,"drain_id":"drain-1"}));
    assert_eq!(drain["all_namespaces_exited"], true);
    let b = f.size("b");
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(f.size("b"), b);
    assert!(b > 0, "dirty data must remain on disk");
    assert_eq!(
        f.request(json!({"op":"open","expected_nonce":f.nonce,"drain_id":"wrong"}))["ok"],
        false
    );
    f.ok(json!({"op":"open","expected_nonce":f.nonce,"drain_id":"drain-1"}));
    f.start("after", "printf recovered".into());
    assert_eq!(f.completion("after")["stdout"], "recovered");
}

#[test]
#[ignore = "requires an isolated privileged Linux container, no network"]
fn malformed_client_does_not_kill_supervisor_and_stale_identity_is_rejected() {
    let f = Fixture::new();
    let mut bad = UnixStream::connect(&f.socket).unwrap();
    bad.write_all(b"not-json\n").unwrap();
    drop(bad);
    assert_eq!(f.ok(json!({"op":"identity"}))["open"], false);
    assert_eq!(
        f.request(json!({"op":"open","expected_nonce":"other-daemon","drain_id":null}))["ok"],
        false
    );
}

#[test]
#[ignore = "requires an isolated privileged Linux container, no network"]
fn daemon_crash_stops_background_and_requires_recovery_before_reopening() {
    let mut f = Fixture::new();
    f.open();
    f.start(
        "crash-writer",
        "setsid sh -c '(while :; do echo dirty >> crash; sleep 0.05; done) >/dev/null 2>&1 &'"
            .into(),
    );
    assert_eq!(f.completion("crash-writer")["completion"]["exit_code"], 0);
    std::thread::sleep(Duration::from_millis(200));
    assert!(f.size("crash") > 0);
    let old_nonce = f.nonce.clone();
    f.server.kill().unwrap();
    f.server.wait().unwrap();
    f.server = Command::new(env!("CARGO_BIN_EXE_swvol-supervisor"))
        .arg("serve")
        .arg(&f.socket)
        .arg(f.root.join("state"))
        .arg(f.root.join("workspace"))
        .args(["65534", "65533"])
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if UnixStream::connect(&f.socket).is_ok() {
            break;
        }
        assert!(Instant::now() < deadline, "supervisor restart failed");
        std::thread::sleep(Duration::from_millis(20));
    }
    let identity = f.ok(json!({"op":"identity"}));
    f.nonce = identity["identity"]["supervisor_nonce"]
        .as_str()
        .unwrap()
        .into();
    assert_ne!(f.nonce, old_nonce);
    assert_eq!(identity["recovered_from"]["supervisor_nonce"], old_nonce);
    assert_eq!(
        identity["recovered_journal_digest"].as_str().unwrap().len(),
        64
    );
    let immediate_predecessor = f.nonce.clone();
    f.server.kill().unwrap();
    f.server.wait().unwrap();
    f.server = Command::new(env!("CARGO_BIN_EXE_swvol-supervisor"))
        .arg("serve")
        .arg(&f.socket)
        .arg(f.root.join("state"))
        .arg(f.root.join("workspace"))
        .args(["65534", "65533"])
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if UnixStream::connect(&f.socket).is_ok() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "second supervisor restart failed"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let repeated = f.ok(json!({"op":"identity"}));
    f.nonce = repeated["identity"]["supervisor_nonce"]
        .as_str()
        .unwrap()
        .into();
    let ancestry = repeated["recovery_ancestry"].as_array().unwrap();
    assert_eq!(ancestry.len(), 2);
    assert_eq!(ancestry[0]["supervisor_nonce"], old_nonce);
    assert_eq!(ancestry[1]["supervisor_nonce"], immediate_predecessor);
    let stopped = f.size("crash");
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(f.size("crash"), stopped);
    assert_eq!(
        f.request(json!({"op":"open","expected_nonce":f.nonce,"drain_id":null}))["ok"],
        false
    );
    let proof = f.ok(json!({"op":"drain","expected_nonce":f.nonce,"drain_id":"recovery-1"}));
    assert_eq!(proof["recovered_from"]["supervisor_nonce"], old_nonce);
    assert_eq!(proof["all_namespaces_exited"], true);
    f.ok(json!({"op":"open","expected_nonce":f.nonce,"drain_id":"recovery-1"}));
    assert_eq!(f.request(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"crash-writer","command":"echo replayed > wrong","cwd":f.root.join("workspace")}}))["ok"],false);
    assert!(!f.root.join("workspace/wrong").exists());
    f.start("after-recovery", "cat crash >/dev/null; echo ready".into());
    assert_eq!(f.completion("after-recovery")["stdout"], "ready\n");
}
