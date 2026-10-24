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
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
#[cfg(unix)]
use std::{
    io::Read,
    process::{Command, Stdio},
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

/// Sentinels the production `printf` wraps `$PATH` in, so a login shell's own startup output
/// (MOTD banners, nvm/direnv/etc. chatter printed by `.profile`/`.zshrc` before our command
/// even runs) can never be mistaken for part of the `PATH`, or corrupt it by landing next to
/// it in the same stdout stream. Picked unusual enough that no real shell banner is likely to
/// contain them by coincidence; `extract_path` treats either one being absent, or out of
/// order, the same as a broken shell: fall back to the system `PATH`.
#[cfg(unix)]
const PATH_BEGIN: &str = "__SW_SANDBOX_PATH_BEGIN__";
#[cfg(unix)]
const PATH_END: &str = "__SW_SANDBOX_PATH_END__";

/// Discovers the `PATH` a login shell would produce, for toolchains (nvm, pyenv, Homebrew, ...)
/// installed through shell profile scripts rather than present on the system `PATH`. Falls back
/// to a minimal system `PATH` if `$SHELL` is unset, fails to start, exits non-zero, prints
/// nothing (or nothing between the sentinels), or does not reply within the timeout.
///
/// Cached for the lifetime of the process: a login shell is expensive to spawn (profile
/// scripts, `nvm`/`pyenv`/etc. init), and `PATH` is not expected to change while this process
/// is running, so every caller after the first gets the first call's result for free instead
/// of re-spawning a shell on every `local_host_status` poll.
#[cfg(unix)]
pub(crate) fn user_path() -> (String, ToolchainPath) {
    static CACHE: std::sync::OnceLock<(String, ToolchainPath)> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            resolve_user_path(&shell, USER_PATH_TIMEOUT)
        })
        .clone()
}

/// `user_path()`'s logic with the shell and timeout as parameters, so a test can drive a slow
/// or broken shell without mutating this process's own `$SHELL` environment variable (shared by
/// every test in the binary), and without going through (or populating) `user_path()`'s own
/// process-wide cache. Polls with `try_wait()` instead of a blocking `wait()`, so a shell that
/// never exits is killed at `timeout` instead of hanging this call indefinitely.
#[cfg(unix)]
fn resolve_user_path(shell: &str, timeout: Duration) -> (String, ToolchainPath) {
    let fallback = || (FALLBACK_PATH.to_string(), ToolchainPath::System);

    let mut child = match Command::new(shell)
        .arg("-lc")
        .arg(format!("printf '{PATH_BEGIN}%s{PATH_END}' \"$PATH\""))
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

    match extract_path(&output) {
        Some(path) if !path.is_empty() => (path.to_string(), ToolchainPath::LoginShell),
        _ => fallback(),
    }
}

/// Pulls the text between `PATH_BEGIN`/`PATH_END` out of a login shell's full stdout, so any
/// startup banner printed before (or stray output printed after) the `printf` that produced
/// the sentinels cannot land inside, or be mistaken for, the `PATH` value. Returns `None` if
/// either sentinel is missing or out of order, which `resolve_user_path` treats the same as a
/// broken shell.
#[cfg(unix)]
fn extract_path(output: &str) -> Option<&str> {
    let begin = output.find(PATH_BEGIN)? + PATH_BEGIN.len();
    let end = output[begin..].find(PATH_END)? + begin;
    Some(&output[begin..end])
}

/// Probes an already-unpacked sandbox bundle: starts the sidecar with `init`, sends a `probe`
/// request, and reports exactly why execution is unavailable when either step fails, using the
/// sidecar's own error message verbatim. Never returns `Ready` unless both the start/`init`
/// round trip and `probe` succeed.
///
/// `pub` (not `pub(crate)`) only so the ignored Linux integration test in
/// `tests/linux_sandbox.rs` can drive it directly against a real bundle and `bwrap` (see the
/// module doc comment above); production code reaches it only through
/// `LocalHost::sandbox_readiness`, which also caches the result (see `ReadinessCache` below) —
/// this function itself is uncached, so a test can call it as many times as it likes.
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

/// `LocalHost::sandbox_readiness`'s cache: probing is expensive (spawning a login shell; on
/// Linux, starting a whole sidecar process and round-tripping `init` + `probe`), and
/// `local_host_status` is polled by the Web UI every few seconds, so a fresh probe runs only
/// when the cached value could plausibly be stale.
///
/// Policy: a cached `Ready` is never rechecked (nothing currently calls `invalidate` to expire
/// it; a later task may, e.g. after installing/updating the sandbox runtime). A cached
/// `NeedsSetup`/`Unsupported` is rechecked once `recheck_interval` has elapsed, since whatever
/// was wrong might have been fixed since. While a probe is already running on some thread, a
/// concurrent call never blocks on it: it returns the last known value, or a transient
/// `NeedsSetup { reason: "Checking the sandbox runtime" }` if there isn't one yet.
// `get_or_probe`/`invalidate` are only reached from `sandbox_readiness`'s Linux branch in a
// production (non-test) build, so a plain `cargo build` on macOS/Windows sees no caller and
// would otherwise warn this whole type as dead code; the unit tests below exercise the cache
// policy directly (platform-independently) precisely so it does not need a real Linux target
// to verify, which is also why it is not itself `#[cfg(target_os = "linux")]`-gated.
#[allow(dead_code)]
#[derive(Debug, Default)]
pub(crate) struct ReadinessCache {
    last: Option<(SandboxReadiness, Instant)>,
    probing: bool,
}

