//! Shared helpers for the macOS real-sandbox integration tests: `macos_sandbox.rs` and the
//! `#[ignore]`d real tests in `local_execution.rs`, both `#![cfg(target_os = "macos")]`. Each
//! pulls this in with `mod common;`, so it is only ever compiled into those macOS-gated test
//! binaries.
//!
//! The Linux suite keeps its own copy of the equivalent helpers inside `linux_sandbox.rs` by
//! design — that file is deliberately left untouched — so there is no cross-platform sharing
//! here; this module is macOS-only and mirrors the Linux helper style.
//!
//! The bundle is located relative to `CARGO_MANIFEST_DIR`, at
//! `apps/desktop/sandbox-sidecar/dist/bundle` (git-ignored), built by that package's
//! `bun run build --rg "$(command -v rg)"`; no new environment variable locates it.
#![allow(dead_code)]
use serde_json::{json, Value};
use sourceweft_desktop::local_host::{
    execution::Executions, readiness::bundle_dir, LocalHost, Workspace,
};
use sourceweft_desktop::local_host::network::{NetworkBridge, OutboundLease};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

/// `apps/desktop/sandbox-sidecar/dist/bundle`.
pub fn built_bundle_source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sandbox-sidecar/dist/bundle")
}

/// Copies the already-built bundle into `dest` (a `<app data>/sandbox/current` directory),
/// matching the layout `readiness::bundle_dir` expects under a real app-data directory.
pub fn copy_bundle_into(dest: &Path) {
    let source = built_bundle_source();
    assert!(
        source.join("srt-sidecar").is_file(),
        "expected a built sidecar bundle at {source:?}; run `bun run build --rg \
         \"$(command -v rg)\"` in apps/desktop/sandbox-sidecar first (see the plan's \
         verification recipe)"
    );
    fs::create_dir_all(dest).unwrap();
    for entry in fs::read_dir(&source).unwrap() {
        let entry = entry.unwrap();
        let target = dest.join(entry.file_name());
        fs::copy(entry.path(), &target).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
    }
}

/// srt treats an existing `/tmp/claude` as its own writable TMPDIR (the state on any machine that
/// also runs Claude Code), so creating it once makes every test run in that configuration;
/// `cannot_write_srt_tmp_claude`-style checks then prove the sidecar's write deny covers it.
/// Creating or removing it mid-command would race srt's bind, so it is created once and never
/// removed.
pub fn ensure_tmp_claude() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        fs::create_dir_all("/tmp/claude").expect("create /tmp/claude");
    });
    assert!(
        Path::new("/tmp/claude").is_dir(),
        "/tmp/claude must be a directory"
    );
}

