//! Readiness of local sandboxed execution, and toolchain `PATH` discovery for the commands run
//! inside it.
//!
//! macOS keeps its existing Seatbelt execution path (migrated by a later plan) and is always
//! `Ready` without ever touching a sandbox bundle. This module's bundle-probing half exists for
//! the Linux bwrap-based sandbox bundle that a later task wires into execution. Nothing here
//! ever reports `Ready` on a missing helper, a failed `init`/`probe` round trip, or a dead
//! sidecar: those are reported as `NeedsSetup` with a reason, so local execution fails loudly
//! instead of silently running unsandboxed.
use super::LocalHost;
#[cfg(unix)]
use super::sidecar::Sidecar;
use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// `InitConfig`, `Platform`, and `Helpers` are defined in `sidecar.rs` (a private module) and
/// widened from `pub(crate)` to `pub` there, then re-exported here, only so the ignored Linux
/// integration test in `tests/linux_sandbox.rs` can build one directly: that test cannot go
/// through `LocalHost::sandbox_readiness` because `LocalHost::open` does not yet support Linux
/// (a later task wires that up). Production code never needs this path; it always goes through
/// `LocalHost::sandbox_readiness` below.
#[cfg(unix)]
pub use super::sidecar::{Helpers, InitConfig, Platform};

/// Readiness of local sandboxed execution on this platform, reported to the Web UI via
/// `local_bridge::local_host_status` (`state` is the serde tag).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SandboxReadiness {
    // `rename_all` on the enum itself only renames variant names (`state` values), not the
    // fields of a struct variant, so `toolchain_path` needs its own `rename_all` to come out
    // as `toolchainPath` on the wire.
    #[serde(rename_all = "camelCase")]
    Ready { toolchain_path: ToolchainPath },
    NeedsSetup { reason: String },
    Unsupported,
}

/// Which `PATH` a sandboxed command's toolchain lookups end up resolving against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolchainPath {
    LoginShell,
    System,
}

/// Where the sandbox bundle (the compiled sidecar plus its helper binaries) lives under the
/// host's own app-data directory.
pub fn bundle_dir(app_data: &Path) -> PathBuf {
    app_data.join("sandbox").join("current")
}

const FALLBACK_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// The production login-shell timeout: long enough for a normal shell profile, short enough
/// that a broken one does not hang readiness reporting.
#[cfg(unix)]
const USER_PATH_TIMEOUT: Duration = Duration::from_secs(5);

/// Discovers the `PATH` a login shell would produce, for toolchains (nvm, pyenv, Homebrew, ...)
/// installed through shell profile scripts rather than present on the system `PATH`. Falls back
/// to a minimal system `PATH` if `$SHELL` is unset, fails to start, exits non-zero, prints
/// nothing, or does not reply within the timeout.
#[cfg(unix)]
pub(crate) fn user_path() -> (String, ToolchainPath) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    resolve_user_path(&shell, USER_PATH_TIMEOUT)
}

/// `user_path()`'s logic with the shell and timeout as parameters, so a test can drive a slow
/// or broken shell without mutating this process's own `$SHELL` environment variable (shared by
/// every test in the binary). Polls with `try_wait()` instead of a blocking `wait()`, so a shell
/// that never exits is killed at `timeout` instead of hanging this call indefinitely.
#[cfg(unix)]
fn resolve_user_path(shell: &str, timeout: Duration) -> (String, ToolchainPath) {
    let fallback = || (FALLBACK_PATH.to_string(), ToolchainPath::System);

    let mut child = match Command::new(shell)
        .arg("-lc")
        .arg(r#"printf %s "$PATH""#)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return fallback(),
    };

    let deadline = Instant::now() + timeout;
    let exited = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => break None,
        }
    };

    let Some(status) = exited else {
        let _ = child.kill();
        let _ = child.wait();
        return fallback();
    };

    if !status.success() {
        return fallback();
    }

    let mut output = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut output);
    }
    let output = output.trim();
    if output.is_empty() {
        return fallback();
    }
    (output.to_string(), ToolchainPath::LoginShell)
}

/// Probes an already-unpacked sandbox bundle: starts the sidecar with `init`, sends a `probe`
/// request, and reports exactly why execution is unavailable when either step fails, using the
/// sidecar's own error message verbatim. Never returns `Ready` unless both the start/`init`
/// round trip and `probe` succeed.
///
/// `pub` (not `pub(crate)`) only so the ignored Linux integration test in
/// `tests/linux_sandbox.rs` can drive it directly against a real bundle and `bwrap` (see the
/// module doc comment above); production code reaches it only through
/// `LocalHost::sandbox_readiness`.
#[cfg(unix)]
pub fn probe_bundle(bundle: &Path, init: &InitConfig) -> SandboxReadiness {
    if !bundle.join("srt-sidecar").is_file() {
        return SandboxReadiness::NeedsSetup {
            reason: "Sandbox runtime is not installed".to_string(),
        };
    }
    let sidecar = match Sidecar::start(bundle, init) {
        Ok(sidecar) => sidecar,
        Err(error) => return SandboxReadiness::NeedsSetup { reason: error.message },
    };
    if let Err(error) = sidecar.probe() {
        return SandboxReadiness::NeedsSetup { reason: error.message };
    }
    SandboxReadiness::Ready {
        toolchain_path: user_path().1,
    }
}

