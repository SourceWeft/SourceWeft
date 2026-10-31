//! Rust client for the long-lived sandbox sidecar process (a Bun-compiled TypeScript
//! program that wraps commands with Anthropic's sandbox-runtime, built in a later task).
//! The host talks to it over stdin/stdout, one JSON object per line each way. This module
//! only speaks that protocol; it does not itself run the wrapped command (see
//! `local_host::process::run_wrapped`) or know where the sidecar bundle lives on disk
//! (a later task supplies `bundle: &Path`).
#![allow(dead_code)] // Wired up by a later task; keep the whole client warning-free until then.
use super::{
    network::{AskEvent, NetworkPolicy},
    HostError, Result,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// The bundle protocol version this app speaks. Must equal `SANDBOX_PROTOCOL_VERSION` in
/// `apps/desktop/sandbox-sidecar/src/protocol.ts`; keep the two in sync, and bump both whenever
/// the init, policy or wrap semantics change (for example a new `InitConfig` policy field).
/// `Sidecar::start` requires the bundle's `init` reply to report exactly this version, so a
/// bundle that predates a policy field can never run commands while ignoring that field.
pub(crate) const SANDBOX_PROTOCOL_VERSION: u32 = 2;

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
    /// Extra literal read denies (absolute paths), on top of `home`. Omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny_roots: Vec<String>,
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
        /// Absent means "no policy", which the sidecar treats as `open`.
        #[serde(skip_serializing_if = "Option::is_none")]
        network: Option<&'a NetworkPolicy>,
    },
    #[serde(rename = "violations", rename_all = "camelCase")]
    Violations {
        id: String,
        command_id: String,
        stderr: String,
    },
    #[serde(rename = "cleanup", rename_all = "camelCase")]
    Cleanup { id: String, command_id: String },
    #[serde(rename = "audit", rename_all = "camelCase")]
    Audit { id: String, command_id: String },
    #[serde(rename = "ask.reply", rename_all = "camelCase")]
    AskReply {
        id: String,
        ask_id: &'a str,
        allow: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'a str>,
    },
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
///
/// The host adds one code of its own that the sidecar never sends: `INVALID_PATH`, returned
/// before any request is written when a path the host would put on the wire (bundle, cwd,
/// workspace root, granted folder) is not valid UTF-8, since the JSON protocol carries paths
/// as strings. It reaches the backend like any other `HostError` code.
///
/// Two more host-generated codes the sidecar never sends are accepted here as passthrough so
/// they stay recognized if they ever travel through this mapping: `BUNDLE_STALE` and
/// `BUNDLE_NEWER`, produced by `check_protocol_version` when the bundle's `init` reply reports
/// a lower (or no) / higher protocol version than `SANDBOX_PROTOCOL_VERSION`.
fn map_error_code(code: &str) -> &'static str {
    match code {
        "BUNDLE_STALE" => "BUNDLE_STALE",
        "BUNDLE_NEWER" => "BUNDLE_NEWER",
        "NOT_INITIALIZED" => "NOT_INITIALIZED",
        "HELPER_MISSING" => "HELPER_MISSING",
        "SANDBOX_UNAVAILABLE" => "SANDBOX_UNAVAILABLE",
        "POLICY_INVALID" => "POLICY_INVALID",
        "BAD_REQUEST" => "BAD_REQUEST",
        _ => "SANDBOX_UNAVAILABLE",
    }
}

/// Checks the `result` of the `init` reply: it must be an object with an integer
/// `protocolVersion` equal to `SANDBOX_PROTOCOL_VERSION`. A missing result (`null`, the
/// pre-handshake reply), a missing or non-integer field, or a lower number is `BUNDLE_STALE`
/// (the bundle may silently ignore policy this app now sends); a higher number is
/// `BUNDLE_NEWER`.
fn check_protocol_version(result: &serde_json::Value) -> Result<()> {
    let ours = i64::from(SANDBOX_PROTOCOL_VERSION);
    let version = result
        .get("protocolVersion")
        .filter(|value| value.is_i64() || value.is_u64());
    match version {
        // Larger than `i64::MAX` is certainly newer than ours.
        Some(value) if value.as_i64().is_none() => Err(newer_error(&value.to_string())),
        Some(value) => {
            let theirs = value.as_i64().unwrap_or_default();
            match theirs.cmp(&ours) {
                std::cmp::Ordering::Equal => Ok(()),
                std::cmp::Ordering::Greater => Err(newer_error(&theirs.to_string())),
                std::cmp::Ordering::Less => Err(stale_error(&theirs.to_string())),
            }
        }
        None => Err(stale_error("none")),
    }
}