#[allow(dead_code)]
impl ReadinessCache {
    /// Runs the cache policy described on the type around `probe`: returns a cached value
    /// without calling `probe` at all when one is fresh enough per the policy above, returns
    /// the last known value (or the transient "checking" placeholder) without blocking when
    /// another call's probe is already in flight, and otherwise calls `probe()` once — with
    /// the lock released, so concurrent callers are never blocked on its actual I/O — and
    /// caches its result.
    fn get_or_probe(
        cache: &Mutex<Self>,
        recheck_interval: Duration,
        probe: impl FnOnce() -> SandboxReadiness,
    ) -> SandboxReadiness {
        {
            let mut state = Self::lock(cache);
            if let Some((value, computed_at)) = &state.last {
                let fresh = matches!(value, SandboxReadiness::Ready { .. })
                    || computed_at.elapsed() < recheck_interval;
                if fresh {
                    return value.clone();
                }
            }
            if state.probing {
                return state
                    .last
                    .as_ref()
                    .map(|(value, _)| value.clone())
                    .unwrap_or_else(|| SandboxReadiness::NeedsSetup {
                        reason: "Checking the sandbox runtime".to_string(),
                    });
            }
            state.probing = true;
        }

        let result = probe();

        let mut state = Self::lock(cache);
        state.probing = false;
        state.last = Some((result.clone(), Instant::now()));
        result
    }

    /// Clears the cached value (but not `probing`, which only the in-flight `get_or_probe`
    /// call that set it may clear), forcing the next `get_or_probe` call to probe again
    /// regardless of how fresh the cleared value was.
    fn invalidate(cache: &Mutex<Self>) {
        Self::lock(cache).last = None;
    }

    /// A poisoned lock here means some earlier call panicked while holding it; the cache is
    /// just an `Option` plus a `bool`, nothing left half-written can be unsafe to read, so
    /// recovering and carrying on is preferable to poisoning every later readiness check too.
    fn lock(cache: &Mutex<Self>) -> std::sync::MutexGuard<'_, Self> {
        cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(target_os = "linux")]
const SANDBOX_READINESS_RECHECK_INTERVAL: Duration = Duration::from_secs(60);

impl LocalHost {
    /// Whether local sandboxed execution can run right now, and why not if it cannot. macOS
    /// keeps its Seatbelt path (migrated by a later plan) and is always `Ready`, without ever
    /// touching a sandbox bundle (and `user_path()` is itself cached, so this is cheap even
    /// though it isn't additionally cached here). Linux probes the bundle under this host's own
    /// app-data directory, through `ReadinessCache` so repeated polling doesn't repeatedly
    /// spawn a sidecar. Every other platform is `Unsupported`.
    pub fn sandbox_readiness(&self) -> SandboxReadiness {
        #[cfg(target_os = "macos")]
        return SandboxReadiness::Ready {
            toolchain_path: user_path().1,
        };

        #[cfg(target_os = "linux")]
        return ReadinessCache::get_or_probe(
            &self.sandbox_readiness_cache,
            SANDBOX_READINESS_RECHECK_INTERVAL,
            || {
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
                probe_bundle(&bundle, &init)
            },
        );

        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        SandboxReadiness::Unsupported
    }

