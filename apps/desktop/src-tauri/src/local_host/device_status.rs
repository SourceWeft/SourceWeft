//! The `status` message a host sends to the backend gateway: platform, shell and sandbox
//! readiness. The wire shape is validated by `apps/backend/src/modules/devices/invocation-reply.ts`
//! (`deviceStatusSchema`); everything here must satisfy it exactly, because a malformed `status`
//! closes the socket with 1008.
//!
//! A host sends `status` only to a gateway that announced it (`connected.features` contains
//! `"status"`): an older backend closes the socket on a message type it does not know.
use super::readiness::SandboxReadiness;
use serde_json::{json, Map, Value};

/// The feature name the gateway lists in `connected.features`.
const STATUS_FEATURE: &str = "status";

/// `reason` limit on the wire. The backend validates with zod's `.max(1000)`, which counts UTF-16
/// code units, so this is enforced in UTF-16 units (a character outside the BMP counts twice).
const MAX_REASON_UTF16_UNITS: usize = 1000;

/// What this host dispatches (`execution.rs`), one entry per action name. A test pins every entry
/// to a literal in `execution.rs`, so a renamed or removed action cannot stay advertised. At most
/// 32 entries of at most 64 characters (backend limit).
pub const CAPABILITIES: &[&str] = &[
    "workspace.ensure",
    "workspace.check",
    "command.execute",
    "command.cancel",
    "file.list",
    "file.read",
    "file.write",
    "file.replace",
    "file.mkdir",
    "file.grep",
    "file.binary.begin",
    "file.binary.chunk",
    "file.binary.close",
    "folder.list",
    "folder.read",
];

/// The shell sandboxed commands run under on macOS: `execution.rs` execs
/// `sandbox-exec ... /bin/sh -c <script>`. A test pins this to that source.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MACOS_COMMAND_SHELL: &str = "sh";

/// The shell sandboxed commands run under on Linux: the sidecar calls srt's
/// `wrapWithSandboxArgv` without a `binShell`, and srt then defaults to `bash`. A test pins the
/// "without a binShell" half to the sidecar source.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const LINUX_COMMAND_SHELL: &str = "bash";

/// Basename of the shell that sandboxed commands run under on this platform; `None` where this
/// host has no sandboxed command execution at all (then no status is reported).
pub fn command_shell() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some(MACOS_COMMAND_SHELL)
    } else if cfg!(target_os = "linux") {
        Some(LINUX_COMMAND_SHELL)
    } else {
        None
    }
}

fn wire_platform(os: &str) -> Option<&'static str> {
    match os {
        "macos" => Some("macos"),
        "linux" => Some("linux"),
        "windows" => Some("windows"),
        _ => None,
    }
}

fn wire_arch(arch: &str) -> Option<&'static str> {
    match arch {
        "x86_64" => Some("x64"),
        "aarch64" => Some("arm64"),
        _ => None,
    }
}

/// The backend's `DEVICE_SHELL_PATTERN`: `^[a-zA-Z0-9._-]{1,64}$`.
fn is_valid_shell(shell: &str) -> bool {
    (1..=64).contains(&shell.len())
        && shell
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `text` cut to at most `MAX_REASON_UTF16_UNITS` UTF-16 code units, on a character boundary.
fn truncate_reason(text: &str) -> String {
    let mut units = 0;
    let mut end = text.len();
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > MAX_REASON_UTF16_UNITS {
            end = index;
            break;
        }
    }
    text[..end].to_owned()
}

fn sandbox_value(readiness: &SandboxReadiness) -> Value {
    let mut sandbox = Map::new();
    match readiness {
        SandboxReadiness::Ready { .. } => {
            sandbox.insert("state".into(), json!("ready"));
        }
        SandboxReadiness::NeedsSetup {
            code,
            reason,
            remedy,
            ..
        } => {
            sandbox.insert("state".into(), json!("needsSetup"));
            // The same camelCase strings `local_host_status` serialises.
            sandbox.insert("code".into(), json!(code));
            sandbox.insert("reason".into(), json!(truncate_reason(reason)));
            sandbox.insert("remedy".into(), json!(remedy));
        }
        SandboxReadiness::Unsupported => {
            sandbox.insert("state".into(), json!("unsupported"));
        }
    }
    Value::Object(sandbox)
}