fn stale_error(theirs: &str) -> HostError {
    HostError::new(
        "BUNDLE_STALE",
        format!(
            "The sandbox runtime is out of date (protocol {theirs}, this app needs {SANDBOX_PROTOCOL_VERSION}). Install the update."
        ),
    )
}

fn newer_error(theirs: &str) -> HostError {
    HostError::new(
        "BUNDLE_NEWER",
        format!(
            "The sandbox runtime (protocol {theirs}) is newer than this app supports ({SANDBOX_PROTOCOL_VERSION}). Update SourceWeft."
        ),
    )
}

fn path_to_string(path: &Path) -> Result<String> {
    path.to_str().map(str::to_string).ok_or_else(|| {
        HostError::new("INVALID_PATH", format!("path is not valid UTF-8: {path:?}"))
    })
}

/// What became of an `ask.reply` sent through [`Sidecar::ask_reply`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AskReplyOutcome {
    Delivered,
    /// The sidecar had no such pending ask (late answer after its own timeout, or a repeat).
    UnknownAsk,
}

/// An unsolicited line from the sidecar: it carries `event` instead of `id`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "event")]
pub(crate) enum SidecarEvent {
    /// A connection that matched no rule; the command keeps running until it is answered.
    #[serde(rename = "ask")]
    Ask(AskEvent),
}

/// Receives sidecar events on the reader thread, together with a handle to answer asks.
/// **It must not block**: a slow handler stalls every reply behind it. Hand long work (such as
/// waiting for a human) to another thread and answer through the [`AskResponder`] later.
pub(crate) type EventHandler = Arc<dyn Fn(SidecarEvent, AskResponder) + Send + Sync>;

/// Sends `ask.reply` from threads other than the request/reply caller (the reader thread and
/// whatever thread the event handler hands the ask to). Requests it originates are
/// fire-and-forget: they carry ids prefixed `ev-`, which the reader thread recognises on the
/// way back and drops instead of delivering to the one in-flight caller, so they can never
/// desynchronize the request/reply pairing.
#[derive(Clone)]
pub(crate) struct AskResponder {
    stdin: Arc<Mutex<ChildStdin>>,
    next: Arc<AtomicU64>,
}

const EVENT_REPLY_PREFIX: &str = "ev-";

impl AskResponder {
    pub(crate) fn reply(&self, ask_id: &str, allow: bool, reason: Option<&str>) -> Result<()> {
        let id = format!(
            "{EVENT_REPLY_PREFIX}{}",
            self.next.fetch_add(1, Ordering::SeqCst)
        );
        write_request(
            &self.stdin,
            &Request::AskReply {
                id,
                ask_id,
                allow,
                reason,
            },
        )
        .map_err(|message| HostError::new("SANDBOX_UNAVAILABLE", message))
    }
}

/// Serialises `request` and writes it as one line. The lock is held for the whole line, so
/// concurrent writers (a caller and an `AskResponder`) never interleave.
fn write_request(
    stdin: &Mutex<ChildStdin>,
    request: &Request,
) -> std::result::Result<(), String> {
    let mut line = serde_json::to_string(request)
        .map_err(|error| format!("failed to encode sidecar request: {error}"))?;
    line.push('\n');
    let mut stdin = stdin
        .lock()
        .map_err(|_| "sidecar stdin lock was poisoned".to_string())?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|()| stdin.flush())
        .map_err(|error| format!("failed to write to sidecar: {error}"))
}

/// The reply half of the connection, held behind its own lock so only one request is ever in
/// flight per `Sidecar`. (Stdin is shared separately, so events can be answered meanwhile.)
struct Connection {
    replies: Receiver<String>,
}

/// What the reader thread makes of one stdout line.
enum Line {
    Event(serde_json::Value),
    /// The reply to a request the reader/handler side sent itself; nobody is waiting for it.
    /// Carries the sidecar's error message when that reply was a failure.
    Orphan(Option<String>),
    /// Anything else, including unparseable text: the in-flight caller judges it, exactly as
    /// before events existed.
    Reply,
}

