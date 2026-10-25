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
/// integration test in `tests/linux_sandbox.rs` can build one directly, to probe a bundle
/// against an explicit `bwrap` path rather than the production one. Production code never
/// needs this path; it always goes through `LocalHost::sandbox_readiness` below.
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
    //
    // `toolchain_path` is `None` on macOS, whose Seatbelt execution never uses the login-shell
    // `PATH`, so reporting readiness there never spawns a login shell (and the field is
    // omitted on the wire).
    #[serde(rename_all = "camelCase")]
    Ready {
        #[serde(skip_serializing_if = "Option::is_none")]
        toolchain_path: Option<ToolchainPath>,
    },
    // `rename_all` again for `setup_command`; `code` and `remedy` serialise as camelCase
    // strings through their own enums. `setup_command` is present only for
    // `Remedy::PrivilegedSetup` and omitted from the wire otherwise.
    #[serde(rename_all = "camelCase")]
    NeedsSetup {
        code: SetupCode,
        reason: String,
        remedy: Remedy,
        #[serde(skip_serializing_if = "Option::is_none")]
        setup_command: Option<String>,
    },
    Unsupported,
}

/// Why local execution needs setup; the machine-readable half of `NeedsSetup`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupCode {
    BundleMissing,
    BundleStale,
    BundleNewer,
    BundleInvalid,
    BwrapMissing,
    UserNamespaceRestricted,
    SandboxFailed,
    Installing,
}

/// What the user can do about a `NeedsSetup`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Remedy {
    DownloadRuntime,
    UpdateApp,
    ReinstallPackage,
    PrivilegedSetup,
    None,
}

// Constructors are used by the Linux probe, the installer, and the tests; a plain macOS
// `cargo build` sees no caller for some of them.
#[allow(dead_code)]
impl SandboxReadiness {
    fn needs_setup(code: SetupCode, reason: impl Into<String>, remedy: Remedy) -> Self {
        Self::NeedsSetup {
            code,
            reason: reason.into(),
            remedy,
            setup_command: None,
        }
    }

    /// The sandbox bundle has not been installed (or is not where the host expects it).
    pub(crate) fn bundle_missing() -> Self {
        Self::needs_setup(
            SetupCode::BundleMissing,
            "Sandbox runtime is not installed",
            Remedy::DownloadRuntime,
        )
    }

    /// The runtime installer is running right now (set by the installer while it works).
    pub(crate) fn installing() -> Self {
        Self::needs_setup(
            SetupCode::Installing,
            "Installing the sandbox runtime",
            Remedy::None,
        )
    }

    /// A transient answer while another thread's probe is still running and there is no earlier
    /// result to return. Reason only: there is nothing for the user to do.
    pub(crate) fn checking() -> Self {
        Self::needs_setup(
            SetupCode::SandboxFailed,
            "Checking the sandbox runtime",
            Remedy::None,
        )
    }

    /// Whether this is the transient placeholder another thread's still-running probe answers
    /// with (see `ReadinessCache`): not a real result, so it must not be reported anywhere.
    pub fn is_checking(&self) -> bool {
        *self == Self::checking()
    }

    /// The scoped bubblewrap at `path` is missing, not executable, or (`code`
    /// `UserNamespaceRestricted`) refused by the kernel's user-namespace policy: all three are
    /// fixed by the same one-time privileged setup. `appimage` (the `APPIMAGE` variable is set)
    /// means there is no package to reinstall, so the user runs the setup script through
    /// `pkexec` instead.
    fn bwrap_setup(code: SetupCode, reason: impl Into<String>, appimage: bool) -> Self {
        if appimage {
            Self::NeedsSetup {
                code,
                reason: reason.into(),
                remedy: Remedy::PrivilegedSetup,
                setup_command: Some(super::privileged_setup::privileged_setup_command()),
            }
        } else {
            Self::needs_setup(code, reason, Remedy::ReinstallPackage)
        }
    }
}

/// Whether this process runs from an AppImage (the AppImage runtime sets `APPIMAGE` to the
/// image path). Read only, never set, and no configuration of ours: it only picks which remedy
/// text we show.
#[cfg(unix)]
fn running_as_appimage() -> bool {
    std::env::var_os("APPIMAGE").is_some_and(|value| !value.is_empty())
}