/// Builds the `status` message from raw platform facts (`std::env::consts::{OS, ARCH}` and the
/// command shell). `None` when any of them cannot be expressed in the wire vocabulary (unknown
/// OS or architecture, or a shell name the backend would reject): a host with nothing valid to say
/// says nothing rather than sending data that closes the socket. `setupCommand` is never sent: it
/// is a local-UI affordance.
pub fn device_status_message(
    os: &str,
    arch: &str,
    shell: &str,
    readiness: &SandboxReadiness,
) -> Option<Value> {
    let platform = wire_platform(os)?;
    let arch = wire_arch(arch)?;
    if !is_valid_shell(shell) {
        return None;
    }
    Some(json!({
        "type": "status",
        "platform": platform,
        "arch": arch,
        "shell": shell,
        "sandbox": sandbox_value(readiness),
        "capabilities": CAPABILITIES,
    }))
}

/// `device_status_message` for this machine.
pub fn host_status_message(readiness: &SandboxReadiness) -> Option<Value> {
    device_status_message(
        std::env::consts::OS,
        std::env::consts::ARCH,
        command_shell()?,
        readiness,
    )
}

/// Whether the gateway's `connected` message announces that it understands `status`. A missing or
/// malformed `features` means it does not (an older backend).
pub fn gateway_accepts_status(connected: &Value) -> bool {
    connected["features"]
        .as_array()
        .is_some_and(|features| features.iter().any(|f| f.as_str() == Some(STATUS_FEATURE)))
}

/// Exactly-once-per-change: send when the gateway accepts `status` and `current` differs from the
/// last message sent (or nothing was sent yet).
pub fn should_send_status(accepts_status: bool, last: Option<&Value>, current: &Value) -> bool {
    accepts_status && last != Some(current)
}

/// Per-connection state of the status report. A new connection starts a new reporter, so the
/// first report of every connection is always sent.
///
/// Readiness is computed off the connection loop (it can spawn a sidecar): the loop asks
/// `begin_probe`, runs the probe in the background, and hands the result to `on_readiness`.
#[derive(Debug, Default)]
pub struct StatusReporter {
    accepts_status: bool,
    last: Option<Value>,
    probing: bool,
}

impl StatusReporter {
    /// Records the gateway's `connected` message.
    pub fn on_connected(&mut self, connected: &Value) {
        self.accepts_status = gateway_accepts_status(connected);
    }

    /// Whether the loop should start a readiness probe now: only when the gateway accepts
    /// `status` and no probe is already running.
    pub fn begin_probe(&mut self) -> bool {
        if !self.accepts_status || self.probing {
            return false;
        }
        self.probing = true;
        true
    }

