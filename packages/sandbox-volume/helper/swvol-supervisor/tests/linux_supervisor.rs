#![cfg(target_os = "linux")]
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Only startup probes retry. Normal requests (especially start) retain exactly-once
// dispatch behavior and expose connection failures immediately.
fn wait_for_identity(
    server: &mut Child,
    socket: &std::path::Path,
    previous: Option<&str>,
) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last_observation = "no identity response".to_string();
    loop {
        if let Some(status) = server.try_wait().map_err(|error| error.to_string())? {
            return Err(format!(
                "supervisor exited before readiness: {status}; {last_observation}"
            ));
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                format!("supervisor identity readiness timed out: {last_observation}")
            })?;
        let probe = (|| -> std::io::Result<String> {
            let mut stream = UnixStream::connect(socket)?;
            let budget = remaining.min(Duration::from_millis(250));
            stream.set_read_timeout(Some(budget))?;
            stream.set_write_timeout(Some(budget))?;
            writeln!(stream, "{}", json!({"op":"identity"}))?;
            let mut line = String::new();
            if BufReader::new(stream).read_line(&mut line)? == 0 {
                return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
            }
            Ok(line)
        })();
        match probe {
            Ok(line) => {
                let value: Value = serde_json::from_str(&line)
                    .map_err(|error| format!("invalid startup identity JSON: {error}"))?;
                if value["ok"] != true {
                    return Err(format!("startup identity was rejected: {value}"));
                }
                let nonce = value["result"]["identity"]["supervisor_nonce"]
                    .as_str()
                    .filter(|nonce| !nonce.is_empty())
                    .ok_or("startup identity has no nonce")?;
                if Some(nonce) != previous {
                    if let Some(status) = server.try_wait().map_err(|error| error.to_string())? {
                        return Err(format!(
                            "supervisor exited during identity readiness: {status}"
                        ));
                    }
                    return Ok(nonce.to_string());
                }
                last_observation = "old supervisor nonce still visible".into();
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::ConnectionRefused
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::UnexpectedEof
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) =>
            {
                last_observation = error.to_string();
            }
            Err(error) => return Err(format!("startup identity probe failed: {error}")),
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct Fixture {
    root: PathBuf,
    socket: PathBuf,
    server: Child,
    nonce: String,
}
impl Fixture {
    fn new() -> Self {
        Self::with_nofile(None)
    }
    fn with_nofile(nofile: Option<u64>) -> Self {
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
        let mut server_command = Command::new(env!("CARGO_BIN_EXE_swvol-supervisor"));
        if let Some(nofile) = nofile {
            unsafe {
                server_command.pre_exec(move || {
                    let limit = libc::rlimit {
                        rlim_cur: nofile,
                        rlim_max: nofile,
                    };
                    if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let server = server_command
            .arg("serve")
            .arg(&socket)
            .arg(root.join("state"))
            .arg(root.join("workspace"))
            .args(["65534", "65533"])
            .env(
                "SWVOL_TEST_SUPERVISOR_SECRET",
                "private-supervisor-sentinel",
            )
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut out = Self {
            root,
            socket,
            server,
            nonce: String::new(),
        };
        out.nonce = wait_for_identity(&mut out.server, &out.socket, None).unwrap();
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
    fn restart(&mut self) {
        self.server.kill().unwrap();
        self.server.wait().unwrap();
        self.server = Command::new(env!("CARGO_BIN_EXE_swvol-supervisor"))
            .arg("serve")
            .arg(&self.socket)
            .arg(self.root.join("state"))
            .arg(self.root.join("workspace"))
            .args(["65534", "65533"])
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        self.nonce = wait_for_identity(&mut self.server, &self.socket, Some(&self.nonce)).unwrap();
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
    let freeze = f.ok(json!({"op":"pause","expected_nonce":f.nonce,"pause_id":"barrier-1"}));
    assert_eq!(freeze["observed_stopped"], true);
    let a_frozen = f.size("a");
    let b_frozen = f.size("b");
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(f.size("a"), a_frozen);
    assert_eq!(f.size("b"), b_frozen);
    assert_eq!(f.request(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"during-freeze","command":"echo bad","cwd":f.root.join("workspace")}}))["ok"],false);
    f.ok(json!({"op":"resume","expected_nonce":f.nonce,"pause_id":"barrier-1"}));
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        f.size("a") > a_frozen && f.size("b") > b_frozen,
        "diagnostic pause/resume must preserve background services"
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

#[test]
#[ignore = "requires isolated privileged Linux; synthetic secret only"]
fn daemon_environment_is_not_inherited_by_workloads() {
    let f = Fixture::new();
    f.open();
    f.start("environment", "env".into());
    let result = f.completion("environment");
    assert!(
        !result["stdout"]
            .as_str()
            .unwrap()
            .contains("private-supervisor-sentinel"),
        "privileged daemon environment leaked into the workload"
    );
}

#[test]
#[ignore = "requires isolated privileged Linux"]
fn lost_resume_response_can_be_retried_without_replaying_or_reopening_another_barrier() {
    let f = Fixture::new();
    f.open();
    f.start(
        "background",
        "(while :; do echo x >> ticks; sleep 0.05; done) >/dev/null 2>&1 &".into(),
    );
    f.completion("background");
    f.ok(json!({"op":"pause","expected_nonce":f.nonce,"pause_id":"lost-ack"}));
    let resume = json!({"op":"resume","expected_nonce":f.nonce,"pause_id":"lost-ack"});
    f.ok(resume.clone()); // The host loses this successful acknowledgement.
    f.ok(resume);
    f.ok(json!({"op":"pause","expected_nonce":f.nonce,"pause_id":"next-barrier"}));
    assert_eq!(
        f.request(json!({"op":"resume","expected_nonce":f.nonce,"pause_id":"lost-ack"}))["ok"],
        false
    );
}

#[test]
#[ignore = "requires isolated privileged Linux"]
fn completed_result_survives_supervisor_crash_without_command_replay() {
    let mut f = Fixture::new();
    f.open();
    f.start(
        "completed-once",
        "echo one >> count; printf receipt; exit 7".into(),
    );
    let before = f.completion("completed-once");
    assert_eq!(before["completion"]["exit_code"], 7);
    f.restart();
    let recovered =
        f.ok(json!({"op":"status","expected_nonce":f.nonce,"execution_id":"completed-once"}));
    assert_eq!(recovered["completion"]["exit_code"], 7);
    assert_eq!(recovered["stdout"], "receipt");
    assert_eq!(
        fs::read_to_string(f.root.join("workspace/count")).unwrap(),
        "one\n"
    );
    assert_eq!(f.request(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"completed-once","command":"echo two >> count","cwd":f.root.join("workspace")}}))["ok"],false);
}

#[test]
#[ignore = "requires isolated privileged Linux; bounded 10 MiB output"]
fn output_flood_is_bounded_and_truncation_is_explicit() {
    let f = Fixture::new();
    f.open();
    f.start("flood", "head -c 10000000 /dev/zero | tr '\\000' x".into());
    let result = f.completion("flood");
    assert!(result["stdout"].as_str().unwrap().len() <= 8 * 1024 * 1024);
    assert_eq!(
        result["truncated"].as_bool(),
        Some(true),
        "discarded output must not masquerade as complete output"
    );
    f.ok(json!({"op":"pause","expected_nonce":f.nonce,"pause_id":"after-flood"}));
}

#[test]
#[ignore = "requires isolated privileged Linux; one deliberately incomplete local client"]
fn incomplete_control_client_does_not_block_other_control_requests() {
    let f = Fixture::new();
    let mut incomplete = UnixStream::connect(&f.socket).unwrap();
    incomplete.write_all(b"{").unwrap();
    std::thread::sleep(Duration::from_millis(30));
    let start = Instant::now();
    f.ok(json!({"op":"identity"}));
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "a partial request blocked unrelated control traffic"
    );
}

#[test]
#[ignore = "requires isolated privileged Linux with pids-limit 512 and memory cap"]
fn diagnostic_pause_is_observed_during_bounded_fork_and_thread_churn() {
    let f = Fixture::new();
    f.open();
    let source = f.root.join("bounded-writers.rs");
    fs::write(&source, include_str!("fixtures/bounded_writers.rs")).unwrap();
    let binary = f.root.join("bounded-writers");
    let target = format!("{}-unknown-linux-musl", std::env::consts::ARCH);
    assert!(Command::new("rustc")
        .args(["--edition=2021", "-O", "--target"])
        .arg(&target)
        .arg("-C")
        .arg(format!("linker={target}-gcc"))
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .status()
        .unwrap()
        .success());
    f.start("churn", binary.to_string_lossy().into_owned());
    let deadline = Instant::now() + Duration::from_secs(3);
    while f.size("churn") < 60 {
        assert!(Instant::now() < deadline, "bounded writers did not start");
        std::thread::sleep(Duration::from_millis(10));
    }
    for turn in 0..12 {
        let id = format!("churn-barrier-{turn}");
        f.ok(json!({"op":"pause","expected_nonce":f.nonce,"pause_id":id}));
        let size = f.size("churn");
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(
            f.size("churn"),
            size,
            "writer continued during diagnostic signal pause on round {turn}"
        );
        f.ok(json!({"op":"resume","expected_nonce":f.nonce,"pause_id":id}));
        std::thread::sleep(Duration::from_millis(30));
    }
    f.ok(json!({"op":"drain","expected_nonce":f.nonce,"drain_id":"finish-churn"}));
    let stopped = f.size("churn");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(f.size("churn"), stopped);
}

#[test]
#[ignore = "requires isolated privileged Linux; eight bounded restart cycles"]
fn repeated_crashes_keep_a_sealed_ancestry_and_never_replay_completed_work() {
    let mut f = Fixture::new();
    f.open();
    f.start(
        "once-eight",
        "echo once >> durable-count; printf result".into(),
    );
    f.completion("once-eight");
    let mut prior = Vec::new();
    for turn in 0..8 {
        prior.push(f.nonce.clone());
        f.restart();
        let identity = f.ok(json!({"op":"identity"}));
        let ancestry = identity["recovery_ancestry"].as_array().unwrap();
        assert_eq!(ancestry.len(), turn + 1);
        for (index, nonce) in prior.iter().enumerate() {
            assert_eq!(
                ancestry[index]["supervisor_nonce"].as_str(),
                Some(nonce.as_str())
            );
        }
        assert_eq!(identity["open"], false);
        let result =
            f.ok(json!({"op":"status","expected_nonce":f.nonce,"execution_id":"once-eight"}));
        assert_eq!(result["stdout"], "result");
        assert_eq!(result["completion"]["exit_code"], 0);
        assert_eq!(
            fs::read_to_string(f.root.join("workspace/durable-count")).unwrap(),
            "once\n"
        );
    }
}

#[test]
#[ignore = "requires isolated privileged Linux; bounded malformed requests"]
fn malicious_control_payloads_do_not_create_jobs_or_damage_admission() {
    let f = Fixture::new();
    let before = fs::read_dir(f.root.join("state")).unwrap().count();
    assert_eq!(
        f.request(json!({"op":"status","expected_nonce":f.nonce,"execution_id":"../../gate"}))
            ["ok"],
        false
    );
    assert_eq!(
        f.request(json!({"op":"status","expected_nonce":f.nonce,"execution_id":"unknown"}))["ok"],
        false
    );
    let oversized = json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"too-large","command":"x".repeat(1024*1024),"cwd":f.root.join("workspace")}});
    assert_eq!(f.request(oversized)["ok"], false);
    assert_eq!(fs::read_dir(f.root.join("state")).unwrap().count(), before);
    assert_eq!(f.ok(json!({"op":"identity"}))["open"], false);
    f.open();
    f.start("after-invalid", "printf healthy".into());
    assert_eq!(f.completion("after-invalid")["stdout"], "healthy");
    assert_eq!(f.request(json!({"op":"status","expected_nonce":f.nonce,"execution_id":"after-invalid","max_output_bytes":1048577}))["ok"],false);
}

