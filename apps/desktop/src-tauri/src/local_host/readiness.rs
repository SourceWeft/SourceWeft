//! Readiness of local sandboxed execution, and toolchain `PATH` discovery for the commands run
//! inside it.
//!
//! On macOS and Linux readiness is the sandbox bundle's probe (the sidecar's `init` + `probe`
//! round trip). On Windows it is a chain (`windows_readiness`): the bundle, the staged
//! `srt-win.exe` against the bundle's manifest hash, that helper's own status, and then the same
//! `init` + `probe` round trip on a scratch workspace. Nothing here ever reports `Ready` on a
//! missing helper, a failed `init`/`probe` round trip, or a dead sidecar: those are reported as
//! `NeedsSetup` with a reason, so local execution fails loudly instead of silently running
//! unsandboxed. Readiness never reads or writes the state of an upstream default srt install.
use super::{HostError, LocalHost};
#[cfg(any(unix, windows))]
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
#[cfg(any(unix, windows))]
pub use super::sidecar::{Helpers, InitConfig, Platform, WindowsInit};

/// Readiness of local sandboxed execution on this platform, reported to the Web UI via
/// `local_bridge::local_host_status` (`state` is the serde tag).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SandboxReadiness {
    // `rename_all` on the enum itself only renames variant names (`state` values), not the
    // fields of a struct variant, so `toolchain_path` needs its own `rename_all` to come out
    // as `toolchainPath` on the wire.
    //
    // `toolchain_path` is `None` only for a value built without a login-shell lookup (the
    // field is then omitted on the wire).
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
    /// Windows: the helper or the sandbox account has not been set up on this computer.
    WindowsNotInstalled,
    /// Windows: a setup exists but is not the one this release needs.
    WindowsSetupOutdated,
}

/// What the user can do about a `NeedsSetup`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Remedy {
    DownloadRuntime,
    UpdateApp,
    ReinstallPackage,
    PrivilegedSetup,
    /// Windows: one UAC-elevated setup (a button; there is no command to copy).
    ElevatedSetup,
    None,
}

