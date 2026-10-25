//! Local command execution on Linux and macOS through the sandbox sidecar (`srt-sidecar`, which
//! wraps each command with sandbox-runtime: bubblewrap on Linux, Seatbelt on macOS). Produces
//! the result shape `{"output","exitCode","truncated","cancelled"}`.
//!
//! One sidecar is kept per `LocalHost`, started lazily from `readiness::bundle_dir`. Its `init`
//! lists `<base>/task-workspaces` plus every currently granted directory as the workspace roots
//! a wrap may name; each `wrap` grants read and write access to exactly that command's workspace
//! root (plus read access to the toolchain read roots and the in-sandbox helper files). The
//! sidecar's Linux policy denies reading `/` and re-allows only its system read set on top of
//! those (`sandbox-sidecar/src/policy.ts`, Ruling R24). Nothing here ever runs
//! a command without an argv the sidecar wrapped: a missing bundle, a failed start, or a wrap
//! that still fails after one restart is returned as an error.
use super::{
    readiness::{bundle_dir, user_path, Helpers, InitConfig, Platform},
    sidecar::{Sidecar, WrappedCommand},
    HostError, LocalHost, Result,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
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

/// The platform this build runs the sidecar for.
pub(crate) const HOST_PLATFORM: Platform = if cfg!(target_os = "macos") {
    Platform::Darwin
} else {
    Platform::Linux
};

/// The `InitConfig` for a sidecar of `platform` whose helpers live in `bundle`, for a host whose
/// app data is `base`. `<base>/local-host` (the host database) and `<base>/sandbox` (the
/// runtime bundles) are denied explicitly, independent of whether `base` lies under `$HOME`.
///
/// Linux gets the production bubblewrap and the seccomp helper; macOS has neither (Seatbelt
/// needs no helper binary), so its bundle holds only the sidecar, ripgrep and the proxy agent.
pub(crate) fn init_config(
    platform: Platform,
    bundle: &Path,
    base: &Path,
    workspace_roots: Vec<String>,
) -> InitConfig {
    let home = std::env::var("HOME").unwrap_or_default();
    let linux = platform == Platform::Linux;
    InitConfig {
        platform,
        read_roots: read_roots(Path::new(&home), base, &user_path().0),
        deny_roots: [base.join("local-host"), base.join("sandbox")]
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        home,
        workspace_roots,
        helpers: Helpers {
            ripgrep: bundle.join("rg").to_string_lossy().into_owned(),
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
            || canonical_home.starts_with(&canonical)
            || canonical == canonical_local
            || canonical.starts_with(&canonical_base)
            || canonical_base.starts_with(&canonical)
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
    if !bundle.join("srt-sidecar").is_file() {
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
    let sidecar = Sidecar::start(
        &bundle,
        &init_config(HOST_PLATFORM, &bundle, &host.base, names),
    )?;
    Ok(SandboxInstance::new(sidecar, roots))
}

/// The wrapped command's environment with the pinned toolchain, home, temp and cache locations
/// laid over it. The pinned values win over anything the sidecar's own environment supplied.
fn child_env(root: &Path, wrapped: Vec<(String, String)>) -> Vec<(String, String)> {
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
    env.into_iter().collect()
}

/// Single-quotes `value` for a POSIX shell.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `script` with `TMPDIR` pinned from inside the sandbox. srt's bwrap argv sets
/// `--setenv TMPDIR /tmp/claude` for every command, which overrides the value inherited from
/// `child_env`, so the workspace `TMPDIR` is re-exported as the first line the sandboxed shell
/// runs. A newline-separated prefix leaves any valid script unchanged.
fn pinned_script(root: &Path, script: &str) -> String {
    let tmpdir = format!("{}/.tmp", root.to_string_lossy());
    format!("export TMPDIR={}\n{script}", shell_quote(&tmpdir))
}

/// Creates `<root>/.tmp` (one level, never following a symlink at that name) so `TMPDIR`
/// exists before the command runs.
fn prepare_tmpdir(root: &Path) -> Result<()> {
    match std::fs::create_dir(root.join(".tmp")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Runs `script` under `/bin/sh`-compatible wrapping in `cwd` (inside `root`), with write access
/// to `root` only, and returns the same JSON shape as macOS.
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
                if matches!(error.code, "SANDBOX_UNAVAILABLE" | "HELPER_MISSING") {
                    host.invalidate_sandbox_readiness();
                }
                return Err(error);
            }
        };
    let env = child_env(root, wrapped.env);
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

#[cfg(test)]
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