fn classify(line: &str) -> Line {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(value) if value.get("event").is_some() => Line::Event(value),
        Ok(value)
            if value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|id| id.starts_with(EVENT_REPLY_PREFIX)) =>
        {
            let failure = (value.get("ok") == Some(&serde_json::Value::Bool(false))).then(|| {
                value
                    .pointer("/error/message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unspecified error")
                    .to_string()
            });
            Line::Orphan(failure)
        }
        _ => Line::Reply,
    }
}

fn dispatch_event(
    value: serde_json::Value,
    handler: &Option<EventHandler>,
    responder: &AskResponder,
) {
    let event: SidecarEvent = match serde_json::from_value(value) {
        Ok(event) => event,
        Err(error) => {
            eprintln!("sourceweft-desktop: ignoring unknown sidecar event: {error}");
            return;
        }
    };
    match handler {
        Some(handler) => {
            let responder = responder.clone();
            let handler = handler.clone();
            // A panicking handler must not kill the reader thread (that would fail every
            // later call); the ask it dropped is denied by the sidecar's own timeout.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                handler(event, responder)
            }));
            if outcome.is_err() {
                eprintln!("sourceweft-desktop: sidecar event handler panicked");
            }
        }
        None => {
            let SidecarEvent::Ask(ask) = event;
            let responder = responder.clone();
            // Off the reader thread, so a full stdin pipe can never stop us reading.
            std::thread::spawn(move || {
                let _ = responder.reply(
                    &ask.ask_id,
                    false,
                    Some("network approvals are not available"),
                );
            });
        }
    }
}

/// A handle to a running sandbox sidecar process, speaking the line-delimited JSON protocol
/// over its stdin/stdout. Stderr is left inherited so sidecar diagnostics land in the host's
/// own log. Construct with `start` / `start_with_events` (or the `_with_timeout` forms for
/// tests); every other call returns `Err(HostError { code: "SANDBOX_UNAVAILABLE", .. })` on I/O
/// failure or on not hearing back within the configured timeout, and otherwise propagates the
/// sidecar's own error code verbatim (mapped through `map_error_code`).
///
/// **Any `Err` with code `"SANDBOX_UNAVAILABLE"` means this `Sidecar` must be discarded.**
/// A timed-out, disconnected, unparseable, or mismatched-id reply means the next line read
/// from the sidecar's stdout is no longer guaranteed to be the reply to the next request —
/// the request/reply pairing has desynchronized, possibly permanently (a late reply can still
/// be sitting in the channel, waiting to be wrongly consumed by a future call). Rather than
/// try to resynchronize, every such failure latches `poisoned`, and every later call on the
/// same instance fails fast with `SANDBOX_UNAVAILABLE` without touching stdin/stdout at all.
/// Callers must start a fresh `Sidecar` instead of reusing one that has failed this way.
///
/// Unsolicited `event` lines are not part of that pairing: the reader thread routes them to
/// the event handler before they can reach the reply channel, so an event arriving while a
/// call is in flight neither satisfies nor desynchronizes it.
pub(crate) struct Sidecar {
    conn: Mutex<Connection>,
    stdin: Arc<Mutex<ChildStdin>>,
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
    /// timeout for every call made over the lifetime of the returned `Sidecar`. Network asks
    /// are all denied (there is no handler to answer them).
    pub(crate) fn start(bundle: &Path, init: &InitConfig) -> Result<Sidecar> {
        Self::start_with_timeout(bundle, init, Duration::from_secs(30))
    }

    /// Same as `start`, but sidecar events go to `handler`.
    pub(crate) fn start_with_events(
        bundle: &Path,
        init: &InitConfig,
        handler: EventHandler,
    ) -> Result<Sidecar> {
        Self::start_inner(bundle, init, Duration::from_secs(30), Some(handler))
    }

    /// Same as `start`, but with an explicit reply timeout, applied to `init` and to every
    /// later call on the returned `Sidecar`. Production code always goes through `start`;
    /// tests use this directly with a short timeout so a stuck or dead stub fails fast.
    pub(crate) fn start_with_timeout(
        bundle: &Path,
        init: &InitConfig,
        timeout: Duration,
    ) -> Result<Sidecar> {
        Self::start_inner(bundle, init, timeout, None)
    }

