//! Local command execution through the sandbox sidecar (`srt-sidecar`, which wraps each command
//! with sandbox-runtime: bubblewrap on Linux, Seatbelt on macOS, the namespaced `srt-win` on
//! Windows). Produces the result shape `{"output","exitCode","truncated","cancelled"}`.
//!
//! macOS and Linux keep one sidecar per `LocalHost`, started lazily from `readiness::bundle_dir`.
//! Its `init` lists `<base>/task-workspaces` plus every currently granted directory as the
//! workspace roots a wrap may name; each `wrap` grants read and write access to exactly that
//! command's workspace root (plus read access to the toolchain read roots and the in-sandbox
//! helper files). The sidecar's policy denies reading `/` on both Linux and macOS and re-allows
//! only its per-platform system read set on top of those (`sandbox-sidecar/src/policy.ts`,
//! `LINUX_SYSTEM_READ_ROOTS` / `DARWIN_SYSTEM_READ_ROOTS`).
//!
//! Windows keeps **one sidecar per workspace root** (`SandboxInstances`): the namespaced srt-win
//! grants write access per session, so a session names exactly one workspace root, and the host
//! holds at most [`MAX_WINDOWS_INSTANCES`] of them (the installed proxy port range has room for
//! four plus one readiness probe). Windows reads are bounded by the sandbox account's NTFS
//! ACLs, so the policy has no blanket deny; the read roots are only the `PATH` directories inside
//! the user's profile (`read_roots_windows`).
//!
//! Nothing here ever runs a command without an argv the sidecar wrapped: a missing bundle, a
//! failed start, or a wrap that still fails after one restart is returned as an error.
use super::{
    network::{ActiveCommand, Decision, NetworkPolicy},
    readiness::{bundle_dir, user_path, Helpers, InitConfig, Platform},
    sidecar::{ripgrep_file_name, sidecar_file_name, EventHandler, Sidecar, SidecarEvent, WrappedCommand},
    win_shell::ShellKind,
    HostError, LocalHost, Result,
};
use serde_json::{json, Value};
#[cfg(unix)]
use std::collections::BTreeMap;
use std::{
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Instant,
};
#[cfg(unix)]
use std::process::Command;

/// The production bubblewrap, installed with its own scoped AppArmor profile. `/usr/bin/bwrap`
/// is never used or loosened.
#[cfg(unix)]
pub(crate) const BWRAP_PATH: &str = "/opt/sourceweft/libexec/bwrap";

/// One running sidecar and the workspace roots its `init` was given.
pub(crate) struct SandboxInstance {
    sidecar: Sidecar,
    /// Read by `covers` (single-slot platforms); Windows finds an instance by the root it is
    /// stored under.
    #[cfg_attr(windows, allow(dead_code))]
    workspace_roots: Vec<PathBuf>,
    /// The Windows shell this instance's `init` named (`windows.shell`). The command prelude must
    /// be written in that shell's syntax, so the instance, not a fresh detection, decides it.
    /// `None` on macOS and Linux.
    shell: Option<ShellKind>,
}

/// `LocalHost::sandbox`: the current sidecar, if one has been started. An instance that failed
/// with `SANDBOX_UNAVAILABLE` is replaced; commands still running under it keep it alive
/// through their own `Arc` until they finish.
#[cfg(not(windows))]
pub(crate) type SandboxSlot = Mutex<Option<Arc<SandboxInstance>>>;

/// `LocalHost::sandbox` on Windows: one instance per workspace root.
#[cfg(windows)]
pub(crate) type SandboxSlot = SandboxInstances;

impl SandboxInstance {
    fn new(sidecar: Sidecar, workspace_roots: Vec<PathBuf>) -> Self {
        Self {
            sidecar,
            workspace_roots,
            shell: None,
        }
    }

    /// This instance's `init` named `shell` as the Windows command shell.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn with_shell(mut self, shell: ShellKind) -> Self {
        self.shell = Some(shell);
        self
    }

    #[cfg(unix)]
    fn covers(&self, root: &Path) -> bool {
        self.workspace_roots
            .iter()
            .any(|allowed| root_within(root, allowed))
    }

    /// Exactly once per successful `wrap` on this instance, after its command exited (or
    /// failed to spawn). srt counts every wrap and defers deleting its bwrap mount-point
    /// placeholders until the matching number of cleanups has arrived, so one call per wrap —
    /// never one for a failed wrap — keeps that count right with overlapping commands.
    fn finish(&self, command_id: &str) {
        if let Err(error) = self.sidecar.cleanup(command_id) {
            // A failed cleanup poisons the sidecar, so the next wrap replaces it; srt also
            // removes its placeholders on reset and on exit.
            eprintln!("sourceweft-desktop: sandbox cleanup failed: {error}");
        }
    }
}

/// Whether `root` is `allowed` or lies below it. Windows compares case-insensitively and ignores
/// the `\\?\` prefix (`winpath::is_inside`); elsewhere it is the plain component prefix test.
#[cfg(any(unix, test))]
fn root_within(root: &Path, allowed: &Path) -> bool {
    #[cfg(windows)]
    {
        super::winpath::is_inside(root, allowed)
    }
    #[cfg(not(windows))]
    {
        root.starts_with(allowed)
    }
}

/// Whether two workspace roots name the same directory: `winpath::same_path` on Windows
/// (case-insensitive, blind to the verbatim prefix), plain equality elsewhere.
fn same_root(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        super::winpath::same_path(a, b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// The platform this build runs the sidecar for. One explicit definition per supported target:
/// no target silently maps to another platform's policy.
#[cfg(target_os = "macos")]
pub(crate) const HOST_PLATFORM: Platform = Platform::Darwin;
#[cfg(target_os = "linux")]
pub(crate) const HOST_PLATFORM: Platform = Platform::Linux;
#[cfg(windows)]
#[allow(dead_code)] // Task 7 (Windows readiness) is the first caller on this target.
pub(crate) const HOST_PLATFORM: Platform = Platform::Windows;

/// The `InitConfig` for a sidecar of `platform` whose helpers live in `bundle`, for a host whose
/// app data is `base`. `<base>/local-host` (the host database) and `<base>/sandbox` (the
/// runtime bundles) are denied explicitly, independent of whether `base` lies under `$HOME`.
///
/// Linux gets the production bubblewrap and the seccomp helper; macOS has neither (Seatbelt
/// needs no helper binary), so its bundle holds only the sidecar, ripgrep and the proxy agent jar.
///
/// macOS and Linux only: a Windows `init` needs the detected shell, the staged `srt-win.exe` and
/// exactly one workspace root, none of which can be defaulted, so it is built by
/// `windows_init_config` (a failure there is an error, never a config without them).
#[cfg(unix)]
pub(crate) fn init_config(
    platform: Platform,
    bundle: &Path,
    base: &Path,
    workspace_roots: Vec<String>,
) -> InitConfig {
    let home = home_dir();
    let linux = platform == Platform::Linux;
    let read_roots = platform_read_roots(platform, &home, base);
    InitConfig {
        platform,
        read_roots,
        deny_roots: [base.join("local-host"), base.join("sandbox")]
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        home,
        workspace_roots,
        helpers: Helpers {
            ripgrep: bundle
                .join(ripgrep_file_name())
                .to_string_lossy()
                .into_owned(),
            apply_seccomp: linux
                .then(|| bundle.join("apply-seccomp").to_string_lossy().into_owned()),
            java_agent_jar: Some(
                bundle
                    .join("srt-proxy-agent.jar")
                    .to_string_lossy()
                    .into_owned(),
            ),
        },
        bwrap_path: linux.then(|| BWRAP_PATH.to_string()),
        windows: None,
    }
}

/// The user's home directory as the sidecar's `home` (the base of its credential-path denies).
/// Empty when the platform's variable is unset, as before.
#[cfg(unix)]
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// The toolchain directories the sandbox must be able to read, per platform (see `read_roots` and
/// `darwin_read_roots`).
#[cfg(unix)]
fn platform_read_roots(platform: Platform, home: &str, base: &Path) -> Vec<String> {
    match platform {
        Platform::Darwin => darwin_read_roots(Path::new(home), base, &user_path().0, XCODE_SELECT),
        Platform::Linux => read_roots(Path::new(home), base, &user_path().0),
        // A Windows `InitConfig` is never built on a unix host; its read roots come from
        // `read_roots_windows`.
        Platform::Windows => Vec::new(),
    }
}

/// Toolchain directories under `$HOME` that the sandbox must still be able to read, although
/// `home` itself is denied: for each `PATH` entry under `home`, its parent if it ends in `/bin`
/// (so `~/.cargo/bin` re-allows `~/.cargo`, where the toolchain keeps its libraries), else the
/// entry itself. Canonicalised, existing directories only, de-duplicated.
///
/// Never returned (Ruling R16): `home` itself, `~/.local`, or any ancestor of `home` — the parent
/// rule falls back to the entry itself for `~/bin` and `~/.local/bin`, since `~/.local` holds
/// `~/.local/share`, where app data (including this host's) lives — and any directory that
/// equals, contains, or lies inside the app data directory `base`.
///
/// A read root can contain credential files (`~/.cargo/credentials.toml` under `~/.cargo`); the
/// sidecar's policy keeps the known ones literally read-denied inside it (Ruling R25).
#[cfg(unix)]
pub(crate) fn read_roots(home: &Path, base: &Path, path_var: &str) -> Vec<String> {
    if !home.is_absolute() {
        return Vec::new();
    }
    let canonical_home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let canonical_base = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let local = home.join(".local");
    let canonical_local = canonical_home.join(".local");
    let mut roots: Vec<String> = Vec::new();
    for entry in path_var.split(':') {
        let entry = Path::new(entry);
        if !entry.is_absolute() || !entry.starts_with(home) || entry == home {
            continue;
        }
        let candidate = match entry.parent() {
            Some(parent)
                if entry.file_name().is_some_and(|name| name == "bin")
                    && parent != home
                    && parent != local =>
            {
                parent
            }
            _ => entry,
        };
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !canonical.is_dir()
            || is_protected_read_root(&canonical, &canonical_home, &canonical_local, &canonical_base)
        {
            continue;
        }
        let Some(text) = canonical.to_str() else {
            continue;
        };
        if !roots.iter().any(|seen| seen == text) {
            roots.push(text.to_string());
        }
    }
    roots
}

/// Ruling R16: the areas a read root must never equal, contain, or be an ancestor of — the home
/// directory itself (and its ancestors), exactly `~/.local` (which holds `~/.local/share`, where
/// app data lives), and the app-data `base` in either direction (a root inside it, or one that
/// contains it). All arguments are already canonicalised.
///
/// `read_roots` processes only `PATH` entries that already lie *inside* `$HOME`, so it does not
/// (and must not) reject "inside home" here — that is the toolchain it is re-allowing.
/// `darwin_read_roots_with` adds that one further check for its discovered extras, which can point
/// anywhere (e.g. a `DEVELOPER_DIR=$HOME` that makes `xcode-select -p` echo the home directory).
#[cfg(unix)]
fn is_protected_read_root(
    canonical: &Path,
    canonical_home: &Path,
    canonical_local: &Path,
    canonical_base: &Path,
) -> bool {
    canonical_home.starts_with(canonical)
        || canonical == canonical_local
        || canonical.starts_with(canonical_base)
        || canonical_base.starts_with(canonical)
}

/// The system `xcode-select` the production discovery runs; a test passes a stub path instead.
#[cfg(unix)]
const XCODE_SELECT: &str = "/usr/bin/xcode-select";

/// Fixed Homebrew prefixes macOS toolchains install under, outside `$HOME`. Added to the read
/// roots when they exist as directories (`darwin_read_roots`): Apple-silicon Homebrew lives at
/// `/opt/homebrew`, Intel Homebrew and other third-party toolchains at `/usr/local`. The sidecar's
/// own `DARWIN_SYSTEM_READ_ROOTS` covers the OS toolchain in `/bin` and `/usr/bin`; these cover
/// user-installed tools such as `bash`, `python3`, `node` and `git` reached through the login
/// `PATH`. `$HOME`-relative toolchains (nvm, pyenv, rustup) come from `read_roots` via `PATH`.
#[cfg(unix)]
const DARWIN_HOMEBREW_PREFIXES: [&str; 2] = ["/opt/homebrew", "/usr/local"];

/// The macOS Command Line Tools developer directory (the fixed OS install path). Read root and
/// `DEVELOPER_DIR` target for the `/usr/bin` xcode-select tool shims (`git`, `cc`, `clang`, `make`,
/// `/usr/bin/python3`) — see `darwin_developer_dir` for why a full `Xcode.app` can't serve that role
/// in the sandbox and the shims are pointed here instead. Added to the read roots when it exists
/// (`darwin_read_roots`), so the sandboxed shim can read the real tools it resolves under it; a
/// narrow toolchain subpath of `/Library`, never a wholesale `/Library` grant.
#[cfg(unix)]
const DARWIN_COMMAND_LINE_TOOLS: &str = "/Library/Developer/CommandLineTools";

/// macOS read roots: the PATH-derived toolchain roots under `$HOME` (`read_roots`), plus the
/// active developer directory from `xcode-select -p` (only when it resolves to a real, canonical
/// directory — the `cc`/`clang`/`git` xcode-select shims resolve the real toolchain under it), the
/// Command Line Tools directory `DARWIN_COMMAND_LINE_TOOLS` (the developer dir the shims are pinned
/// to in the sandbox; `darwin_developer_dir`), and the Homebrew prefixes `DARWIN_HOMEBREW_PREFIXES`.
/// The OS read set (`/bin`, `/usr/bin`, `/etc`, `/var`, `/dev`, …) is the sidecar's own
/// `DARWIN_SYSTEM_READ_ROOTS`, not here. Each discovered path is canonicalised and kept only when
/// it is a directory; the result is de-duplicated with the PATH roots first.
#[cfg(unix)]
pub(crate) fn darwin_read_roots(
    home: &Path,
    base: &Path,
    path_var: &str,
    xcode_select: &str,
) -> Vec<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = developer_dir(xcode_select) {
        candidates.push(dir);
    }
    candidates.push(PathBuf::from(DARWIN_COMMAND_LINE_TOOLS));
    candidates.extend(DARWIN_HOMEBREW_PREFIXES.iter().map(PathBuf::from));
    darwin_read_roots_with(home, base, path_var, &candidates)
}

/// The developer directory the macOS `/usr/bin` xcode-select tool shims (`git`, `cc`, `clang`,
/// `make`, `/usr/bin/python3`) are pinned to inside the sandbox, via `DEVELOPER_DIR` in the child
/// env (`child_env`). Returns the canonical Command Line Tools path when `command_line_tools` is an
/// existing directory holding a usable toolchain (`usr/bin/git` or `usr/bin/clang`, the binaries
/// the shims resolve to), else `None`. A bare or half-removed directory is therefore not pinned:
/// pointing the shims at it would break tools that work under the active developer directory.
///
/// A *full* `Xcode.app` cannot act as the in-sandbox developer directory: its shims make `xcrun`
/// resolve each tool by writing a lookup cache in the per-user Darwin temp dir — which the
/// workspace-only write policy denies — and then cold-fall back to `xcodebuild`, which needs the
/// XPC / Launch Services the tight sandbox withholds and crashes (`DVTSystemPrerequisites`
/// "blocked by sandbox"). Granting a read of the cache dir is on the forbidden list, and reading
/// `Xcode.app/Contents/Info.plist` only moves the failure on to `xcodebuild` — so no read widening
/// fixes it. The Command Line Tools instead resolve tools from a fixed layout with no `xcodebuild`
/// dependency (the cache-write failure is then a harmless warning), so pointing the shims there is
/// the only mechanism that lets them run under the tight policy. Consequences:
///   * when CLT is already the active developer dir, this is the same directory — no change;
///   * when a full Xcode is the active dir, the shims are redirected to CLT. This is a deliberate,
///     documented divergence from the "active" toolchain (`xcode-select -p`): the active one is
///     non-functional in the sandbox, so CLT is the least-surprising *working* choice, and it ships
///     the same command-line `clang`/`git`/`make` for this purpose;
///   * when CLT is absent, `None` leaves the active developer dir in force (an Xcode-only machine's
///     shims stay unsupported — no safe mechanism can run a full Xcode in the sandbox).
#[cfg(unix)]
fn darwin_developer_dir(command_line_tools: &str) -> Option<String> {
    let canonical = Path::new(command_line_tools).canonicalize().ok()?;
    let usable = ["usr/bin/git", "usr/bin/clang"]
        .iter()
        .any(|tool| canonical.join(tool).is_file());
    if !canonical.is_dir() || !usable {
        return None;
    }
    canonical.to_str().map(str::to_string)
}

/// `darwin_read_roots` with its discovered extra directories supplied directly, so a test can
/// drive the merge without depending on what the host has installed. Each extra is canonicalised
/// and kept only when it is a directory **and** passes the same R16 containment filter
/// `read_roots` applies, plus a rejection of anything inside (or equal to) `$HOME`: a discovered
/// extra can point anywhere, so a `DEVELOPER_DIR` that makes `xcode-select -p` echo `$HOME`, a home
/// subdirectory, or the app-data base must never silently re-open it for every wrapped command. The
/// PATH-derived roots come first and duplicates are dropped.
#[cfg(unix)]
fn darwin_read_roots_with(
    home: &Path,
    base: &Path,
    path_var: &str,
    extra: &[PathBuf],
) -> Vec<String> {
    let mut roots = read_roots(home, base, path_var);
    if !home.is_absolute() {
        return roots;
    }
    let canonical_home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let canonical_base = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let canonical_local = canonical_home.join(".local");
    for candidate in extra {
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !canonical.is_dir()
            || canonical.starts_with(&canonical_home)
            || is_protected_read_root(&canonical, &canonical_home, &canonical_local, &canonical_base)
        {
            continue;
        }
        let Some(text) = canonical.to_str() else {
            continue;
        };
        if !roots.iter().any(|seen| seen == text) {
            roots.push(text.to_string());
        }
    }
    roots
}

/// The active developer directory, read by running `<xcode_select> -p`. Returns it only when the
/// command succeeds and the path it prints canonicalises to an existing directory; a missing
/// toolchain, an empty or whitespace result, or a path that no longer exists yields `None`, so a
/// broken `xcode-select` never adds a read root. The canonical form is what is compared and handed
/// to srt (srt matches literal paths without resolving them against a cwd).
#[cfg(unix)]
fn developer_dir(xcode_select: &str) -> Option<PathBuf> {
    // Clear the environment first: `xcode-select -p` echoes `$DEVELOPER_DIR` verbatim when it is
    // set (e.g. `DEVELOPER_DIR=$HOME xcode-select -p` prints the home directory), so an inherited
    // `DEVELOPER_DIR` pointing at `$HOME`, a home subpath, or the app-data base would otherwise be
    // discovered here and re-opened for reads in every wrapped command. `xcode-select` needs no
    // environment to read the active developer directory, and the binary is an absolute path.
    let output = Command::new(xcode_select)
        .env_clear()
        .arg("-p")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let printed = String::from_utf8(output.stdout).ok()?;
    let trimmed = printed.trim();
    if trimmed.is_empty() {
        return None;
    }
    let canonical = Path::new(trimmed).canonicalize().ok()?;
    canonical.is_dir().then_some(canonical)
}

/// 32 bytes from two v4 UUIDs (OS randomness), unpadded base64url: 43 unguessable characters,
/// above srt's 22-character floor for a 128-bit command id.
fn new_command_id() -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(unix)]
fn lock_slot(slot: &SandboxSlot) -> std::sync::MutexGuard<'_, Option<Arc<SandboxInstance>>> {
    // The slot holds only an `Option<Arc<_>>`; nothing half-written can be observed after a
    // panic elsewhere, so recover instead of failing every later command.
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// Drops the current sidecar (the process exits once the last command still using it is done)
/// so the next command starts one from the files now on disk; used when the runtime is replaced.
#[cfg(unix)]
pub(crate) fn stop_sidecar(slot: &SandboxSlot) {
    // Dropping the last reference shuts the sidecar down, which can take seconds: do it after
    // the slot lock is released, so commands starting meanwhile are not blocked behind it.
    let old = lock_slot(slot).take();
    drop(old);
}