/// A `LocalHost` over a fresh temporary app-data directory (under `$TMPDIR`, i.e.
/// `/private/var/folders/...`) with the built bundle installed at `<app data>/sandbox/current`,
/// exactly where production looks for it.
pub fn host_with_bundle() -> (tempfile::TempDir, LocalHost) {
    ensure_tmp_claude();
    let app = tempfile::tempdir().unwrap();
    copy_bundle_into(&bundle_dir(app.path()));
    let host = LocalHost::open(app.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    (app, host)
}

/// A `LocalHost` over a caller-chosen app-data directory (e.g. one under `/tmp`, to exercise the
/// `/tmp`→`/private/tmp` symlink), with the bundle installed. The caller owns `app_path` and its
/// cleanup.
pub fn host_with_bundle_at(app_path: &Path) -> LocalHost {
    ensure_tmp_claude();
    copy_bundle_into(&bundle_dir(app_path));
    let host = LocalHost::open(app_path).unwrap();
    host.initialize_invocation_journal().unwrap();
    host
}

pub fn execute(host: &LocalHost, call: &str, workspace: &Workspace, command: &str) -> Value {
    host.dispatch(
        &Executions::default(),
        call,
        "owner",
        &workspace.thread_id,
        "command.execute",
        json!({"workspaceId": workspace.id, "command": command, "timeoutMs": 60000, "maxOutputChars": 20000}),
    )
    .map(|result| {
        diagnose_proxy_refusal(host, workspace, &result);
        result
    })
    .unwrap_or_else(|error| panic!("command.execute failed: {error}"))
}

pub fn output(result: &Value) -> &str {
    result["output"].as_str().unwrap()
}

/// A sandboxed command that "could not connect to localhost port N" never reached the sidecar's
/// proxy at all. Right then, while the sidecar is still alive, ask the host what it can see —
/// otherwise the failure is indistinguishable from a dead or not-yet-listening sidecar. Prints to
/// stderr (shown for a failing test); never fails a test by itself.
pub fn diagnose_proxy_refusal(host: &LocalHost, workspace: &Workspace, result: &Value) {
    let Some(text) = result["output"].as_str() else { return };
    let Some(rest) = text.split("Failed to connect to localhost port ").nth(1) else { return };
    let port: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if port.is_empty() {
        return;
    }
    let run = |script: String| {
        std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .map(|out| {
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                )
            })
            .unwrap_or_else(|error| error.to_string())
    };
    eprintln!(
        "--- proxy refusal diagnostics (port {port}) ---\nsidecars:\n{}\nlisteners on {port}:\n{}\nconnect 127.0.0.1: {}\nconnect ::1: {}\nsockets:\n{}",
        run("ps -axo pid,ppid,etime,stat,command | grep '[s]rt-sidecar'".into()),
        run(format!("lsof -nP -iTCP:{port} 2>&1 | head -5")),
        run(format!("nc -z -w1 127.0.0.1 {port} && echo open || echo refused")),
        run(format!("nc -z -w1 ::1 {port} && echo open || echo refused")),
        run(format!("netstat -an 2>/dev/null | grep '\\.{port} ' | head -5")),
    );
    // The same question from inside a fresh sandbox of the same host: is the refusal per command
    // (a new profile can connect) or lasting (this sidecar's proxy is unreachable from sandboxes)?
    let probe = format!(
        "env | grep -i '_proxy=' ; \
         for target in http://127.0.0.1:{port}/ 'http://[::1]:{port}/' http://localhost:{port}/; do \
           echo \"== $target\"; curl -sS --noproxy '*' -m 3 -o /dev/null -w '%{{http_code}}' \"$target\" 2>&1 | tail -2; echo; \
         done"
    );
    let follow_up = host.dispatch(
        &Executions::default(),
        &format!("proxy-diag-{port}"),
        "owner",
        &workspace.thread_id,
        "command.execute",
        json!({"workspaceId": workspace.id, "command": probe, "timeoutMs": 30000, "maxOutputChars": 4000, "network": {"mode": "open", "allow": [], "suggested": {}}}),
    );
    match follow_up {
        Ok(value) => eprintln!("in-sandbox follow-up:\n{}", value["output"].as_str().unwrap_or("<no output>")),
        Err(error) => eprintln!("in-sandbox follow-up failed: {error}"),
    }
}

/// Runs `command` after a positive control that must succeed inside the sandbox, and asserts the
/// control ran, so a denial test cannot pass merely because the sandbox failed to start the
/// command at all (e.g. exit 127 from a missing helper).
pub fn execute_denied(host: &LocalHost, call: &str, workspace: &Workspace, command: &str) -> Value {
    let control = workspace.path.join(".sw-control");
    let _ = fs::remove_file(&control);
    let result = execute(
        host,
        call,
        workspace,
        &format!("printf ran > .sw-control && {command}"),
    );
    assert_eq!(
        fs::read_to_string(&control).ok().as_deref(),
        Some("ran"),
        "the sandboxed command never ran: {result}"
    );
    result
}

/// Single-quotes `path` for `/bin/sh`.
pub fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

pub fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME must be set for this test"))
}

/// Removes a planted file even when an assertion fails.
pub struct RemoveOnDrop(pub PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Sets an environment variable for the lifetime of the guard and restores its previous value (or
/// removes it) on drop. The real-sandbox tests run with `--test-threads=1`, so a transient
/// process-wide variable set here never races a sibling test.
pub struct EnvVarGuard {
    key: String,
    previous: Option<String>,
}
impl EnvVarGuard {
    pub fn set(key: &str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self {
            key: key.to_string(),
            previous,
        }
    }
}
impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(&self.key, value),
            None => std::env::remove_var(&self.key),
        }
    }
}

