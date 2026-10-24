//! Rust client for the long-lived sandbox sidecar process (a Bun-compiled TypeScript
//! program that wraps commands with Anthropic's sandbox-runtime, built in a later task).
//! The host talks to it over stdin/stdout, one JSON object per line each way. This module
//! only speaks that protocol; it does not itself run the wrapped command (see
//! `local_host::process::run_wrapped`) or know where the sidecar bundle lives on disk
//! (a later task supplies `bundle: &Path`).
#![allow(dead_code)] // Wired up by a later task; keep the whole client warning-free until then.
use super::{HostError, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Mutex,
    },
    time::{Duration, Instant},
};

/// `InitConfig` as sent on `init`, mirroring the TypeScript type (camelCase on the wire).
///
/// `pub`, not `pub(crate)`: this module is private, but `readiness.rs` re-exports this type
/// (along with `Platform` and `Helpers`) so the ignored Linux integration test in
/// `tests/linux_sandbox.rs` can build one directly; see that re-export's doc comment.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitConfig {
    pub platform: Platform,
    pub home: String,
    pub workspace_roots: Vec<String>,
    pub read_roots: Vec<String>,
    pub helpers: Helpers,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bwrap_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Linux,
    Darwin,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Helpers {
    pub ripgrep: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apply_seccomp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_agent_jar: Option<String>,
}

/// Result of a successful `wrap` call.
#[derive(Debug)]
pub(crate) struct WrappedCommand {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// One outbound request. Serialize-only: the host never needs to parse its own requests back.
#[derive(Serialize)]
#[serde(tag = "op")]
enum Request<'a> {
    #[serde(rename = "init")]
    Init { id: String, config: &'a InitConfig },
    #[serde(rename = "wrap", rename_all = "camelCase")]
    Wrap {
        id: String,
        command_id: String,
        command: String,
        cwd: String,
        workspace_root: String,
    },
    #[serde(rename = "violations", rename_all = "camelCase")]
    Violations {
        id: String,
        command_id: String,
        stderr: String,
    },
    #[serde(rename = "cleanup", rename_all = "camelCase")]
    Cleanup { id: String, command_id: String },
    #[serde(rename = "probe")]
    Probe { id: String },
    #[serde(rename = "shutdown")]
    Shutdown { id: String },
}

/// One inbound reply, in either of the two shapes the protocol defines.
#[derive(Deserialize)]
struct Response {
    id: String,
    ok: bool,
    #[serde(default)]
    result: serde_json::Value,
    #[serde(default)]
    error: Option<ResponseError>,
}

#[derive(Deserialize)]
struct ResponseError {
    code: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrapResult {
    argv: Vec<String>,
    env: BTreeMap<String, String>,
}

/// The five sidecar-defined error codes; anything else the sidecar sends is reported as
/// `SANDBOX_UNAVAILABLE` rather than propagating an unrecognized code to the rest of the host.
fn map_error_code(code: &str) -> &'static str {
    match code {
        "NOT_INITIALIZED" => "NOT_INITIALIZED",
        "HELPER_MISSING" => "HELPER_MISSING",
        "SANDBOX_UNAVAILABLE" => "SANDBOX_UNAVAILABLE",
        "POLICY_INVALID" => "POLICY_INVALID",
        "BAD_REQUEST" => "BAD_REQUEST",
        _ => "SANDBOX_UNAVAILABLE",
    }
}

fn path_to_string(path: &Path) -> Result<String> {
    path.to_str().map(str::to_string).ok_or_else(|| {
        HostError::new("INVALID_PATH", format!("path is not valid UTF-8: {path:?}"))
    })
}

/// The live stdin/stdout half of the connection, held behind the same lock so only one
/// request is ever in flight per `Sidecar`.
struct Connection {
    stdin: ChildStdin,
    replies: Receiver<String>,
}

/// A handle to a running sandbox sidecar process, speaking the line-delimited JSON protocol
/// over its stdin/stdout. Stderr is left inherited so sidecar diagnostics land in the host's
/// own log. Construct with `start` (or `start_with_timeout` for tests); every other call
/// returns `Err(HostError { code: "SANDBOX_UNAVAILABLE", .. })` on I/O failure or on not
/// hearing back within the configured timeout, and otherwise propagates the sidecar's own
/// error code verbatim (mapped through `map_error_code`).
///
/// **Any `Err` with code `"SANDBOX_UNAVAILABLE"` means this `Sidecar` must be discarded.**
/// A timed-out, disconnected, unparseable, or mismatched-id reply means the next line read
/// from the sidecar's stdout is no longer guaranteed to be the reply to the next request —
/// the request/reply pairing has desynchronized, possibly permanently (a late reply can still
/// be sitting in the channel, waiting to be wrongly consumed by a future call). Rather than
/// try to resynchronize, every such failure latches `poisoned`, and every later call on the
/// same instance fails fast with `SANDBOX_UNAVAILABLE` without touching stdin/stdout at all.
/// Callers (Task 6) must start a fresh `Sidecar` instead of reusing one that has failed this
/// way.
pub(crate) struct Sidecar {
    conn: Mutex<Connection>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    timeout: Duration,
    /// Set once any call desynchronizes the stdin/stdout framing (or otherwise proves the
    /// sidecar unusable); see the type-level doc above. Checked, lock-free, at the top of
    /// every `call()`.
    poisoned: AtomicBool,
}

impl Sidecar {
    /// Starts `<bundle>/srt-sidecar` and sends `init`, using the production 30 s reply
    /// timeout for every call made over the lifetime of the returned `Sidecar`.
    pub(crate) fn start(bundle: &Path, init: &InitConfig) -> Result<Sidecar> {
        Self::start_with_timeout(bundle, init, Duration::from_secs(30))
    }

