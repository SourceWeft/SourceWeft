//! Local command execution on Linux and macOS through the sandbox sidecar (`srt-sidecar`, which
//! wraps each command with sandbox-runtime: bubblewrap on Linux, Seatbelt on macOS). Produces
//! the result shape `{"output","exitCode","truncated","cancelled"}`.
//!
//! The module also compiles on Windows, where only the platform-neutral parts exist so far
//! (the slot, the restart policy, `init_config`); the POSIX toolchain/read-root/shell pieces are
//! unix-only and `execute_command` fails closed until per-workspace instances land (Task 6).
//!
//! One sidecar is kept per `LocalHost`, started lazily from `readiness::bundle_dir`. Its `init`
//! lists `<base>/task-workspaces` plus every currently granted directory as the workspace roots
//! a wrap may name; each `wrap` grants read and write access to exactly that command's workspace
//! root (plus read access to the toolchain read roots and the in-sandbox helper files). The
//! sidecar's policy denies reading `/` on both Linux and macOS and re-allows only its per-platform
//! system read set on top of those (`sandbox-sidecar/src/policy.ts`,
//! `LINUX_SYSTEM_READ_ROOTS` / `DARWIN_SYSTEM_READ_ROOTS`). Nothing here ever runs
//! a command without an argv the sidecar wrapped: a missing bundle, a failed start, or a wrap
//! that still fails after one restart is returned as an error.
// Windows has no caller yet for most of this module (Task 6 wires the Windows instances).
#![cfg_attr(windows, allow(dead_code, unused_imports))]
#[cfg(unix)]
use super::readiness::user_path;
use super::{
    readiness::{bundle_dir, Helpers, InitConfig, Platform},
    sidecar::{ripgrep_file_name, sidecar_file_name, Sidecar, WrappedCommand},
    HostError, LocalHost, Result,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::AtomicBool, Arc, Mutex},
};

/// The production bubblewrap, installed with its own scoped AppArmor profile. `/usr/bin/bwrap`
/// is never used or loosened.
pub(crate) const BWRAP_PATH: &str = "/opt/sourceweft/libexec/bwrap";

/// One running sidecar and the workspace roots its `init` was given.
pub(crate) struct SandboxInstance {
    sidecar: Sidecar,
    workspace_roots: Vec<PathBuf>,
}

/// `LocalHost::sandbox`: the current sidecar, if one has been started. An instance that failed
/// with `SANDBOX_UNAVAILABLE` is replaced; commands still running under it keep it alive
/// through their own `Arc` until they finish.
pub(crate) type SandboxSlot = Mutex<Option<Arc<SandboxInstance>>>;

impl SandboxInstance {
    fn new(sidecar: Sidecar, workspace_roots: Vec<PathBuf>) -> Self {
        Self {
            sidecar,
            workspace_roots,
        }
    }

    fn covers(&self, root: &Path) -> bool {
        self.workspace_roots
            .iter()
            .any(|allowed| root.starts_with(allowed))
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

/// The platform this build runs the sidecar for. One explicit definition per supported target:
/// no target silently maps to another platform's policy.
#[cfg(target_os = "macos")]
pub(crate) const HOST_PLATFORM: Platform = Platform::Darwin;
#[cfg(target_os = "linux")]
pub(crate) const HOST_PLATFORM: Platform = Platform::Linux;
#[cfg(windows)]
pub(crate) const HOST_PLATFORM: Platform = Platform::Windows;

/// The `InitConfig` for a sidecar of `platform` whose helpers live in `bundle`, for a host whose
/// app data is `base`. `<base>/local-host` (the host database) and `<base>/sandbox` (the
/// runtime bundles) are denied explicitly, independent of whether `base` lies under `$HOME`.
///
/// Linux gets the production bubblewrap and the seccomp helper; macOS has neither (Seatbelt
/// needs no helper binary), so its bundle holds only the sidecar, ripgrep and the proxy agent jar.
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
        // Task 6: the Windows host supplies `windows: Some(WindowsInit { srt_win, shell })` once
        // the staged `srt-win.exe` and the shell are detected. Until then a Windows `init` goes
        // out without it and the sidecar refuses it (`POLICY_INVALID`): nothing runs.
        windows: None,
    }
}

/// The user's home directory as the sidecar's `home` (the base of its credential-path denies).
/// Empty when the platform's variable is unset, as before.
#[cfg(unix)]
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// Windows has no `HOME`; the profile directory is `USERPROFILE`.
// Task 4: the Windows wire path form (forward-slash drive paths) is applied here.
#[cfg(windows)]
fn home_dir() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}

/// The toolchain directories the sandbox must be able to read, per platform (see `read_roots` and
/// `darwin_read_roots`).
#[cfg(unix)]
fn platform_read_roots(platform: Platform, home: &str, base: &Path) -> Vec<String> {
    match platform {
        Platform::Darwin => darwin_read_roots(Path::new(home), base, &user_path().0, XCODE_SELECT),
        Platform::Linux => read_roots(Path::new(home), base, &user_path().0),
        // A Windows `InitConfig` is never built on a unix host; its read roots are decided where
        // the Windows host runs (Task 6).
        Platform::Windows => Vec::new(),
    }
}