    /// A finished probe (`None`: the probe task failed). The message to send, if the report
    /// changed. A transient "checking" placeholder is not a result and is neither sent nor
    /// remembered; the next probe asks again.
    pub fn on_readiness(&mut self, readiness: Option<SandboxReadiness>) -> Option<Value> {
        self.probing = false;
        let readiness = readiness?;
        if readiness.is_checking() {
            return None;
        }
        let message = host_status_message(&readiness)?;
        if !should_send_status(self.accepts_status, self.last.as_ref(), &message) {
            return None;
        }
        self.last = Some(message.clone());
        Some(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_host::readiness::{Remedy, SetupCode, ToolchainPath};

    fn needs_setup(reason: &str) -> SandboxReadiness {
        SandboxReadiness::NeedsSetup {
            code: SetupCode::UserNamespaceRestricted,
            reason: reason.to_owned(),
            remedy: Remedy::PrivilegedSetup,
            setup_command: Some("pkexec /opt/x/setup.sh".to_owned()),
        }
    }

    fn build(readiness: &SandboxReadiness) -> Value {
        device_status_message("linux", "x86_64", "bash", readiness).unwrap()
    }

    #[test]
    fn ready_reports_state_only() {
        let ready = SandboxReadiness::Ready {
            toolchain_path: Some(ToolchainPath::LoginShell),
        };
        assert_eq!(
            build(&ready),
            json!({
                "type": "status",
                "platform": "linux",
                "arch": "x64",
                "shell": "bash",
                "sandbox": {"state": "ready"},
                "capabilities": CAPABILITIES,
            })
        );
        let macos = device_status_message(
            "macos",
            "aarch64",
            "sh",
            &SandboxReadiness::Ready {
                toolchain_path: None,
            },
        )
        .unwrap();
        assert_eq!(macos["platform"], "macos");
        assert_eq!(macos["arch"], "arm64");
        assert_eq!(macos["sandbox"], json!({"state": "ready"}));
    }

    #[test]
    fn needs_setup_reports_camel_case_code_remedy_and_reason_but_not_the_command() {
        let message = build(&needs_setup("bubblewrap was refused"));
        assert_eq!(
            message["sandbox"],
            json!({
                "state": "needsSetup",
                "code": "userNamespaceRestricted",
                "reason": "bubblewrap was refused",
                "remedy": "privilegedSetup",
            })
        );
        assert!(!message.to_string().contains("pkexec"));
    }

    #[test]
    fn every_code_and_remedy_serialises_as_the_backend_enum() {
        let codes = [
            (SetupCode::BundleMissing, "bundleMissing"),
            (SetupCode::BundleStale, "bundleStale"),
            (SetupCode::BundleNewer, "bundleNewer"),
            (SetupCode::BundleInvalid, "bundleInvalid"),
            (SetupCode::BwrapMissing, "bwrapMissing"),
            (SetupCode::UserNamespaceRestricted, "userNamespaceRestricted"),
            (SetupCode::SandboxFailed, "sandboxFailed"),
            (SetupCode::Installing, "installing"),
        ];
        let remedies = [
            (Remedy::DownloadRuntime, "downloadRuntime"),
            (Remedy::UpdateApp, "updateApp"),
            (Remedy::ReinstallPackage, "reinstallPackage"),
            (Remedy::PrivilegedSetup, "privilegedSetup"),
            (Remedy::None, "none"),
        ];
        for (code, wire_code) in codes {
            for (remedy, wire_remedy) in remedies {
                let message = build(&SandboxReadiness::NeedsSetup {
                    code,
                    reason: "r".into(),
                    remedy,
                    setup_command: None,
                });
                assert_eq!(message["sandbox"]["code"], wire_code);
                assert_eq!(message["sandbox"]["remedy"], wire_remedy);
            }
        }
    }

    #[test]
    fn unsupported_reports_state_only() {
        assert_eq!(
            build(&SandboxReadiness::Unsupported)["sandbox"],
            json!({"state": "unsupported"})
        );
    }

    #[test]
    fn long_reason_is_cut_to_the_backend_limit() {
        let message = build(&needs_setup(&"x".repeat(5000)));
        assert_eq!(message["sandbox"]["reason"].as_str().unwrap().len(), 1000);
        // exactly at the limit is kept whole
        let exact = "y".repeat(1000);
        let message = build(&needs_setup(&exact));
        assert_eq!(message["sandbox"]["reason"], exact);
    }

    #[test]
    fn reason_is_cut_on_a_character_boundary_in_utf16_units() {
        // 3-byte BMP characters: 1000 characters fit, the 1001st does not.
        let message = build(&needs_setup(&"é中".repeat(800)));
        let reason = message["sandbox"]["reason"].as_str().unwrap();
        assert_eq!(reason.chars().count(), 1000);
        // Characters outside the BMP count as 2 UTF-16 units (zod's `.max` counts those).
        let message = build(&needs_setup(&"😀".repeat(900)));
        let reason = message["sandbox"]["reason"].as_str().unwrap();
        assert_eq!(reason.chars().count(), 500);
        assert!(reason.encode_utf16().count() <= 1000);
        // An odd limit boundary: one ASCII char then emoji; the emoji that would straddle is dropped.
        let message = build(&needs_setup(&format!("a{}", "😀".repeat(600))));
        let reason = message["sandbox"]["reason"].as_str().unwrap();
        assert!(reason.encode_utf16().count() <= 1000);
        assert_eq!(reason.chars().count(), 1 + 499);
    }

    #[test]
    fn unknown_platform_or_architecture_sends_nothing() {
        let ready = SandboxReadiness::Unsupported;
        assert!(device_status_message("freebsd", "x86_64", "bash", &ready).is_none());
        assert!(device_status_message("linux", "riscv64", "bash", &ready).is_none());
        assert!(device_status_message("linux", "x86", "bash", &ready).is_none());
        assert!(device_status_message("windows", "aarch64", "bash", &ready).is_some());
    }

    #[test]
    fn hostile_or_empty_shell_names_send_nothing() {
        let ready = SandboxReadiness::Unsupported;
        for shell in [
            "",
            "/bin/sh",
            "bash -c",
            "ba\nsh",
            "sh;rm",
            "bäsh",
            &"s".repeat(65),
        ] {
            assert!(
                device_status_message("linux", "x86_64", shell, &ready).is_none(),
                "{shell:?}"
            );
        }
        for shell in ["sh", "bash", "zsh", "dash", "pwsh.exe", "my_sh-1.2", &"s".repeat(64)] {
            assert!(
                device_status_message("linux", "x86_64", shell, &ready).is_some(),
                "{shell:?}"
            );
        }
    }

    #[test]
    fn capabilities_fit_the_backend_limits_and_are_unique() {
        assert!(CAPABILITIES.len() <= 32);
        for capability in CAPABILITIES {
            assert!((1..=64).contains(&capability.len()), "{capability}");
        }
        let mut sorted = CAPABILITIES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), CAPABILITIES.len());
    }