/// Drops every Windows sidecar (each exits once the last command still using it is done) so the
/// next command starts new ones from the files now on disk; used when the runtime is replaced.
#[cfg(windows)]
pub(crate) fn stop_sidecar(instances: &SandboxSlot) {
    instances.stop_all();
}

/// Wraps one attempt on `instance`. A failed wrap is never followed by a cleanup: srt has
/// already undone its own count for it.
fn try_wrap(
    instance: &SandboxInstance,
    command_id: &str,
    script: &str,
    cwd: &Path,
    root: &Path,
    network: Option<&NetworkPolicy>,
) -> Result<WrappedCommand> {
    let wrapped = instance
        .sidecar
        .wrap(command_id, script, cwd, root, network)?;
    if wrapped.argv.is_empty() {
        // srt counted this wrap; balance it before reporting the sidecar unusable.
        instance.finish(command_id);
        return Err(HostError::new(
            "SANDBOX_UNAVAILABLE",
            "The sandbox returned an empty command.",
        ));
    }
    Ok(wrapped)
}

/// Returns the sidecar to use for `root` and the wrapped command, enforcing the restart policy:
///
/// - no sidecar yet: start one;
/// - the current sidecar's `init` does not cover `root` (e.g. a folder granted after it
///   started): start a new one with the current roots, once, then wrap;
/// - `wrap` fails with `SANDBOX_UNAVAILABLE` (the instance is poisoned): replace it once and
///   retry the wrap once; a second failure is returned.
///
/// `start` builds a fresh instance from the current workspace roots. The slot lock is held
/// while starting, so concurrent callers never start duplicate sidecars; wraps run outside it.
/// On success the caller must call `finish` on the returned instance exactly once, after the
/// command exits.
#[cfg(unix)]
fn wrap_in_sandbox(
    slot: &SandboxSlot,
    root: &Path,
    cwd: &Path,
    script: &str,
    command_id: &str,
    network: Option<&NetworkPolicy>,
    mut start: impl FnMut() -> Result<SandboxInstance>,
) -> Result<(Arc<SandboxInstance>, WrappedCommand)> {
    let instance = {
        let mut current = lock_slot(slot);
        match current.as_ref() {
            Some(existing) if existing.covers(root) => existing.clone(),
            _ => {
                let fresh = Arc::new(start()?);
                *current = Some(fresh.clone());
                fresh
            }
        }
    };
    match try_wrap(&instance, command_id, script, cwd, root, network) {
        Ok(wrapped) => Ok((instance, wrapped)),
        Err(error) if error.code == "SANDBOX_UNAVAILABLE" => {
            let replacement = {
                let mut current = lock_slot(slot);
                match current.as_ref() {
                    // Another command already replaced the dead instance: use its replacement.
                    Some(other) if !Arc::ptr_eq(other, &instance) && other.covers(root) => {
                        other.clone()
                    }
                    _ => {
                        *current = None;
                        let fresh = Arc::new(start()?);
                        *current = Some(fresh.clone());
                        fresh
                    }
                }
            };
            drop(instance);
            let wrapped = try_wrap(&replacement, command_id, script, cwd, root, network)?;
            Ok((replacement, wrapped))
        }
        Err(error) => Err(error),
    }
}

/// The most sidecars a Windows host keeps alive. Each uses two loopback ports of the installed
/// proxy range (`60180-60189`: ten ports), and one more sidecar is needed at a time for the
/// readiness probe, so four workspaces fit.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const MAX_WINDOWS_INSTANCES: usize = 4;

struct InstanceEntry {
    /// The workspace root this instance's `init` named, compared with `same_root`.
    root: PathBuf,
    instance: Arc<SandboxInstance>,
    last_used: Instant,
}

#[derive(Default)]
struct InstanceTable {
    entries: Vec<InstanceEntry>,
    /// Sidecars being started right now. They count against the capacity before they exist, so
    /// two roots starting at once can never overshoot it.
    starting: usize,
}

/// The Windows sidecars, one per workspace root (see the module doc for why).
///
/// - A lookup or an eviction takes only the table lock, briefly. Starting a sidecar (up to 30 s)
///   runs under that root's own gate and never under the table lock, so starting root A does not
///   block a command on root B, and two commands on a new root A start exactly one sidecar.
/// - An instance is *idle* when the table holds its only `Arc`: a running command holds a clone,
///   and clones are only made under the table lock, so the test cannot race a new command.
/// - At capacity the least recently used idle instance is dropped (its sidecar shuts down) to
///   make room. When every instance has a command running, the new command is refused with
///   `SANDBOX_BUSY` instead of queueing behind a 2-minute command.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct SandboxInstances {
    table: Mutex<InstanceTable>,
    gates: Mutex<Vec<(PathBuf, Arc<Mutex<()>>)>>,
    capacity: usize,
}

impl Default for SandboxInstances {
    fn default() -> Self {
        Self::with_capacity(MAX_WINDOWS_INSTANCES)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // The guarded data is a plain list that is never left half-updated by a panic; recover.
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg_attr(not(windows), allow(dead_code))]
impl SandboxInstances {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            table: Mutex::new(InstanceTable::default()),
            gates: Mutex::new(Vec::new()),
            capacity,
        }
    }

    /// The live instance for `root`, marking it used.
    fn lookup(&self, root: &Path) -> Option<Arc<SandboxInstance>> {
        let mut table = lock(&self.table);
        let entry = table
            .entries
            .iter_mut()
            .find(|entry| same_root(&entry.root, root))?;
        entry.last_used = Instant::now();
        Some(entry.instance.clone())
    }

    /// The start gate of `root`. Gates nobody holds are forgotten whenever a new one is added, so
    /// the list does not grow with every task workspace ever used.
    fn gate(&self, root: &Path) -> Arc<Mutex<()>> {
        let mut gates = lock(&self.gates);
        if let Some((_, gate)) = gates.iter().find(|(known, _)| same_root(known, root)) {
            return gate.clone();
        }
        gates.retain(|(_, gate)| Arc::strong_count(gate) > 1);
        let gate = Arc::new(Mutex::new(()));
        gates.push((root.to_path_buf(), gate.clone()));
        gate
    }

    /// Makes room for one more sidecar and counts it as starting. Returns the evicted instance,
    /// which the caller drops *outside* every lock and before starting the new sidecar, so its
    /// ports are free again.
    fn reserve(&self) -> Result<Option<Arc<SandboxInstance>>> {
        let mut table = lock(&self.table);
        let mut evicted = None;
        if table.entries.len() + table.starting >= self.capacity {
            let idlest = table
                .entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| Arc::strong_count(&entry.instance) == 1)
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(index, _)| index);
            match idlest {
                Some(index) => evicted = Some(table.entries.remove(index).instance),
                None => {
                    return Err(HostError::new(
                        "SANDBOX_BUSY",
                        "Too many workspaces are running commands at once; wait for one to finish.",
                    ))
                }
            }
        }
        table.starting += 1;
        Ok(evicted)
    }

    /// Starts a sidecar for `root` and stores it. The caller holds `root`'s gate.
    fn start_new(
        &self,
        root: &Path,
        start: &mut dyn FnMut() -> Result<SandboxInstance>,
    ) -> Result<Arc<SandboxInstance>> {
        drop(self.reserve()?);
        let started = start();
        let mut table = lock(&self.table);
        table.starting -= 1;
        let fresh = Arc::new(started?);
        table.entries.push(InstanceEntry {
            root: root.to_path_buf(),
            instance: fresh.clone(),
            last_used: Instant::now(),
        });
        Ok(fresh)
    }

    /// The instance for `root`: the live one, or a new one started with `start`.
    fn instance(
        &self,
        root: &Path,
        start: &mut dyn FnMut() -> Result<SandboxInstance>,
    ) -> Result<Arc<SandboxInstance>> {
        if let Some(found) = self.lookup(root) {
            return Ok(found);
        }
        let gate = self.gate(root);
        let _starting = lock(&gate);
        // Another command may have started it while this one waited for the gate.
        if let Some(found) = self.lookup(root) {
            return Ok(found);
        }
        self.start_new(root, start)
    }

    /// Replaces `dead` (this root's instance, which just failed with `SANDBOX_UNAVAILABLE`) with a
    /// new one, unless another command already did. Only this root is touched.
    fn replace(
        &self,
        root: &Path,
        dead: Arc<SandboxInstance>,
        start: &mut dyn FnMut() -> Result<SandboxInstance>,
    ) -> Result<Arc<SandboxInstance>> {
        let gate = self.gate(root);
        let _starting = lock(&gate);
        let removed = {
            let mut table = lock(&self.table);
            match table
                .entries
                .iter()
                .position(|entry| same_root(&entry.root, root))
            {
                Some(index) if !Arc::ptr_eq(&table.entries[index].instance, &dead) => {
                    let entry = &mut table.entries[index];
                    entry.last_used = Instant::now();
                    return Ok(entry.instance.clone());
                }
                Some(index) => Some(table.entries.remove(index)),
                None => None,
            }
        };
        // Release the dead sidecar (the process exits once the commands still using it are done)
        // before the replacement takes its ports.
        drop(removed);
        drop(dead);
        self.start_new(root, start)
    }

    /// Drops every instance. Each sidecar exits once the last command using it is done.
    pub(crate) fn stop_all(&self) {
        let all = std::mem::take(&mut lock(&self.table).entries);
        drop(all);
    }
}