/// Whether `message` is one of the known ways bubblewrap reports that the kernel refused the
/// unprivileged user/network namespace it needs (AppArmor's
/// `apparmor_restrict_unprivileged_userns`, or a missing uid-map permission). Only these
/// specific signals match: a bwrap failure that merely says "Operation not permitted" (for
/// example a mount refused inside Docker/LXC or by a seccomp filter) is NOT a user-namespace
/// denial, and sending that user to a privileged setup or a package reinstall would not help.
#[cfg(unix)]
fn is_user_namespace_denial(message: &str) -> bool {
    [
        "RTM_NEWADDR",
        "setting up uid map",
        "No permissions to create new namespace",
        "Creating new namespace failed",
    ]
    .iter()
    .any(|signal| message.contains(signal))
}

/// On a platform that has no published runtime, "download the runtime" is not a remedy anyone
/// can follow: the install would fail with `SANDBOX_PLATFORM_UNSUPPORTED`. Such a result is
/// reported as a failure without a remedy and with the platform reason instead. Results that do
/// not offer a download are returned unchanged.
#[cfg(unix)]
#[allow(dead_code)]
fn without_unavailable_download(readiness: SandboxReadiness, published: bool) -> SandboxReadiness {
    match readiness {
        SandboxReadiness::NeedsSetup {
            code,
            reason,
            remedy: Remedy::DownloadRuntime,
            ..
        } if !published => {
            let platform = super::bundle_install::NO_RUNTIME_PUBLISHED;
            let reason = if code == SetupCode::BundleMissing {
                platform.to_string()
            } else {
                format!("{reason} {platform}")
            };
            SandboxReadiness::needs_setup(SetupCode::SandboxFailed, reason, Remedy::None)
        }
        other => other,
    }
}

/// Maps a failed `Sidecar::start` / `probe` (the host error `code` and `message`) to the
/// readiness it means. Pure, so the table test needs no Linux.
///
/// - `BUNDLE_STALE` (older protocol) -> reinstall the runtime; `BUNDLE_NEWER` -> update the app.
/// - `HELPER_MISSING` (a file the bundle should contain is gone) -> the bundle is invalid:
///   reinstall the runtime.
/// - A known user-namespace denial -> same remedy as a missing bwrap.
/// - Anything else -> `SandboxFailed` with the message verbatim and no remedy: we do not guess.
#[cfg(unix)]
fn classify_probe_failure(code: &str, message: &str, appimage: bool) -> SandboxReadiness {
    match code {
        "BUNDLE_STALE" => SandboxReadiness::needs_setup(
            SetupCode::BundleStale,
            message,
            Remedy::DownloadRuntime,
        ),
        "BUNDLE_NEWER" => {
            SandboxReadiness::needs_setup(SetupCode::BundleNewer, message, Remedy::UpdateApp)
        }
        "HELPER_MISSING" => SandboxReadiness::needs_setup(
            SetupCode::BundleInvalid,
            message,
            Remedy::DownloadRuntime,
        ),
        _ if is_user_namespace_denial(message) => {
            SandboxReadiness::bwrap_setup(SetupCode::UserNamespaceRestricted, message, appimage)
        }
        _ => SandboxReadiness::needs_setup(SetupCode::SandboxFailed, message, Remedy::None),
    }
}

/// Whether `path` is a regular file (following symlinks) with at least one execute bit.
#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
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

#[cfg(unix)]
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
    probe_bundle_with(bundle, init, running_as_appimage())
}

/// `probe_bundle` with the AppImage decision as a parameter, so tests do not depend on (or
/// mutate) this process's environment.
///
/// Deterministic pre-checks run before any process is started: a missing bundle, then (when the
/// init names one) a missing or non-executable bubblewrap. Only then is the sidecar started.
#[cfg(unix)]
fn probe_bundle_with(bundle: &Path, init: &InitConfig, appimage: bool) -> SandboxReadiness {
    if !bundle.join("srt-sidecar").is_file() {
        return SandboxReadiness::bundle_missing();
    }
    if let Some(bwrap) = init.bwrap_path.as_deref() {
        if !is_executable_file(Path::new(bwrap)) {
            return SandboxReadiness::bwrap_setup(
                SetupCode::BwrapMissing,
                format!("The sandbox helper bubblewrap is missing or not executable at {bwrap}"),
                appimage,
            );
        }
    }
    let sidecar = match Sidecar::start(bundle, init) {
        Ok(sidecar) => sidecar,
        Err(error) => return classify_probe_failure(error.code, &error.message, appimage),
    };
    if let Err(error) = sidecar.probe() {
        return classify_probe_failure(error.code, &error.message, appimage);
    }
    SandboxReadiness::Ready {
        toolchain_path: Some(user_path().1),
    }
}