    /// Same as `start`, but with an explicit reply timeout, applied to `init` and to every
    /// later call on the returned `Sidecar`. Production code always goes through `start`;
    /// tests use this directly with a short timeout so a stuck or dead stub fails fast.
    pub(crate) fn start_with_timeout(
        bundle: &Path,
        init: &InitConfig,
        timeout: Duration,
    ) -> Result<Sidecar> {
        let mut command = Command::new(bundle.join("srt-sidecar"));
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Ok(home) = std::env::var("HOME") {
            command.env("HOME", home);
        }
        if let Ok(lang) = std::env::var("LANG") {
            command.env("LANG", lang);
        }
        let mut child = command.spawn().map_err(|error| {
            HostError::new(
                "SANDBOX_UNAVAILABLE",
                format!("failed to start sandbox sidecar: {error}"),
            )
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            HostError::new("SANDBOX_UNAVAILABLE", "sidecar stdin was not piped")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            HostError::new("SANDBOX_UNAVAILABLE", "sidecar stdout was not piped")
        })?;

        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\n', '\r']).to_string();
                        if sender.send(trimmed).is_err() {
                            break;
                        }
                    }
                }
            }
            // Reaching here drops `sender`, which turns every future `recv` into a prompt
            // `Disconnected` instead of a full timeout wait.
        });

        let sidecar = Sidecar {
            conn: Mutex::new(Connection { stdin, replies }),
            child: Mutex::new(child),
            next_id: AtomicU64::new(0),
            timeout,
            poisoned: AtomicBool::new(false),
        };
        let id = sidecar.allocate_id();
        sidecar.call(&id, &Request::Init { id: id.clone(), config: init })?;
        Ok(sidecar)
    }

    pub(crate) fn wrap(
        &self,
        command_id: &str,
        command: &str,
        cwd: &Path,
        workspace_root: &Path,
    ) -> Result<WrappedCommand> {
        let id = self.allocate_id();
        let result = self.call(
            &id,
            &Request::Wrap {
                id: id.clone(),
                command_id: command_id.to_string(),
                command: command.to_string(),
                cwd: path_to_string(cwd)?,
                workspace_root: path_to_string(workspace_root)?,
            },
        )?;
        let wrapped: WrapResult = serde_json::from_value(result).map_err(|error| {
            HostError::new(
                "SANDBOX_UNAVAILABLE",
                format!("invalid wrap result from sidecar: {error}"),
            )
        })?;
        Ok(WrappedCommand {
            argv: wrapped.argv,
            env: wrapped.env.into_iter().collect(),
        })
    }

    pub(crate) fn violations(&self, command_id: &str, stderr: &str) -> Result<String> {
        let id = self.allocate_id();
        let result = self.call(
            &id,
            &Request::Violations {
                id: id.clone(),
                command_id: command_id.to_string(),
                stderr: stderr.to_string(),
            },
        )?;
        serde_json::from_value(result).map_err(|error| {
            HostError::new(
                "SANDBOX_UNAVAILABLE",
                format!("invalid violations result from sidecar: {error}"),
            )
        })
    }

    pub(crate) fn cleanup(&self, command_id: &str) -> Result<()> {
        let id = self.allocate_id();
        self.call(
            &id,
            &Request::Cleanup {
                id: id.clone(),
                command_id: command_id.to_string(),
            },
        )?;
        Ok(())
    }

    pub(crate) fn probe(&self) -> Result<()> {
        let id = self.allocate_id();
        self.call(&id, &Request::Probe { id: id.clone() })?;
        Ok(())
    }

    fn allocate_id(&self) -> String {
        self.next_id.fetch_add(1, Ordering::SeqCst).to_string()
    }

    /// Marks this `Sidecar` permanently unusable and returns the `SANDBOX_UNAVAILABLE` error
    /// to report for the call that discovered it. See the type-level doc comment.
    fn poison(&self, message: impl Into<String>) -> HostError {
        self.poisoned.store(true, Ordering::SeqCst);
        HostError::new("SANDBOX_UNAVAILABLE", message)
    }

    /// Sends one request and waits for its reply, holding the connection lock for the whole
    /// round trip so at most one request is ever in flight per `Sidecar`. Every failure that
    /// could leave the stdin/stdout framing desynchronized poisons the instance (see the
    /// type-level doc comment) before returning; a call made after that returns immediately,
    /// without touching stdin/stdout.
    fn call(&self, id: &str, request: &Request) -> Result<serde_json::Value> {
        if self.poisoned.load(Ordering::SeqCst) {
            return Err(HostError::new(
                "SANDBOX_UNAVAILABLE",
                "sidecar connection is desynchronized from a previous failure; this Sidecar must be discarded and a new one started",
            ));
        }

        let mut conn = self
            .conn
            .lock()
            .map_err(|_| self.poison("sidecar connection lock was poisoned"))?;

        let mut line = serde_json::to_string(request)
            .map_err(|error| self.poison(format!("failed to encode sidecar request: {error}")))?;
        line.push('\n');
        conn.stdin
            .write_all(line.as_bytes())
            .and_then(|()| conn.stdin.flush())
            .map_err(|error| self.poison(format!("failed to write to sidecar: {error}")))?;

        let raw = conn.replies.recv_timeout(self.timeout).map_err(|error| {
            let reason = match error {
                RecvTimeoutError::Timeout => "sidecar did not reply in time",
                RecvTimeoutError::Disconnected => "sidecar exited without replying",
            };
            self.poison(reason)
        })?;
        drop(conn);

        let response: Response = serde_json::from_str(&raw)
            .map_err(|error| self.poison(format!("invalid sidecar reply: {error}")))?;
        if response.id != id {
            return Err(self.poison("sidecar reply id did not match the request"));
        }
        if response.ok {
            return Ok(response.result);
        }
        match response.error {
            Some(error) => {
                let code = map_error_code(&error.code);
                if code == "SANDBOX_UNAVAILABLE" {
                    self.poisoned.store(true, Ordering::SeqCst);
                }
                Err(HostError::new(code, error.message))
            }
            None => Err(self.poison("sidecar reported failure without an error body")),
        }
    }
}

