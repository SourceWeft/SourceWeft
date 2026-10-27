//! Network approvals for sandboxed commands (Linux sidecar path).
//!
//! The sidecar decides every outbound connection; for a host it has no rule for, it emits an
//! unsolicited `ask` event while the command keeps running. [`NetworkBridge`] turns that event
//! into a `network.ask` message on the device's WebSocket, waits for the backend's
//! `network.decision`, and hands the answer back to the sidecar. It fails closed everywhere: no
//! connection, no single active command, a cancelled or finished command, a dropped socket or a
//! timeout all deny.
//!
//! The bridge is platform independent (it only knows closures and JSON); `srt_exec.rs` wires
//! it to the sidecar's event handler. The macOS Seatbelt path never asks (decision N7).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

/// How long the host waits for the backend before denying (decision N8: the backend's own
/// window is 120 s; this is the backstop). Deliberately a few seconds below the sidecar's own
/// 150 s ask timeout (`ASK_TIMEOUT_MS` in `network-policy.ts`), which is only a backstop for a
/// host that never answers: the bridge must be the first to deny, so the denial carries the
/// bridge's reason.
pub const ASK_TIMEOUT: Duration = Duration::from_secs(145);
/// An ask is never held until the command's own kill deadline: the denial must reach the
/// sidecar early enough for the command to notice it and finish by itself (so its output
/// carries the `<sandbox_violations>` text) instead of being killed with exit 124.
pub const DEADLINE_MARGIN: Duration = Duration::from_secs(10);
/// How often a waiting ask re-checks whether its command was cancelled.
const CANCEL_POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Open,
    Ask,
    Strict,
}

/// The `network` object of a `command.execute` payload, forwarded verbatim to the sidecar's
/// `wrap` (camelCase on both wires). `suggested` is domain -> skill name, display only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicy {
    pub mode: NetworkMode,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub suggested: BTreeMap<String, String>,
}

impl NetworkPolicy {
    /// Reads `payload.network`. Absent or null means "no policy" (the sidecar treats that as
    /// `open`); a present but malformed value is an error rather than a silent downgrade.
    pub fn from_payload(payload: &Value) -> super::Result<Option<NetworkPolicy>> {
        match payload.get("network") {
            None | Some(Value::Null) => Ok(None),
            Some(value) => serde_json::from_value(value.clone()).map(Some).map_err(|error| {
                super::HostError::new("INVALID_CALL", format!("Invalid network policy: {error}"))
            }),
        }
    }
}

/// Whether `host:port` is well-formed enough to put in a `network.ask`: a DNS-style name of
/// 1..=253 characters from `[A-Za-z0-9._-]`, or a bracket-free IPv6 literal of `[0-9a-fA-F:.]`
/// (anything containing a colon), and a nonzero port. Control characters, whitespace and
/// everything else fail.
fn is_relayable_target(host: &str, port: u16) -> bool {
    if port == 0 || host.is_empty() || host.len() > 253 {
        return false;
    }
    if host.contains(':') {
        host.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
    } else {
        host.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    }
}

/// An `ask` event from the sidecar: a connection that matched no rule.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskEvent {
    pub ask_id: String,
    #[serde(default)]
    pub command_id: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub suggested_by: Option<String>,
}

/// The answer to one ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub allow: bool,
    pub reason: Option<String>,
}

impl Decision {
    fn deny(reason: &str) -> Self {
        Self {
            allow: false,
            reason: Some(reason.to_string()),
        }
    }
}

/// Delivers a [`Decision`] back to whoever asked (in production: the sidecar's responder).
pub type Reply = Box<dyn FnOnce(Decision) + Send>;

struct Pending {
    invocation: String,
    /// The connection whose channel carried the `network.ask`; only that connection's close or
    /// decisions touch this ask.
    connection: u64,
    answer: mpsc::Sender<Decision>,
}

struct Active {
    invocation: String,
    /// When the command is killed for running too long (start + its `timeoutMs`).
    kill_deadline: Instant,
    /// The sidecar's id for the command this invocation is running, registered before the
    /// command is wrapped. An ask naming any other command is not this invocation's.
    command_id: Option<String>,
    cancel: Arc<AtomicBool>,
}