/// `LocalHost::sandbox_readiness`'s cache: probing is expensive (spawning a login shell; on
/// Linux, starting a whole sidecar process and round-tripping `init` + `probe`), and
/// `local_host_status` is polled by the Web UI every few seconds, so a fresh probe runs only
/// when the cached value could plausibly be stale.
///
/// Policy: a cached `Ready` is never rechecked on its own; only `invalidate` (after a runtime
/// install or the privileged setup) expires it. A cached
/// `NeedsSetup`/`Unsupported` is rechecked once `recheck_interval` has elapsed, since whatever
/// was wrong might have been fixed since. While a probe is already running on some thread, a
/// concurrent call never blocks on it: it returns the last known value, or a transient
/// `SandboxReadiness::checking()` (`NeedsSetup`, reason "Checking the sandbox runtime", no
/// remedy) if there isn't one yet.
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
    /// Bumped by every `invalidate`. A probe that started before an invalidation answers its
    /// own caller but does not store its (possibly pre-install) result.
    epoch: u64,
    /// A runtime install is running (see `InstallGuard`): readiness reports `installing`.
    installing: bool,
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
        let epoch = {
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
                    .unwrap_or_else(SandboxReadiness::checking);
            }
            state.probing = true;
            state.epoch
        };

        // A panicking probe must not leave `probing` set forever.
        struct ClearProbing<'a>(&'a Mutex<ReadinessCache>, bool);
        impl Drop for ClearProbing<'_> {
            fn drop(&mut self) {
                if self.1 {
                    ReadinessCache::lock(self.0).probing = false;
                }
            }
        }
        let mut clear = ClearProbing(cache, true);
        let result = probe();
        clear.1 = false;

        let mut state = Self::lock(cache);
        state.probing = false;
        if state.epoch == epoch {
            state.last = Some((result.clone(), Instant::now()));
        }
        result
    }

    /// Clears the cached value (but not `probing`, which only the in-flight `get_or_probe`
    /// call that set it may clear), forcing the next `get_or_probe` call to probe again
    /// regardless of how fresh the cleared value was.
    fn invalidate(cache: &Mutex<Self>) {
        let mut state = Self::lock(cache);
        state.last = None;
        state.epoch += 1;
    }

    /// Whether a runtime install is running right now.
    pub(crate) fn is_installing(cache: &Mutex<Self>) -> bool {
        Self::lock(cache).installing
    }

    #[cfg(test)]
    pub(crate) fn seed_for_test(cache: &Mutex<Self>, value: SandboxReadiness) {
        Self::lock(cache).last = Some((value, Instant::now()));
    }

    #[cfg(test)]
    pub(crate) fn cached_for_test(cache: &Mutex<Self>) -> Option<SandboxReadiness> {
        Self::lock(cache).last.as_ref().map(|(value, _)| value.clone())
    }

    /// Marks an install as running. `None` when one already is: installs never overlap. The
    /// returned guard ends the install, and invalidates the cache, when dropped, whatever the
    /// outcome, so neither a success nor a failure leaves a stale answer behind.
    pub(crate) fn begin_install(cache: &Mutex<Self>) -> Option<InstallGuard<'_>> {
        let mut state = Self::lock(cache);
        if state.installing {
            return None;
        }
        state.installing = true;
        Some(InstallGuard { cache })
    }

    /// A poisoned lock here means some earlier call panicked while holding it; the cache is
    /// just an `Option` plus a `bool`, nothing left half-written can be unsafe to read, so
    /// recovering and carrying on is preferable to poisoning every later readiness check too.
    fn lock(cache: &Mutex<Self>) -> std::sync::MutexGuard<'_, Self> {
        cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Held for the duration of a runtime install; see `ReadinessCache::begin_install`.
pub(crate) struct InstallGuard<'a> {
    cache: &'a Mutex<ReadinessCache>,
}

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        let mut state = ReadinessCache::lock(self.cache);
        state.installing = false;
        state.last = None;
        state.epoch += 1;
    }
}