/// Polls `child` with `try_wait()` until it exits or `bound` elapses, sleeping briefly between
/// polls. Returns `true` if the child was observed to exit, `false` if the bound ran out (or
/// `try_wait()` itself errored) without that happening. Never calls the blocking `wait()`, so
/// it can never hang past `bound`.
fn wait_up_to(child: &mut Child, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => return false,
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // Best-effort: ask the sidecar to shut itself down, but never block on a reply —
        // a dead or stuck sidecar must not hang the host's own shutdown path.
        if let Ok(mut conn) = self.conn.lock() {
            let id = self.allocate_id();
            if let Ok(mut line) = serde_json::to_string(&Request::Shutdown { id }) {
                line.push('\n');
                let _ = conn.stdin.write_all(line.as_bytes());
                let _ = conn.stdin.flush();
            }
        }
        if let Ok(mut child) = self.child.lock() {
            // Give the sidecar up to 2s to exit on its own after `shutdown`.
            if wait_up_to(&mut child, Duration::from_secs(2)) {
                return;
            }
            let _ = child.kill();
            // And up to 2 more seconds to actually die after SIGKILL. `wait()` itself can
            // block forever on a process stuck in an uninterruptible kernel state, so this
            // never escalates to a blocking wait — Drop must stay bounded no matter what.
            if !wait_up_to(&mut child, Duration::from_secs(2)) {
                eprintln!(
                    "sourceweft-desktop: sandbox sidecar (pid {}) did not exit after SIGKILL; abandoning it",
                    child.id()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    const STUB: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stub-sidecar.sh");

    fn bundle_with_stub() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("srt-sidecar");
        fs::copy(STUB, &target).unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
        // Force the copy to disk before any test execs it. Under heavy parallel test load on
        // an overlayfs-backed container filesystem, exec-ing a just-written file can transiently
        // fail with ETXTBSY ("Text file busy") if the copy-up hasn't settled yet; an explicit
        // fsync here (observed to close the race in practice) is cheap insurance against that,
        // confined to this test helper rather than touching `Sidecar::start` itself.
        fs::File::open(&target).unwrap().sync_all().unwrap();
        dir
    }

    fn test_init() -> InitConfig {
        InitConfig {
            platform: Platform::Darwin,
            home: "/tmp/sourceweft-sidecar-test-home".to_string(),
            workspace_roots: vec!["/tmp/sourceweft-sidecar-test-workspace".to_string()],
            read_roots: vec![],
            helpers: Helpers {
                ripgrep: "/usr/bin/rg".to_string(),
                apply_seccomp: None,
                java_agent_jar: None,
            },
            bwrap_path: None,
        }
    }

    #[test]
    fn wrap_returns_argv_and_env() {
        let bundle = bundle_with_stub();
        let sidecar = Sidecar::start(bundle.path(), &test_init()).unwrap();
        let wrapped = sidecar
            .wrap(
                "cmd-1",
                "echo hi",
                Path::new("/tmp"),
                Path::new("/tmp/sourceweft-sidecar-test-workspace"),
            )
            .unwrap();
        assert_eq!(wrapped.argv, vec!["/bin/echo".to_string(), "hi".to_string()]);
        assert!(wrapped.env.contains(&("FOO".to_string(), "bar".to_string())));
    }

    #[test]
    fn sidecar_error_code_is_preserved() {
        let bundle = bundle_with_stub();
        let sidecar = Sidecar::start(bundle.path(), &test_init()).unwrap();
        let error = sidecar
            .wrap(
                "cmd-2",
                "ERROR:HELPER_MISSING",
                Path::new("/tmp"),
                Path::new("/tmp/sourceweft-sidecar-test-workspace"),
            )
            .unwrap_err();
        assert_eq!(error.code, "HELPER_MISSING");
    }

    #[test]
    fn dead_sidecar_is_sandbox_unavailable() {
        let bundle = bundle_with_stub();
        let mut init = test_init();
        init.home = "/tmp/sourceweft-sidecar-test-home/exit-after-init".to_string();
        let sidecar = Sidecar::start_with_timeout(bundle.path(), &init, Duration::from_secs(5))
            .expect("init reply arrives before the stub exits");
        let error = sidecar.probe().unwrap_err();
        assert_eq!(error.code, "SANDBOX_UNAVAILABLE");
    }

    #[test]
    fn no_reply_times_out() {
        let bundle = bundle_with_stub();
        let sidecar =
            Sidecar::start_with_timeout(bundle.path(), &test_init(), Duration::from_secs(3))
                .unwrap();
        let started = Instant::now();
        let error = sidecar
            .wrap(
                "cmd-3",
                "HANG",
                Path::new("/tmp"),
                Path::new("/tmp/sourceweft-sidecar-test-workspace"),
            )
            .unwrap_err();
        assert_eq!(error.code, "SANDBOX_UNAVAILABLE");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "expected the 3s sidecar timeout to fire well before the stub's 10s sleep ends"
        );
    }

    #[test]
    fn desynced_sidecar_fails_fast_on_second_call() {
        let bundle = bundle_with_stub();
        let sidecar =
            Sidecar::start_with_timeout(bundle.path(), &test_init(), Duration::from_secs(3))
                .unwrap();
        let first = sidecar
            .wrap(
                "cmd-5",
                "HANG",
                Path::new("/tmp"),
                Path::new("/tmp/sourceweft-sidecar-test-workspace"),
            )
            .unwrap_err();
        assert_eq!(first.code, "SANDBOX_UNAVAILABLE");

        // The stub never replied to "cmd-5"; any later call must not wait around for that
        // stale reply (or any real reply at all) to decide this connection is unusable.
        let started = Instant::now();
        let second = sidecar.probe().unwrap_err();
        assert_eq!(second.code, "SANDBOX_UNAVAILABLE");
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "expected a poisoned Sidecar to fail fast, not wait out another timeout: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn environment_has_no_proxy() {
        let bundle = bundle_with_stub();
        let sidecar = Sidecar::start(bundle.path(), &test_init()).unwrap();
        let names = sidecar.violations("cmd-4", "DUMP_ENV").unwrap();
        assert!(
            !names.to_uppercase().contains("PROXY"),
            "sidecar environment leaked a proxy variable: {names}"
        );
    }
}