    /// Clears the cached sandbox readiness, forcing the next `sandbox_readiness()` call to
    /// probe again regardless of how recently it last succeeded or how long ago it last
    /// failed. Exposed for later tasks: e.g. call this right after installing or updating the
    /// sandbox runtime, so the cached pre-install `NeedsSetup` (or a stale `Ready`) does not
    /// linger until the recheck interval happens to elapse on its own.
    pub fn invalidate_sandbox_readiness(&self) {
        ReadinessCache::invalidate(&self.sandbox_readiness_cache);
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
    const PROBE_FAILS_STUB: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/stub-sidecar-probe-error.sh"
    );
    #[cfg(unix)]
    const BANNER_SHELL: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/banner-shell.sh"
    );
    #[cfg(unix)]
    const NO_SENTINEL_SHELL: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/no-sentinel-shell.sh"
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
    fn bundle_with_script(script: &str) -> tempfile::TempDir {
        use std::{fs, os::unix::fs::PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("srt-sidecar");
        fs::copy(script, &target).unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
        // See sidecar.rs's own test helper: fsync before any test execs the just-written file,
        // closing an observed ETXTBSY race on overlayfs-backed container filesystems.
        fs::File::open(&target).unwrap().sync_all().unwrap();
        dir
    }

    #[cfg(unix)]
    fn bundle_with_stub() -> tempfile::TempDir {
        bundle_with_script(STUB)
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
        // The stub acks `init` normally, then replies to `probe` with a fixed `ok:false`
        // error of its own, instead of relying on the process exiting between `init` and
        // `probe` (which raced the client's own stdin write against the stub's exit, making
        // the reported reason nondeterministic between "failed to write to sidecar: Broken
        // pipe" and "sidecar exited without replying" depending on scheduling).
        let bundle = bundle_with_script(PROBE_FAILS_STUB);
        let readiness = probe_bundle(bundle.path(), &test_init());
        assert_eq!(
            readiness,
            SandboxReadiness::NeedsSetup {
                reason: "stub probe failure for readiness test".to_string()
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

    #[test]
    #[cfg(unix)]
    fn login_shell_startup_banner_does_not_corrupt_the_path() {
        let (path, kind) = resolve_user_path(BANNER_SHELL, USER_PATH_TIMEOUT);
        assert_eq!(kind, ToolchainPath::LoginShell);
        assert_eq!(path, "/banner/bin:/usr/bin:/bin");
    }

    #[test]
    #[cfg(unix)]
    fn output_without_sentinels_falls_back_to_system_path() {
        let (path, kind) = resolve_user_path(NO_SENTINEL_SHELL, USER_PATH_TIMEOUT);
        assert_eq!(kind, ToolchainPath::System);
        assert_eq!(path, FALLBACK_PATH);
    }

    #[test]
    #[cfg(unix)]
    fn user_path_is_cached_across_calls() {
        // Both calls hit the same process-wide `OnceLock`; this does not by itself prove the
        // shell was only spawned once (that would need instrumenting the real `$SHELL`, which
        // `user_path()` deliberately does not take as a parameter), but it does prove the
        // cached value is stable, which is what every caller actually depends on.
        assert_eq!(user_path(), user_path());
    }

    #[test]
    fn ready_result_is_cached_forever() {
        let cache = Mutex::new(ReadinessCache::default());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            SandboxReadiness::Ready {
                toolchain_path: ToolchainPath::System,
            }
        };
        let first = ReadinessCache::get_or_probe(&cache, Duration::from_millis(1), probe);
        std::thread::sleep(Duration::from_millis(20));
        let second = ReadinessCache::get_or_probe(&cache, Duration::from_millis(1), probe);
        assert_eq!(first, second);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn needs_setup_is_not_rechecked_before_the_interval_elapses() {
        let cache = Mutex::new(ReadinessCache::default());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            SandboxReadiness::NeedsSetup {
                reason: "not yet".to_string(),
            }
        };
        ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), probe);
        ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), probe);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn needs_setup_is_rechecked_after_the_interval_elapses() {
        let cache = Mutex::new(ReadinessCache::default());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            SandboxReadiness::NeedsSetup {
                reason: "not yet".to_string(),
            }
        };
        ReadinessCache::get_or_probe(&cache, Duration::from_millis(20), probe);
        std::thread::sleep(Duration::from_millis(40));
        ReadinessCache::get_or_probe(&cache, Duration::from_millis(20), probe);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn a_probe_already_in_flight_returns_the_last_known_value_without_blocking() {
        let cache = Mutex::new(ReadinessCache {
            last: Some((
                SandboxReadiness::NeedsSetup {
                    reason: "stale".to_string(),
                },
                Instant::now(),
            )),
            probing: true,
        });
        let result = ReadinessCache::get_or_probe(&cache, Duration::from_secs(0), || {
            panic!("must not call probe while one is already in flight")
        });
        assert_eq!(
            result,
            SandboxReadiness::NeedsSetup {
                reason: "stale".to_string()
            }
        );
    }

    #[test]
    fn a_probe_already_in_flight_with_no_prior_result_reports_checking() {
        let cache = Mutex::new(ReadinessCache {
            last: None,
            probing: true,
        });
        let result = ReadinessCache::get_or_probe(&cache, Duration::from_secs(0), || {
            panic!("must not call probe while one is already in flight")
        });
        assert_eq!(
            result,
            SandboxReadiness::NeedsSetup {
                reason: "Checking the sandbox runtime".to_string()
            }
        );
    }

    #[test]
    fn invalidate_forces_a_fresh_probe_even_within_the_interval() {
        let cache = Mutex::new(ReadinessCache::default());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            SandboxReadiness::Ready {
                toolchain_path: ToolchainPath::System,
            }
        };
        ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), probe);
        ReadinessCache::invalidate(&cache);
        ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), probe);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
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
