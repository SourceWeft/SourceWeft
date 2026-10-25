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
/// window is 120 s; this is the backstop).
pub const ASK_TIMEOUT: Duration = Duration::from_secs(150);
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
    answer: mpsc::Sender<Decision>,
}

struct Active {
    invocation: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct State {
    outbound: Option<tokio::sync::mpsc::UnboundedSender<Value>>,
    active: Vec<Active>,
    /// Keyed by the bridge's own device-unique ask id, so ids from different sidecar
    /// instances (a restarted sidecar reuses its counter) can never collide on the backend.
    pending: HashMap<String, Pending>,
}

struct Inner {
    state: Mutex<State>,
    timeout: Duration,
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

impl Drop for ActiveCommand {
    fn drop(&mut self) {
        self.bridge.end(&self.invocation);
    }
}

impl NetworkBridge {
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                timeout,
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // Plain maps and a sender; nothing half-written survives a panic elsewhere.
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Installs (or clears) the channel `remote_host::connection()` drains to the WebSocket.
    /// Clearing denies every pending ask: nobody is left to answer it.
    pub fn set_outbound(&self, outbound: Option<tokio::sync::mpsc::UnboundedSender<Value>>) {
        let drained = {
            let mut state = self.state();
            let clearing = outbound.is_none();
            state.outbound = outbound;
            if clearing {
                state.pending.drain().map(|(_, p)| p).collect::<Vec<_>>()
            } else {
                Vec::new()
            }
        };
        for pending in drained {
            let _ = pending.answer.send(Decision::deny("device disconnected"));
        }
    }

    /// The connection ended.
    pub fn disconnect(&self) {
        self.set_outbound(None);
    }

    /// Records `invocation` as running a command. Commands run serially per device; if more
    /// than one is somehow active, asks are treated as having no active command.
    pub fn begin(&self, invocation: &str, cancel: Arc<AtomicBool>) -> ActiveCommand {
        self.state().active.push(Active {
            invocation: invocation.to_string(),
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

    /// The backend answered (`network.decision`). Returns whether an ask was waiting.
    pub fn resolve(&self, ask_id: &str, allow: bool, reason: Option<String>) -> bool {
        let pending = self.state().pending.remove(ask_id);
        match pending {
            Some(pending) => {
                let _ = pending.answer.send(Decision { allow, reason });
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
        let (answer, receiver) = mpsc::channel();
        let ask_id = uuid::Uuid::new_v4().to_string();
        let cancel = {
            let mut state = self.state();
            let Some(outbound) = state.outbound.clone() else {
                return Decision::deny("device is offline");
            };
            if state.active.len() != 1 {
                return Decision::deny("no active command");
            }
            let invocation = state.active[0].invocation.clone();
            let cancel = state.active[0].cancel.clone();
            state.pending.insert(
                ask_id.clone(),
                Pending {
                    invocation: invocation.clone(),
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
        let deadline = Instant::now() + self.inner.timeout;
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
    ) -> tokio::sync::mpsc::UnboundedReceiver<Value> {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        bridge.set_outbound(Some(sender));
        receiver
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
        let _frames = connected(&bridge);
        let idle = bridge.decide(&ask("a.com"));
        assert_eq!(idle, Decision::deny("no active command"));
    }

    #[test]
    fn two_active_commands_count_as_none() {
        let bridge = NetworkBridge::default();
        let mut frames = connected(&bridge);
        let _a = bridge.begin("one", Arc::default());
        let _b = bridge.begin("two", Arc::default());
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("no active command"));
        assert!(frames.try_recv().is_err());
    }

    #[test]
    fn ask_is_sent_and_the_decision_resolves_it() {
        let bridge = NetworkBridge::default();
        let mut frames = connected(&bridge);
        let _active = bridge.begin("inv-1", Arc::default());
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
        let mut frames = connected(&bridge);
        let _active = bridge.begin("inv", Arc::default());
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
        let mut frames = connected(&bridge);
        let _active = bridge.begin("inv", Arc::default());
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
        let mut frames = connected(&bridge);
        let cancel = Arc::new(AtomicBool::new(false));
        let _active = bridge.begin("inv", cancel.clone());
        let waiting = spawn_decide(&bridge, ask("example.com"));
        let ask_id = next_frame(&mut frames)["askId"].as_str().unwrap().to_string();
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(waiting.join().unwrap(), Decision::deny("command cancelled"));
        assert!(!bridge.resolve(&ask_id, true, None));
    }

    #[test]
    fn disconnect_denies_all_pending_asks() {
        let bridge = NetworkBridge::default();
        let mut frames = connected(&bridge);
        let _active = bridge.begin("inv", Arc::default());
        let first = spawn_decide(&bridge, ask("a.com"));
        let second = spawn_decide(&bridge, ask("b.com"));
        next_frame(&mut frames);
        next_frame(&mut frames);
        bridge.disconnect();
        assert_eq!(first.join().unwrap(), Decision::deny("device disconnected"));
        assert_eq!(second.join().unwrap(), Decision::deny("device disconnected"));
        // And a new ask now sees an offline device.
        assert_eq!(bridge.decide(&ask("c.com")), Decision::deny("device is offline"));
    }

    #[test]
    fn the_end_of_a_command_denies_what_it_left_pending() {
        let bridge = NetworkBridge::default();
        let mut frames = connected(&bridge);
        let active = bridge.begin("inv", Arc::default());
        let waiting = spawn_decide(&bridge, ask("a.com"));
        next_frame(&mut frames);
        drop(active);
        assert_eq!(waiting.join().unwrap(), Decision::deny("command finished"));
    }

    #[test]
    fn no_answer_times_out_as_a_denial() {
        let bridge = NetworkBridge::with_timeout(Duration::from_millis(300));
        let _frames = connected(&bridge);
        let _active = bridge.begin("inv", Arc::default());
        let started = Instant::now();
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("approval timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_closed_outbound_channel_is_offline() {
        let bridge = NetworkBridge::default();
        let frames = connected(&bridge);
        drop(frames);
        let _active = bridge.begin("inv", Arc::default());
        assert_eq!(bridge.decide(&ask("a.com")), Decision::deny("device is offline"));
    }

    #[test]
    fn on_ask_does_not_block_and_replies_once() {
        let bridge = NetworkBridge::default();
        let mut frames = connected(&bridge);
        let _active = bridge.begin("inv", Arc::default());
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
}