    #[test]
    fn every_capability_is_an_action_the_dispatcher_names() {
        let source = include_str!("execution.rs");
        for capability in CAPABILITIES {
            assert!(
                source.contains(&format!("\"{capability}\"")),
                "execution.rs no longer names {capability}"
            );
        }
    }

    #[test]
    fn macos_shell_is_the_one_execution_rs_execs() {
        // `execute_command` for macOS: `sandbox-exec -p <policy> /bin/sh -c <script>`.
        let source = include_str!("execution.rs");
        assert!(source.contains("\"/usr/bin/sandbox-exec\".to_string(),"));
        assert!(source.contains("\"/bin/sh\".to_string(),\n        \"-c\".to_string(),"));
        assert_eq!(MACOS_COMMAND_SHELL, "sh");
    }

    #[test]
    fn linux_shell_is_srts_default_because_the_sidecar_passes_no_bin_shell() {
        // `wrapWithSandboxArgv(request.command, undefined /* binShell */, customConfig, ...)`;
        // srt then runs `bash` (`const shellPath = shell || 'bash'`).
        let source = include_str!("../../../sandbox-sidecar/src/server.ts");
        let squashed = source.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            squashed.contains("wrapWithSandboxArgv( request.command, undefined, customConfig,"),
            "the sidecar passes a binShell now: update LINUX_COMMAND_SHELL"
        );
        assert_eq!(LINUX_COMMAND_SHELL, "bash");
    }

    #[test]
    fn this_platform_has_a_shell_the_backend_accepts() {
        if let Some(shell) = command_shell() {
            assert!(is_valid_shell(shell));
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(command_shell().is_some());
    }

    #[test]
    fn gateway_features_gate_status() {
        assert!(gateway_accepts_status(&json!({"type": "connected", "features": ["status"]})));
        assert!(gateway_accepts_status(&json!({"features": ["other", "status"]})));
        assert!(!gateway_accepts_status(&json!({"type": "connected"})));
        assert!(!gateway_accepts_status(&json!({"features": []})));
        assert!(!gateway_accepts_status(&json!({"features": ["other"]})));
        assert!(!gateway_accepts_status(&json!({"features": "status"})));
        assert!(!gateway_accepts_status(&json!({"features": null})));
        assert!(!gateway_accepts_status(&json!({"features": [1, null]})));
    }

    #[test]
    fn should_send_status_decides_once_per_change() {
        let a = json!({"n": 1});
        let b = json!({"n": 2});
        assert!(!should_send_status(false, None, &a), "gateway without the feature");
        assert!(!should_send_status(false, Some(&a), &b));
        assert!(should_send_status(true, None, &a), "first report");
        assert!(!should_send_status(true, Some(&a), &a), "unchanged");
        assert!(should_send_status(true, Some(&a), &b), "changed");
    }

    fn ready() -> SandboxReadiness {
        SandboxReadiness::Ready {
            toolchain_path: None,
        }
    }

    #[test]
    fn reporter_never_probes_or_reports_for_a_gateway_without_the_feature() {
        let mut reporter = StatusReporter::default();
        assert!(!reporter.begin_probe(), "before `connected`");
        reporter.on_connected(&json!({"type": "connected"}));
        assert!(!reporter.begin_probe());
        assert!(reporter.on_readiness(Some(ready())).is_none());
    }

    #[test]
    fn reporter_sends_first_report_then_only_changes() {
        let mut reporter = StatusReporter::default();
        reporter.on_connected(&json!({"features": ["status"]}));
        // one probe at a time
        assert!(reporter.begin_probe());
        assert!(!reporter.begin_probe());
        let first = reporter.on_readiness(Some(ready()));
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            assert_eq!(first.unwrap()["sandbox"], json!({"state": "ready"}));
            // unchanged: nothing, however often it is asked
            for _ in 0..3 {
                assert!(reporter.begin_probe());
                assert!(reporter.on_readiness(Some(ready())).is_none());
            }
            // changed: sent once
            assert!(reporter.begin_probe());
            let changed = reporter.on_readiness(Some(needs_setup("gone"))).unwrap();
            assert_eq!(changed["sandbox"]["state"], "needsSetup");
            assert!(reporter.begin_probe());
            assert!(reporter.on_readiness(Some(needs_setup("gone"))).is_none());
            // and back
            assert!(reporter.begin_probe());
            assert_eq!(
                reporter.on_readiness(Some(ready())).unwrap()["sandbox"],
                json!({"state": "ready"})
            );
        } else {
            assert!(first.is_none());
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn reporter_skips_the_transient_checking_placeholder_and_failed_probes() {
        let mut reporter = StatusReporter::default();
        reporter.on_connected(&json!({"features": ["status"]}));
        assert!(reporter.begin_probe());
        assert!(reporter.on_readiness(Some(SandboxReadiness::checking())).is_none());
        // not remembered: the real answer is still a first report
        assert!(reporter.begin_probe());
        assert!(reporter.on_readiness(None).is_none());
        assert!(reporter.begin_probe());
        assert!(reporter.on_readiness(Some(ready())).is_some());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_new_connection_reports_again() {
        let connected = json!({"features": ["status"]});
        let mut first = StatusReporter::default();
        first.on_connected(&connected);
        assert!(first.begin_probe());
        assert!(first.on_readiness(Some(ready())).is_some());
        let mut second = StatusReporter::default();
        second.on_connected(&connected);
        assert!(second.begin_probe());
        assert!(second.on_readiness(Some(ready())).is_some());
    }
}