struct Outbound {
    connection: u64,
    sender: tokio::sync::mpsc::UnboundedSender<Value>,
}

#[derive(Default)]
struct State {
    outbound: Option<Outbound>,
    next_connection: u64,
    active: Vec<Active>,
    /// Keyed by the bridge's own device-unique ask id, so ids from different sidecar
    /// instances (a restarted sidecar reuses its counter) can never collide on the backend.
    pending: HashMap<String, Pending>,
}

struct Inner {
    state: Mutex<State>,
    timeout: Duration,
    margin: Duration,
}

/// Cheap to clone; every clone shares one state.
#[derive(Clone)]
pub struct NetworkBridge {
    inner: Arc<Inner>,
}

impl Default for NetworkBridge {
    fn default() -> Self {
        Self::with_timeout(ASK_TIMEOUT)
    }
}

/// Marks one invocation as the active command for its lifetime; dropping it ends the command
/// and denies whatever it still had pending.
pub struct ActiveCommand {
    bridge: NetworkBridge,
    invocation: String,
}

impl ActiveCommand {
    /// Registers the sidecar's id for the command about to be wrapped, so that only asks naming
    /// it are attributed to this invocation. Call before `wrap`: the first ask can follow the
    /// wrap reply immediately.
    pub fn set_command_id(&self, command_id: &str) {
        let mut state = self.bridge.state();
        if let Some(active) = state
            .active
            .iter_mut()
            .find(|a| a.invocation == self.invocation)
        {
            active.command_id = Some(command_id.to_string());
        }
    }
}

impl Drop for ActiveCommand {
    fn drop(&mut self) {
        self.bridge.end(&self.invocation);
    }
}

/// One WebSocket connection's hold on the bridge's outbound slot. Dropping it clears the slot
/// and denies the asks sent over *this* connection — but only if it is still the current one:
/// an old connection's future that exits late (after a re-enrol attached a new connection) must
/// not touch the new connection's channel or asks.
pub struct OutboundLease {
    bridge: NetworkBridge,
    connection: u64,
}

impl OutboundLease {
    /// A `network.decision` that arrived on this connection. Returns whether an ask of this
    /// connection was waiting; unknown, already-settled (the backend delivers at least once) and
    /// other connections' asks are ignored.
    pub fn resolve(&self, ask_id: &str, allow: bool, reason: Option<String>) -> bool {
        self.bridge
            .settle(ask_id, Some(self.connection), Decision { allow, reason })
    }
}

impl Drop for OutboundLease {
    fn drop(&mut self) {
        self.bridge.detach(self.connection);
    }
}

impl NetworkBridge {
    pub fn with_timeout(timeout: Duration) -> Self {
        Self::with_limits(timeout, DEADLINE_MARGIN)
    }

    /// `timeout`: the longest an ask waits. `margin`: how long before the command's kill
    /// deadline an ask must be settled (tests shrink both).
    pub fn with_limits(timeout: Duration, margin: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                timeout,
                margin,
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // Plain maps and a sender; nothing half-written survives a panic elsewhere.
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Installs the channel `remote_host::connection()` drains to its WebSocket, replacing any
    /// earlier connection's. The returned lease owns the slot: see [`OutboundLease`].
    pub fn attach(&self, sender: tokio::sync::mpsc::UnboundedSender<Value>) -> OutboundLease {
        let mut state = self.state();
        state.next_connection += 1;
        let connection = state.next_connection;
        state.outbound = Some(Outbound { connection, sender });
        OutboundLease {
            bridge: self.clone(),
            connection,
        }
    }

    fn detach(&self, connection: u64) {
        let drained = {
            let mut state = self.state();
            if state
                .outbound
                .as_ref()
                .is_some_and(|outbound| outbound.connection == connection)
            {
                state.outbound = None;
            }
            let ids: Vec<String> = state
                .pending
                .iter()
                .filter(|(_, p)| p.connection == connection)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| state.pending.remove(&id))
                .collect::<Vec<_>>()
        };
        for pending in drained {
            let _ = pending.answer.send(Decision::deny("device disconnected"));
        }
    }