impl LocalHost {
    /// Whether local sandboxed execution can run right now, and why not if it cannot. macOS
    /// keeps its Seatbelt path (migrated by a later plan) and is always `Ready`, without ever
    /// touching a sandbox bundle. Linux probes the bundle under this host's own app-data
    /// directory. Every other platform is `Unsupported`.
    pub fn sandbox_readiness(&self) -> SandboxReadiness {
        #[cfg(target_os = "macos")]
        return SandboxReadiness::Ready {
            toolchain_path: user_path().1,
        };

        #[cfg(target_os = "linux")]
        {
            let bundle = bundle_dir(&self.base);
            let init = InitConfig {
                platform: Platform::Linux,
                home: std::env::var("HOME").unwrap_or_default(),
                workspace_roots: vec![self.workspace_base().to_string_lossy().into_owned()],
                read_roots: Vec::new(),
                helpers: Helpers {
                    ripgrep: bundle.join("rg").to_string_lossy().into_owned(),
                    apply_seccomp: Some(
                        bundle.join("apply-seccomp").to_string_lossy().into_owned(),
                    ),
                    java_agent_jar: Some(
                        bundle
                            .join("srt-proxy-agent.jar")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                },
                bwrap_path: Some("/opt/sourceweft/libexec/bwrap".to_string()),
            };
            return probe_bundle(&bundle, &init);
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        SandboxReadiness::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    const STUB: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stub-sidecar.sh");
    #[cfg(unix)]
    const SLOW_SHELL: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/slow-shell.sh"
    );

    #[cfg(unix)]
    fn test_init() -> InitConfig {
        InitConfig {
            platform: Platform::Darwin,
            home: "/tmp/sourceweft-readiness-test-home".to_string(),
            workspace_roots: vec!["/tmp/sourceweft-readiness-test-workspace".to_string()],
            read_roots: vec![],
            helpers: Helpers {
                ripgrep: "/usr/bin/rg".to_string(),
                apply_seccomp: None,
                java_agent_jar: None,
            },
            bwrap_path: None,
        }
    }

    #[cfg(unix)]
    fn bundle_with_stub() -> tempfile::TempDir {
        use std::{fs, os::unix::fs::PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("srt-sidecar");
        fs::copy(STUB, &target).unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
        // See sidecar.rs's own test helper: fsync before any test execs the just-written file,
        // closing an observed ETXTBSY race on overlayfs-backed container filesystems.
        fs::File::open(&target).unwrap().sync_all().unwrap();
        dir
    }

    #[test]
    #[cfg(unix)]
    fn missing_bundle_is_needs_setup() {
        let bundle = tempfile::tempdir().unwrap();
        let readiness = probe_bundle(bundle.path(), &test_init());
        assert_eq!(
            readiness,
            SandboxReadiness::NeedsSetup {
                reason: "Sandbox runtime is not installed".to_string()
            }
        );
    }

    #[test]
    #[cfg(unix)]
    fn working_sidecar_is_ready() {
        let bundle = bundle_with_stub();
        let readiness = probe_bundle(bundle.path(), &test_init());
        assert!(
            matches!(readiness, SandboxReadiness::Ready { .. }),
            "expected Ready, got {readiness:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn sidecar_failure_message_is_reported_verbatim() {
        // The stub acks `init` and then exits immediately; the following `probe` call never
        // gets a reply, which `Sidecar` reports as SANDBOX_UNAVAILABLE with this exact message.
        let bundle = bundle_with_stub();
        let mut init = test_init();
        init.home = "/tmp/sourceweft-readiness-test-home/exit-after-init".to_string();
        let readiness = probe_bundle(bundle.path(), &init);
        assert_eq!(
            readiness,
            SandboxReadiness::NeedsSetup {
                reason: "sidecar exited without replying".to_string()
            }
        );
    }

    #[test]
    #[cfg(unix)]
    fn slow_login_shell_falls_to_system_path() {
        let started = Instant::now();
        let (path, kind) = resolve_user_path(SLOW_SHELL, USER_PATH_TIMEOUT);
        assert_eq!(kind, ToolchainPath::System);
        assert_eq!(path, FALLBACK_PATH);
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "expected the 5s user_path timeout to fire well before the script's 10s sleep ends: {:?}",
            started.elapsed()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_is_ready_without_bundle() {
        let app_data = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app_data.path()).unwrap();
        // No bundle was ever placed under `app_data`; macOS must still report Ready.
        assert!(!bundle_dir(app_data.path()).exists());
        assert!(
            matches!(host.sandbox_readiness(), SandboxReadiness::Ready { .. }),
            "expected Ready without a bundle on macOS"
        );
    }
}