    pub(crate) fn start_inner(
        bundle: &Path,
        init: &InitConfig,
        timeout: Duration,
        handler: Option<EventHandler>,
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

        let stdin = Arc::new(Mutex::new(stdin));
        let responder = AskResponder {
            stdin: stdin.clone(),
            next: Arc::new(AtomicU64::new(0)),
        };
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let mut logged_failed_reply = false;
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\n', '\r']).to_string();
                        match classify(&trimmed) {
                            Line::Event(value) => dispatch_event(value, &handler, &responder),
                            // A failed `ask.reply` we sent ourselves is almost always a late
                            // answer to an ask the sidecar already timed out or finished
                            // ("no pending ask"): benign, never a desync. Say so once.
                            Line::Orphan(failure) => {
                                if let Some(message) = failure {
                                    if !logged_failed_reply {
                                        logged_failed_reply = true;
                                        eprintln!(
                                            "sourceweft-desktop: sidecar rejected an ask.reply (ignored; logged once): {message}"
                                        );
                                    }
                                }
                            }
                            Line::Reply => {
                                if sender.send(trimmed).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            // Reaching here drops `sender`, which turns every future `recv` into a prompt
            // `Disconnected` instead of a full timeout wait.
        });

        let sidecar = Sidecar {
            conn: Mutex::new(Connection { replies }),
            stdin,
            child: Mutex::new(child),
            next_id: AtomicU64::new(0),
            timeout,
            poisoned: AtomicBool::new(false),
        };
        let id = sidecar.allocate_id();
        let init_result =
            sidecar.call(&id, &Request::Init { id: id.clone(), config: init })?;
        if let Err(rejection) = check_protocol_version(&init_result) {
            // A bundle that fails the handshake must never be used, and must not linger either:
            // kill it now rather than relying on `Drop`'s polite shutdown-then-wait.
            sidecar.kill_now();
            return Err(rejection);
        }
        Ok(sidecar)
    }