// Constructors are used by the Linux probe, the installer, and the tests; a plain macOS
// `cargo build` sees no caller for some of them.
#[allow(dead_code)]
impl SandboxReadiness {
    pub(crate) fn needs_setup(code: SetupCode, reason: impl Into<String>, remedy: Remedy) -> Self {
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
        // The only two situations a package reinstall or the privileged setup can fix.
        debug_assert!(matches!(
            code,
            SetupCode::BwrapMissing | SetupCode::UserNamespaceRestricted
        ));
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
#[cfg(any(unix, windows))]
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

/// Waits (bounded) until `read` stops answering with the transient "checking" placeholder, which
/// it does while a probe from another thread is still in flight. Install uses this so its result
/// is a real state. `None` when the wait ran out.
pub(crate) fn settled_readiness(
    mut read: impl FnMut() -> SandboxReadiness,
    poll: Duration,
    limit: Duration,
) -> Option<SandboxReadiness> {
    let deadline = Instant::now() + limit;
    loop {
        let current = read();
        if current != SandboxReadiness::checking() {
            return Some(current);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(poll);
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
    if let Some(readiness) = classify_bundle_failure(code, message) {
        return readiness;
    }
    if is_user_namespace_denial(message) {
        return SandboxReadiness::bwrap_setup(SetupCode::UserNamespaceRestricted, message, appimage);
    }
    SandboxReadiness::needs_setup(SetupCode::SandboxFailed, message, Remedy::None)
}

/// The failures that are about the downloaded bundle and mean the same on every platform: an older
/// protocol or a missing file -> reinstall the runtime, a newer protocol -> update the app. `None`
/// for any other code.
#[cfg(any(unix, windows))]
pub(crate) fn classify_bundle_failure(code: &str, message: &str) -> Option<SandboxReadiness> {
    match code {
        "BUNDLE_STALE" => Some(SandboxReadiness::needs_setup(
            SetupCode::BundleStale,
            message,
            Remedy::DownloadRuntime,
        )),
        "BUNDLE_NEWER" => Some(SandboxReadiness::needs_setup(
            SetupCode::BundleNewer,
            message,
            Remedy::UpdateApp,
        )),
        "HELPER_MISSING" => Some(SandboxReadiness::needs_setup(
            SetupCode::BundleInvalid,
            message,
            Remedy::DownloadRuntime,
        )),
        _ => None,
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

/// The `PATH` of the host process on Windows, as the sandboxed command will resolve tools through
/// it. The sandbox sidecar is started with this very `PATH` and srt hands it to the broker, whose
/// `PATH` is the one overlay the sandboxed child inherits (Plan 6, fact 6): there is no login shell
/// to ask, and `System` is what is reported. A `PATH` that is not valid Unicode is converted
/// lossily; an unset one is empty.
#[cfg(any(windows, test))]
pub(crate) fn windows_path_value(raw: Option<std::ffi::OsString>) -> String {
    raw.map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Cached for the lifetime of the process, like the unix login-shell lookup: `PATH` is not
/// expected to change while the app runs, and the sidecar captured it at start anyway.
#[cfg(windows)]
pub(crate) fn user_path() -> (String, ToolchainPath) {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let path = CACHE.get_or_init(|| windows_path_value(std::env::var_os("PATH")));
    (path.clone(), ToolchainPath::System)
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
    if !bundle.join(super::sidecar::sidecar_file_name()).is_file() {
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

/// `LocalHost::sandbox_readiness`'s cache: probing is expensive (spawning a login shell, then
/// starting a whole sidecar process and round-tripping `init` + `probe`), and
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
// `get_or_probe`/`invalidate` are only reached from `sandbox_readiness` on macOS and Linux, so a
// build for any other target sees no caller and would otherwise warn this whole type as dead
// code; the unit tests below exercise the cache policy directly (platform-independently),
// which is also why the type is not itself `cfg`-gated to those targets.
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
    /// Windows: consecutive probes whose first start did not finish within the init timeout
    /// (`SANDBOX_INIT_TIMEOUT`). Reset by a successful probe and when an install or setup begins
    /// (a new bundle or helper is a new situation); deliberately not by `invalidate`.
    init_timeouts: u32,
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

    /// Records one more probe that hit the init timeout; returns how many in a row there are.
    #[cfg(any(windows, test))]
    pub(crate) fn note_init_timeout(cache: &Mutex<Self>) -> u32 {
        let mut state = Self::lock(cache);
        state.init_timeouts = state.init_timeouts.saturating_add(1);
        state.init_timeouts
    }

    /// A probe got past the first start: the streak is over.
    #[cfg(any(windows, test))]
    pub(crate) fn clear_init_timeouts(cache: &Mutex<Self>) {
        Self::lock(cache).init_timeouts = 0;
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
        state.init_timeouts = 0;
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

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
const SANDBOX_READINESS_RECHECK_INTERVAL: Duration = Duration::from_secs(60);

/// The steps of the Windows readiness check, as functions of the machine, so the order and the
/// fail-closed behaviour of the check are tested with injected answers on every platform.
#[cfg(any(windows, test))]
pub(crate) struct WindowsProbe<'a> {
    /// The bundle's sidecar executable exists.
    pub bundle_present: &'a dyn Fn() -> bool,
    /// The SHA-256 the bundle's manifest lists for `srt-win.exe`.
    pub bundle_srt_win_hash: &'a dyn Fn() -> super::Result<String>,
    /// The SHA-256 of the staged helper: `Ok(None)` when none is staged, `Err` (with the reason)
    /// when it cannot be determined.
    pub staged_hash: &'a dyn Fn() -> Result<Option<String>, String>,
    /// `srt-win status` of the staged helper.
    pub status: &'a dyn Fn() -> Result<super::windows::SrtWinStatus, String>,
    /// The sidecar `init` + `probe` round trip on a scratch workspace.
    pub sidecar: &'a dyn Fn() -> super::Result<()>,
}

/// Windows readiness: bundle present -> the staged helper exists and is the bundle's -> its status
/// -> the sidecar's `init` + `probe` (srt's own provisioning and WFP fence check, under the token a
/// command gets). The first step that fails decides; `Ready` only when every step passed, and no
/// step is skipped or substituted when another fails.
#[cfg(any(windows, test))]
pub(crate) fn windows_readiness(probe: &WindowsProbe<'_>) -> SandboxReadiness {
    use super::windows::{
        classify_staged_helper, classify_windows_probe_failure, classify_windows_status,
    };
    if !(probe.bundle_present)() {
        return SandboxReadiness::bundle_missing();
    }
    let bundle_hash = match (probe.bundle_srt_win_hash)() {
        Ok(hash) => hash,
        Err(error) => {
            return SandboxReadiness::needs_setup(
                SetupCode::BundleInvalid,
                error.message,
                Remedy::DownloadRuntime,
            )
        }
    };
    let staged_hash = match (probe.staged_hash)() {
        Ok(hash) => hash,
        Err(reason) => {
            return SandboxReadiness::needs_setup(SetupCode::SandboxFailed, reason, Remedy::None)
        }
    };
    if let Some(readiness) = classify_staged_helper(staged_hash.as_deref(), &bundle_hash) {
        return readiness;
    }
    let staged_hash = staged_hash.unwrap_or_default();
    let status = match (probe.status)() {
        Ok(status) => status,
        Err(reason) => {
            return SandboxReadiness::needs_setup(SetupCode::SandboxFailed, reason, Remedy::None)
        }
    };
    if let Some(readiness) = classify_windows_status(&status, &bundle_hash, &staged_hash) {
        return readiness;
    }
    if let Err(error) = (probe.sidecar)() {
        return classify_windows_probe_failure(error.code, &error.message);
    }
    SandboxReadiness::Ready {
        toolchain_path: Some(ToolchainPath::System),
    }
}

/// How many probes in a row may report "still getting ready" before it is called a failure.
#[cfg(any(windows, test))]
pub(crate) const MAX_PREPARING_PROBES: u32 = 3;

/// The error a probe reports for its `streak`-th consecutive init timeout: the transient one
/// (`SANDBOX_INIT_TIMEOUT`, shown as "getting ready") until [`MAX_PREPARING_PROBES`] have passed,
/// then a failure that says so and where to look. `minutes` is the init timeout each probe waited,
/// `result_file` the setup's result file.
#[cfg(any(windows, test))]
pub(crate) fn cap_init_timeout(
    streak: u32,
    error: HostError,
    minutes: u64,
    result_file: &str,
) -> HostError {
    if streak < MAX_PREPARING_PROBES {
        return error;
    }
    HostError::new(
        "SANDBOX_START_INCOMPLETE",
        format!(
            "The sandbox did not finish its first start: {streak} checks in a row each waited \
             {minutes} minutes for it. The setup's own account of what it did is in {result_file}; \
             running the sandbox setup again (or removing and reinstalling it) usually fixes this."
        ),
    )
}

impl LocalHost {
    /// Whether local sandboxed execution can run right now, and why not if it cannot. macOS,
    /// Linux and Windows probe the bundle under this host's own app-data directory (Windows also
    /// checks its elevated setup), through `ReadinessCache` so repeated polling doesn't repeatedly
    /// spawn a sidecar. Every other platform is `Unsupported`.
    pub fn sandbox_readiness(&self) -> SandboxReadiness {
        // While the runtime is being replaced there is nothing meaningful to probe, and the
        // bundle directory may be mid-swap.
        if ReadinessCache::is_installing(&self.sandbox_readiness_cache) {
            return SandboxReadiness::installing();
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        return ReadinessCache::get_or_probe(
            &self.sandbox_readiness_cache,
            SANDBOX_READINESS_RECHECK_INTERVAL,
            || {
                // The same helpers, bwrap and read roots that command execution uses (see
                // `srt_exec::init_config`), probed against the automatic workspace base.
                let bundle = bundle_dir(&self.base);
                let init = super::srt_exec::init_config(
                    super::srt_exec::HOST_PLATFORM,
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

        #[cfg(windows)]
        return ReadinessCache::get_or_probe(
            &self.sandbox_readiness_cache,
            SANDBOX_READINESS_RECHECK_INTERVAL,
            || {
                // A crash in the middle of a runtime swap leaves the previous runtime aside.
                super::bundle_install::recover_previous_runtime(&self.base.join("sandbox"));
                without_unavailable_download(
                    self.probe_windows(),
                    super::bundle_install::InstallSpec::runtime_published(),
                )
            },
        );

        #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
        SandboxReadiness::Unsupported
    }

    /// The Windows readiness check against this host's bundle and this machine's staged helper.
    /// The sidecar round trip uses a scratch workspace root `<app data>/sandbox/probe`, never a
    /// user folder, built through the same `InitConfig` code as a real command.
    #[cfg(windows)]
    fn probe_windows(&self) -> SandboxReadiness {
        use super::windows::{file_sha256_hex, srt_win_status, staged_srt_win_path};
        let bundle = bundle_dir(&self.base);
        let probe_root = self.base.join("sandbox").join("probe");
        let staged = staged_srt_win_path();
        windows_readiness(&WindowsProbe {
            bundle_present: &|| bundle.join(super::sidecar::sidecar_file_name()).is_file(),
            bundle_srt_win_hash: &|| {
                super::bundle_install::bundle_file_sha256(&bundle, "srt-win.exe")
            },
            staged_hash: &|| {
                let path = staged.as_ref().ok_or_else(|| {
                    "The Program Files location could not be determined, so the sandbox helper cannot be found."
                        .to_string()
                })?;
                match file_sha256_hex(path) {
                    Ok(hash) => Ok(Some(hash)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(error) => Err(format!(
                        "The sandbox helper could not be read ({}): {error}",
                        path.display()
                    )),
                }
            },
            status: &|| match staged.as_ref() {
                Some(path) => srt_win_status(path),
                None => Err("The sandbox helper cannot be found.".to_string()),
            },
            sidecar: &|| {
                std::fs::create_dir_all(&probe_root)?;
                let (init, _) =
                    super::srt_exec::windows_init_config_for(&bundle, &self.base, &probe_root)?;
                // The first start after a fresh setup is slow (the sandbox account's profile is
                // created at its first logon): the same long `init` timeout as a workspace.
                let outcome = Sidecar::start_for_workspace(&bundle, &init).and_then(|sidecar| sidecar.probe());
                match outcome {
                    Ok(()) => {
                        ReadinessCache::clear_init_timeouts(&self.sandbox_readiness_cache);
                        Ok(())
                    }
                    Err(error) if error.code == "SANDBOX_INIT_TIMEOUT" => {
                        let streak = ReadinessCache::note_init_timeout(&self.sandbox_readiness_cache);
                        let result_file = super::windows::program_files_dir()
                            .and_then(|dir| super::windows::setup_result_path_in(&dir))
                            .map(|path| path.display().to_string())
                            .unwrap_or_else(|| "%ProgramFiles%\\SourceWeft\\sandbox-setup-result.json".into());
                        Err(cap_init_timeout(
                            streak,
                            error,
                            super::sidecar::WINDOWS_INIT_TIMEOUT.as_secs() / 60,
                            &result_file,
                        ))
                    }
                    Err(error) => Err(error),
                }
            },
        })
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

    #[test]
    fn a_slow_first_start_is_transient_three_times_then_a_failure_that_says_where_to_look() {
        use crate::local_host::windows::classify_windows_probe_failure;
        let cache = Mutex::new(ReadinessCache::default());
        let timeout = || HostError::new("SANDBOX_INIT_TIMEOUT", "slow");
        let answer = |streak: u32| {
            let error = cap_init_timeout(streak, timeout(), 10, r"C:\Program Files\SourceWeft\sandbox-setup-result.json");
            classify_windows_probe_failure(error.code, &error.message)
        };
        for expected in 1..MAX_PREPARING_PROBES {
            let streak = ReadinessCache::note_init_timeout(&cache);
            assert_eq!(streak, expected);
            match answer(streak) {
                SandboxReadiness::NeedsSetup { code: SetupCode::Installing, remedy: Remedy::None, .. } => {}
                other => panic!("probe {streak} must still be transient, got {other:?}"),
            }
        }
        let streak = ReadinessCache::note_init_timeout(&cache);
        assert_eq!(streak, MAX_PREPARING_PROBES);
        match answer(streak) {
            SandboxReadiness::NeedsSetup { code: SetupCode::SandboxFailed, remedy: Remedy::None, reason, .. } => {
                assert!(reason.contains("10 minutes"), "{reason}");
                assert!(reason.contains("sandbox-setup-result.json"), "{reason}");
                assert!(reason.contains("setup again"), "{reason}");
            }
            other => panic!("the third consecutive timeout must be a failure, got {other:?}"),
        }
    }

    #[test]
    fn the_init_timeout_streak_ends_on_success_and_when_an_install_begins_but_not_on_invalidate() {
        let cache = Mutex::new(ReadinessCache::default());
        ReadinessCache::note_init_timeout(&cache);
        ReadinessCache::note_init_timeout(&cache);
        ReadinessCache::invalidate(&cache);
        assert_eq!(ReadinessCache::note_init_timeout(&cache), 3, "invalidate keeps the streak");
        ReadinessCache::clear_init_timeouts(&cache);
        assert_eq!(ReadinessCache::note_init_timeout(&cache), 1, "a success starts over");
        ReadinessCache::note_init_timeout(&cache);
        drop(ReadinessCache::begin_install(&cache).unwrap());
        assert_eq!(ReadinessCache::note_init_timeout(&cache), 1, "a new install starts over");
    }

    #[test]
    fn windows_path_is_the_process_path_verbatim_or_empty() {
        use std::ffi::OsString;
        assert_eq!(
            windows_path_value(Some(OsString::from(r"C:\Windows\System32;C:\Users\me\.cargo\bin"))),
            r"C:\Windows\System32;C:\Users\me\.cargo\bin"
        );
        assert_eq!(windows_path_value(None), "");
    }

    // ---- Windows readiness (injected steps; runs on every platform) ----------------------------

    mod windows_flow {
        use super::*;
        use crate::local_host::{windows::SrtWinStatus, HostError};
        use std::cell::RefCell;

        const BUNDLE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        fn healthy_status() -> SrtWinStatus {
            SrtWinStatus {
                user_exists: true,
                in_sandbox_group: true,
                cred_present: true,
                marker_version: Some(3),
                setup_version: 3,
                wfp_state: "cannot-read".into(),
                port_range: None,
                allow_loopback: false,
            }
        }

        /// A machine for the flow: each step is a closure over a log so the order can be asserted.
        struct Machine {
            bundle_present: bool,
            bundle_hash: Result<String, (&'static str, &'static str)>,
            staged: Result<Option<String>, String>,
            status: Result<SrtWinStatus, String>,
            sidecar: Result<(), (&'static str, &'static str)>,
            log: RefCell<Vec<&'static str>>,
        }

        impl Machine {
            fn ready() -> Self {
                Self {
                    bundle_present: true,
                    bundle_hash: Ok(BUNDLE.to_string()),
                    staged: Ok(Some(BUNDLE.to_string())),
                    status: Ok(healthy_status()),
                    sidecar: Ok(()),
                    log: RefCell::new(Vec::new()),
                }
            }

            fn run(&self) -> SandboxReadiness {
                let host_error = |(code, message): (&'static str, &'static str)| HostError::new(code, message);
                windows_readiness(&WindowsProbe {
                    bundle_present: &|| {
                        self.log.borrow_mut().push("bundle");
                        self.bundle_present
                    },
                    bundle_srt_win_hash: &|| {
                        self.log.borrow_mut().push("bundle hash");
                        self.bundle_hash.clone().map_err(host_error)
                    },
                    staged_hash: &|| {
                        self.log.borrow_mut().push("staged hash");
                        self.staged.clone()
                    },
                    status: &|| {
                        self.log.borrow_mut().push("status");
                        self.status.clone()
                    },
                    sidecar: &|| {
                        self.log.borrow_mut().push("sidecar");
                        self.sidecar.map_err(host_error)
                    },
                })
            }

            fn steps(&self) -> Vec<&'static str> {
                self.log.borrow().clone()
            }
        }

        fn parts(readiness: &SandboxReadiness) -> (SetupCode, Remedy) {
            match readiness {
                SandboxReadiness::NeedsSetup { code, remedy, .. } => (*code, *remedy),
                other => panic!("expected NeedsSetup, got {other:?}"),
            }
        }

        #[test]
        fn every_step_passing_is_ready_and_nothing_else_is() {
            let machine = Machine::ready();
            assert_eq!(
                machine.run(),
                SandboxReadiness::Ready { toolchain_path: Some(ToolchainPath::System) }
            );
            assert_eq!(machine.steps(), ["bundle", "bundle hash", "staged hash", "status", "sidecar"]);
        }

        #[test]
        fn a_missing_bundle_asks_for_the_download_and_runs_nothing_else() {
            let machine = Machine { bundle_present: false, ..Machine::ready() };
            assert_eq!(machine.run(), SandboxReadiness::bundle_missing());
            assert_eq!(machine.steps(), ["bundle"]);
        }

        #[test]
        fn a_bundle_without_a_helper_entry_is_invalid_and_never_probed() {
            let machine = Machine {
                bundle_hash: Err(("SANDBOX_BUNDLE_INVALID", "The runtime does not contain srt-win.exe.")),
                ..Machine::ready()
            };
            let readiness = machine.run();
            assert_eq!(parts(&readiness), (SetupCode::BundleInvalid, Remedy::DownloadRuntime));
            assert_eq!(machine.steps(), ["bundle", "bundle hash"]);
        }

        #[test]
        fn no_staged_helper_needs_the_elevated_setup_and_never_runs_the_sidecar() {
            let machine = Machine { staged: Ok(None), ..Machine::ready() };
            let readiness = machine.run();
            assert_eq!(parts(&readiness), (SetupCode::WindowsNotInstalled, Remedy::ElevatedSetup));
            assert_eq!(machine.steps(), ["bundle", "bundle hash", "staged hash"]);
            // The wire form is what the backend and the web page accept.
            let value = serde_json::to_value(&readiness).unwrap();
            assert_eq!(value["code"], "windowsNotInstalled");
            assert_eq!(value["remedy"], "elevatedSetup");
            assert!(value.get("setupCommand").is_none(), "there is no command to copy on Windows");
        }

        #[test]
        fn a_different_staged_helper_is_outdated_and_its_status_is_never_run() {
            let machine = Machine { staged: Ok(Some("c".repeat(64))), ..Machine::ready() };
            assert_eq!(parts(&machine.run()), (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup));
            // A helper that is not the bundle's is not executed to ask it anything.
            assert_eq!(machine.steps(), ["bundle", "bundle hash", "staged hash"]);
        }

        #[test]
        fn an_unreadable_helper_or_status_fails_with_its_reason_and_no_remedy() {
            let unreadable = Machine { staged: Err("access denied".into()), ..Machine::ready() };
            let readiness = unreadable.run();
            assert_eq!(parts(&readiness), (SetupCode::SandboxFailed, Remedy::None));
            assert!(matches!(&readiness, SandboxReadiness::NeedsSetup { reason, .. } if reason == "access denied"));
            let broken = Machine { status: Err("did not start".into()), ..Machine::ready() };
            let readiness = broken.run();
            assert_eq!(parts(&readiness), (SetupCode::SandboxFailed, Remedy::None));
            assert_eq!(broken.steps(), ["bundle", "bundle hash", "staged hash", "status"]);
        }

        #[test]
        fn a_status_verdict_stops_before_the_sidecar() {
            let machine = Machine {
                status: Ok(SrtWinStatus { marker_version: Some(2), ..healthy_status() }),
                ..Machine::ready()
            };
            assert_eq!(parts(&machine.run()), (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup));
            assert_eq!(machine.steps().last(), Some(&"status"));
            let machine = Machine {
                status: Ok(SrtWinStatus { user_exists: false, ..healthy_status() }),
                ..Machine::ready()
            };
            assert_eq!(parts(&machine.run()), (SetupCode::WindowsNotInstalled, Remedy::ElevatedSetup));
        }

        #[test]
        fn sidecar_failures_are_classified_and_never_ready() {
            for (code, message, expected) in [
                ("SANDBOX_UNAVAILABLE", "[not_provisioned] not provisioned", (SetupCode::WindowsNotInstalled, Remedy::ElevatedSetup)),
                ("SANDBOX_UNAVAILABLE", "[reinstall_required] other release", (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup)),
                ("BUNDLE_STALE", "old protocol", (SetupCode::BundleStale, Remedy::DownloadRuntime)),
                ("BUNDLE_NEWER", "new protocol", (SetupCode::BundleNewer, Remedy::UpdateApp)),
                ("HELPER_MISSING", "no ripgrep", (SetupCode::BundleInvalid, Remedy::DownloadRuntime)),
                ("SANDBOX_UNAVAILABLE", "sidecar did not reply in time", (SetupCode::SandboxFailed, Remedy::None)),
            ] {
                let machine = Machine { sidecar: Err((code, message)), ..Machine::ready() };
                let readiness = machine.run();
                assert_eq!(parts(&readiness), expected, "{message}");
                assert!(!matches!(readiness, SandboxReadiness::Ready { .. }));
            }
        }
    }

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
            windows: None,
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
                "The sandbox runtime is out of date (protocol none, this app needs 2). Install the update.",
            ),
            (
                "protocol-0",
                SetupCode::BundleStale,
                Remedy::DownloadRuntime,
                "The sandbox runtime is out of date (protocol 0, this app needs 2). Install the update.",
            ),
            (
                "protocol-1",
                SetupCode::BundleStale,
                Remedy::DownloadRuntime,
                "The sandbox runtime is out of date (protocol 1, this app needs 2). Install the update.",
            ),
            (
                "protocol-3",
                SetupCode::BundleNewer,
                Remedy::UpdateApp,
                "The sandbox runtime (protocol 3) is newer than this app supports (2). Update SourceWeft.",
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
    fn macos_missing_bundle_is_needs_setup() {
        let app_data = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app_data.path()).unwrap();
        // No bundle was ever placed under `app_data`: macOS must not report Ready. A runtime IS
        // published for macOS now, so the remedy is `downloadRuntime` (same as Linux), not the
        // downgraded no-download failure.
        assert!(!bundle_dir(app_data.path()).exists());
        assert_eq!(host.sandbox_readiness(), SandboxReadiness::bundle_missing());
        assert_eq!(
            serde_json::to_value(host.sandbox_readiness()).unwrap(),
            serde_json::json!({
                "state": "needsSetup",
                "code": "bundleMissing",
                "reason": "Sandbox runtime is not installed",
                "remedy": "downloadRuntime",
            })
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
    fn a_package_reinstall_is_only_ever_offered_for_a_missing_or_refused_bwrap() {
        let messages = [
            "",
            "Operation not permitted",
            "sandbox probe exited with code 1",
            "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
            "bwrap: Can't find source path /nope: No such file or directory",
            "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
            "bwrap: setting up uid map: Permission denied",
            "bwrap: No permissions to create new namespace",
            "bwrap: Creating new namespace failed: Operation not permitted",
            "unexpected EOF from the sidecar",
        ];
        let codes = [
            "BUNDLE_STALE",
            "BUNDLE_NEWER",
            "HELPER_MISSING",
            "SANDBOX_UNAVAILABLE",
            "POLICY_INVALID",
            "SIDECAR_TIMEOUT",
            "",
        ];
        for appimage in [false, true] {
            for code in codes {
                for message in messages {
                    if let SandboxReadiness::NeedsSetup {
                        code: setup_code,
                        remedy,
                        ..
                    } = classify_probe_failure(code, message, appimage)
                    {
                        assert_eq!(
                            remedy == Remedy::ReinstallPackage,
                            !appimage
                                && matches!(
                                    setup_code,
                                    SetupCode::BwrapMissing | SetupCode::UserNamespaceRestricted
                                ),
                            "{code} / {message} / appimage={appimage}"
                        );
                        if setup_code == SetupCode::SandboxFailed {
                            assert_eq!(remedy, Remedy::None, "{code} / {message}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn settled_readiness_waits_out_the_checking_placeholder() {
        let mut answers = vec![
            SandboxReadiness::checking(),
            SandboxReadiness::checking(),
            SandboxReadiness::bundle_missing(),
        ]
        .into_iter();
        let result = settled_readiness(
            || answers.next().unwrap(),
            Duration::from_millis(1),
            Duration::from_secs(5),
        );
        assert_eq!(result, Some(SandboxReadiness::bundle_missing()));
        // Gives up (None) instead of returning the placeholder.
        assert_eq!(
            settled_readiness(
                SandboxReadiness::checking,
                Duration::from_millis(1),
                Duration::from_millis(20)
            ),
            None
        );
    }

    #[test]
    fn a_probe_in_flight_during_an_install_never_becomes_the_install_result() {
        use std::sync::{mpsc, Arc};
        let cache = Arc::new(Mutex::new(ReadinessCache::default()));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        // A probe that began before the install and is still running.
        let in_flight = {
            let cache = cache.clone();
            std::thread::spawn(move || {
                ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    SandboxReadiness::bundle_missing() // stale: the runtime is installed now
                })
            })
        };
        started_rx.recv().unwrap();
        drop(ReadinessCache::begin_install(&cache).unwrap()); // the install ends, cache invalidated

        let now = ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), || unreachable!());
        assert_eq!(now, SandboxReadiness::checking(), "the placeholder, while it runs");

        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            release_tx.send(()).unwrap();
        });
        let fresh = SandboxReadiness::Ready {
            toolchain_path: Some(ToolchainPath::System),
        };
        let result = settled_readiness(
            || {
                ReadinessCache::get_or_probe(&cache, Duration::from_secs(60), || fresh.clone())
            },
            Duration::from_millis(5),
            Duration::from_secs(10),
        );
        releaser.join().unwrap();
        in_flight.join().unwrap();
        assert_eq!(result, Some(fresh.clone()), "a fresh probe, not the placeholder or the stale answer");
        assert_eq!(ReadinessCache::cached_for_test(&cache), Some(fresh));
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