/// Task 6: Windows read roots are exactly the `PATH` directories inside the profile (plus the
/// shell's install root), computed there. Empty until then.
#[cfg(windows)]
fn platform_read_roots(_platform: Platform, _home: &str, _base: &Path) -> Vec<String> {
    Vec::new()
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

fn lock_slot(slot: &SandboxSlot) -> std::sync::MutexGuard<'_, Option<Arc<SandboxInstance>>> {
    // The slot holds only an `Option<Arc<_>>`; nothing half-written can be observed after a
    // panic elsewhere, so recover instead of failing every later command.
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// Drops the current sidecar (the process exits once the last command still using it is done)
/// so the next command starts one from the files now on disk; used when the runtime is replaced.
pub(crate) fn stop_sidecar(slot: &SandboxSlot) {
    // Dropping the last reference shuts the sidecar down, which can take seconds: do it after
    // the slot lock is released, so commands starting meanwhile are not blocked behind it.
    let old = lock_slot(slot).take();
    drop(old);
}

/// Wraps one attempt on `instance`. A failed wrap is never followed by a cleanup: srt has
/// already undone its own count for it.
fn try_wrap(
    instance: &SandboxInstance,
    command_id: &str,
    script: &str,
    cwd: &Path,
    root: &Path,
) -> Result<WrappedCommand> {
    let wrapped = instance.sidecar.wrap(command_id, script, cwd, root)?;
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
fn wrap_in_sandbox(
    slot: &SandboxSlot,
    root: &Path,
    cwd: &Path,
    script: &str,
    command_id: &str,
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
    match try_wrap(&instance, command_id, script, cwd, root) {
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
            let wrapped = try_wrap(&replacement, command_id, script, cwd, root)?;
            Ok((replacement, wrapped))
        }
        Err(error) => Err(error),
    }
}

/// Starts a sidecar from this host's installed bundle, with `init.workspaceRoots` set to the
/// automatic workspace base plus every currently granted directory.
fn start_instance(host: &LocalHost) -> Result<SandboxInstance> {
    let bundle = bundle_dir(&host.base);
    if !bundle.join(sidecar_file_name()).is_file() {
        return Err(HostError::new(
            "SANDBOX_UNAVAILABLE",
            "Sandbox runtime is not installed",
        ));
    }
    // Task 6: a Windows host starts one instance per workspace root (`init` with exactly one
    // workspace root, the staged `srt-win.exe` and the detected shell). Until then no Windows
    // sidecar is started for commands.
    #[cfg(windows)]
    return Err(HostError::new(
        "UNSUPPORTED_PLATFORM",
        "Local command execution is not available on Windows yet.",
    ));
    #[cfg(unix)]
    {
        let roots = host.sandbox_workspace_roots()?;
        let names = roots
            .iter()
            .map(|root| {
                root.to_str().map(str::to_string).ok_or_else(|| {
                    HostError::new("INVALID_PATH", format!("path is not valid UTF-8: {root:?}"))
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let sidecar = Sidecar::start(
            &bundle,
            &init_config(HOST_PLATFORM, &bundle, &host.base, names),
        )?;
        Ok(SandboxInstance::new(sidecar, roots))
    }
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

#[cfg(unix)]
/// Runs `script` under `/bin/sh`-compatible wrapping in `cwd` (inside `root`), with write access
/// to `root` only, and returns the JSON shape the backend expects
/// (`{"output","exitCode","truncated","cancelled"}`).
pub(crate) fn execute_command(
    host: &LocalHost,
    root: &Path,
    cwd: &Path,
    script: &str,
    timeout_ms: u64,
    max_chars: usize,
    cancel: Arc<AtomicBool>,
) -> Result<Value> {
    prepare_tmpdir(root)?;
    let command_id = new_command_id();
    let script = pinned_script(root, script);
    let (instance, wrapped) =
        match wrap_in_sandbox(&host.sandbox, root, cwd, &script, &command_id, || {
            start_instance(host)
        }) {
            Ok(found) => found,
            Err(error) => {
                if matches!(
                    error.code,
                    "SANDBOX_UNAVAILABLE" | "HELPER_MISSING" | "BUNDLE_STALE" | "BUNDLE_NEWER"
                ) {
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
    let run = super::process::run_wrapped(&wrapped.argv, &env, cwd, timeout_ms, max_chars, cancel);
    let result = run.map(|run| {
        let stderr = String::from_utf8_lossy(&run.stderr).into_owned();
        let stderr = match instance.sidecar.violations(&command_id, &stderr) {
            Ok(annotated) => annotated,
            // The command already ran; report its real output and say why the sandbox's own
            // annotation is missing rather than dropping either.
            Err(error) => format!(
                "{stderr}\n[sandbox violation report unavailable: {}]",
                error.message
            ),
        };
        let output = format!("{}{}", String::from_utf8_lossy(&run.stdout), stderr);
        json!({
            "output": output.chars().take(max_chars).collect::<String>(),
            "exitCode": run.exit_code,
            "truncated": run.truncated || output.chars().count() > max_chars,
            "cancelled": run.cancelled,
        })
    });
    instance.finish(&command_id);
    result
}

/// Task 6: Windows command execution (per-workspace instances, shell prelude, Windows child
/// environment) replaces this. Until then it fails closed: nothing runs, and the caller sees why.
#[cfg(windows)]
pub(crate) fn execute_command(
    _host: &LocalHost,
    _root: &Path,
    _cwd: &Path,
    _script: &str,
    _timeout_ms: u64,
    _max_chars: usize,
    _cancel: Arc<AtomicBool>,
) -> Result<Value> {
    Err(HostError::new(
        "UNSUPPORTED_PLATFORM",
        "Local command execution is not available on Windows yet.",
    ))
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
        let (first, _) = wrap_in_sandbox(&slot, w, w, "echo a", "cmd-a", start).unwrap();
        let (second, _) = wrap_in_sandbox(&slot, w, w, "echo b", "cmd-b", start).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        let failed = wrap_in_sandbox(&slot, w, w, "ERROR:POLICY_INVALID", "cmd-c", start)
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
}