/// `wrap_in_sandbox` for the per-root instances: the instance for `root` (started on first use,
/// replaced once when its wrap fails with `SANDBOX_UNAVAILABLE`), and the wrapped command.
/// `script_for` builds the script for the instance that will wrap it, because the shell prelude
/// depends on the shell the instance was started with. On success the caller must call `finish`
/// on the returned instance exactly once, after the command exits.
#[cfg_attr(not(windows), allow(dead_code))]
fn wrap_in_instances(
    instances: &SandboxInstances,
    root: &Path,
    cwd: &Path,
    command_id: &str,
    network: Option<&NetworkPolicy>,
    script_for: &dyn Fn(&SandboxInstance) -> Result<String>,
    mut start: impl FnMut() -> Result<SandboxInstance>,
) -> Result<(Arc<SandboxInstance>, WrappedCommand)> {
    let instance = instances.instance(root, &mut start)?;
    let script = script_for(&instance)?;
    match try_wrap(&instance, command_id, &script, cwd, root, network) {
        Ok(wrapped) => Ok((instance, wrapped)),
        Err(error) if error.code == "SANDBOX_UNAVAILABLE" => {
            let replacement = instances.replace(root, instance, &mut start)?;
            let script = script_for(&replacement)?;
            let wrapped = try_wrap(&replacement, command_id, &script, cwd, root, network)?;
            Ok((replacement, wrapped))
        }
        Err(error) => Err(error),
    }
}

/// Starts a sidecar from this host's installed bundle, with `init.workspaceRoots` set to the
/// automatic workspace base plus every currently granted directory.
#[cfg(unix)]
fn start_instance(host: &LocalHost) -> Result<SandboxInstance> {
    let bundle = bundle_dir(&host.base);
    if !bundle.join(sidecar_file_name()).is_file() {
        return Err(HostError::new(
            "SANDBOX_UNAVAILABLE",
            "Sandbox runtime is not installed",
        ));
    }
    let roots = host.sandbox_workspace_roots()?;
    let names = roots
        .iter()
        .map(|root| {
            root.to_str().map(str::to_string).ok_or_else(|| {
                HostError::new("INVALID_PATH", format!("path is not valid UTF-8: {root:?}"))
            })
        })
        .collect::<Result<Vec<_>>>()?;
    // Every instance — including one that replaces a poisoned predecessor, on every platform —
    // is built here, so every sidecar answers its network asks through the host's bridge.
    let sidecar = Sidecar::start_with_events(
        &bundle,
        &init_config(HOST_PLATFORM, &bundle, &host.base, names),
        event_handler(host.network.clone()),
    )?;
    Ok(SandboxInstance::new(sidecar, roots))
}

/// Routes sidecar `ask` events to the bridge. Runs on the sidecar's reader thread, so it only
/// hands the ask over; the bridge waits on a thread of its own and then answers through the
/// responder.
fn event_handler(bridge: super::network::NetworkBridge) -> EventHandler {
    Arc::new(move |event, responder| match event {
        SidecarEvent::Ask(ask) => {
            let ask_id = ask.ask_id.clone();
            bridge.on_ask(
                ask,
                Box::new(move |Decision { allow, reason }| {
                    if let Err(error) = responder.reply(&ask_id, allow, reason.as_deref()) {
                        eprintln!("sourceweft-desktop: could not answer network ask: {error}");
                    }
                }),
            );
        }
    })
}

/// The wrapped command's environment with the pinned toolchain, home, temp and cache locations
/// laid over it. The pinned values win over anything the sidecar's own environment supplied.
///
/// `developer_dir` is set only on macOS (`Some` from `darwin_developer_dir`), and pins
/// `DEVELOPER_DIR` so the `/usr/bin` xcode-select tool shims resolve against the Command Line Tools
/// toolchain, which works under the tight sandbox where a full `Xcode.app` cannot. It is `None` on
/// Linux and on a macOS host without usable Command Line Tools, leaving the inherited developer
/// dir untouched. When `Some`, the pin overrides a `DEVELOPER_DIR` the user's own environment
/// carries (the `wrapped` value is replaced): a full Xcode selected that way cannot run its shims
/// in the sandbox anyway (see `darwin_developer_dir`).
#[cfg(unix)]
fn child_env(
    root: &Path,
    wrapped: Vec<(String, String)>,
    developer_dir: Option<&str>,
) -> Vec<(String, String)> {
    let root_text = root.to_string_lossy();
    let mut env: BTreeMap<String, String> = wrapped.into_iter().collect();
    for (key, value) in [
        ("PATH", user_path().0),
        ("HOME", root_text.to_string()),
        ("TMPDIR", format!("{root_text}/.tmp")),
        ("npm_config_cache", format!("{root_text}/.cache/npm")),
        ("PIP_CACHE_DIR", format!("{root_text}/.cache/pip")),
        ("NODE_USE_ENV_PROXY", "1".to_string()),
    ] {
        env.insert(key.to_string(), value);
    }
    if let Some(dir) = developer_dir {
        env.insert("DEVELOPER_DIR".to_string(), dir.to_string());
    }
    env.into_iter().collect()
}

/// Single-quotes `value` for a POSIX shell.
#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `script` with `TMPDIR` pinned from inside the sandbox. srt's bwrap argv sets
/// `--setenv TMPDIR /tmp/claude` for every command, which overrides the value inherited from
/// `child_env`, so the workspace `TMPDIR` is re-exported as the first line the sandboxed shell
/// runs. A newline-separated prefix leaves any valid script unchanged.
#[cfg(unix)]
fn pinned_script(root: &Path, script: &str) -> String {
    let tmpdir = format!("{}/.tmp", root.to_string_lossy());
    format!("export TMPDIR={}\n{script}", shell_quote(&tmpdir))
}

/// Creates `<root>/.tmp` (one level, never following a symlink at that name) so `TMPDIR`
/// exists before the command runs.
#[cfg(unix)]
fn prepare_tmpdir(root: &Path) -> Result<()> {
    match std::fs::create_dir(root.join(".tmp")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Whether a failed wrap means the runtime on disk is unusable and readiness must be re-probed.
/// `SANDBOX_BUSY` and the like are about load, not about the runtime.
fn invalidates_readiness(code: &str) -> bool {
    matches!(
        code,
        "SANDBOX_UNAVAILABLE" | "HELPER_MISSING" | "BUNDLE_STALE" | "BUNDLE_NEWER"
    )
}

/// How long a command may run, how much output is kept, and the flag that cancels it.
struct RunLimits {
    timeout_ms: u64,
    max_chars: usize,
    cancel: Arc<AtomicBool>,
}

/// Runs the argv `wrapped` on `instance` through the shared process loop and reports the result
/// in the backend's shape `{"output","exitCode","truncated","cancelled"}`, with the sandbox's own
/// violation annotation added to stderr and `networkAudit` (the sidecar's recorded connection
/// decisions for this command; `networkAuditError` in its place if the audit cannot be read, which
/// never fails the command). Calls `finish` exactly once for the wrap, however the run
/// ended.
fn run_and_report(
    instance: &SandboxInstance,
    command_id: &str,
    argv: &[String],
    env: &[(String, String)],
    cwd: &Path,
    limits: RunLimits,
) -> Result<Value> {
    let RunLimits {
        timeout_ms,
        max_chars,
        cancel,
    } = limits;
    let run = super::process::run_wrapped(argv, env, cwd, timeout_ms, max_chars, cancel);
    let result = run.map(|run| {
        let stderr = String::from_utf8_lossy(&run.stderr).into_owned();
        let stderr = match instance.sidecar.violations(command_id, &stderr) {
            Ok(annotated) => annotated,
            // The command already ran; report its real output and say why the sandbox's own
            // annotation is missing rather than dropping either.
            Err(error) => format!(
                "{stderr}\n[sandbox violation report unavailable: {}]",
                error.message
            ),
        };
        let output = format!("{}{}", String::from_utf8_lossy(&run.stdout), stderr);
        let mut result = json!({
            "output": output.chars().take(max_chars).collect::<String>(),
            "exitCode": run.exit_code,
            "truncated": run.truncated || output.chars().count() > max_chars,
            "cancelled": run.cancelled,
        });
        // Drained before `finish`, which makes the sidecar forget the command. A failed audit
        // never fails the command; it is reported honestly instead of as an empty list.
        match instance.sidecar.audit(command_id) {
            Ok(entries) => result["networkAudit"] = Value::Array(entries),
            Err(error) => result["networkAuditError"] = Value::String(error.message),
        }
        result
    });
    instance.finish(command_id);
    result
}

#[cfg(unix)]
/// Runs `script` under `/bin/sh`-compatible wrapping in `cwd` (inside `root`), with write access
/// to `root` only, and returns the JSON shape the backend expects
/// (`{"output","exitCode","truncated","cancelled"}`) plus `networkAudit` (the sidecar's recorded
/// connection decisions for this command). If the audit cannot be read the command's result is
/// still returned, with `networkAuditError` in place of `networkAudit`. `network` is forwarded
/// to the sidecar; `None` means the sidecar's default (`open`).
pub(crate) fn execute_command(
    host: &LocalHost,
    root: &Path,
    cwd: &Path,
    script: &str,
    timeout_ms: u64,
    max_chars: usize,
    cancel: Arc<AtomicBool>,
    network: Option<&NetworkPolicy>,
    active: &ActiveCommand,
) -> Result<Value> {
    prepare_tmpdir(root)?;
    let command_id = new_command_id();
    // Before `wrap`: the sidecar's first ask can follow the wrap reply immediately, and the
    // bridge only attributes asks that name this command.
    active.set_command_id(&command_id);
    let script = pinned_script(root, script);
    let (instance, wrapped) =
        match wrap_in_sandbox(
            &host.sandbox,
            root,
            cwd,
            &script,
            &command_id,
            network,
            || start_instance(host),
        ) {
            Ok(found) => found,
            Err(error) => {
                if invalidates_readiness(error.code) {
                    host.invalidate_sandbox_readiness();
                }
                return Err(error);
            }
        };
    // macOS pins `DEVELOPER_DIR` to the Command Line Tools so the `/usr/bin` xcode-select tool
    // shims work under the tight policy; Linux and a CLT-less macOS host get `None` (unchanged env).
    let developer_dir = (HOST_PLATFORM == Platform::Darwin)
        .then(|| darwin_developer_dir(DARWIN_COMMAND_LINE_TOOLS))
        .flatten();
    let env = child_env(root, wrapped.env, developer_dir.as_deref());
    run_and_report(
        &instance,
        &command_id,
        &wrapped.argv,
        &env,
        cwd,
        RunLimits {
            timeout_ms,
            max_chars,
            cancel,
        },
    )
}

// --------------------------------------------------------------------------------------------
// Windows policy inputs. Everything below up to `windows_init_config` is pure (injected
// environment and canonicalisation) so it is unit-tested on every OS; only the functions marked
// `cfg(windows)` touch the machine.
// --------------------------------------------------------------------------------------------

/// Splits a Windows `PATH` value the way `std::env::split_paths` does on Windows: `;` separates
/// entries, a `"` toggles quoting (the quote itself is dropped, a `;` inside quotes is data) and
/// empty entries disappear. Not `split_paths` itself, which splits on the host OS's separator.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn split_windows_path(path_var: &str) -> Vec<String> {
    let mut entries = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in path_var.chars() {
        match c {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                if !current.is_empty() {
                    entries.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        entries.push(current);
    }
    entries
}

/// What `read_roots_windows` decides from. All paths are native (`C:\...`) and canonical.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct ReadRootInputs<'a> {
    /// The user's profile directory: the only area read roots may lie in.
    pub profile: &'a Path,
    /// `AppData\Roaming`, `\Local`, `\LocalLow` and whatever `APPDATA`/`LOCALAPPDATA` name.
    pub app_data_roots: &'a [PathBuf],
    /// The app-data directory of this application (host database, runtime bundles).
    pub base: &'a Path,
    /// The `PATH` the commands will resolve tools through.
    pub path_var: &'a str,
    /// The chosen shell's install root, when it has one (Git for Windows).
    pub shell_root: Option<&'a Path>,
    /// The credential locations (`winpath::protected_locations`): a read root that equals or lies
    /// inside one is dropped, because the sidecar refuses such a read root outright
    /// (`POLICY_INVALID`) and that would fail the whole `init` (a Microsoft Store Python `Scripts`
    /// directory under `AppData\Local\Packages` is the usual case).
    pub protected: &'a [PathBuf],
}

/// The Windows `readRoots` (Plan 6, W3): exactly the `PATH` directories (and the shell's install
/// root) that lie **inside the user's profile**. Windows reads are bounded by the sandbox
/// account's NTFS ACLs, which already allow the system directories, so only toolchains installed
/// under the profile (`~\.cargo\bin`, `~\AppData\Local\Programs\Python`, `~\scoop\shims`, a
/// per-user Git) need an explicit read grant.
///
/// - No widening: `~\.cargo\bin` grants `~\.cargo\bin`, not `~\.cargo` (which holds the registry
///   cache and `credentials.toml`). There is no bin-to-parent rule here.
/// - Never granted: the profile itself, `AppData` and its `Local`/`Roaming`/`LocalLow` children
///   (anything that equals or contains one of `app_data_roots`), and `base` in either direction
///   (equal, inside, or containing it) — the host database and bundles are not tool directories —
///   and anything equal to or inside a credential location (`ReadRootInputs::protected`).
///   Directories *inside* `AppData\Local` and `\Roaming` are fine.
/// - Only absolute local drive paths that `canonical` resolves to existing directories count:
///   relative entries are skipped before `canonical` is asked, so the process's current directory
///   can never make a `PATH` entry mean something else; UNC, non-existent and unspellable paths
///   (`..`, device names) are dropped.
/// - `canonical` is `canonicalize` + native form in production; the result is what the sidecar
///   receives and what it compares case-insensitively. De-duplicated case-insensitively, in
///   `PATH` order with the shell root last.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn read_roots_windows(
    inputs: &ReadRootInputs,
    canonical: impl Fn(&Path) -> Option<PathBuf>,
) -> Vec<String> {
    use super::winpath::{is_inside, same_path, to_native, to_wire_str};
    let mut roots: Vec<PathBuf> = Vec::new();
    let entries = split_windows_path(inputs.path_var)
        .into_iter()
        .map(PathBuf::from)
        .chain(inputs.shell_root.map(Path::to_path_buf));
    for entry in entries {
        // An absolute local drive path, spelled as the `PATH` spelled it.
        let absolute = entry
            .to_str()
            .is_some_and(|text| text.len() >= 3 && to_wire_str(text).is_ok());
        if !absolute {
            continue;
        }
        let Some(native) = canonical(&entry).and_then(|path| to_native(&path).ok()) else {
            continue;
        };
        let protected = same_path(&native, inputs.profile)
            || !is_inside(&native, inputs.profile)
            || inputs.app_data_roots.iter().any(|root| is_inside(root, &native))
            || is_inside(&native, inputs.base)
            || is_inside(inputs.base, &native)
            || inputs.protected.iter().any(|location| is_inside(&native, location));
        if protected || roots.iter().any(|seen| same_path(seen, &native)) {
            continue;
        }
        roots.push(native);
    }
    roots
        .into_iter()
        .filter_map(|path| path.to_str().map(str::to_string))
        .collect()
}

/// Everything about this Windows machine that the sidecar's `init` is built from.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct WindowsHost {
    /// The user's profile directory, canonical and native.
    pub profile: PathBuf,
    pub app_data_roots: Vec<PathBuf>,
    /// The `PATH` of this process: the sidecar inherits it and srt hands it to the broker, which
    /// is the `PATH` the sandboxed command resolves tools through.
    pub path_var: String,
    pub shell: super::win_shell::WindowsShell,
    /// The staged `srt-win.exe` (`windows::staged_srt_win_path`).
    pub srt_win: PathBuf,
}