    pub(crate) fn wrap(
        &self,
        command_id: &str,
        command: &str,
        cwd: &Path,
        workspace_root: &Path,
        network: Option<&NetworkPolicy>,
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
                network,
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

    /// Drains the connection/HTTP decisions recorded for `command_id`. Call it before
    /// `cleanup`, which forgets the command.
    pub(crate) fn audit(&self, command_id: &str) -> Result<Vec<serde_json::Value>> {
        #[derive(Deserialize)]
        struct AuditResult {
            entries: Vec<serde_json::Value>,
        }
        let id = self.allocate_id();
        let result = self.call(
            &id,
            &Request::Audit {
                id: id.clone(),
                command_id: command_id.to_string(),
            },
        )?;
        serde_json::from_value::<AuditResult>(result)
            .map(|audit| audit.entries)
            .map_err(|error| {
                HostError::new(
                    "SANDBOX_UNAVAILABLE",
                    format!("invalid audit result from sidecar: {error}"),
                )
            })
    }

    /// Answers a network ask through the normal request/reply path and waits for the sidecar's
    /// `ok`. Must not be called from the event handler on the reader thread (the reader has to
    /// keep reading to deliver that reply); event handlers answer through their
    /// [`AskResponder`] instead.
    ///
    /// An ask the sidecar no longer knows (already answered, or timed out on its side) is not
    /// an error and does not poison the connection: it is reported as
    /// [`AskReplyOutcome::UnknownAsk`] and logged once per process.
    pub(crate) fn ask_reply(
        &self,
        ask_id: &str,
        allow: bool,
        reason: Option<&str>,
    ) -> Result<AskReplyOutcome> {
        let id = self.allocate_id();
        match self.call(
            &id,
            &Request::AskReply {
                id: id.clone(),
                ask_id,
                allow,
                reason,
            },
        ) {
            Ok(_) => Ok(AskReplyOutcome::Delivered),
            Err(error) if error.code == "BAD_REQUEST" && error.message.starts_with("no pending ask") => {
                static LOGGED: AtomicBool = AtomicBool::new(false);
                if !LOGGED.swap(true, Ordering::SeqCst) {
                    eprintln!(
                        "sourceweft-desktop: ask.reply for an ask the sidecar no longer holds (ignored; logged once): {}",
                        error.message
                    );
                }
                Ok(AskReplyOutcome::UnknownAsk)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn probe(&self) -> Result<()> {
        let id = self.allocate_id();
        self.call(&id, &Request::Probe { id: id.clone() })?;
        Ok(())
    }

    /// Kills the child immediately (bounded wait for it to be reaped) and latches `poisoned`,
    /// for a sidecar that has been rejected and is about to be dropped.
    fn kill_now(&self) {
        self.poisoned.store(true, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = wait_up_to(&mut child, Duration::from_secs(2));
        }
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

        let conn = self
            .conn
            .lock()
            .map_err(|_| self.poison("sidecar connection lock was poisoned"))?;

        write_request(&self.stdin, request).map_err(|message| self.poison(message))?;

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
        let id = self.allocate_id();
        let _ = write_request(&self.stdin, &Request::Shutdown { id });
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
pub(crate) mod tests {
    use super::*;
    use super::super::network::NetworkMode;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn the_protocol_version_equals_the_sidecars_typescript_constant() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sandbox-sidecar/src/protocol.ts"
        ))
        .expect("the sidecar's protocol.ts");
        let declared: Vec<u32> = source
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix("export const SANDBOX_PROTOCOL_VERSION = ")?
                    .strip_suffix(';')?
                    .trim()
                    .parse()
                    .ok()
            })
            .collect();
        assert_eq!(
            declared,
            [SANDBOX_PROTOCOL_VERSION],
            "protocol.ts and sidecar.rs must declare the same SANDBOX_PROTOCOL_VERSION"
        );
    }

    const STUB: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stub-sidecar.sh");

    pub(crate) fn bundle_with_stub() -> tempfile::TempDir {
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

    pub(crate) fn test_init() -> InitConfig {
        InitConfig {
            platform: Platform::Darwin,
            home: "/tmp/sourceweft-sidecar-test-home".to_string(),
            workspace_roots: vec!["/tmp/sourceweft-sidecar-test-workspace".to_string()],
            read_roots: vec![],
            deny_roots: vec![],
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
                None,
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
                None,
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
                None,
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
                None,
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

    const WORKSPACE: &str = "/tmp/sourceweft-sidecar-test-workspace";

    fn wrap(sidecar: &Sidecar, command: &str, network: Option<&NetworkPolicy>) -> Result<WrappedCommand> {
        sidecar.wrap("cmd-ev", command, Path::new("/tmp"), Path::new(WORKSPACE), network)
    }

    /// A handler that forwards every ask to a channel and answers `allow` from `answer`.
    fn collecting_handler(
        answer: bool,
    ) -> (EventHandler, mpsc::Receiver<AskEvent>) {
        let (sender, receiver) = mpsc::channel();
        let sender = Mutex::new(sender);
        let handler: EventHandler = Arc::new(move |event, responder| {
            let SidecarEvent::Ask(ask) = event;
            let _ = responder.reply(&ask.ask_id, answer, Some("handler says so"));
            let _ = sender.lock().unwrap().send(ask);
        });
        (handler, receiver)
    }

    fn recording_init(dir: &Path) -> (InitConfig, std::path::PathBuf) {
        let mut init = test_init();
        init.home = dir.join("record-ops").to_str().unwrap().to_string();
        (init, dir.join("record-ops.log"))
    }

    fn wait_for_log(log: &Path, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = fs::read_to_string(log).unwrap_or_default();
            if text.contains(needle) {
                return text;
            }
            assert!(Instant::now() < deadline, "log never contained {needle:?}: {text}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn ask_event_after_a_reply_reaches_the_handler() {
        let bundle = bundle_with_stub();
        let (handler, asks) = collecting_handler(true);
        let sidecar =
            Sidecar::start_with_events(bundle.path(), &test_init(), handler).unwrap();
        wrap(&sidecar, "ASK:example.com:443", None).unwrap();
        let ask = asks.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(ask.ask_id, "ask-1");
        assert_eq!(ask.command_id, "cmd-ev");
        assert_eq!(ask.host, "example.com");
        assert_eq!(ask.port, 443);
        assert_eq!(ask.suggested_by, None);
    }

    #[test]
    fn an_event_arriving_mid_call_does_not_desync() {
        let bundle = bundle_with_stub();
        let (handler, asks) = collecting_handler(true);
        let sidecar =
            Sidecar::start_with_events(bundle.path(), &test_init(), handler).unwrap();
        // The stub writes the event line first, then the wrap reply.
        let wrapped = wrap(&sidecar, "EVENT_FIRST:example.com:80", None).unwrap();
        assert_eq!(wrapped.argv, ["/bin/echo", "hi"]);
        assert_eq!(asks.recv_timeout(Duration::from_secs(5)).unwrap().port, 80);
        // The framing is intact: later calls still pair with their own replies.
        sidecar.probe().unwrap();
        wrap(&sidecar, "echo ok", None).unwrap();
        sidecar.cleanup("cmd-ev").unwrap();
        assert!(!sidecar.poisoned.load(Ordering::SeqCst));
    }

    #[test]
    fn handler_answers_are_written_and_their_replies_are_not_delivered_to_callers() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = bundle_with_stub();
        let (init, log) = recording_init(dir.path());
        let (handler, asks) = collecting_handler(false);
        let sidecar = Sidecar::start_with_events(bundle.path(), &init, handler).unwrap();
        wrap(&sidecar, "ASK:example.com:443", None).unwrap();
        asks.recv_timeout(Duration::from_secs(5)).unwrap();
        let text = wait_for_log(&log, "ask.reply ask-1 false handler says so");
        assert!(text.contains("wrap cmd-ev"), "{text}");
        // The stub's `ok` for that reply carries an `ev-` id; if it leaked into the reply
        // channel the next call would see a mismatched id and poison the connection.
        sidecar.probe().unwrap();
        sidecar.probe().unwrap();
        assert!(!sidecar.poisoned.load(Ordering::SeqCst));
    }

    #[test]
    fn without_a_handler_every_ask_is_denied() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = bundle_with_stub();
        let (init, log) = recording_init(dir.path());
        let sidecar = Sidecar::start(bundle.path(), &init).unwrap();
        wrap(&sidecar, "ASK:example.com:443", None).unwrap();
        wait_for_log(&log, "ask.reply ask-1 false network approvals are not available");
        sidecar.probe().unwrap();
    }

    #[test]
    fn a_panicking_handler_does_not_kill_the_connection() {
        let bundle = bundle_with_stub();
        let handler: EventHandler = Arc::new(|_, _| panic!("boom"));
        let sidecar =
            Sidecar::start_with_events(bundle.path(), &test_init(), handler).unwrap();
        wrap(&sidecar, "EVENT_FIRST:example.com:443", None).unwrap();
        sidecar.probe().unwrap();
    }

    #[test]
    fn a_blocked_handler_thread_does_not_stall_calls() {
        // The handler hands the ask to another thread and returns. That thread stays blocked on
        // a gate the test opens only after the calls below have returned, so the calls provably
        // complete while an ask is unanswered; it then answers through the responder.
        let dir = tempfile::tempdir().unwrap();
        let bundle = bundle_with_stub();
        let (init, log) = recording_init(dir.path());
        let (open_gate, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(Some(gate));
        let handler: EventHandler = Arc::new(move |event, responder| {
            let SidecarEvent::Ask(ask) = event;
            let gate = gate.lock().unwrap().take().expect("one ask");
            std::thread::spawn(move || {
                let _ = gate.recv_timeout(Duration::from_secs(30));
                let _ = responder.reply(&ask.ask_id, true, None);
            });
        });
        let sidecar = Sidecar::start_with_events(bundle.path(), &init, handler).unwrap();
        wrap(&sidecar, "ASK:example.com:443", None).unwrap();
        // Several round trips while the ask is still unanswered.
        sidecar.probe().unwrap();
        wrap(&sidecar, "echo while-pending", None).unwrap();
        sidecar.probe().unwrap();
        let before_release = fs::read_to_string(&log).unwrap_or_default();
        assert!(
            !before_release.contains("ask.reply"),
            "the answer must not have been written yet: {before_release}"
        );
        open_gate.send(()).unwrap();
        wait_for_log(&log, "ask.reply ask-1 true");
        sidecar.probe().unwrap();
    }

    #[test]
    fn ask_reply_goes_through_the_normal_call_path() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = bundle_with_stub();
        let (init, log) = recording_init(dir.path());
        let sidecar = Sidecar::start(bundle.path(), &init).unwrap();
        assert_eq!(
            sidecar.ask_reply("ask-9", true, None).unwrap(),
            AskReplyOutcome::Delivered
        );
        sidecar.ask_reply("ask-10", false, Some("nope")).unwrap();
        let text = fs::read_to_string(&log).unwrap();
        assert!(text.contains("ask.reply ask-9 true"), "{text}");
        assert!(text.contains("ask.reply ask-10 false nope"), "{text}");
    }

    #[test]
    fn a_late_ask_reply_is_benign_and_does_not_poison() {
        let bundle = bundle_with_stub();
        let sidecar = Sidecar::start(bundle.path(), &test_init()).unwrap();
        // The stub rejects askId "ask-gone" the way the sidecar rejects an unknown or
        // already-answered one.
        assert_eq!(
            sidecar.ask_reply("ask-gone", true, None).unwrap(),
            AskReplyOutcome::UnknownAsk
        );
        sidecar.probe().unwrap();
        assert!(!sidecar.poisoned.load(Ordering::SeqCst));
    }

    #[test]
    fn a_rejected_responder_reply_is_dropped_without_a_desync() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = bundle_with_stub();
        let (init, log) = recording_init(dir.path());
        let handler: EventHandler = Arc::new(|_, responder| {
            let _ = responder.reply("ask-gone", true, None);
        });
        let sidecar = Sidecar::start_with_events(bundle.path(), &init, handler).unwrap();
        wrap(&sidecar, "EVENT_FIRST:example.com:443", None).unwrap();
        wait_for_log(&log, "ask.reply ask-gone true");
        sidecar.probe().unwrap();
        sidecar.probe().unwrap();
        assert!(!sidecar.poisoned.load(Ordering::SeqCst));
    }

    #[test]
    fn audit_returns_the_entries() {
        let bundle = bundle_with_stub();
        let sidecar = Sidecar::start(bundle.path(), &test_init()).unwrap();
        let entries = sidecar.audit("cmd-1").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["host"], "example.com");
        assert_eq!(entries[0]["source"], "approval");
    }

    #[test]
    fn an_audit_error_keeps_its_code_and_does_not_poison() {
        let bundle = bundle_with_stub();
        let sidecar = Sidecar::start(bundle.path(), &test_init()).unwrap();
        let error = sidecar.audit("AUDIT_ERROR").unwrap_err();
        assert_eq!(error.code, "BAD_REQUEST");
        sidecar.probe().unwrap();
    }

    #[test]
    fn wrap_sends_the_network_policy_and_omits_it_when_absent() {
        let bundle = bundle_with_stub();
        let sidecar = Sidecar::start(bundle.path(), &test_init()).unwrap();
        let policy = NetworkPolicy {
            mode: NetworkMode::Ask,
            allow: vec!["a.com".to_string()],
            suggested: BTreeMap::from([("a.com".to_string(), "skill".to_string())]),
        };
        let with = wrap(&sidecar, "SHOW_NETWORK", Some(&policy)).unwrap();
        assert_eq!(
            with.argv[1],
            r#"{"mode":"ask","allow":["a.com"],"suggested":{"a.com":"skill"}}"#
        );
        let without = wrap(&sidecar, "SHOW_NETWORK", None).unwrap();
        assert_eq!(without.argv[1], "");
    }

    #[test]
    fn poisoned_semantics_are_unchanged_with_a_handler_present() {
        let bundle = bundle_with_stub();
        let (handler, _asks) = collecting_handler(true);
        let sidecar = Sidecar::start_inner(
            bundle.path(),
            &test_init(),
            Duration::from_secs(4),
            Some(handler),
        )
        .unwrap();
        let first = wrap(&sidecar, "HANG", None).unwrap_err();
        assert_eq!(first.code, "SANDBOX_UNAVAILABLE");
        let started = Instant::now();
        assert_eq!(sidecar.probe().unwrap_err().code, "SANDBOX_UNAVAILABLE");
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    const STALE_STUB: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/stub-sidecar-stale.sh"
    );

    fn bundle_with_script(script: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("srt-sidecar");
        fs::copy(script, &target).unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
        // See `bundle_with_stub`: avoids an observed ETXTBSY race on overlayfs.
        fs::File::open(&target).unwrap().sync_all().unwrap();
        dir
    }

    /// `test_init` with the stub's `init.home`-suffix behaviour selector appended.
    fn init_with_stub_mode(mode: &str) -> InitConfig {
        let mut init = test_init();
        init.home = format!("/tmp/sourceweft-sidecar-test-home/{mode}");
        init
    }

    fn start_expecting_error(init: &InitConfig) -> HostError {
        let bundle = bundle_with_stub();
        match Sidecar::start_with_timeout(bundle.path(), init, Duration::from_secs(5)) {
            Ok(_) => panic!("start must reject this init reply"),
            Err(error) => error,
        }
    }

    #[test]
    fn matching_protocol_version_starts() {
        let bundle = bundle_with_stub();
        Sidecar::start_with_timeout(bundle.path(), &test_init(), Duration::from_secs(5))
            .expect("the current protocolVersion is accepted");
    }

    #[test]
    fn older_or_malformed_protocol_versions_are_bundle_stale() {
        for (mode, shown) in [
            ("protocol-null", "none"),
            ("protocol-missing", "none"),
            ("protocol-string", "none"),
            ("protocol-float", "none"),
            ("protocol-0", "0"),
            // A bundle from before the network-approval protocol (version 1): the host would
            // wrap commands with a policy it ignores, so it is rejected as out of date.
            ("protocol-1", "1"),
        ] {
            let error = start_expecting_error(&init_with_stub_mode(mode));
            assert_eq!(error.code, "BUNDLE_STALE", "{mode}");
            assert_eq!(
                error.message,
                format!(
                    "The sandbox runtime is out of date (protocol {shown}, this app needs {SANDBOX_PROTOCOL_VERSION}). Install the update."
                ),
                "{mode}"
            );
        }
    }

    #[test]
    fn a_version_1_bundle_is_rejected_with_the_install_the_update_message() {
        let error = start_expecting_error(&init_with_stub_mode("protocol-1"));
        assert_eq!(error.code, "BUNDLE_STALE");
        assert_eq!(
            error.message,
            format!(
                "The sandbox runtime is out of date (protocol 1, this app needs {SANDBOX_PROTOCOL_VERSION}). Install the update."
            )
        );
        assert!(error.message.ends_with("Install the update."));
    }

    #[test]
    fn newer_protocol_version_is_bundle_newer() {
        let error = start_expecting_error(&init_with_stub_mode("protocol-3"));
        assert_eq!(error.code, "BUNDLE_NEWER");
        assert_eq!(
            error.message,
            format!(
                "The sandbox runtime (protocol 3) is newer than this app supports ({SANDBOX_PROTOCOL_VERSION}). Update SourceWeft."
            )
        );
    }

    #[test]
    fn check_protocol_version_edge_cases() {
        use serde_json::json;
        let ours = u64::from(SANDBOX_PROTOCOL_VERSION);
        assert!(check_protocol_version(&json!({"protocolVersion": ours, "extra": true})).is_ok());
        for stale in [
            json!(null),
            json!([]),
            json!("1"),
            json!({}),
            json!({"protocolVersion": null}),
            json!({"protocolVersion": -1}),
            json!({"protocolVersion": 1.5}),
            json!({"protocolVersion": 0}),
        ] {
            assert_eq!(
                check_protocol_version(&stale).unwrap_err().code,
                "BUNDLE_STALE",
                "{stale}"
            );
        }
        assert_eq!(
            check_protocol_version(&json!({"protocolVersion": u64::MAX}))
                .unwrap_err()
                .code,
            "BUNDLE_NEWER"
        );
    }

    #[test]
    fn host_generated_bundle_codes_pass_through_map_error_code() {
        assert_eq!(map_error_code("BUNDLE_STALE"), "BUNDLE_STALE");
        assert_eq!(map_error_code("BUNDLE_NEWER"), "BUNDLE_NEWER");
        assert_eq!(map_error_code("anything else"), "SANDBOX_UNAVAILABLE");
    }

    fn process_is_alive(pid: &str) -> bool {
        std::process::Command::new("/bin/kill")
            .args(["-0", pid])
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    /// An old sidecar that ignores policy fields it does not know (here `denyRoots`) and acks
    /// `init` with `null` must be refused, killed, and never be asked to wrap anything.
    #[test]
    fn stale_sidecar_that_ignores_deny_roots_is_rejected_and_killed() {
        let bundle = bundle_with_script(STALE_STUB);
        let record = tempfile::tempdir().unwrap();
        let home = record.path().join("home");
        let log = record.path().join("home.log");
        let mut init = test_init();
        init.home = home.to_string_lossy().into_owned();
        init.deny_roots = vec!["/tmp/sourceweft-denied".to_string()];
        let error = match Sidecar::start_with_timeout(bundle.path(), &init, Duration::from_secs(5))
        {
            Ok(_) => panic!("a bundle that does not report its protocol must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.code, "BUNDLE_STALE");
        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.lines().any(|line| line == "init"), "{logged}");
        assert!(!logged.lines().any(|line| line == "wrap"), "{logged}");
        let pid = logged
            .lines()
            .find_map(|line| line.strip_prefix("pid "))
            .expect("the stub logs its pid");
        assert!(!process_is_alive(pid), "rejected sidecar {pid} is still running");
    }
}