#[test]
#[ignore = "requires isolated privileged Linux"]
fn a_new_partial_ledger_is_not_mistaken_for_a_reaped_namespace() {
    let f = Fixture::new();
    let directory = f.root.join("state/exec-partial");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        directory.join("launch.json"),
        json!({"execution_id":"partial","command":"true","cwd":f.root.join("workspace")})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        f.request(json!({"op":"status","expected_nonce":f.nonce,"execution_id":"partial"}))["ok"],
        false,
        "an absent in-memory handle alone is not proof that a namespace exited"
    );
}

#[test]
#[ignore = "requires isolated privileged Linux; corrupt ledger is confined to the fixture"]
fn missing_namespace_journal_never_produces_a_false_recovery_stop_proof() {
    let mut f = Fixture::new();
    let directory = f.root.join("state/exec-unprovable");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(directory.join("go.json"), "{\"start\":true}").unwrap();
    fs::write(f.root.join("workspace/preserved"), "dirty files stay here").unwrap();
    f.server.kill().unwrap();
    f.server.wait().unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_swvol-supervisor"))
        .arg("serve")
        .arg(&f.socket)
        .arg(f.root.join("state"))
        .arg(f.root.join("workspace"))
        .args(["65534", "65533"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("lacks a namespace journal"));
    assert_eq!(
        fs::read_to_string(f.root.join("workspace/preserved")).unwrap(),
        "dirty files stay here"
    );
}

#[test]
#[ignore = "requires isolated privileged Linux; four bounded 9-second drip clients"]
fn four_drip_clients_cannot_renew_the_total_request_budget() {
    let f = Fixture::new();
    let mut clients = Vec::new();
    for _ in 0..4 {
        let mut stream = UnixStream::connect(&f.socket).unwrap();
        stream.write_all(b"{").unwrap();
        clients.push(stream);
    }
    std::thread::sleep(Duration::from_secs(9));
    for stream in &mut clients {
        let _ = stream.write_all(b" ");
    }
    std::thread::sleep(Duration::from_millis(1500));
    let fresh = Instant::now();
    f.ok(json!({"op":"identity"}));
    assert!(
        fresh.elapsed() < Duration::from_secs(3),
        "four drip clients extended the 10-second total input budget"
    );
}

#[test]
#[ignore = "requires isolated privileged Linux; 600 sequential namespaces and low FD limit"]
fn completed_namespaces_release_kernel_resources_but_keep_result_and_replay_fence() {
    let f = Fixture::with_nofile(Some(256));
    f.open();
    let fd_count = || {
        fs::read_dir(format!("/proc/{}/fd", f.server.id()))
            .unwrap()
            .count()
    };
    let zombie_count = || {
        fs::read_dir("/proc")
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let Ok(status) = fs::read_to_string(entry.path().join("status")) else {
                    return false;
                };
                let parent = status
                    .lines()
                    .find_map(|line| line.strip_prefix("PPid:"))
                    .and_then(|v| v.trim().parse::<u32>().ok());
                parent == Some(f.server.id())
                    && status
                        .lines()
                        .any(|line| line.starts_with("State:") && line.contains("Z (zombie)"))
            })
            .count()
    };
    let baseline = fd_count();
    for index in 0..600 {
        let id = format!("short-{index}");
        f.start(&id, format!("printf result-{index}"));
        assert_eq!(f.completion(&id)["stdout"], format!("result-{index}"));
        if (index + 1) % 50 == 0 {
            eprintln!(
                "completed={} fds={} baseline={} zombies={}",
                index + 1,
                fd_count(),
                baseline,
                zombie_count()
            );
        }
    }
    std::thread::sleep(Duration::from_millis(100));
    f.ok(json!({"op":"identity"}));
    assert!(
        fd_count() <= baseline + 4,
        "completed namespace pidfds accumulated"
    );
    assert_eq!(zombie_count(), 0, "namespace launchers were not reaped");
    for id in ["short-0", "short-299", "short-599"] {
        let status = f.completion(id);
        assert_eq!(status["completion"]["exit_code"], 0);
        assert_eq!(status["namespace_exited"], true);
        assert_eq!(status["stdout"], id.replace("short-", "result-"));
        assert_eq!(f.request(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":id,"command":"echo REPLAYED >> replayed","cwd":f.root.join("workspace")}}))["ok"],false);
    }
    assert!(!f.root.join("workspace/replayed").exists());
}

#[test]
#[ignore = "isolated Linux fixture: bind-before-listen and stale identity startup race"]
fn readiness_requires_a_live_new_identity_not_just_a_socket_path() {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::net::UnixListener;
    let socket = std::env::temp_dir().join(format!("swvol-readiness-{}.sock", std::process::id()));
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    assert!(fd >= 0);
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (target, byte) in address
        .sun_path
        .iter_mut()
        .zip(socket.as_os_str().as_bytes())
    {
        *target = *byte as libc::c_char;
    }
    assert_eq!(
        unsafe {
            libc::bind(
                fd.as_raw_fd(),
                &address as *const _ as *const libc::sockaddr,
                std::mem::size_of_val(&address) as libc::socklen_t,
            )
        },
        0
    );
    assert!(socket.exists());
    assert_eq!(
        UnixStream::connect(&socket).unwrap_err().kind(),
        std::io::ErrorKind::ConnectionRefused
    );
    let listener_thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(unsafe { libc::listen(fd.as_raw_fd(), 4) }, 0);
        let listener = UnixListener::from(fd);
        for nonce in ["old-controller", "new-controller"] {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap(),
                json!({"op":"identity"})
            );
            writeln!(
                stream,
                "{}",
                json!({"ok":true,"result":{"identity":{"supervisor_nonce":nonce}}})
            )
            .unwrap();
        }
    });
    let mut child = Command::new("sleep").arg("5").spawn().unwrap();
    let result = wait_for_identity(&mut child, &socket, Some("old-controller"));
    let _ = child.kill();
    child.wait().unwrap();
    listener_thread.join().unwrap();
    assert_eq!(result.unwrap(), "new-controller");
    let error = wait_for_identity(&mut child, &socket, None).unwrap_err();
    assert!(error.contains("exited before readiness"), "{error}");
    fs::remove_file(socket).unwrap();
}