/// The `InitConfig` of a Windows sidecar for the single workspace `root` (native path), whose
/// helpers live in `bundle`, for a host whose app data is `base`. Exactly one workspace root: the
/// namespaced srt-win grants write access per session and refuses a per-command grant.
/// `<base>\local-host` and `<base>\sandbox` are denied explicitly.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_init_config(
    bundle: &Path,
    base: &Path,
    root: &Path,
    host: &WindowsHost,
    canonical: impl Fn(&Path) -> Option<PathBuf>,
) -> InitConfig {
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let shell_root = host.shell.install_root();
    let protected = super::winpath::protected_locations(&host.profile);
    let read_roots = read_roots_windows(
        &ReadRootInputs {
            profile: &host.profile,
            app_data_roots: &host.app_data_roots,
            base,
            path_var: &host.path_var,
            shell_root: shell_root.as_deref(),
            protected: &protected,
        },
        canonical,
    );
    InitConfig {
        platform: Platform::Windows,
        home: text(&host.profile),
        workspace_roots: vec![text(root)],
        read_roots,
        deny_roots: vec![text(&base.join("local-host")), text(&base.join("sandbox"))],
        helpers: Helpers {
            ripgrep: text(&bundle.join(ripgrep_file_name())),
            apply_seccomp: None,
            java_agent_jar: Some(text(&bundle.join("srt-proxy-agent.jar"))),
        },
        bwrap_path: None,
        windows: Some(super::readiness::WindowsInit {
            srt_win: text(&host.srt_win),
            shell: text(&host.shell.exe),
        }),
    }
}

/// `canonicalize`, then the native non-verbatim form; `None` unless it is an existing directory.
#[cfg(windows)]
fn windows_canonical_dir(path: &Path) -> Option<PathBuf> {
    let native = super::winpath::to_native(&path.canonicalize().ok()?).ok()?;
    native.is_dir().then_some(native)
}

/// This machine's `WindowsHost`. Every failure is an error with its reason: a missing profile,
/// shell or staged helper means no sandbox, never a config without them.
#[cfg(windows)]
fn windows_host() -> Result<WindowsHost> {
    let (profile, app_data_roots) = super::winpath::user_locations()?;
    let shell = super::win_shell::detect().ok_or_else(super::win_shell::no_shell_error)?;
    let srt_win = super::windows::staged_srt_win_path().ok_or_else(|| {
        HostError::new(
            "SANDBOX_UNAVAILABLE",
            "The Program Files location could not be determined, so the sandbox helper cannot be found.",
        )
    })?;
    Ok(WindowsHost {
        profile,
        app_data_roots,
        path_var: user_path().0,
        shell,
        srt_win,
    })
}

/// The `InitConfig` of a Windows sidecar for `root`, from this machine. Used by command execution
/// and, with a scratch workspace root, by the readiness probe.
///
/// Before returning it, the sandbox account is given traversal of every profile directory above
/// `root` and above each read root (`win_acl`): programs resolve the path they run in, and the
/// account cannot `stat` those directories otherwise (`EPERM ... lstat '...\AppData'`). That
/// grant is part of building the config so that every sidecar start, the readiness probe
/// included, has it. A machine without the sandbox account fails closed here.
#[cfg(windows)]
pub(crate) fn windows_init_config_for(
    bundle: &Path,
    base: &Path,
    root: &Path,
) -> Result<(InitConfig, ShellKind)> {
    let host = windows_host()?;
    // The sidecar compares paths as spelled, so the workspace root it is given must be the
    // canonical long-name form (a base under an 8.3-spelled profile would otherwise differ from
    // the read roots and the grants below).
    let root = super::winpath::to_native(root)?;
    let root = windows_canonical_dir(&root).unwrap_or(root);
    let kind = host.shell.kind;
    let init = windows_init_config(bundle, base, &root, &host, windows_canonical_dir);
    let mut targets = vec![root.clone()];
    targets.extend(init.read_roots.iter().map(PathBuf::from));
    super::win_acl::ensure_ancestor_traversal(base, &host.profile, &targets)?;
    Ok((init, kind))
}

/// Refused while the runtime is being installed or the elevated setup is running: both replace
/// the files a sidecar runs from (and the staged helper it launches), so nothing may start, or
/// keep serving a new command, meanwhile.
#[cfg(windows)]
fn refuse_while_installing(host: &LocalHost) -> Result<()> {
    if super::readiness::ReadinessCache::is_installing(&host.sandbox_readiness_cache) {
        return Err(HostError::new(
            "SANDBOX_UNAVAILABLE",
            "The sandbox is installing; try again when it has finished.",
        ));
    }
    Ok(())
}

/// Starts the sidecar for `root` from this host's installed bundle.
#[cfg(windows)]
fn start_windows_instance(host: &LocalHost, root: &Path) -> Result<SandboxInstance> {
    refuse_while_installing(host)?;
    let bundle = bundle_dir(&host.base);
    if !bundle.join(sidecar_file_name()).is_file() {
        return Err(HostError::new(
            "SANDBOX_UNAVAILABLE",
            "Sandbox runtime is not installed",
        ));
    }
    let root = super::winpath::to_native(root)?;
    let (init, shell) = windows_init_config_for(&bundle, &host.base, &root)?;
    // The first `init` of a workspace walks its tree and can take minutes.
    let sidecar = Sidecar::start_for_workspace(&bundle, &init, Some(event_handler(host.network.clone())))?;
    // An install that began while this one was starting must not find a sidecar running from the
    // files it is about to swap: drop it (it shuts down) rather than hand it out.
    refuse_while_installing(host)?;
    Ok(SandboxInstance::new(sidecar, vec![root]).with_shell(shell))
}