#[cfg(target_os = "linux")]
const SANDBOX_READINESS_RECHECK_INTERVAL: Duration = Duration::from_secs(60);

impl LocalHost {
    /// Whether local sandboxed execution can run right now, and why not if it cannot. macOS
    /// keeps its Seatbelt path (migrated by a later plan) and is always `Ready`, without ever
    /// touching a sandbox bundle or spawning a login shell (`toolchain_path` is `None`: Seatbelt
    /// execution does not use the login-shell `PATH`). Linux probes the bundle under this host's own
    /// app-data directory, through `ReadinessCache` so repeated polling doesn't repeatedly
    /// spawn a sidecar. Every other platform is `Unsupported`.
    pub fn sandbox_readiness(&self) -> SandboxReadiness {
        // While the runtime is being replaced there is nothing meaningful to probe, and the
        // bundle directory may be mid-swap.
        if ReadinessCache::is_installing(&self.sandbox_readiness_cache) {
            return SandboxReadiness::installing();
        }

        #[cfg(target_os = "macos")]
        return SandboxReadiness::Ready {
            toolchain_path: None,
        };

        #[cfg(target_os = "linux")]
        return ReadinessCache::get_or_probe(
            &self.sandbox_readiness_cache,
            SANDBOX_READINESS_RECHECK_INTERVAL,
            || {
                // The same helpers, bwrap and read roots that command execution uses (see
                // `srt_exec::init_config`), probed against the automatic workspace base.
                let bundle = bundle_dir(&self.base);
                let init = super::srt_exec::init_config(
                    &bundle,
                    &self.base,
                    vec![self.workspace_base().to_string_lossy().into_owned()],
                );
                // A crash in the middle of a runtime swap leaves the previous runtime aside.
                super::bundle_install::recover_previous_runtime(&self.base.join("sandbox"));
                without_unavailable_download(
                    probe_bundle(&bundle, &init),
                    super::bundle_install::InstallSpec::runtime_published(),
                )
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

    fn needs_setup_for_test(reason: &str) -> SandboxReadiness {
        SandboxReadiness::needs_setup(SetupCode::SandboxFailed, reason, Remedy::None)
    }

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
            deny_roots: vec![],
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
        assert_eq!(readiness, SandboxReadiness::bundle_missing());
        assert_eq!(
            serde_json::to_value(&readiness).unwrap(),
            serde_json::json!({
                "state": "needsSetup",
                "code": "bundleMissing",
                "reason": "Sandbox runtime is not installed",
                "remedy": "downloadRuntime",
            })
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
            SandboxReadiness::needs_setup(
                SetupCode::SandboxFailed,
                "stub probe failure for readiness test",
                Remedy::None
            )
        );
    }

    #[test]
    #[cfg(unix)]
    fn stale_or_newer_bundles_need_setup_with_the_exact_reason() {
        let bundle = bundle_with_stub();
        for (mode, code, remedy, expected) in [
            (
                "protocol-null",
                SetupCode::BundleStale,
                Remedy::DownloadRuntime,
                "The sandbox runtime is out of date (protocol none, this app needs 1). Install the update.",
            ),
            (
                "protocol-0",
                SetupCode::BundleStale,
                Remedy::DownloadRuntime,
                "The sandbox runtime is out of date (protocol 0, this app needs 1). Install the update.",
            ),
            (
                "protocol-2",
                SetupCode::BundleNewer,
                Remedy::UpdateApp,
                "The sandbox runtime (protocol 2) is newer than this app supports (1). Update SourceWeft.",
            ),
        ] {
            let mut init = test_init();
            init.home = format!("/tmp/sourceweft-readiness-test-home/{mode}");
            assert_eq!(
                probe_bundle(bundle.path(), &init),
                SandboxReadiness::needs_setup(code, expected, remedy),
                "{mode}"
            );
        }
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
                toolchain_path: Some(ToolchainPath::System),
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
            needs_setup_for_test("not yet")
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
            needs_setup_for_test("not yet")
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
                needs_setup_for_test("stale"),
                Instant::now(),
            )),
            probing: true,
            ..Default::default()
        });
        let result = ReadinessCache::get_or_probe(&cache, Duration::from_secs(0), || {
            panic!("must not call probe while one is already in flight")
        });
        assert_eq!(result, needs_setup_for_test("stale"));
    }

    #[test]
    fn a_probe_already_in_flight_with_no_prior_result_reports_checking() {
        let cache = Mutex::new(ReadinessCache {
            last: None,
            probing: true,
            ..Default::default()
        });
        let result = ReadinessCache::get_or_probe(&cache, Duration::from_secs(0), || {
            panic!("must not call probe while one is already in flight")
        });
        assert_eq!(result, SandboxReadiness::checking());
        assert!(matches!(
            result,
            SandboxReadiness::NeedsSetup { ref reason, remedy: Remedy::None, .. }
                if reason == "Checking the sandbox runtime"
        ));
    }

    #[test]
    fn invalidate_forces_a_fresh_probe_even_within_the_interval() {
        let cache = Mutex::new(ReadinessCache::default());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            SandboxReadiness::Ready {
                toolchain_path: Some(ToolchainPath::System),
            }
        };
        ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), probe);
        ReadinessCache::invalidate(&cache);
        ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), probe);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn a_probe_that_started_before_an_invalidation_does_not_cache_its_stale_answer() {
        let cache = Mutex::new(ReadinessCache::default());
        let stale = ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), || {
            // The install finishes while this probe is still running.
            ReadinessCache::invalidate(&cache);
            SandboxReadiness::bundle_missing()
        });
        assert_eq!(stale, SandboxReadiness::bundle_missing(), "its own caller still gets it");
        let fresh = ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), || {
            SandboxReadiness::Ready {
                toolchain_path: Some(ToolchainPath::System),
            }
        });
        assert!(matches!(fresh, SandboxReadiness::Ready { .. }), "nothing stale was cached");
    }

    #[test]
    fn installs_do_not_overlap_and_the_guard_invalidates_on_drop() {
        let cache = Mutex::new(ReadinessCache::default());
        ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), SandboxReadiness::bundle_missing);
        assert!(!ReadinessCache::is_installing(&cache));
        let guard = ReadinessCache::begin_install(&cache).expect("first install starts");
        assert!(ReadinessCache::is_installing(&cache));
        assert!(ReadinessCache::begin_install(&cache).is_none(), "second install refused");
        drop(guard);
        assert!(!ReadinessCache::is_installing(&cache));
        assert!(ReadinessCache::lock(&cache).last.is_none(), "the cached answer was dropped");
        assert!(ReadinessCache::begin_install(&cache).is_some(), "a later install may start");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_is_ready_without_bundle() {
        let app_data = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app_data.path()).unwrap();
        // No bundle was ever placed under `app_data`; macOS must still report Ready.
        assert!(!bundle_dir(app_data.path()).exists());
        // Ruling R26: no login shell on macOS, so no toolchain path either.
        assert_eq!(
            host.sandbox_readiness(),
            SandboxReadiness::Ready {
                toolchain_path: None
            },
            "expected Ready without a bundle on macOS"
        );
    }

    #[test]
    fn needs_setup_wire_shape() {
        use serde_json::json;
        assert_eq!(
            serde_json::to_value(SandboxReadiness::installing()).unwrap(),
            json!({
                "state": "needsSetup",
                "code": "installing",
                "reason": "Installing the sandbox runtime",
                "remedy": "none",
            })
        );
        assert_eq!(
            serde_json::to_value(SandboxReadiness::NeedsSetup {
                code: SetupCode::BwrapMissing,
                reason: "missing".to_string(),
                remedy: Remedy::PrivilegedSetup,
                setup_command: Some("pkexec true".to_string()),
            })
            .unwrap(),
            json!({
                "state": "needsSetup",
                "code": "bwrapMissing",
                "reason": "missing",
                "remedy": "privilegedSetup",
                "setupCommand": "pkexec true",
            })
        );
        assert_eq!(
            serde_json::to_value(SandboxReadiness::Unsupported).unwrap(),
            json!({"state": "unsupported"})
        );
    }

    #[test]
    fn every_code_and_remedy_serialises_camel_case() {
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
        for (code, wire) in codes {
            assert_eq!(serde_json::to_value(code).unwrap(), wire);
        }
        let remedies = [
            (Remedy::DownloadRuntime, "downloadRuntime"),
            (Remedy::UpdateApp, "updateApp"),
            (Remedy::ReinstallPackage, "reinstallPackage"),
            (Remedy::PrivilegedSetup, "privilegedSetup"),
            (Remedy::None, "none"),
        ];
        for (remedy, wire) in remedies {
            assert_eq!(serde_json::to_value(remedy).unwrap(), wire);
        }
    }

    #[cfg(unix)]
    #[test]
    fn probe_failures_are_classified() {
        let command = crate::local_host::privileged_setup::privileged_setup_command();
        let setup = |code: SetupCode, reason: &str, appimage: bool| {
            if appimage {
                SandboxReadiness::NeedsSetup {
                    code,
                    reason: reason.to_string(),
                    remedy: Remedy::PrivilegedSetup,
                    setup_command: Some(command.clone()),
                }
            } else {
                SandboxReadiness::needs_setup(code, reason, Remedy::ReinstallPackage)
            }
        };
        let userns = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
        let uid_map = "bwrap: setting up uid map: Permission denied";
        let namespace = "bwrap: Creating new namespace failed: Operation not permitted";
        let no_permissions = "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.";
        let multi_line = "srt: wrap failed\nbwrap: Creating new namespace failed: Operation not permitted\n";
        for appimage in [false, true] {
            // Bundle problems never depend on how the app was installed.
            assert_eq!(
                classify_probe_failure("BUNDLE_STALE", "old", appimage),
                SandboxReadiness::needs_setup(SetupCode::BundleStale, "old", Remedy::DownloadRuntime)
            );
            assert_eq!(
                classify_probe_failure("BUNDLE_NEWER", "new", appimage),
                SandboxReadiness::needs_setup(SetupCode::BundleNewer, "new", Remedy::UpdateApp)
            );
            assert_eq!(
                classify_probe_failure("HELPER_MISSING", "sandbox helper not found at /b/rg", appimage),
                SandboxReadiness::needs_setup(
                    SetupCode::BundleInvalid,
                    "sandbox helper not found at /b/rg",
                    Remedy::DownloadRuntime
                )
            );
            // The known user-namespace denials, whatever code carried them.
            for message in [userns, uid_map, namespace, no_permissions, multi_line] {
                for code in ["SANDBOX_UNAVAILABLE", "POLICY_INVALID"] {
                    assert_eq!(
                        classify_probe_failure(code, message, appimage),
                        setup(SetupCode::UserNamespaceRestricted, message, appimage),
                        "{code}: {message}"
                    );
                }
            }
            // Everything else is reported verbatim with no remedy.
            for message in [
                "bwrap: Can't find source path /nope: No such file or directory",
                "cp: cannot create regular file: Operation not permitted",
                // Docker/LXC/seccomp refusals of other bwrap steps: not a user-namespace denial,
                // so no privileged setup or reinstall is offered for them.
                "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
                "bwrap: Can't mount tmpfs on /newroot: Operation not permitted",
                "bwrap: mount --make-rslave / failed: Operation not permitted",
                "bwrap: Can't bind mount /oldroot/usr on /newroot/usr: Operation not permitted",
                "bwrap: pivot_root: Operation not permitted",
                "sandbox probe exited with code 1",
                "Operation not permitted",
                "",
            ] {
                assert_eq!(
                    classify_probe_failure("SANDBOX_UNAVAILABLE", message, appimage),
                    SandboxReadiness::needs_setup(SetupCode::SandboxFailed, message, Remedy::None),
                    "{message}"
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn download_is_only_offered_where_a_runtime_is_published() {
        let missing = SandboxReadiness::bundle_missing();
        let unavailable = without_unavailable_download(missing.clone(), false);
        assert_eq!(
            unavailable,
            SandboxReadiness::needs_setup(
                SetupCode::SandboxFailed,
                "No sandbox runtime is published for this platform.",
                Remedy::None
            )
        );
        // Stale and invalid bundles keep their reason, but lose the unusable remedy.
        for code in [SetupCode::BundleStale, SetupCode::BundleInvalid] {
            let result = without_unavailable_download(
                SandboxReadiness::needs_setup(code, "old runtime.", Remedy::DownloadRuntime),
                false,
            );
            assert_eq!(
                result,
                SandboxReadiness::needs_setup(
                    SetupCode::SandboxFailed,
                    "old runtime. No sandbox runtime is published for this platform.",
                    Remedy::None
                )
            );
        }
        // Published platform: untouched. Other remedies and states: untouched everywhere.
        assert_eq!(without_unavailable_download(missing.clone(), true), missing);
        for other in [
            SandboxReadiness::needs_setup(SetupCode::BundleNewer, "n", Remedy::UpdateApp),
            SandboxReadiness::needs_setup(SetupCode::SandboxFailed, "f", Remedy::None),
            SandboxReadiness::Unsupported,
            SandboxReadiness::Ready { toolchain_path: None },
        ] {
            assert_eq!(without_unavailable_download(other.clone(), false), other);
        }
    }

    #[test]
    fn a_panicking_probe_does_not_leave_probing_set() {
        let cache = Mutex::new(ReadinessCache::default());
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), || panic!("probe blew up"))
        }));
        assert!(panicked.is_err());
        let result = ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), || {
            SandboxReadiness::bundle_missing()
        });
        assert_eq!(result, SandboxReadiness::bundle_missing(), "the next call probes again");
    }

    #[cfg(unix)]
    mod bwrap_precheck {
        use super::*;
        use std::{fs, os::unix::fs::PermissionsExt};

        fn init_with_bwrap(path: &Path) -> InitConfig {
            let mut init = test_init();
            init.bwrap_path = Some(path.to_string_lossy().into_owned());
            init
        }

        fn write_mode(path: &Path, mode: u32) {
            fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        }

        #[test]
        fn a_missing_or_non_executable_bwrap_needs_privileged_setup_or_a_reinstall() {
            let bundle = bundle_with_stub();
            let dir = tempfile::tempdir().unwrap();
            let not_executable = dir.path().join("bwrap-noexec");
            write_mode(&not_executable, 0o644);
            let directory = dir.path().join("bwrap-dir");
            fs::create_dir(&directory).unwrap();
            let missing = dir.path().join("bwrap-missing");

            for path in [missing, not_executable, directory] {
                let init = init_with_bwrap(&path);
                let reason = format!(
                    "The sandbox helper bubblewrap is missing or not executable at {}",
                    path.display()
                );
                assert_eq!(
                    probe_bundle_with(bundle.path(), &init, false),
                    SandboxReadiness::needs_setup(
                        SetupCode::BwrapMissing,
                        reason.clone(),
                        Remedy::ReinstallPackage
                    ),
                    "{path:?}"
                );
                assert_eq!(
                    probe_bundle_with(bundle.path(), &init, true),
                    SandboxReadiness::NeedsSetup {
                        code: SetupCode::BwrapMissing,
                        reason,
                        remedy: Remedy::PrivilegedSetup,
                        setup_command: Some(
                            crate::local_host::privileged_setup::privileged_setup_command()
                        ),
                    },
                    "{path:?}"
                );
            }
        }

        #[test]
        fn an_executable_bwrap_lets_the_probe_proceed() {
            let bundle = bundle_with_stub();
            let dir = tempfile::tempdir().unwrap();
            let bwrap = dir.path().join("bwrap");
            write_mode(&bwrap, 0o755);
            let readiness =
                probe_bundle_with(bundle.path(), &init_with_bwrap(&bwrap), false);
            assert!(
                matches!(readiness, SandboxReadiness::Ready { .. }),
                "expected Ready, got {readiness:?}"
            );
        }

        #[test]
        fn a_missing_bundle_is_reported_before_a_missing_bwrap() {
            let bundle = tempfile::tempdir().unwrap();
            let init = init_with_bwrap(Path::new("/nonexistent/bwrap"));
            assert_eq!(
                probe_bundle_with(bundle.path(), &init, true),
                SandboxReadiness::bundle_missing()
            );
        }
    }

    #[test]
    fn ready_without_a_toolchain_path_omits_the_field() {
        assert_eq!(
            serde_json::to_value(SandboxReadiness::Ready {
                toolchain_path: None
            })
            .unwrap(),
            serde_json::json!({"state": "ready"})
        );
        assert_eq!(
            serde_json::to_value(SandboxReadiness::Ready {
                toolchain_path: Some(ToolchainPath::LoginShell)
            })
            .unwrap(),
            serde_json::json!({"state": "ready", "toolchainPath": "loginShell"})
        );
    }
}