#[test]
#[ignore = "isolated Linux: POSIX kernel SIGCONT defeats diagnostic signal pause"]
fn kernel_timer_resumes_diagnostic_pause_and_production_freeze_is_unavailable() {
    let f = Fixture::new();
    let identity = f.ok(json!({"op":"identity"}));
    assert_eq!(identity["identity"]["stable_freeze"], false);
    assert_eq!(identity["identity"]["freeze_mechanism"], "signal-pause");
    let source = f.root.join("workspace/timer.c");
    let binary = f.root.join("workspace/timer");
    fs::write(&source, include_str!("fixtures/posix_sigcont_writer.c")).unwrap();
    assert!(
        Command::new(format!("{}-unknown-linux-musl-gcc", std::env::consts::ARCH))
            .args(["-static", "-O2"])
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .arg("-lrt")
            .status()
            .unwrap()
            .success()
    );
    f.open();
    f.start("timer", format!("exec {}", binary.display()));
    let deadline = Instant::now() + Duration::from_secs(3);
    while f.size("counter") < 10 {
        assert!(
            Instant::now() < deadline,
            "POSIX timer writer failed to start"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let freeze =
        f.request(json!({"op":"freeze","expected_nonce":f.nonce,"freeze_id":"not-a-barrier"}));
    assert_eq!(freeze["ok"], false);
    assert!(freeze["error"]
        .as_str()
        .unwrap()
        .contains("STABLE_FREEZE_UNAVAILABLE"));
    assert!(freeze["result"]["all_writers_stopped"].is_null());
    let pause = f.ok(json!({"op":"pause","expected_nonce":f.nonce,"pause_id":"diagnostic-only"}));
    assert_eq!(pause["observed_stopped"], true);
    assert_eq!(pause["signal_pause"], true);
    assert_eq!(pause["stable_freeze"], false);
    assert!(pause["all_writers_stopped"].is_null());
    let before = f.size("counter");
    std::thread::sleep(Duration::from_millis(350));
    let after = f.size("counter");
    eprintln!("SIGCONT_COUNTEREXAMPLE before={before} after={after} observation_ms=350");
    assert!(
        after > before,
        "POSIX SIGCONT must expose that diagnostic pause is not a stable barrier"
    );
    f.ok(json!({"op":"drain","expected_nonce":f.nonce,"drain_id":"test-cleanup"}));
    let stopped = f.size("counter");
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        f.size("counter"),
        stopped,
        "namespace teardown remains a valid stop boundary"
    );
}