/// The shape every `command.execute` result has, on every platform: the four original fields
/// with the right types, and nothing else except the optional extras a sandboxed run adds
/// (`networkAudit`, `networkAuditError`, `vaultWarning`). Panics naming the problem otherwise.
pub fn assert_result_shape(result: &Value) {
    let object = result
        .as_object()
        .unwrap_or_else(|| panic!("result is not an object: {result}"));
    assert!(object.get("output").is_some_and(Value::is_string), "output: {result}");
    assert!(object.get("exitCode").is_some_and(Value::is_i64), "exitCode: {result}");
    assert!(object.get("truncated").is_some_and(Value::is_boolean), "truncated: {result}");
    assert!(object.get("cancelled").is_some_and(Value::is_boolean), "cancelled: {result}");
    for key in object.keys() {
        assert!(
            ["output", "exitCode", "truncated", "cancelled", "networkAudit", "networkAuditError", "vaultWarning"]
                .contains(&key.as_str()),
            "unexpected result key {key:?}: {result}"
        );
    }
    if let Some(audit) = object.get("networkAudit") {
        assert!(audit.is_array(), "networkAudit must be an array: {result}");
    }
    for key in ["networkAuditError", "vaultWarning"] {
        if let Some(value) = object.get(key) {
            assert!(value.is_string(), "{key} must be a string: {result}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Network approvals. The backend half is replaced by `ApprovalBridge`: it installs an outbound
// channel on `host.network`, records every `network.ask` frame, and answers through
// `host.network.resolve`, exactly as `remote_host.rs` does for a `network.decision`.
// ---------------------------------------------------------------------------------------------

/// A `network` payload for `command.execute`.
pub fn net_policy(mode: &str, allow: &[&str]) -> Value {
    json!({"mode": mode, "allow": allow, "suggested": {}})
}

/// `command.execute` with an explicit network policy and command timeout.
pub fn execute_net_timeout(
    host: &LocalHost,
    call: &str,
    workspace: &Workspace,
    command: &str,
    network: Option<Value>,
    timeout_ms: u64,
) -> Value {
    let mut payload = json!({"workspaceId": workspace.id, "command": command, "timeoutMs": timeout_ms, "maxOutputChars": 20000});
    if let Some(network) = network {
        payload["network"] = network;
    }
    host.dispatch(
        &Executions::default(),
        call,
        "owner",
        &workspace.thread_id,
        "command.execute",
        payload,
    )
    .map(|result| {
        diagnose_proxy_refusal(host, workspace, &result);
        result
    })
    .unwrap_or_else(|error| panic!("command.execute failed: {error}"))
}

pub fn execute_net(
    host: &LocalHost,
    call: &str,
    workspace: &Workspace,
    command: &str,
    network: Option<Value>,
) -> Value {
    execute_net_timeout(host, call, workspace, command, network, 60000)
}

/// What the stand-in backend does with each `network.ask`: wait `delay`, then answer.
#[derive(Clone)]
pub struct Answer {
    pub delay: Duration,
    pub allow: bool,
    pub reason: Option<&'static str>,
}

/// Installs an outbound channel on `host.network` for its lifetime. With `answer` it resolves
/// every ask after the delay; without, it only records them (the ask stays pending).
pub struct ApprovalBridge {
    lease: Option<OutboundLease>,
    asks: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl ApprovalBridge {
    pub fn start(host: &LocalHost, answer: Option<Answer>) -> Self {
        let bridge: NetworkBridge = host.network.clone();
        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let lease = bridge.attach(sender);
        let asks = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let (asks, stop) = (asks.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    match frames.try_recv() {
                        Ok(frame) => {
                            asks.lock().unwrap().push(frame.clone());
                            if let Some(answer) = &answer {
                                std::thread::sleep(answer.delay);
                                let ask_id = frame["askId"].as_str().unwrap();
                                bridge.resolve(ask_id, answer.allow, answer.reason.map(str::to_string));
                            }
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(10)),
                    }
                }
            })
        };
        Self {
            lease: Some(lease),
            asks,
            stop,
            worker: Some(worker),
        }
    }

    pub fn allowing(host: &LocalHost, delay_ms: u64) -> Self {
        Self::start(
            host,
            Some(Answer {
                delay: Duration::from_millis(delay_ms),
                allow: true,
                reason: None,
            }),
        )
    }

    pub fn asks(&self) -> Vec<Value> {
        self.asks.lock().unwrap().clone()
    }
}

impl Drop for ApprovalBridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        drop(self.lease.take());
    }
}

pub fn audit_of(result: &Value) -> &Vec<Value> {
    result["networkAudit"]
        .as_array()
        .unwrap_or_else(|| panic!("result has no networkAudit: {result}"))
}

/// The first audit entry for which `matches` holds.
pub fn audit_entry<'a>(result: &'a Value, matches: impl Fn(&Value) -> bool) -> &'a Value {
    audit_of(result)
        .iter()
        .find(|entry| matches(entry))
        .unwrap_or_else(|| panic!("no matching audit entry in: {result}"))
}

/// A `connection` audit entry for the npm registry over HTTPS.
pub fn npm_connection(entry: &Value, decision: &str, source: &str) -> bool {
    entry["kind"] == "connection"
        && entry["host"] == "registry.npmjs.org"
        && entry["port"] == 443
        && entry["decision"] == decision
        && entry["source"] == source
}

pub const FETCH_NPM: &str =
    "curl -sS -o /dev/null -w %{http_code} https://registry.npmjs.org/left-pad";