    /// Records `invocation` as running a command. Commands run serially per device; if more
    /// than one is somehow active, asks are treated as having no active command.
    ///
    /// `kill_deadline` is when the command will be killed for running too long. Asks wait at
    /// most until `margin` before it, and an ask that arrives later than that is denied at once
    /// (`approval timed out`), so a denial always reaches the command while it can still react.
    pub fn begin(
        &self,
        invocation: &str,
        cancel: Arc<AtomicBool>,
        kill_deadline: Instant,
    ) -> ActiveCommand {
        self.state().active.push(Active {
            invocation: invocation.to_string(),
            kill_deadline,
            command_id: None,
            cancel,
        });
        ActiveCommand {
            bridge: self.clone(),
            invocation: invocation.to_string(),
        }
    }

    fn end(&self, invocation: &str) {
        let drained = {
            let mut state = self.state();
            if let Some(index) = state.active.iter().position(|a| a.invocation == invocation) {
                state.active.remove(index);
            }
            let ids: Vec<String> = state
                .pending
                .iter()
                .filter(|(_, p)| p.invocation == invocation)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| state.pending.remove(&id))
                .collect::<Vec<_>>()
        };
        for pending in drained {
            let _ = pending.answer.send(Decision::deny("command finished"));
        }
    }

    /// The backend answered (`network.decision`), from any connection. Returns whether an ask
    /// was waiting. Connections use [`OutboundLease::resolve`].
    pub fn resolve(&self, ask_id: &str, allow: bool, reason: Option<String>) -> bool {
        self.settle(ask_id, None, Decision { allow, reason })
    }

    fn settle(&self, ask_id: &str, connection: Option<u64>, decision: Decision) -> bool {
        let pending = {
            let mut state = self.state();
            match state.pending.get(ask_id) {
                Some(p) if connection.is_none_or(|c| p.connection == c) => {
                    state.pending.remove(ask_id)
                }
                _ => None,
            }
        };
        match pending {
            Some(pending) => {
                let _ = pending.answer.send(decision);
                true
            }
            None => false,
        }
    }

    /// Handles one sidecar ask without blocking the caller (the sidecar's reader thread):
    /// the wait happens on a thread of its own, which then calls `reply` exactly once.
    pub fn on_ask(&self, event: AskEvent, reply: Reply) {
        let bridge = self.clone();
        let spawned = std::thread::Builder::new()
            .name("network-ask".into())
            .spawn(move || {
                let decision = bridge.decide(&event);
                reply(decision);
            });
        if let Err(error) = spawned {
            // The closure (and with it `reply`) is gone; the sidecar's own timeout denies.
            eprintln!("sourceweft-desktop: could not start network ask thread: {error}");
        }
    }

    /// Blocks until the ask has an answer. Public for tests; production goes through `on_ask`.
    pub fn decide(&self, event: &AskEvent) -> Decision {
        // The host comes from a sandboxed command's own request, so it is untrusted input: a
        // malformed one is refused here and never reaches the backend.
        if !is_relayable_target(&event.host, event.port) {
            return Decision::deny("invalid host");
        }
        let (answer, receiver) = mpsc::channel();
        let ask_id = uuid::Uuid::new_v4().to_string();
        let wait_budget;
        let cancel = {
            let mut state = self.state();
            let Some((connection, outbound)) = state
                .outbound
                .as_ref()
                .map(|o| (o.connection, o.sender.clone()))
            else {
                return Decision::deny("device is offline");
            };
            match state.active.len() {
                0 => return Decision::deny("no active command"),
                1 => {}
                _ => return Decision::deny("ambiguous active commands"),
            }
            let invocation = state.active[0].invocation.clone();
            if state.active[0].command_id.as_deref() != Some(event.command_id.as_str()) {
                return Decision::deny("ask for a different command");
            }
            let cancel = state.active[0].cancel.clone();
            // Settle the ask before the command's own kill deadline (see `DEADLINE_MARGIN`).
            let remaining = state.active[0]
                .kill_deadline
                .saturating_duration_since(Instant::now());
            let Some(budget) = remaining.checked_sub(self.inner.margin) else {
                return Decision::deny("approval timed out");
            };
            if budget.is_zero() {
                return Decision::deny("approval timed out");
            }
            wait_budget = budget.min(self.inner.timeout);
            state.pending.insert(
                ask_id.clone(),
                Pending {
                    invocation: invocation.clone(),
                    connection,
                    answer,
                },
            );
            let message = json!({
                "type": "network.ask",
                "id": invocation,
                "askId": ask_id,
                "host": event.host,
                "port": event.port,
            });
            if outbound.send(message).is_err() {
                state.pending.remove(&ask_id);
                return Decision::deny("device is offline");
            }
            cancel
        };
        let deadline = Instant::now() + wait_budget;
        loop {
            let now = Instant::now();
            let wait = deadline.saturating_duration_since(now).min(CANCEL_POLL);
            match receiver.recv_timeout(wait) {
                Ok(decision) => return decision,
                Err(RecvTimeoutError::Disconnected) => {
                    return Decision::deny("device disconnected");
                }
                Err(RecvTimeoutError::Timeout) => {
                    if cancel.load(Ordering::SeqCst) {
                        self.state().pending.remove(&ask_id);
                        return Decision::deny("command cancelled");
                    }
                    if Instant::now() >= deadline {
                        self.state().pending.remove(&ask_id);
                        return Decision::deny("approval timed out");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(host: &str) -> AskEvent {
        AskEvent {
            ask_id: "ask-1".into(),
            command_id: "cmd".into(),
            host: host.into(),
            port: 443,
            suggested_by: None,
        }
    }

    fn connected(
        bridge: &NetworkBridge,
    ) -> (OutboundLease, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        (bridge.attach(sender), receiver)
    }

    /// A kill deadline that never matters in a test.
    fn far() -> Instant {
        Instant::now() + Duration::from_secs(3600)
    }

    /// `begin` plus the command-id registration `srt_exec` does before wrapping.
    fn begin_cmd(bridge: &NetworkBridge, invocation: &str, cancel: Arc<AtomicBool>) -> ActiveCommand {
        let active = bridge.begin(invocation, cancel, far());
        active.set_command_id("cmd");
        active
    }

    fn spawn_decide(bridge: &NetworkBridge, event: AskEvent) -> std::thread::JoinHandle<Decision> {
        let bridge = bridge.clone();
        std::thread::spawn(move || bridge.decide(&event))
    }

    fn next_frame(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(frame) = receiver.try_recv() {
                return frame;
            }
            assert!(Instant::now() < deadline, "no frame sent");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn offline_and_no_command_deny_immediately() {
        let bridge = NetworkBridge::default();
        let offline = bridge.decide(&ask("a.com"));
        assert_eq!(offline, Decision::deny("device is offline"));
        let (_lease, _frames) = connected(&bridge);
        let idle = bridge.decide(&ask("a.com"));
        assert_eq!(idle, Decision::deny("no active command"));
    }

    #[test]
    fn two_active_commands_count_as_none() {
        let bridge = NetworkBridge::default();
        let (_lease, mut frames) = connected(&bridge);
        let _a = begin_cmd(&bridge, "one", Arc::default());
        let _b = begin_cmd(&bridge, "two", Arc::default());
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("ambiguous active commands"));
        assert!(frames.try_recv().is_err());
    }

    #[test]
    fn ask_is_sent_and_the_decision_resolves_it() {
        let bridge = NetworkBridge::default();
        let (_lease, mut frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv-1", Arc::default());
        let waiting = spawn_decide(&bridge, ask("example.com"));
        let frame = next_frame(&mut frames);
        assert_eq!(frame["type"], "network.ask");
        assert_eq!(frame["id"], "inv-1");
        assert_eq!(frame["host"], "example.com");
        assert_eq!(frame["port"], 443);
        let ask_id = frame["askId"].as_str().unwrap().to_string();
        assert!(!waiting.is_finished());
        assert!(bridge.resolve(&ask_id, true, None));
        assert_eq!(
            waiting.join().unwrap(),
            Decision {
                allow: true,
                reason: None
            }
        );
        // A late or repeated decision finds nothing waiting.
        assert!(!bridge.resolve(&ask_id, false, None));
    }

    #[test]
    fn a_deny_carries_its_reason() {
        let bridge = NetworkBridge::default();
        let (_lease, mut frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        let waiting = spawn_decide(&bridge, ask("example.com"));
        let ask_id = next_frame(&mut frames)["askId"].as_str().unwrap().to_string();
        bridge.resolve(&ask_id, false, Some("user said no".into()));
        assert_eq!(
            waiting.join().unwrap(),
            Decision {
                allow: false,
                reason: Some("user said no".into())
            }
        );
    }

    #[test]
    fn the_ask_ids_sent_to_the_backend_are_unique_even_for_equal_sidecar_ids() {
        let bridge = NetworkBridge::default();
        let (_lease, mut frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        let first = spawn_decide(&bridge, ask("a.com"));
        let second = spawn_decide(&bridge, ask("b.com"));
        let one = next_frame(&mut frames)["askId"].as_str().unwrap().to_string();
        let two = next_frame(&mut frames)["askId"].as_str().unwrap().to_string();
        assert_ne!(one, two);
        bridge.resolve(&one, true, None);
        bridge.resolve(&two, true, None);
        assert!(first.join().unwrap().allow);
        assert!(second.join().unwrap().allow);
    }

    #[test]
    fn cancelling_the_invocation_denies_its_pending_ask() {
        let bridge = NetworkBridge::default();
        let (_lease, mut frames) = connected(&bridge);
        let cancel = Arc::new(AtomicBool::new(false));
        let _active = begin_cmd(&bridge, "inv", cancel.clone());
        let waiting = spawn_decide(&bridge, ask("example.com"));
        let ask_id = next_frame(&mut frames)["askId"].as_str().unwrap().to_string();
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(waiting.join().unwrap(), Decision::deny("command cancelled"));
        assert!(!bridge.resolve(&ask_id, true, None));
    }

    #[test]
    fn disconnect_denies_all_pending_asks() {
        let bridge = NetworkBridge::default();
        let (lease, mut frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        let first = spawn_decide(&bridge, ask("a.com"));
        let second = spawn_decide(&bridge, ask("b.com"));
        next_frame(&mut frames);
        next_frame(&mut frames);
        drop(lease);
        assert_eq!(first.join().unwrap(), Decision::deny("device disconnected"));
        assert_eq!(second.join().unwrap(), Decision::deny("device disconnected"));
        // And a new ask now sees an offline device.
        assert_eq!(bridge.decide(&ask("c.com")), Decision::deny("device is offline"));
    }

    #[test]
    fn the_end_of_a_command_denies_what_it_left_pending() {
        let bridge = NetworkBridge::default();
        let (_lease, mut frames) = connected(&bridge);
        let active = begin_cmd(&bridge, "inv", Arc::default());
        let waiting = spawn_decide(&bridge, ask("a.com"));
        next_frame(&mut frames);
        drop(active);
        assert_eq!(waiting.join().unwrap(), Decision::deny("command finished"));
    }

    #[test]
    fn no_answer_times_out_as_a_denial() {
        let bridge = NetworkBridge::with_timeout(Duration::from_millis(300));
        let (_lease, _frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        let started = Instant::now();
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("approval timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_closed_outbound_channel_is_offline() {
        let bridge = NetworkBridge::default();
        let (_lease, frames) = connected(&bridge);
        drop(frames);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("device is offline"));
    }

    #[test]
    fn on_ask_does_not_block_and_replies_once() {
        let bridge = NetworkBridge::default();
        let (_lease, mut frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        let (done, answered) = mpsc::channel();
        let started = Instant::now();
        bridge.on_ask(
            ask("example.com"),
            Box::new(move |decision| {
                let _ = done.send(decision);
            }),
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        let ask_id = next_frame(&mut frames)["askId"].as_str().unwrap().to_string();
        bridge.resolve(&ask_id, true, None);
        let decision = answered.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(decision.allow);
    }

    #[test]
    fn policy_parses_from_the_payload_and_defaults_are_empty() {
        let payload = json!({"network": {"mode": "ask", "allow": ["a.com"], "suggested": {"b.com": "skill-x"}}});
        let policy = NetworkPolicy::from_payload(&payload).unwrap().unwrap();
        assert_eq!(policy.mode, NetworkMode::Ask);
        assert_eq!(policy.allow, ["a.com"]);
        assert_eq!(policy.suggested["b.com"], "skill-x");
        let bare = NetworkPolicy::from_payload(&json!({"network": {"mode": "strict"}}))
            .unwrap()
            .unwrap();
        assert!(bare.allow.is_empty() && bare.suggested.is_empty());
        assert!(NetworkPolicy::from_payload(&json!({})).unwrap().is_none());
        assert!(NetworkPolicy::from_payload(&json!({"network": null})).unwrap().is_none());
    }

    #[test]
    fn a_malformed_policy_is_rejected_not_downgraded() {
        for bad in [
            json!({"network": {"mode": "wide-open"}}),
            json!({"network": {"allow": []}}),
            json!({"network": "open"}),
            json!({"network": {"mode": "ask", "allow": "a.com"}}),
        ] {
            let error = NetworkPolicy::from_payload(&bad).unwrap_err();
            assert_eq!(error.code, "INVALID_CALL", "{bad}");
        }
    }

    #[test]
    fn the_policy_serialises_in_the_sidecar_wire_shape() {
        let policy = NetworkPolicy {
            mode: NetworkMode::Ask,
            allow: vec!["a.com".into()],
            suggested: BTreeMap::from([("a.com".into(), "skill".into())]),
        };
        assert_eq!(
            serde_json::to_string(&policy).unwrap(),
            r#"{"mode":"ask","allow":["a.com"],"suggested":{"a.com":"skill"}}"#
        );
    }

    #[test]
    fn an_ask_for_another_command_or_an_unregistered_one_is_denied() {
        let bridge = NetworkBridge::default();
        let (_lease, mut frames) = connected(&bridge);
        let active = bridge.begin("inv", Arc::default(), far());
        // No sidecar command id registered yet: fail closed.
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("ask for a different command"));
        active.set_command_id("cmd-mine");
        let mut other = ask("a.com");
        other.command_id = "cmd-other".into();
        assert_eq!(bridge.decide(&other), Decision::deny("ask for a different command"));
        assert!(frames.try_recv().is_err(), "nothing may reach the backend");
        let mut mine = ask("a.com");
        mine.command_id = "cmd-mine".into();
        let waiting = spawn_decide(&bridge, mine);
        let frame = next_frame(&mut frames);
        assert!(bridge.resolve(frame["askId"].as_str().unwrap(), true, None));
        assert!(waiting.join().unwrap().allow);
    }

    #[test]
    fn closing_an_old_connection_leaves_the_new_one_working() {
        let bridge = NetworkBridge::default();
        let (old_lease, mut old_frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        let on_old = spawn_decide(&bridge, ask("old.example.com"));
        let old_ask = next_frame(&mut old_frames)["askId"].as_str().unwrap().to_string();

        // A re-enrol attaches a new connection before the old future has exited.
        let (new_lease, mut new_frames) = connected(&bridge);
        let on_new = spawn_decide(&bridge, ask("new.example.com"));
        let new_ask = next_frame(&mut new_frames)["askId"].as_str().unwrap().to_string();

        // The old connection finally closes: only its own ask is denied...
        drop(old_lease);
        assert_eq!(on_old.join().unwrap(), Decision::deny("device disconnected"));
        // ...the new connection's ask is untouched and still answerable...
        assert!(!on_new.is_finished());
        assert!(new_lease.resolve(&new_ask, true, None));
        assert!(on_new.join().unwrap().allow);
        // ...and the new channel is still installed.
        let third = spawn_decide(&bridge, ask("third.example.com"));
        let third_ask = next_frame(&mut new_frames)["askId"].as_str().unwrap().to_string();
        assert!(bridge.resolve(&third_ask, false, None));
        assert!(!third.join().unwrap().allow);
        assert!(!bridge.resolve(&old_ask, true, None));
    }

    #[test]
    fn a_connection_only_settles_its_own_asks() {
        let bridge = NetworkBridge::default();
        let (old_lease, mut old_frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        let waiting = spawn_decide(&bridge, ask("a.com"));
        let ask_id = next_frame(&mut old_frames)["askId"].as_str().unwrap().to_string();
        let (new_lease, _new_frames) = connected(&bridge);
        // A decision arriving on the other connection does not settle it.
        assert!(!new_lease.resolve(&ask_id, true, None));
        assert!(!waiting.is_finished());
        assert!(old_lease.resolve(&ask_id, true, None));
        assert!(waiting.join().unwrap().allow);
        // At-least-once delivery: a repeat is ignored.
        assert!(!old_lease.resolve(&ask_id, false, None));
    }

    #[test]
    fn the_last_connection_closing_goes_offline() {
        let bridge = NetworkBridge::default();
        let (lease, _frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        drop(lease);
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("device is offline"));
    }

    #[test]
    fn malformed_targets_are_refused_without_contacting_the_backend() {
        let bridge = NetworkBridge::default();
        let (_lease, mut frames) = connected(&bridge);
        let _active = begin_cmd(&bridge, "inv", Arc::default());
        let long = format!("{}.com", "a".repeat(300));
        let edge = "a".repeat(253);
        for (host, port) in [
            (long.as_str(), 443),
            ("evil\0.com", 443),
            ("evil\n.com", 443),
            ("evil\r\nHost: x", 443),
            ("with space.com", 443),
            ("[::1]", 443),
            ("ünicode.com", 443),
            ("", 443),
            ("example.com", 0),
            ("1::g", 443),
        ] {
            let mut event = ask(host);
            event.port = port;
            assert_eq!(
                bridge.decide(&event),
                Decision::deny("invalid host"),
                "{host:?}:{port}"
            );
        }
        assert!(frames.try_recv().is_err(), "nothing may be relayed");
        // The longest legal name and IPv6/IP literals are relayed.
        for host in [edge.as_str(), "2001:db8::1", "::ffff:1.2.3.4", "a-b_c.example.com", "93.184.216.34"] {
            let worker = bridge.clone();
            let event = ask(host);
            let waiting = std::thread::spawn(move || worker.decide(&event));
            let frame = next_frame(&mut frames);
            assert_eq!(frame["host"], host);
            assert!(!waiting.is_finished());
            assert!(frames.try_recv().is_err());
            // Answer it so the thread ends.
            let id = frame["askId"].as_str().unwrap().to_string();
            for _ in 0..200 {
                if waiting.is_finished() {
                    break;
                }
                bridge.resolve(&id, true, None);
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(waiting.join().unwrap().allow);
        }
    }

    // ---- ask waits follow the command's own kill deadline ----

    /// A bridge whose ask timeout is `timeout` and whose margin is `margin`, with one command
    /// that will be killed `kill_in` from now.
    fn bridge_killed_in(
        timeout: Duration,
        margin: Duration,
        kill_in: Duration,
        cancel: Arc<AtomicBool>,
    ) -> (
        NetworkBridge,
        OutboundLease,
        tokio::sync::mpsc::UnboundedReceiver<Value>,
        ActiveCommand,
    ) {
        let bridge = NetworkBridge::with_limits(timeout, margin);
        let (lease, frames) = connected(&bridge);
        let active = bridge.begin("inv", cancel, Instant::now() + kill_in);
        active.set_command_id("cmd");
        (bridge, lease, frames, active)
    }

    #[test]
    fn an_ask_waits_only_until_the_margin_before_the_kill_deadline() {
        // 30 s-style case, scaled: killed in 1.2 s, margin 0.4 s => waits ~0.8 s, then denies.
        let (bridge, _lease, mut frames, _active) = bridge_killed_in(
            Duration::from_secs(60),
            Duration::from_millis(400),
            Duration::from_millis(1200),
            Arc::default(),
        );
        let started = Instant::now();
        let waiting = spawn_decide(&bridge, ask("a.com"));
        let id = next_frame(&mut frames)["askId"].as_str().unwrap().to_string();
        let decision = waiting.join().unwrap();
        let waited = started.elapsed();
        assert_eq!(decision, Decision::deny("approval timed out"));
        assert!(waited >= Duration::from_millis(600), "{waited:?}");
        assert!(waited <= Duration::from_millis(1100), "must answer before the kill: {waited:?}");
        // The ask is settled: a late decision finds nothing.
        assert!(!bridge.resolve(&id, true, None));
    }

    #[test]
    fn an_ask_arriving_inside_the_margin_is_denied_immediately_and_not_relayed() {
        let (bridge, _lease, mut frames, _active) = bridge_killed_in(
            Duration::from_secs(60),
            Duration::from_millis(400),
            Duration::from_millis(250),
            Arc::default(),
        );
        let started = Instant::now();
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("approval timed out"));
        assert!(started.elapsed() < Duration::from_millis(100), "{:?}", started.elapsed());
        assert!(frames.try_recv().is_err(), "nothing may reach the backend");
        // Already past the deadline: same.
        let (bridge, _lease, _frames, _active) = bridge_killed_in(
            Duration::from_secs(60),
            Duration::from_millis(400),
            Duration::ZERO,
            Arc::default(),
        );
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("approval timed out"));
    }

    #[test]
    fn a_long_command_still_waits_for_the_full_ask_timeout() {
        let (bridge, _lease, mut frames, _active) = bridge_killed_in(
            Duration::from_millis(700),
            Duration::from_millis(100),
            Duration::from_secs(3600),
            Arc::default(),
        );
        let started = Instant::now();
        let waiting = spawn_decide(&bridge, ask("a.com"));
        next_frame(&mut frames);
        assert_eq!(waiting.join().unwrap(), Decision::deny("approval timed out"));
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(650) && waited < Duration::from_secs(3), "{waited:?}");
        // The production defaults: 145 s ask cap, 10 s margin, below the sidecar's 150 s.
        assert!(ASK_TIMEOUT < Duration::from_secs(150));
        assert_eq!(DEADLINE_MARGIN, Duration::from_secs(10));
    }

    #[test]
    fn cancel_still_wins_over_the_deadline_wait() {
        let cancel = Arc::new(AtomicBool::new(false));
        let (bridge, _lease, mut frames, _active) = bridge_killed_in(
            Duration::from_secs(60),
            Duration::from_millis(100),
            Duration::from_secs(30),
            cancel.clone(),
        );
        let waiting = spawn_decide(&bridge, ask("a.com"));
        next_frame(&mut frames);
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(waiting.join().unwrap(), Decision::deny("command cancelled"));
    }

    #[test]
    fn a_decision_just_before_the_effective_deadline_is_honoured_and_just_after_is_not() {
        // Effective wait = killed in 1.0 s - margin 0.4 s = 0.6 s.
        for (answer_after, expect_allow) in [(Duration::from_millis(350), true), (Duration::from_millis(1000), false)] {
            let (bridge, _lease, mut frames, _active) = bridge_killed_in(
                Duration::from_secs(60),
                Duration::from_millis(400),
                Duration::from_millis(1000),
                Arc::default(),
            );
            let waiting = spawn_decide(&bridge, ask("a.com"));
            let id = next_frame(&mut frames)["askId"].as_str().unwrap().to_string();
            std::thread::sleep(answer_after);
            let delivered = bridge.resolve(&id, true, None);
            let decision = waiting.join().unwrap();
            assert_eq!(decision.allow, expect_allow, "{answer_after:?}: {decision:?}");
            assert_eq!(delivered, expect_allow, "{answer_after:?}");
            if !expect_allow {
                assert_eq!(decision, Decision::deny("approval timed out"));
            }
        }
    }
}