/// Runs `script` in the workspace `root` (cwd inside it) with write access to `root` only, under
/// the shell the root's sidecar was started with, and returns the backend's JSON shape
/// (`{"output","exitCode","truncated","cancelled"}`). The child's `PATH` is the sidecar's (the
/// host's) and its `HOME`/`TEMP`/`TMP`/cache locations are pinned by the script prelude: the
/// wrapped environment is used unchanged, because the sandboxed command never sees the host's
/// environment, only the broker's `PATH`/`PATHEXT` and the proxy variables.
#[cfg(windows)]
pub(crate) fn execute_command(
    host: &LocalHost,
    root: &Path,
    cwd: &Path,
    script: &str,
    timeout_ms: u64,
    max_chars: usize,
    cancel: Arc<AtomicBool>,
    network: Option<&NetworkPolicy>,
    active: &ActiveCommand,
) -> Result<Value> {
    refuse_while_installing(host)?;
    // Instances are keyed by, and the sidecar is told, the canonical spelling of the root (see
    // `windows_init_config_for`); the working directory is rebased onto it.
    let canonical_root = windows_canonical_dir(root).unwrap_or_else(|| root.to_path_buf());
    let rebased_cwd = match super::winpath::relative_below(root, cwd) {
        Some(relative) if relative.is_empty() => canonical_root.clone(),
        Some(relative) => canonical_root.join(relative.replace('/', "\\")),
        None => cwd.to_path_buf(),
    };
    let (root, cwd) = (canonical_root.as_path(), rebased_cwd.as_path());
    super::win_shell::prepare_tmpdir(root)?;
    let command_id = new_command_id();
    // Before `wrap`: the sidecar's first ask can follow the wrap reply immediately, and the
    // bridge only attributes asks that name this command.
    active.set_command_id(&command_id);
    let script_for = |instance: &SandboxInstance| -> Result<String> {
        let kind = instance.shell.ok_or_else(|| {
            HostError::new("SANDBOX_UNAVAILABLE", "The sandbox instance has no shell.")
        })?;
        super::win_shell::pinned_script(kind, root, cwd, script)
    };
    let (instance, wrapped) = match wrap_in_instances(
        &host.sandbox,
        root,
        cwd,
        &command_id,
        network,
        &script_for,
        || start_windows_instance(host, root),
    ) {
        Ok(found) => found,
        Err(error) => {
            if invalidates_readiness(error.code) {
                host.invalidate_sandbox_readiness();
            }
            return Err(error);
        }
    };
    run_and_report(
        &instance,
        &command_id,
        &wrapped.argv,
        &wrapped.env,
        cwd,
        RunLimits {
            timeout_ms,
            max_chars,
            cancel,
        },
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

    const STUB: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/stub-sidecar.sh"
    );

    fn bundle_with_stub() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("srt-sidecar");
        fs::copy(STUB, &target).unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
        // See sidecar.rs's test helper: avoids an observed ETXTBSY race on overlayfs.
        fs::File::open(&target).unwrap().sync_all().unwrap();
        dir
    }

    fn stub_instance(bundle: &Path, roots: &[&str]) -> Result<SandboxInstance> {
        stub_instance_at(bundle, roots, "/tmp/sourceweft-srt-exec-test-home")
    }

    /// A stub whose `init.home` is `home`; a `home` ending in `/record-ops` makes the stub log
    /// every later request as `<op> <commandId>` to `<home>.log`.
    fn stub_instance_at(bundle: &Path, roots: &[&str], home: &str) -> Result<SandboxInstance> {
        let init = InitConfig {
            platform: Platform::Linux,
            home: home.to_string(),
            workspace_roots: roots.iter().map(|r| r.to_string()).collect(),
            read_roots: vec![],
            deny_roots: vec![],
            helpers: Helpers {
                ripgrep: "/usr/bin/rg".to_string(),
                apply_seccomp: None,
                java_agent_jar: None,
            },
            bwrap_path: None,
            windows: None,
        };
        let sidecar = Sidecar::start_with_timeout(bundle, &init, Duration::from_secs(5))?;
        Ok(SandboxInstance::new(
            sidecar,
            roots.iter().map(PathBuf::from).collect(),
        ))
    }

    #[test]
    fn pinned_script_exports_the_workspace_tmpdir_first() {
        assert_eq!(
            pinned_script(Path::new("/w/it's [测试]"), "echo hi"),
            "export TMPDIR='/w/it'\\''s [测试]/.tmp'\necho hi"
        );
    }

    #[test]
    fn command_ids_are_long_and_unique() {
        let first = new_command_id();
        let second = new_command_id();
        assert!(first.len() >= 22, "{first}");
        assert_ne!(first, second);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn stopping_the_sidecar_empties_the_slot_so_the_next_command_starts_a_new_one() {
        let bundle = bundle_with_stub();
        let slot = SandboxSlot::default();
        let mut starts = 0;
        let mut run = |slot: &SandboxSlot| {
            let (instance, _) = wrap_in_sandbox(
                slot,
                Path::new("/w/a/files"),
                Path::new("/w/a/files"),
                "echo hi",
                "id",
                None,
                || {
                    starts += 1;
                    stub_instance(bundle.path(), &["/w"])
                },
            )
            .unwrap();
            instance.finish("id");
        };
        run(&slot);
        stop_sidecar(&slot);
        assert!(slot.lock().unwrap().is_none());
        run(&slot);
        stop_sidecar(&slot);
        stop_sidecar(&slot); // idempotent on an empty slot
        assert_eq!(starts, 2);
    }

    #[test]
    fn running_sidecar_is_reused() {
        let bundle = bundle_with_stub();
        let slot = SandboxSlot::default();
        let mut starts = 0;
        for _ in 0..2 {
            let (instance, wrapped) = wrap_in_sandbox(
                &slot,
                Path::new("/w/a/files"),
                Path::new("/w/a/files"),
                "echo hi",
                "id",
                None,
                || {
                    starts += 1;
                    stub_instance(bundle.path(), &["/w"])
                },
            )
            .unwrap();
            assert_eq!(wrapped.argv, ["/bin/echo", "hi"]);
            instance.finish("id");
        }
        assert_eq!(starts, 1);
    }

    #[test]
    fn root_outside_init_restarts_with_current_roots() {
        let bundle = bundle_with_stub();
        let slot = SandboxSlot::default();
        *slot.lock().unwrap() = Some(Arc::new(stub_instance(bundle.path(), &["/w"]).unwrap()));
        let before = slot.lock().unwrap().clone().unwrap();
        let mut starts = 0;
        let (instance, _) = wrap_in_sandbox(
            &slot,
            Path::new("/granted"),
            Path::new("/granted"),
            "echo hi",
            "id",
            None,
            || {
                starts += 1;
                stub_instance(bundle.path(), &["/w", "/granted"])
            },
        )
        .unwrap();
        instance.finish("id");
        assert_eq!(starts, 1);
        let after = slot.lock().unwrap().clone().unwrap();
        assert!(!Arc::ptr_eq(&before, &after));
        assert!(after.covers(Path::new("/granted")));
    }

    /// Requests the recording stub saw with op `op`, as their command ids, in order.
    fn recorded(log: &Path, op: &str) -> Vec<String> {
        fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.strip_prefix(&format!("{op} ")))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn cleanup_runs_once_per_successful_wrap_and_never_after_a_failed_one() {
        let bundle = bundle_with_stub();
        let record = tempfile::tempdir().unwrap();
        let home = record.path().join("record-ops");
        let home = home.to_str().unwrap();
        let log = record.path().join("record-ops.log");
        let slot = SandboxSlot::default();
        let start = || stub_instance_at(bundle.path(), &["/w"], home);
        let w = Path::new("/w");
        // Two overlapping commands: the second is wrapped before the first has finished.
        let (first, _) = wrap_in_sandbox(&slot, w, w, "echo a", "cmd-a", None, start).unwrap();
        let (second, _) = wrap_in_sandbox(&slot, w, w, "echo b", "cmd-b", None, start).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        let failed = wrap_in_sandbox(&slot, w, w, "ERROR:POLICY_INVALID", "cmd-c", None, start)
            .err()
            .expect("a policy error must be returned");
        assert_eq!(failed.code, "POLICY_INVALID");
        first.finish("cmd-a");
        second.finish("cmd-b");
        assert_eq!(recorded(&log, "wrap"), ["cmd-a", "cmd-b", "cmd-c"]);
        assert_eq!(recorded(&log, "cleanup"), ["cmd-a", "cmd-b"]);
    }

    #[test]
    fn unavailable_wrap_restarts_once_then_fails() {
        let bundle = bundle_with_stub();
        let record = tempfile::tempdir().unwrap();
        let home = record.path().join("record-ops");
        let home = home.to_str().unwrap();
        let log = record.path().join("record-ops.log");
        let slot = SandboxSlot::default();
        let mut starts = 0;
        let error = wrap_in_sandbox(
            &slot,
            Path::new("/w"),
            Path::new("/w"),
            "ERROR:SANDBOX_UNAVAILABLE",
            "id",
            None,
            || {
                starts += 1;
                stub_instance_at(bundle.path(), &["/w"], home)
            },
        )
        .err()
        .expect("a wrap that keeps failing must not succeed");
        assert_eq!(error.code, "SANDBOX_UNAVAILABLE");
        // The first start plus exactly one restart, and no cleanup for either failed wrap.
        assert_eq!(starts, 2);
        assert_eq!(recorded(&log, "wrap"), ["id", "id"]);
        assert!(recorded(&log, "cleanup").is_empty());
    }

    #[test]
    fn other_wrap_errors_do_not_restart() {
        let bundle = bundle_with_stub();
        let slot = SandboxSlot::default();
        let mut starts = 0;
        let error = wrap_in_sandbox(
            &slot,
            Path::new("/w"),
            Path::new("/w"),
            "ERROR:POLICY_INVALID",
            "id",
            None,
            || {
                starts += 1;
                stub_instance(bundle.path(), &["/w"])
            },
        )
        .err()
        .expect("a policy error must be returned");
        assert_eq!(error.code, "POLICY_INVALID");
        assert_eq!(starts, 1);
    }

    /// A bundle from before the protocol handshake (it would ignore `denyRoots` and wrap
    /// anything) is refused at start, so `wrap_in_sandbox` never gets an instance to wrap with.
    #[test]
    fn stale_bundle_never_reaches_wrap() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("srt-sidecar");
        fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/stub-sidecar-stale.sh"
            ),
            &target,
        )
        .unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
        fs::File::open(&target).unwrap().sync_all().unwrap();
        let record = tempfile::tempdir().unwrap();
        let home = record.path().join("home");
        let log = record.path().join("home.log");
        let slot = SandboxSlot::default();
        let error = wrap_in_sandbox(
            &slot,
            Path::new("/w"),
            Path::new("/w"),
            "echo hi",
            "id",
            None,
            || stub_instance_at(dir.path(), &["/w"], home.to_str().unwrap()),
        )
        .err()
        .expect("a stale bundle must not run commands");
        assert_eq!(error.code, "BUNDLE_STALE");
        assert!(slot.lock().unwrap().is_none());
        let logged = fs::read_to_string(&log).unwrap();
        assert!(!logged.lines().any(|line| line == "wrap"), "{logged}");
    }

    #[test]
    fn failed_start_is_returned() {
        let slot = SandboxSlot::default();
        let error = wrap_in_sandbox(
            &slot,
            Path::new("/w"),
            Path::new("/w"),
            "true",
            "id",
            None,
            || Err(HostError::new("HELPER_MISSING", "stub")),
        )
        .err()
        .expect("a failed start must be returned");
        assert_eq!(error.code, "HELPER_MISSING");
        assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn read_roots_follow_the_bin_parent_rule() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        for dir in [
            ".cargo/bin",
            ".local/bin",
            ".local/node/bin",
            ".local/share/app/sandbox/current",
            "bin",
            "tools/node",
            "missing-parent",
        ] {
            fs::create_dir_all(home.join(dir)).unwrap();
        }
        fs::remove_dir(home.join("missing-parent")).unwrap();
        let base = home.join(".local/share/app");
        let h = home.to_str().unwrap();
        let path = format!(
            "{h}/.cargo/bin:/usr/bin:{h}/.local/bin:{h}/.local/node/bin:{h}/bin:{h}/tools/node:\
             {h}/missing-parent:{h}:relative/bin:{h}/.cargo/bin:{h}/tools/../..:{h}/.local/node/..:\
             {h}/.local/share:{h}/.local/share/app/sandbox/current:{h}/.local/share/app"
        );
        assert_eq!(
            read_roots(&home, &base, &path),
            [
                format!("{h}/.cargo"),
                // R16(a): `~/.local/bin` is kept as-is, never widened to `~/.local`.
                format!("{h}/.local/bin"),
                format!("{h}/.local/node"),
                format!("{h}/bin"),
                format!("{h}/tools/node"),
            ]
        );
        assert!(read_roots(Path::new(""), &base, &path).is_empty());
    }

    #[test]
    fn read_roots_never_touch_the_app_data_directory() {
        // R16(b): a root that contains, equals, or lies inside `base` is dropped even when it is
        // a legitimate-looking toolchain directory.
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        let base = home.join("apps/sw");
        fs::create_dir_all(base.join("tools/bin")).unwrap();
        let h = home.to_str().unwrap();
        let path = format!("{h}/apps/bin:{h}/apps/sw/bin:{h}/apps/sw/tools/bin");
        fs::create_dir_all(home.join("apps/bin")).unwrap();
        assert!(
            read_roots(&home, &base, &path).is_empty(),
            "{:?}",
            read_roots(&home, &base, &path)
        );
    }

    /// Writes an executable stub `xcode-select` into `dir` that prints `prints` to stdout and
    /// exits with `code` when invoked (it ignores its arguments, so `-p` behaves like any call).
    /// Mirrors `bundle_with_stub`'s pattern for a scripted fake binary.
    fn stub_xcode_select(dir: &Path, prints: &str, code: i32) -> String {
        let path = dir.join("xcode-select");
        fs::write(&path, format!("#!/bin/sh\nprintf '%s' {prints}\nexit {code}\n")).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
        fs::File::open(&path).unwrap().sync_all().unwrap();
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn developer_dir_is_read_from_a_stub_xcode_select() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().canonicalize().unwrap();
        // A real, canonical directory the stub `xcode-select -p` points at.
        let developer = dir.join("Developer");
        fs::create_dir(&developer).unwrap();
        let stub = stub_xcode_select(&dir, developer.to_str().unwrap(), 0);
        assert_eq!(developer_dir(&stub), Some(developer));

        // Non-zero exit (no active toolchain): None.
        let failing = stub_xcode_select(&dir, "/anything", 1);
        assert_eq!(developer_dir(&failing), None);
        // Success but the printed path does not exist: None.
        let gone = dir.join("Developer-gone");
        let missing = stub_xcode_select(&dir, gone.to_str().unwrap(), 0);
        assert_eq!(developer_dir(&missing), None);
        // Success but a file, not a directory: None.
        let file = dir.join("afile");
        fs::write(&file, "x").unwrap();
        let as_file = stub_xcode_select(&dir, file.to_str().unwrap(), 0);
        assert_eq!(developer_dir(&as_file), None);
        // Empty output: None.
        let empty = stub_xcode_select(&dir, "", 0);
        assert_eq!(developer_dir(&empty), None);
        // The binary does not exist at all: None, no panic.
        assert_eq!(developer_dir("/no/such/xcode-select"), None);
    }

    #[test]
    fn darwin_read_roots_merge_path_roots_then_discovered_dirs() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        fs::create_dir_all(home.join(".cargo/bin")).unwrap();
        let base = home.join(".app");
        // Two discovered extras: one real directory, one that does not exist (dropped).
        let developer = tempfile::tempdir().unwrap();
        let developer = developer.path().canonicalize().unwrap();
        let absent = home.join("opt-homebrew-absent");
        let h = home.to_str().unwrap();
        let roots = darwin_read_roots_with(
            &home,
            &base,
            &format!("{h}/.cargo/bin:/usr/bin"),
            &[developer.clone(), absent.clone(), developer.clone()],
        );
        assert_eq!(
            roots,
            [
                // The `$HOME` PATH root (`~/.cargo`) comes first, before the discovered dirs.
                format!("{h}/.cargo"),
                // The real discovered directory, added once (the duplicate is dropped).
                developer.to_str().unwrap().to_string(),
            ]
        );
        assert!(!roots.iter().any(|r| *r == absent.to_string_lossy()));
    }

    #[test]
    fn darwin_read_roots_drop_home_local_and_base_candidates() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        fs::create_dir_all(home.join(".local")).unwrap();
        let home_sub = home.join("Developer");
        fs::create_dir(&home_sub).unwrap();
        let home_parent = home.parent().unwrap().to_path_buf();
        // A base OUTSIDE home, so the base-containment checks are exercised on their own (on a real
        // macOS host base is under home, where the inside-home check already covers it).
        let base_root = tempfile::tempdir().unwrap();
        let base = base_root.path().canonicalize().unwrap().join("app");
        fs::create_dir_all(&base).unwrap();
        let base_parent = base.parent().unwrap().to_path_buf();
        // A directory outside every protected area.
        let safe = tempfile::tempdir().unwrap();
        let safe = safe.path().canonicalize().unwrap();

        for dropped in [
            home.clone(),         // equals home
            home_sub.clone(),     // inside home (the DEVELOPER_DIR=$HOME/sub leak)
            home.join(".local"),  // exactly ~/.local
            home_parent.clone(),  // contains (is an ancestor of) home
            base.clone(),         // equals base
            base_parent.clone(),  // contains base
        ] {
            let roots = darwin_read_roots_with(&home, &base, "/usr/bin", std::slice::from_ref(&dropped));
            assert!(
                !roots.iter().any(|r| *r == dropped.to_string_lossy()),
                "{dropped:?} must be dropped, got {roots:?}"
            );
        }
        // A directory outside all protected areas is kept.
        let kept = darwin_read_roots_with(&home, &base, "/usr/bin", &[safe.clone()]);
        assert!(
            kept.iter().any(|r| *r == safe.to_string_lossy()),
            "{safe:?} should be kept, got {kept:?}"
        );
    }

    #[test]
    fn developer_dir_runs_xcode_select_with_a_cleared_environment() {
        // Regression: `xcode-select -p` echoes `$DEVELOPER_DIR` verbatim, so an inherited
        // `DEVELOPER_DIR` (pointing at `$HOME`, a home subpath, or the app-data base) must never
        // reach the child and become a read root. Rather than mutate this process's own
        // environment (which would race the login-shell `user_path()` reads in sibling tests), the
        // stub reports success only when it sees a cleared environment: the test runner always has
        // `HOME` set, so if `developer_dir` did NOT clear the child env the stub would see it and
        // bail. It prints a real directory (so a non-cleared run is caught as a `Some` vs `None`
        // difference, not a missing path) only when `DEVELOPER_DIR` and `HOME` are both empty. (A
        // cleared-env `/bin/sh` still defaults `PATH`, so `PATH` is not part of the check.)
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().canonicalize().unwrap();
        let reported = dir.join("Developer");
        fs::create_dir(&reported).unwrap();
        let stub = dir.join("xcode-select");
        fs::write(
            &stub,
            format!(
                "#!/bin/sh\nif [ -z \"$DEVELOPER_DIR\" ] && [ -z \"$HOME\" ]; \
                 then printf '%s' '{}'; else exit 7; fi\n",
                reported.to_str().unwrap()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&stub).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&stub, permissions).unwrap();
        fs::File::open(&stub).unwrap().sync_all().unwrap();
        assert!(
            std::env::var_os("HOME").is_some(),
            "the test runner must have HOME set for this test to be meaningful"
        );
        assert_eq!(
            developer_dir(stub.to_str().unwrap()),
            Some(reported),
            "xcode-select must run with a cleared environment (HOME/PATH/DEVELOPER_DIR unset)"
        );
    }

    /// The production discovery entry point adds the real `xcode-select -p` developer directory
    /// when one is active on this machine; otherwise it matches the PATH-derived roots. Either
    /// way it must not panic and must keep the PATH roots first.
    #[test]
    fn darwin_read_roots_runs_the_real_xcode_select_without_panicking() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        let base = home.join(".app");
        let roots = darwin_read_roots(&home, &base, "/usr/bin:/bin", XCODE_SELECT);
        // Every entry is an absolute, canonical path (no `$HOME` roots in this PATH).
        assert!(roots.iter().all(|r| Path::new(r).is_absolute()));
    }

    #[test]
    fn darwin_developer_dir_requires_a_usable_toolchain() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().canonicalize().unwrap();
        let clt = dir.join("CommandLineTools");
        fs::create_dir(&clt).unwrap();
        // An existing directory without usr/bin/git or usr/bin/clang is not usable: None.
        assert_eq!(darwin_developer_dir(clt.to_str().unwrap()), None);
        fs::create_dir_all(clt.join("usr/bin")).unwrap();
        assert_eq!(darwin_developer_dir(clt.to_str().unwrap()), None);
        // A directory standing in for the tool is not a tool.
        fs::create_dir(clt.join("usr/bin/git")).unwrap();
        assert_eq!(darwin_developer_dir(clt.to_str().unwrap()), None);
        fs::remove_dir(clt.join("usr/bin/git")).unwrap();
        // Either tool makes it usable; the canonical path is returned.
        for tool in ["git", "clang"] {
            fs::write(clt.join("usr/bin").join(tool), "x").unwrap();
            assert_eq!(
                darwin_developer_dir(clt.to_str().unwrap()),
                Some(clt.to_str().unwrap().to_string()),
                "usr/bin/{tool} must make the directory usable"
            );
            fs::remove_file(clt.join("usr/bin").join(tool)).unwrap();
        }
        // A path that does not exist: None.
        assert_eq!(darwin_developer_dir(dir.join("absent").to_str().unwrap()), None);
        // A file, not a directory: None.
        let file = dir.join("afile");
        fs::write(&file, "x").unwrap();
        assert_eq!(darwin_developer_dir(file.to_str().unwrap()), None);
    }

    #[test]
    fn child_env_pins_the_developer_dir_only_when_given() {
        let root = Path::new("/w/ws");
        // A wrapped env that already carries a (stale) DEVELOPER_DIR, to prove the pin wins.
        let wrapped = || vec![("DEVELOPER_DIR".to_string(), "/stale/xcode".to_string())];

        let with = child_env(root, wrapped(), Some("/Library/Developer/CommandLineTools"));
        let find = |env: &[(String, String)], key: &str| {
            env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
        };
        assert_eq!(
            find(&with, "DEVELOPER_DIR").as_deref(),
            Some("/Library/Developer/CommandLineTools"),
            "the override must win over the wrapped value"
        );
        // The other pinned values are still laid over the wrapped env.
        assert_eq!(find(&with, "HOME").as_deref(), Some("/w/ws"));
        assert_eq!(find(&with, "TMPDIR").as_deref(), Some("/w/ws/.tmp"));

        // No override (Linux / no Command Line Tools): DEVELOPER_DIR is left as the wrapped value,
        // never introduced or rewritten by us.
        let without = child_env(root, wrapped(), None);
        assert_eq!(find(&without, "DEVELOPER_DIR").as_deref(), Some("/stale/xcode"));

        // No override and no wrapped value: no DEVELOPER_DIR at all.
        let clean = child_env(root, vec![], None);
        assert_eq!(find(&clean, "DEVELOPER_DIR"), None);
    }

    #[test]
    fn init_config_denies_the_host_database_and_bundles() {
        let base = Path::new("/home/u/.local/share/app");
        let init = init_config(Platform::Linux, &base.join("sandbox/current"), base, vec![]);
        assert_eq!(
            init.deny_roots,
            [
                "/home/u/.local/share/app/local-host",
                "/home/u/.local/share/app/sandbox"
            ]
        );
        assert_eq!(init.platform, Platform::Linux);
        assert_eq!(init.bwrap_path.as_deref(), Some(BWRAP_PATH));
        assert!(init.helpers.apply_seccomp.is_some());
        assert!(init.helpers.java_agent_jar.is_some());
    }

    #[test]
    fn darwin_init_config_has_no_bwrap_or_seccomp_but_keeps_the_jar() {
        let base = Path::new("/Users/u/Library/Application Support/app");
        let bundle = base.join("sandbox/current");
        let init = init_config(Platform::Darwin, &bundle, base, vec!["/w".to_string()]);
        assert_eq!(init.platform, Platform::Darwin);
        assert_eq!(init.bwrap_path, None);
        assert_eq!(init.helpers.apply_seccomp, None);
        assert_eq!(
            init.helpers.java_agent_jar.as_deref(),
            Some("/Users/u/Library/Application Support/app/sandbox/current/srt-proxy-agent.jar")
        );
        assert_eq!(
            init.helpers.ripgrep,
            "/Users/u/Library/Application Support/app/sandbox/current/rg"
        );
        assert_eq!(
            init.deny_roots,
            [
                "/Users/u/Library/Application Support/app/local-host",
                "/Users/u/Library/Application Support/app/sandbox"
            ]
        );
        assert_eq!(init.workspace_roots, ["/w"]);
        let wire = serde_json::to_value(&init).unwrap();
        assert_eq!(wire["platform"], "darwin");
        assert!(wire.get("bwrapPath").is_none());
        assert!(wire["helpers"].get("applySeccomp").is_none());
    }

    fn host_with_stub_bundle() -> (tempfile::TempDir, LocalHost, PathBuf) {
        let app = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        let current = bundle_dir(&host.base);
        fs::create_dir_all(&current).unwrap();
        let target = current.join("srt-sidecar");
        fs::copy(STUB, &target).unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
        fs::File::open(&target).unwrap().sync_all().unwrap();
        let root = host.base.join("task-workspaces/ws1");
        fs::create_dir_all(&root).unwrap();
        (app, host, root)
    }

    fn next_ask(frames: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok(frame) = frames.try_recv() {
                return frame;
            }
            assert!(std::time::Instant::now() < deadline, "no network.ask was sent");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// A kill deadline that never matters in a test.
    fn far() -> std::time::Instant {
        std::time::Instant::now() + Duration::from_secs(3600)
    }

    fn ask_policy() -> NetworkPolicy {
        NetworkPolicy {
            mode: super::super::network::NetworkMode::Ask,
            allow: vec![],
            suggested: Default::default(),
        }
    }

    #[test]
    fn execute_command_relays_an_ask_and_reports_the_audit() {
        let (_app, host, root) = host_with_stub_bundle();
        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
        let _lease = host.network.attach(sender);
        let active = host.network.begin("inv-1", Arc::default(), far());
        let bridge = host.network.clone();
        let answerer = std::thread::spawn(move || {
            let frame = next_ask(&mut frames);
            assert_eq!(frame["type"], "network.ask");
            assert_eq!(frame["id"], "inv-1");
            assert_eq!(frame["host"], "example.com");
            assert_eq!(frame["port"], 443);
            assert!(bridge.resolve(frame["askId"].as_str().unwrap(), true, None));
        });
        let result = execute_command(
            &host,
            &root,
            &root,
            "SLEEP_ASK:example.com:443",
            20_000,
            1000,
            Arc::default(),
            Some(&ask_policy()), &active,
        )
        .unwrap();
        answerer.join().unwrap();
        assert_eq!(result["exitCode"], 0);
        let audit = result["networkAudit"].as_array().unwrap();
        assert_eq!(audit.len(), 1);
        // The stub reports the answer it received via `ask.reply`.
        assert_eq!(audit[0]["decision"], "allow");
        assert!(result.get("networkAuditError").is_none());
    }

    #[test]
    fn a_denied_ask_reaches_the_sidecar_as_a_deny() {
        let (_app, host, root) = host_with_stub_bundle();
        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
        let _lease = host.network.attach(sender);
        let active = host.network.begin("inv-1", Arc::default(), far());
        let bridge = host.network.clone();
        let answerer = std::thread::spawn(move || {
            let frame = next_ask(&mut frames);
            bridge.resolve(frame["askId"].as_str().unwrap(), false, Some("no".into()));
        });
        let result = execute_command(
            &host, &root, &root, "SLEEP_ASK:example.com:443", 20_000, 1000, Arc::default(),
            Some(&ask_policy()), &active,
        )
        .unwrap();
        answerer.join().unwrap();
        assert_eq!(result["networkAudit"][0]["decision"], "deny");
    }

    #[test]
    fn an_ask_naming_another_command_is_denied_and_never_reaches_the_backend() {
        let (_app, host, root) = host_with_stub_bundle();
        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
        let _lease = host.network.attach(sender);
        let active = host.network.begin("inv-1", Arc::default(), far());
        let result = execute_command(
            &host, &root, &root, "SLEEP_ASK_OTHER:example.com:443", 20_000, 1000, Arc::default(),
            Some(&ask_policy()), &active,
        )
        .unwrap();
        assert!(frames.try_recv().is_err(), "an ask for another command must not be relayed");
        assert_eq!(result["networkAudit"][0]["decision"], "deny");
    }

    #[test]
    fn asks_without_a_connection_are_denied_and_the_command_still_finishes() {
        let (_app, host, root) = host_with_stub_bundle();
        let active = host.network.begin("inv-1", Arc::default(), far());
        let result = execute_command(
            &host, &root, &root, "SLEEP_ASK:example.com:443", 20_000, 1000, Arc::default(), None, &active,
        )
        .unwrap();
        assert_eq!(result["exitCode"], 0);
        assert_eq!(result["networkAudit"][0]["decision"], "deny");
    }

    #[test]
    fn a_failing_audit_never_fails_the_command() {
        let (_app, host, root) = host_with_stub_bundle();
        let active = host.network.begin("inv", Arc::default(), far());
        let result = execute_command(
            &host, &root, &root, "AUDIT_FAIL", 20_000, 1000, Arc::default(), None, &active,
        )
        .unwrap();
        assert_eq!(result["exitCode"], 0);
        assert!(result.get("networkAudit").is_none());
        assert_eq!(result["networkAuditError"], "stub audit error");
    }

    #[test]
    fn the_result_is_the_macos_shape_plus_the_audit() {
        let (_app, host, root) = host_with_stub_bundle();
        let active = host.network.begin("inv", Arc::default(), far());
        let result = execute_command(
            &host, &root, &root, "echo hi", 20_000, 1000, Arc::default(), None, &active,
        )
        .unwrap();
        super::super::execution::network_tests::assert_result_shape(&result);
        assert!(result["networkAudit"].is_array(), "{result}");
    }

    #[test]
    fn a_replacement_sidecar_also_answers_asks_through_the_bridge() {
        let (_app, host, root) = host_with_stub_bundle();
        // Seed the slot with a sidecar that has already desynchronized (a wrap that never
        // answers), so the next wrap replaces it via the production `start_instance`.
        let bundle = bundle_dir(&host.base);
        let init = init_config(HOST_PLATFORM, &bundle, &host.base, vec![host.base.join("task-workspaces").to_str().unwrap().to_string()]);
        let dead = Sidecar::start_with_timeout(&bundle, &init, Duration::from_secs(5)).unwrap();
        assert!(dead
            .wrap("x", "HANG", &root, &root, None)
            .is_err());
        *host.sandbox.lock().unwrap() = Some(Arc::new(SandboxInstance::new(
            dead,
            vec![host.base.join("task-workspaces")],
        )));
        let before = host.sandbox.lock().unwrap().clone().unwrap();

        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
        let _lease = host.network.attach(sender);
        let active = host.network.begin("inv-1", Arc::default(), far());
        active.set_command_id("cmd");
        let (instance, _) = wrap_in_sandbox(
            &host.sandbox, &root, &root, "SLEEP_ASK:example.com:443", "cmd", None,
            || start_instance(&host),
        )
        .unwrap();
        assert!(!Arc::ptr_eq(&before, &instance));
        let frame = next_ask(&mut frames);
        assert!(host.network.resolve(frame["askId"].as_str().unwrap(), true, None));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let entries = instance.sidecar.audit("cmd").unwrap();
            if entries[0]["decision"] == "allow" {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "the answer never reached the sidecar");
            std::thread::sleep(Duration::from_millis(20));
        }
        instance.finish("cmd");
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::root_within;
    use std::path::Path;

    #[test]
    fn a_workspace_root_is_covered_case_insensitively_and_across_path_spellings() {
        let allowed = Path::new(r"C:\Users\Me\Work");
        assert!(root_within(Path::new(r"C:\Users\Me\Work"), allowed));
        assert!(root_within(Path::new(r"c:\users\me\WORK\sub"), allowed));
        assert!(root_within(Path::new(r"\\?\C:\Users\Me\Work\sub"), allowed));
        assert!(!root_within(Path::new(r"C:\Users\Me\Work2"), allowed));
        assert!(!root_within(Path::new(r"C:\Users\Me"), allowed));
        assert!(!root_within(Path::new(r"D:\Users\Me\Work"), allowed));
    }

    #[test]
    fn roots_that_differ_only_in_case_or_prefix_are_the_same_root() {
        use super::same_root;
        assert!(same_root(Path::new(r"C:\Users\Me\Work"), Path::new(r"c:\users\me\work")));
        assert!(same_root(Path::new(r"\\?\C:\Users\Me\Work"), Path::new(r"C:\Users\Me\Work\")));
        assert!(!same_root(Path::new(r"C:\Users\Me\Work"), Path::new(r"C:\Users\Me\Work\sub")));
    }

    #[test]
    fn nothing_starts_or_runs_while_an_install_is_in_progress() {
        use super::{execute_command, start_windows_instance};
        use crate::local_host::{readiness::ReadinessCache, LocalHost};
        use std::sync::{atomic::AtomicBool, Arc};
        let app = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        let root = app.path().to_path_buf();
        let run = |host: &LocalHost| {
            let active = host.network.begin(
                "inv",
                Arc::default(),
                std::time::Instant::now() + std::time::Duration::from_secs(3600),
            );
            execute_command(
                host,
                &root,
                &root,
                "echo hi",
                1000,
                100,
                Arc::new(AtomicBool::new(false)),
                None,
                &active,
            )
            .unwrap_err()
        };
        let guard = ReadinessCache::begin_install(&host.sandbox_readiness_cache)
            .expect("no install is running yet");
        let refused = run(&host);
        assert_eq!(refused.code, "SANDBOX_UNAVAILABLE");
        assert!(refused.message.contains("installing"), "{}", refused.message);
        let refused = match start_windows_instance(&host, &root) {
            Err(error) => error,
            Ok(_) => panic!("a sidecar must not start while an install runs"),
        };
        assert_eq!(refused.code, "SANDBOX_UNAVAILABLE");
        assert!(refused.message.contains("installing"), "{}", refused.message);
        // Once the install is over the refusal is gone (this machine has no runtime, which is a
        // different, honest error).
        drop(guard);
        let error = run(&host);
        assert!(!error.message.contains("installing"), "{}", error.message);
    }

    /// The production `canonical` against a real directory tree: only existing directories under
    /// the profile, in native form, with no widening of `bin`.
    #[test]
    fn read_roots_come_from_real_directories_in_native_form() {
        use super::{read_roots_windows, windows_canonical_dir, ReadRootInputs};
        let tree = tempfile::tempdir().unwrap();
        let profile = windows_canonical_dir(tree.path()).unwrap();
        let make = |relative: &str| {
            let path = profile.join(relative);
            std::fs::create_dir_all(&path).unwrap();
            path
        };
        let cargo_bin = make(r".cargo\bin");
        make(r".cargo\registry");
        let tools = make("My Tools");
        let appdata = make(r"AppData\Roaming");
        let base = make(r"AppData\Roaming\app");
        std::fs::write(profile.join("a-file"), "x").unwrap();
        let path_var = format!(
            "{};{};{};{};{};{};{}",
            cargo_bin.display(),
            tools.display(),
            profile.join("gone").display(),
            profile.join("a-file").display(),
            profile.display(),
            appdata.display(),
            base.display(),
        );
        let found = read_roots_windows(
            &ReadRootInputs {
                profile: &profile,
                app_data_roots: std::slice::from_ref(&appdata),
                base: &base,
                path_var: &path_var,
                shell_root: None,
                protected: &[],
            },
            windows_canonical_dir,
        );
        assert_eq!(
            found,
            [cargo_bin.to_str().unwrap(), tools.to_str().unwrap()],
            "{found:?}"
        );
        assert!(found.iter().all(|root| !root.starts_with(r"\\?\")));
    }

    #[test]
    fn a_command_without_the_runtime_fails_closed_and_runs_nothing() {
        use super::{execute_command, LocalHost};
        use std::sync::{atomic::AtomicBool, Arc};
        let app = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = super::super::winpath::to_native(&workspace.path().canonicalize().unwrap()).unwrap();
        let active = host.network.begin(
            "inv",
            Arc::default(),
            std::time::Instant::now() + std::time::Duration::from_secs(3600),
        );
        let error = execute_command(
            &host,
            &root,
            &root,
            "echo ran > marker.txt",
            5_000,
            1_000,
            Arc::new(AtomicBool::new(false)),
            None,
            &active,
        )
        .unwrap_err();
        assert_eq!(error.code, "SANDBOX_UNAVAILABLE");
        assert!(error.message.contains("not installed"), "{error}");
        assert!(!root.join("marker.txt").exists());
    }
}

/// The Windows policy inputs are pure and run on every OS.
#[cfg(test)]
mod windows_policy_tests {
    use super::*;
    use crate::local_host::win_shell::{ShellKind, WindowsShell};
    use std::cell::RefCell;

    const PROFILE: &str = r"C:\Users\Me";
    const BASE: &str = r"C:\Users\Me\AppData\Roaming\com.sourceweft.desktop";

    fn app_data() -> Vec<PathBuf> {
        [
            r"C:\Users\Me\AppData\Roaming",
            r"C:\Users\Me\AppData\Local",
            r"C:\Users\Me\AppData\LocalLow",
        ]
        .iter()
        .map(PathBuf::from)
        .collect()
    }

    /// `canonical` for a pretend file system holding exactly `dirs` (compared case-insensitively
    /// like NTFS); the answer is spelled as stored, like `canonicalize` does.
    fn fake_fs(dirs: &'static [&'static str]) -> impl Fn(&Path) -> Option<PathBuf> {
        move |path| {
            let wanted = path.to_str()?.trim_end_matches('\\').to_ascii_lowercase();
            dirs.iter()
                .find(|dir| dir.to_ascii_lowercase() == wanted)
                .map(PathBuf::from)
        }
    }

    fn roots(path_var: &str, shell_root: Option<&str>, fs: impl Fn(&Path) -> Option<PathBuf>) -> Vec<String> {
        let app_data = app_data();
        let protected = crate::local_host::winpath::protected_locations(Path::new(PROFILE));
        read_roots_windows(
            &ReadRootInputs {
                profile: Path::new(PROFILE),
                app_data_roots: &app_data,
                base: Path::new(BASE),
                path_var,
                shell_root: shell_root.map(Path::new),
                protected: &protected,
            },
            fs,
        )
    }

    #[test]
    fn path_values_split_like_windows() {
        assert_eq!(
            split_windows_path(r#"C:\a;"D:\b;c";;E:\d;"#),
            [r"C:\a", r"D:\b;c", r"E:\d"]
        );
        assert_eq!(split_windows_path(""), Vec::<String>::new());
        assert_eq!(split_windows_path(";;"), Vec::<String>::new());
        assert_eq!(split_windows_path(r#"C:\My" "Tools"#), [r"C:\My Tools"]);
    }

    static EXISTING: &[&str] = &[
        r"C:\Windows\System32",
        r"C:\Windows",
        r"C:\Users",
        r"C:\Users\Me",
        r"C:\Users\Me\.cargo",
        r"C:\Users\Me\.cargo\bin",
        r"C:\Users\Me\My Tools",
        r"C:\Users\Me\a;b",
        r"C:\Users\Me\AppData",
        r"C:\Users\Me\AppData\Roaming",
        r"C:\Users\Me\AppData\Roaming\npm",
        r"C:\Users\Me\AppData\Roaming\com.sourceweft.desktop",
        r"C:\Users\Me\AppData\Roaming\com.sourceweft.desktop\sandbox\current",
        r"C:\Users\Me\AppData\Local",
        r"C:\Users\Me\AppData\Local\Programs\Python\Python312",
        r"C:\Users\Me\AppData\Local\Programs\Python\Python312\Scripts",
        r"C:\Users\Me\AppData\Local\Programs\Git",
        r"C:\Users\Me\scoop\shims",
        r"C:\Program Files\Git",
    ];

    #[test]
    fn only_path_directories_inside_the_profile_become_read_roots_without_widening() {
        let path_var = [
            r"C:\Windows\System32",
            r"C:\Windows",
            r"C:\Users\Me\.cargo\bin",
            r"c:\users\me\.CARGO\bin\",
            r"C:\Users\Me\AppData\Local\Programs\Python\Python312",
            r"C:\Users\Me\AppData\Local\Programs\Python\Python312\Scripts",
            r"C:\Users\Me\AppData\Roaming\npm",
            r#""C:\Users\Me\My Tools""#,
            r#""C:\Users\Me\a;b""#,
            r"C:\Users\Me\scoop\shims",
        ]
        .join(";");
        assert_eq!(
            roots(&path_var, None, fake_fs(EXISTING)),
            [
                // `.cargo\bin` stays `.cargo\bin`: the parent holds the registry and credentials.
                r"C:\Users\Me\.cargo\bin",
                r"C:\Users\Me\AppData\Local\Programs\Python\Python312",
                r"C:\Users\Me\AppData\Local\Programs\Python\Python312\Scripts",
                r"C:\Users\Me\AppData\Roaming\npm",
                r"C:\Users\Me\My Tools",
                r"C:\Users\Me\a;b",
                r"C:\Users\Me\scoop\shims",
            ]
        );
    }

    #[test]
    fn protected_areas_are_never_read_roots() {
        let path_var = [
            r"C:\Users",                                   // contains the profile
            r"C:\Users\Me",                                // the profile itself
            r"C:\Users\Me\AppData",                        // contains the app-data roots
            r"C:\Users\Me\AppData\Roaming",                // an app-data root
            r"C:\Users\Me\AppData\Local",                  // an app-data root
            r"C:\Users\Me\AppData\Roaming\com.sourceweft.desktop", // the app's own base
            r"C:\Users\Me\AppData\Roaming\com.sourceweft.desktop\sandbox\current", // inside it
        ]
        .join(";");
        assert_eq!(roots(&path_var, None, fake_fs(EXISTING)), Vec::<String>::new());
    }

    #[test]
    fn path_entries_inside_credential_locations_are_not_read_roots() {
        // The sidecar refuses a read root in a protected location with POLICY_INVALID, which would
        // fail the whole init: such PATH entries (a Store Python's Scripts directory, a tool
        // installed under `.ssh`) must be dropped before the config is built.
        static DIRS: &[&str] = &[
            r"C:\Users\Me\AppData\Local\Packages\PythonSoftwareFoundation.Python.3.12_abc\LocalCache\local-packages\Scripts",
            r"C:\Users\Me\AppData\Local\Packages",
            r"C:\Users\Me\.ssh",
            r"C:\Users\Me\.ssh\bin",
            r"C:\Users\Me\.sshfoo",
            r"C:\Users\Me\.cargo\bin",
            r"C:\Users\Me\AppData\Local\Programs\Python\Python312\Scripts",
        ];
        let path_var = DIRS.join(";");
        assert_eq!(
            roots(&path_var, None, fake_fs(DIRS)),
            [
                r"C:\Users\Me\.sshfoo",
                r"C:\Users\Me\.cargo\bin",
                r"C:\Users\Me\AppData\Local\Programs\Python\Python312\Scripts",
            ]
        );
        // The shell's install root is held to the same rule.
        assert_eq!(
            roots("", Some(r"C:\Users\Me\.ssh\bin"), fake_fs(DIRS)),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_base_outside_appdata_is_protected_in_both_directions() {
        let app_data = app_data();
        let found = read_roots_windows(
            &ReadRootInputs {
                profile: Path::new(PROFILE),
                app_data_roots: &app_data,
                base: Path::new(r"C:\Users\Me\tools\app"),
                path_var: concat!(
                    r"C:\Users\Me\tools;C:\Users\Me\TOOLS\app;C:\Users\Me\tools\app\bin;",
                    r"C:\Users\Me\tools\apple;C:\Users\Me\other"
                ),
                shell_root: None,
                protected: &[],
            },
            |path: &Path| Some(path.to_path_buf()),
        );
        // The container of `base`, `base` and what is inside it are refused; the sibling that
        // merely shares a name prefix and an unrelated directory are kept.
        assert_eq!(found, [r"C:\Users\Me\tools\apple", r"C:\Users\Me\other"]);
    }

    #[test]
    fn unusable_entries_are_dropped_before_the_file_system_is_asked() {
        let asked = RefCell::new(Vec::new());
        let found = roots(
            r"relative\bin;.;..;\\server\share\bin;\\?\UNC\server\share;C:rel;D;C:\Users\Me\..\..;/usr/bin;C:\Users\Me\con;C:\Users\Me\a.",
            None,
            |path| {
                asked.borrow_mut().push(path.to_path_buf());
                Some(path.to_path_buf())
            },
        );
        assert_eq!(found, Vec::<String>::new());
        // None of these is an absolute local path Windows can spell, so none reaches `canonical`
        // (a relative one would resolve against the current directory).
        assert_eq!(asked.into_inner(), Vec::<PathBuf>::new());
    }

    #[test]
    fn missing_directories_and_verbatim_answers_are_handled() {
        // A PATH entry the file system does not have is dropped; a canonical answer in verbatim
        // form is handed on in native form.
        let verbatim = |path: &Path| {
            (path.to_str()? == r"C:\Users\Me\tools").then(|| PathBuf::from(r"\\?\C:\Users\Me\tools"))
        };
        assert_eq!(
            roots(r"C:\Users\Me\tools;C:\Users\Me\gone", None, verbatim),
            [r"C:\Users\Me\tools"]
        );
    }

    #[test]
    fn a_junction_is_judged_by_where_it_points() {
        // `canonicalize` resolves a junction; the grant and the checks use the target.
        let junction = |path: &Path| {
            (path.to_str()? == r"C:\Users\Me\tools\link").then(|| PathBuf::from(r"C:\Windows\System32"))
        };
        assert_eq!(roots(r"C:\Users\Me\tools\link", None, junction), Vec::<String>::new());
        let into_profile = |path: &Path| {
            (path.to_str()? == r"C:\Program Files\link").then(|| PathBuf::from(r"C:\Users\Me\scoop\shims"))
        };
        assert_eq!(
            roots(r"C:\Program Files\link", None, into_profile),
            [r"C:\Users\Me\scoop\shims"]
        );
    }

    #[test]
    fn the_shell_install_root_is_added_last_only_inside_the_profile() {
        let path_var = r"C:\Users\Me\AppData\Local\Programs\Git;C:\Users\Me\scoop\shims";
        // Inside the profile and already on PATH: once, in PATH order.
        assert_eq!(
            roots(path_var, Some(r"C:\Users\Me\AppData\Local\Programs\Git"), fake_fs(EXISTING)),
            [r"C:\Users\Me\AppData\Local\Programs\Git", r"C:\Users\Me\scoop\shims"]
        );
        // Inside the profile and not on PATH: appended after the PATH roots.
        assert_eq!(
            roots(r"C:\Users\Me\scoop\shims", Some(r"C:\Users\Me\AppData\Local\Programs\Git"), fake_fs(EXISTING)),
            [r"C:\Users\Me\scoop\shims", r"C:\Users\Me\AppData\Local\Programs\Git"]
        );
        // Outside the profile (Program Files): readable by every account already, not a root.
        assert_eq!(
            roots("", Some(r"C:\Program Files\Git"), fake_fs(EXISTING)),
            Vec::<String>::new()
        );
    }

    fn host(shell: ShellKind, exe: &str) -> WindowsHost {
        WindowsHost {
            profile: PathBuf::from(PROFILE),
            app_data_roots: app_data(),
            path_var: r"C:\Windows\System32;C:\Users\Me\.cargo\bin".to_string(),
            shell: WindowsShell {
                kind: shell,
                exe: PathBuf::from(exe),
            },
            srt_win: PathBuf::from(r"C:\Program Files\SourceWeft\sandbox\srt-win.exe"),
        }
    }

    #[test]
    fn the_windows_init_names_one_root_the_shell_and_the_staged_helper() {
        let base = Path::new(BASE);
        let bundle = base.join("sandbox").join("current");
        let init = windows_init_config(
            &bundle,
            base,
            Path::new(r"C:\Users\Me\My Project"),
            &host(ShellKind::GitBash, r"C:\Program Files\Git\bin\bash.exe"),
            fake_fs(EXISTING),
        );
        let wire = serde_json::to_value(&init).unwrap();
        assert_eq!(wire["platform"], "win32");
        assert_eq!(wire["home"], PROFILE);
        assert_eq!(wire["workspaceRoots"], serde_json::json!([r"C:\Users\Me\My Project"]));
        assert_eq!(wire["readRoots"], serde_json::json!([r"C:\Users\Me\.cargo\bin"]));
        assert_eq!(
            wire["denyRoots"],
            serde_json::json!([
                base.join("local-host").to_string_lossy(),
                base.join("sandbox").to_string_lossy()
            ])
        );
        assert_eq!(
            wire["windows"],
            serde_json::json!({
                "srtWin": r"C:\Program Files\SourceWeft\sandbox\srt-win.exe",
                "shell": r"C:\Program Files\Git\bin\bash.exe",
            })
        );
        assert!(wire.get("bwrapPath").is_none());
        assert!(wire["helpers"].get("applySeccomp").is_none());
        assert_eq!(
            wire["helpers"]["ripgrep"],
            bundle.join(ripgrep_file_name()).to_string_lossy().as_ref()
        );
        assert_eq!(
            wire["helpers"]["javaAgentJar"],
            bundle.join("srt-proxy-agent.jar").to_string_lossy().as_ref()
        );
    }

    #[test]
    fn a_git_install_inside_the_profile_becomes_a_read_root() {
        let base = Path::new(BASE);
        let init = windows_init_config(
            &base.join("sandbox").join("current"),
            base,
            Path::new(r"C:\Users\Me\proj"),
            &host(
                ShellKind::GitBash,
                r"C:\Users\Me\AppData\Local\Programs\Git\bin\bash.exe",
            ),
            fake_fs(EXISTING),
        );
        assert_eq!(
            init.read_roots,
            [r"C:\Users\Me\.cargo\bin", r"C:\Users\Me\AppData\Local\Programs\Git"]
        );
    }
}

/// The per-root instance map, driven by the unix stub sidecar (the map is platform-neutral; only
/// Windows uses it in production).
#[cfg(all(test, unix))]
mod instance_tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    fn bundle_with_stub() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("srt-sidecar");
        fs::copy(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stub-sidecar.sh"),
            &target,
        )
        .unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
        // See sidecar.rs's test helper: avoids an observed ETXTBSY race on overlayfs.
        fs::File::open(&target).unwrap().sync_all().unwrap();
        dir
    }

    /// A stub instance for `root`, recording its requests to `<log_dir>/<name>.log`.
    fn recording_instance(
        bundle: &Path,
        log_dir: &Path,
        name: &str,
        root: &str,
    ) -> Result<SandboxInstance> {
        let home = log_dir.join(name).join("record-ops");
        fs::create_dir_all(home.parent().unwrap()).unwrap();
        let init = InitConfig {
            platform: Platform::Linux,
            home: home.to_str().unwrap().to_string(),
            workspace_roots: vec![root.to_string()],
            read_roots: vec![],
            deny_roots: vec![],
            helpers: Helpers {
                ripgrep: "/usr/bin/rg".to_string(),
                apply_seccomp: None,
                java_agent_jar: None,
            },
            bwrap_path: None,
            windows: None,
        };
        let sidecar = Sidecar::start_with_timeout(bundle, &init, Duration::from_secs(5))?;
        Ok(SandboxInstance::new(sidecar, vec![PathBuf::from(root)]))
    }

    fn requests(log_dir: &Path, name: &str, op: &str) -> usize {
        fs::read_to_string(log_dir.join(name).join("record-ops.log"))
            .unwrap_or_default()
            .lines()
            .filter(|line| line.split(' ').next() == Some(op))
            .count()
    }

    struct Fixture {
        bundle: tempfile::TempDir,
        logs: tempfile::TempDir,
        starts: AtomicUsize,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                bundle: bundle_with_stub(),
                logs: tempfile::tempdir().unwrap(),
                starts: AtomicUsize::new(0),
            }
        }

        /// A `start` closure for `root`; the n-th start of the same root logs as `<name>-<n>`.
        fn start<'a>(&'a self, name: &'a str, root: &'a str) -> impl FnMut() -> Result<SandboxInstance> + 'a {
            move || {
                let n = self.starts.fetch_add(1, Ordering::SeqCst);
                recording_instance(self.bundle.path(), self.logs.path(), &format!("{name}-{n}"), root)
            }
        }

        fn started(&self) -> usize {
            self.starts.load(Ordering::SeqCst)
        }
    }

    fn kinds(seen: &RefCell<Vec<Option<ShellKind>>>) -> Vec<Option<ShellKind>> {
        seen.borrow().clone()
    }

    use std::cell::RefCell;

    fn plain(_: &SandboxInstance) -> Result<String> {
        Ok("echo hi".to_string())
    }

    fn wrap(
        instances: &SandboxInstances,
        root: &str,
        script_for: &dyn Fn(&SandboxInstance) -> Result<String>,
        start: impl FnMut() -> Result<SandboxInstance>,
    ) -> Result<(Arc<SandboxInstance>, WrappedCommand)> {
        wrap_in_instances(instances, Path::new(root), Path::new(root), "id", None, script_for, start)
    }

    #[test]
    fn an_instance_is_reused_for_its_root() {
        let fixture = Fixture::new();
        let instances = SandboxInstances::default();
        let (first, wrapped) = wrap(&instances, "/w/a", &plain, fixture.start("a", "/w/a")).unwrap();
        assert_eq!(wrapped.argv, ["/bin/echo", "hi"]);
        first.finish("id");
        let (second, _) = wrap(&instances, "/w/a", &plain, fixture.start("a", "/w/a")).unwrap();
        second.finish("id");
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(fixture.started(), 1);
    }

    #[test]
    fn each_root_has_its_own_instance_with_exactly_one_workspace_root() {
        let fixture = Fixture::new();
        let instances = SandboxInstances::default();
        let (a, _) = wrap(&instances, "/w/a", &plain, fixture.start("a", "/w/a")).unwrap();
        let (b, _) = wrap(&instances, "/w/b", &plain, fixture.start("b", "/w/b")).unwrap();
        assert!(!Arc::ptr_eq(&a, &b));
        assert_eq!(fixture.started(), 2);
        assert_eq!(a.workspace_roots, [PathBuf::from("/w/a")]);
        assert_eq!(b.workspace_roots, [PathBuf::from("/w/b")]);
        // A root nested in another root is a different workspace: no sharing by prefix.
        let (nested, _) = wrap(&instances, "/w/a/sub", &plain, fixture.start("n", "/w/a/sub")).unwrap();
        assert!(!Arc::ptr_eq(&a, &nested));
        for instance in [&a, &b, &nested] {
            instance.finish("id");
        }
    }

    #[test]
    fn at_capacity_the_least_recently_used_idle_instance_is_evicted() {
        let fixture = Fixture::new();
        let instances = SandboxInstances::with_capacity(2);
        for root in ["/w/a", "/w/b"] {
            let (instance, _) = wrap(&instances, root, &plain, fixture.start(&root[3..], root)).unwrap();
            instance.finish("id");
        }
        // Touch `a`, so `b` is now the least recently used.
        let (a, _) = wrap(&instances, "/w/a", &plain, fixture.start("a2", "/w/a")).unwrap();
        a.finish("id");
        drop(a);
        let (c, _) = wrap(&instances, "/w/c", &plain, fixture.start("c", "/w/c")).unwrap();
        c.finish("id");
        drop(c);
        // `b` (start #1) was shut down; `a` (start #0) was not.
        assert_eq!(requests(fixture.logs.path(), "b-1", "shutdown"), 1);
        assert_eq!(requests(fixture.logs.path(), "a-0", "shutdown"), 0);
        assert_eq!(fixture.started(), 3);
        let table = lock(&instances.table);
        let mut live: Vec<_> = table.entries.iter().map(|e| e.root.to_str().unwrap().to_string()).collect();
        live.sort();
        assert_eq!(live, ["/w/a", "/w/c"]);
    }

    #[test]
    fn when_every_instance_is_running_a_command_the_new_root_is_refused_without_starting() {
        let fixture = Fixture::new();
        let instances = SandboxInstances::with_capacity(2);
        let (a, _) = wrap(&instances, "/w/a", &plain, fixture.start("a", "/w/a")).unwrap();
        let (b, _) = wrap(&instances, "/w/b", &plain, fixture.start("b", "/w/b")).unwrap();
        let refused = wrap(&instances, "/w/c", &plain, fixture.start("c", "/w/c"))
            .err()
            .expect("all busy");
        assert_eq!(refused.code, "SANDBOX_BUSY");
        assert_eq!(
            refused.message,
            "Too many workspaces are running commands at once; wait for one to finish."
        );
        assert_eq!(fixture.started(), 2, "no sidecar may be started just to be refused");
        // The busy ones still work.
        let (a_again, _) = wrap(&instances, "/w/a", &plain, fixture.start("a", "/w/a")).unwrap();
        assert!(Arc::ptr_eq(&a, &a_again));
        a_again.finish("id");
        drop(a_again);
        // One finishes: its slot is available again.
        a.finish("id");
        drop(a);
        let (c, _) = wrap(&instances, "/w/c", &plain, fixture.start("c", "/w/c")).unwrap();
        c.finish("id");
        b.finish("id");
        assert_eq!(fixture.started(), 3);
    }

    #[test]
    fn a_dead_instance_is_replaced_once_for_its_own_root_only() {
        let fixture = Fixture::new();
        let instances = SandboxInstances::default();
        let (b, _) = wrap(&instances, "/w/b", &plain, fixture.start("b", "/w/b")).unwrap();
        b.finish("id");
        let failing = |_: &SandboxInstance| Ok("ERROR:SANDBOX_UNAVAILABLE".to_string());
        let error = wrap(&instances, "/w/a", &failing, fixture.start("a", "/w/a"))
            .err()
            .expect("a wrap that keeps failing must not succeed");
        assert_eq!(error.code, "SANDBOX_UNAVAILABLE");
        // `b` once, `a` twice (first start + exactly one replacement).
        assert_eq!(fixture.started(), 3);
        // The poisoned first `a` (start #1) was shut down by the replacement.
        assert_eq!(requests(fixture.logs.path(), "a-1", "shutdown"), 1);
        // `b` was never touched: same instance, no shutdown.
        let (b_again, _) = wrap(&instances, "/w/b", &plain, fixture.start("b", "/w/b")).unwrap();
        assert!(Arc::ptr_eq(&b, &b_again));
        b_again.finish("id");
        assert_eq!(requests(fixture.logs.path(), "b-0", "shutdown"), 0);
        assert_eq!(fixture.started(), 3);
    }

    #[test]
    fn a_replacement_made_by_another_command_is_used_instead_of_starting_a_third() {
        let fixture = Fixture::new();
        let instances = SandboxInstances::default();
        let (first, _) = wrap(&instances, "/w/a", &plain, fixture.start("a", "/w/a")).unwrap();
        first.finish("id");
        // Another command replaces it ...
        let other = instances
            .replace(Path::new("/w/a"), first.clone(), &mut fixture.start("a", "/w/a"))
            .unwrap();
        assert_eq!(fixture.started(), 2);
        // ... and ours, which also saw `first` fail, finds the replacement.
        let ours = instances
            .replace(Path::new("/w/a"), first, &mut fixture.start("a", "/w/a"))
            .unwrap();
        assert!(Arc::ptr_eq(&other, &ours));
        assert_eq!(fixture.started(), 2);
    }

    #[test]
    fn the_script_is_built_for_the_instance_that_wraps_it() {
        let fixture = Fixture::new();
        let instances = SandboxInstances::default();
        let seen = RefCell::new(Vec::new());
        let script_for = |instance: &SandboxInstance| {
            seen.borrow_mut().push(instance.shell);
            Ok("ERROR:SANDBOX_UNAVAILABLE".to_string())
        };
        let mut shells = [ShellKind::GitBash, ShellKind::PowerShell].into_iter();
        let mut start = || {
            let n = fixture.starts.fetch_add(1, Ordering::SeqCst);
            Ok(recording_instance(fixture.bundle.path(), fixture.logs.path(), &format!("a-{n}"), "/w/a")?
                .with_shell(shells.next().unwrap()))
        };
        let _ = wrap(&instances, "/w/a", &script_for, &mut start);
        // The first attempt used the first instance's shell, the retry the replacement's.
        assert_eq!(
            kinds(&seen),
            [Some(ShellKind::GitBash), Some(ShellKind::PowerShell)]
        );
    }

    #[test]
    fn stopping_clears_every_instance_and_the_next_command_starts_fresh() {
        let fixture = Fixture::new();
        let instances = SandboxInstances::default();
        for root in ["/w/a", "/w/b"] {
            let (instance, _) = wrap(&instances, root, &plain, fixture.start(&root[3..], root)).unwrap();
            instance.finish("id");
        }
        instances.stop_all();
        instances.stop_all(); // idempotent
        assert!(lock(&instances.table).entries.is_empty());
        assert_eq!(requests(fixture.logs.path(), "a-0", "shutdown"), 1);
        assert_eq!(requests(fixture.logs.path(), "b-1", "shutdown"), 1);
        let (again, _) = wrap(&instances, "/w/a", &plain, fixture.start("a", "/w/a")).unwrap();
        again.finish("id");
        assert_eq!(fixture.started(), 3);
    }

    #[test]
    fn a_running_command_keeps_its_instance_alive_through_stop() {
        let fixture = Fixture::new();
        let instances = SandboxInstances::default();
        let (running, _) = wrap(&instances, "/w/a", &plain, fixture.start("a", "/w/a")).unwrap();
        instances.stop_all();
        assert_eq!(requests(fixture.logs.path(), "a-0", "shutdown"), 0, "still in use");
        running.finish("id");
        drop(running);
        assert_eq!(requests(fixture.logs.path(), "a-0", "shutdown"), 1);
    }

    #[test]
    fn a_failed_start_is_returned_and_leaves_no_trace() {
        let instances = SandboxInstances::with_capacity(1);
        let error = wrap(&instances, "/w/a", &plain, || Err(HostError::new("HELPER_MISSING", "stub")))
            .err()
            .unwrap();
        assert_eq!(error.code, "HELPER_MISSING");
        assert!(lock(&instances.table).entries.is_empty());
        // The failed start did not keep its capacity reservation.
        let fixture = Fixture::new();
        let (instance, _) = wrap(&instances, "/w/b", &plain, fixture.start("b", "/w/b")).unwrap();
        instance.finish("id");
    }

    #[test]
    fn starting_one_root_never_blocks_another_and_two_commands_on_a_new_root_start_one_sidecar() {
        let fixture = Arc::new(Fixture::new());
        let instances = Arc::new(SandboxInstances::with_capacity(2));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let slow = {
            let (fixture, instances) = (fixture.clone(), instances.clone());
            std::thread::spawn(move || {
                let release_rx = release_rx;
                let mut start = || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap(); // held "starting" until the test lets go
                    let n = fixture.starts.fetch_add(1, Ordering::SeqCst);
                    recording_instance(fixture.bundle.path(), fixture.logs.path(), &format!("a-{n}"), "/w/a")
                };
                instances.instance(Path::new("/w/a"), &mut start).map(|_| ())
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(5)).expect("A started");
        // A is mid-start: B must complete regardless.
        let b = wrap(&instances, "/w/b", &plain, fixture.start("b", "/w/b")).unwrap().0;
        // The reservation for A counts: with B running, the two-slot table is full and a third
        // root is refused rather than overshooting the capacity.
        let refused = wrap(&instances, "/w/c", &plain, fixture.start("c", "/w/c")).err().unwrap();
        assert_eq!(refused.code, "SANDBOX_BUSY");
        // A second command on A waits for A's gate and then shares A's sidecar.
        let waiter = {
            let (fixture, instances) = (fixture.clone(), instances.clone());
            std::thread::spawn(move || {
                instances
                    .instance(Path::new("/w/a"), &mut fixture.start("a-dup", "/w/a"))
                    .map(|_| ())
            })
        };
        std::thread::sleep(Duration::from_millis(100));
        release_tx.send(()).unwrap();
        slow.join().unwrap().unwrap();
        waiter.join().unwrap().unwrap();
        b.finish("id");
        assert_eq!(fixture.started(), 2, "exactly one sidecar for A and one for B");
    }
}
