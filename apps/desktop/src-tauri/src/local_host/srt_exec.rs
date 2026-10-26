//! Linux local command execution through the sandbox sidecar (`srt-sidecar`, which wraps each
//! command with sandbox-runtime and bubblewrap). Produces exactly the macOS
//! `execute_command` result shape: `{"output","exitCode","truncated","cancelled"}`.
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
    network::{ActiveCommand, Decision, NetworkMode, NetworkPolicy},
    readiness::{bundle_dir, user_path, Helpers, InitConfig, Platform},
    sidecar::{EventHandler, Sidecar, SidecarEvent, TlsInit, WrapSecret, WrappedCommand},
    vault::VaultEntry,
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

/// One running sidecar, the workspace roots its `init` was given, and whether it was started
/// with TLS termination (`init.tls`), which it is only while the device vault holds secrets.
pub(crate) struct SandboxInstance {
    sidecar: Sidecar,
    workspace_roots: Vec<PathBuf>,
    tls: bool,
}

/// `LocalHost::sandbox`: the current sidecar, if one has been started. An instance that failed
/// with `SANDBOX_UNAVAILABLE` is replaced; commands still running under it keep it alive
/// through their own `Arc` until they finish.
pub(crate) type SandboxSlot = Mutex<Option<Arc<SandboxInstance>>>;

impl SandboxInstance {
    fn new(sidecar: Sidecar, workspace_roots: Vec<PathBuf>, tls: bool) -> Self {
        Self {
            sidecar,
            workspace_roots,
            tls,
        }
    }

    /// Whether this instance can wrap a command in `root` that needs TLS termination iff `tls`.
    /// A mismatch in either direction means a new sidecar: with an empty vault the sidecar must
    /// run exactly as without secrets (no interception), and secrets need a terminating one.
    fn covers(&self, root: &Path, tls: bool) -> bool {
        self.tls == tls
            && self
                .workspace_roots
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

/// The `InitConfig` for a Linux sidecar whose helpers live in `bundle`, for a host whose app
/// data is `base`. `<base>/local-host` (the host database) and `<base>/sandbox` (the runtime
/// bundles) are denied explicitly, independent of whether `base` lies under `$HOME`.
pub(crate) fn init_config(
    bundle: &Path,
    base: &Path,
    workspace_roots: Vec<String>,
    tls: bool,
) -> InitConfig {
    let home = std::env::var("HOME").unwrap_or_default();
    InitConfig {
        platform: Platform::Linux,
        read_roots: read_roots(Path::new(&home), base, &user_path().0),
        deny_roots: [base.join("local-host"), base.join("sandbox")]
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        home,
        workspace_roots,
        helpers: Helpers {
            ripgrep: bundle.join("rg").to_string_lossy().into_owned(),
            apply_seccomp: Some(bundle.join("apply-seccomp").to_string_lossy().into_owned()),
            java_agent_jar: Some(
                bundle
                    .join("srt-proxy-agent.jar")
                    .to_string_lossy()
                    .into_owned(),
            ),
        },
        bwrap_path: Some(BWRAP_PATH.to_string()),
        // `<base>/sandbox` is already a deny root, so the CA key is unreadable inside.
        tls: tls.then(|| TlsInit {
            ca_dir: base.join("sandbox").join("ca").to_string_lossy().into_owned(),
        }),
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
    network: Option<&NetworkPolicy>,
    secrets: &[WrapSecret],
) -> Result<WrappedCommand> {
    let wrapped = instance
        .sidecar
        .wrap(command_id, script, cwd, root, network, secrets)?;
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
///   started), or it was started with the other TLS setting than this command needs (`tls`:
///   the vault became non-empty or empty): start a new one with the current roots and the
///   right setting, once, then wrap;
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
    network: Option<&NetworkPolicy>,
    secrets: &[WrapSecret],
    tls: bool,
    mut start: impl FnMut(bool) -> Result<SandboxInstance>,
) -> Result<(Arc<SandboxInstance>, WrappedCommand)> {
    let instance = {
        let mut current = lock_slot(slot);
        match current.as_ref() {
            Some(existing) if existing.covers(root, tls) => existing.clone(),
            _ => {
                let fresh = Arc::new(start(tls)?);
                *current = Some(fresh.clone());
                fresh
            }
        }
    };
    match try_wrap(&instance, command_id, script, cwd, root, network, secrets) {
        Ok(wrapped) => Ok((instance, wrapped)),
        Err(error) if error.code == "SANDBOX_UNAVAILABLE" => {
            let replacement = {
                let mut current = lock_slot(slot);
                match current.as_ref() {
                    // Another command already replaced the dead instance: use its replacement.
                    Some(other) if !Arc::ptr_eq(other, &instance) && other.covers(root, tls) => {
                        other.clone()
                    }
                    _ => {
                        *current = None;
                        let fresh = Arc::new(start(tls)?);
                        *current = Some(fresh.clone());
                        fresh
                    }
                }
            };
            drop(instance);
            let wrapped = try_wrap(&replacement, command_id, script, cwd, root, network, secrets)?;
            Ok((replacement, wrapped))
        }
        Err(error) => Err(error),
    }
}

/// Starts a sidecar from this host's installed bundle, with `init.workspaceRoots` set to the
/// automatic workspace base plus every currently granted directory, and `init.tls` iff `tls`.
fn start_instance(host: &LocalHost, tls: bool) -> Result<SandboxInstance> {
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
    // Every instance — including one that replaces a poisoned predecessor — is built here, so
    // every sidecar answers its network asks through the host's bridge.
    let sidecar = Sidecar::start_with_events(
        &bundle,
        &init_config(&bundle, &host.base, names, tls),
        event_handler(host.network.clone()),
    )?;
    Ok(SandboxInstance::new(sidecar, roots, tls))
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

/// Names `child_env` pins for every command; a secret's placeholder may never replace them.
const PINNED_ENV: [&str; 6] = [
    "PATH",
    "HOME",
    "TMPDIR",
    "npm_config_cache",
    "PIP_CACHE_DIR",
    "NODE_USE_ENV_PROXY",
];

/// The wrapped command's environment: the sidecar's, then the secrets' placeholders
/// (`secret_env`), then the pinned toolchain, home, temp and cache locations laid over both. The
/// pinned values win over anything the sidecar supplied, and a placeholder never takes the place
/// of a pinned name (the vault refuses such names, this is the second lock).
fn child_env(
    root: &Path,
    wrapped: Vec<(String, String)>,
    secret_env: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let root_text = root.to_string_lossy();
    let mut env: BTreeMap<String, String> = wrapped.into_iter().collect();
    for (name, placeholder) in secret_env {
        if !PINNED_ENV.contains(&name.as_str()) {
            env.insert(name, placeholder);
        }
    }
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

/// The most `network.allow` entries the sidecar accepts for one command.
const MAX_ALLOW_ENTRIES: usize = 500;

/// The one line appended to a command's stderr (and returned as `vaultWarning`) when the vault
/// could not be read. It names a short reason, never a label or a value.
fn vault_warning_line(error: &HostError) -> String {
    let reason = match error.code {
        "VAULT_VALUE_MISSING" => "a stored secret is missing from the keychain".to_string(),
        _ => {
            let text: String = error
                .message
                .chars()
                .filter(|c| !c.is_control())
                .take(120)
                .collect();
            if text.is_empty() {
                "the keychain is unavailable".to_string()
            } else {
                text
            }
        }
    };
    format!("[sandbox vault unavailable: {reason}; stored secrets were not available to this command]")
}

/// `network` with the vault's hosts added to its allow list (decision S7: the user bound the
/// secret to those hosts, so reaching them is implicitly allowed). `open` (or no policy) already
/// allows everything and is returned unchanged.
fn with_vault_hosts(
    network: Option<&NetworkPolicy>,
    entries: &[VaultEntry],
) -> Option<NetworkPolicy> {
    let mut policy = network?.clone();
    if policy.mode == NetworkMode::Open {
        return Some(policy);
    }
    let mut vault_hosts: Vec<String> = Vec::new();
    for host in entries.iter().flat_map(|entry| entry.meta.hosts.iter()) {
        let host = host.to_ascii_lowercase();
        if !vault_hosts.contains(&host) {
            vault_hosts.push(host);
        }
    }
    // The rest of the list, de-duplicated case-insensitively and without the vault's own hosts
    // (they are appended below), in its original order.
    let mut others: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = vault_hosts.iter().cloned().collect();
    for host in std::mem::take(&mut policy.allow) {
        if seen.insert(host.to_ascii_lowercase()) {
            others.push(host);
        }
    }
    // The sidecar rejects more than MAX_ALLOW_ENTRIES entries, and it would do so for every
    // command. Vault hosts win: trailing non-vault entries are dropped to fit.
    let room = MAX_ALLOW_ENTRIES.saturating_sub(vault_hosts.len());
    if others.len() > room {
        static LOGGED: AtomicBool = AtomicBool::new(false);
        if !LOGGED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            eprintln!(
                "sourceweft-desktop: the network allow list plus the vault's hosts exceeds {MAX_ALLOW_ENTRIES} entries; dropping {} trailing non-vault entries (logged once)",
                others.len() - room
            );
        }
        others.truncate(room);
    }
    others.extend(vault_hosts);
    policy.allow = others;
    Some(policy)
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
/// to `root` only, and returns the macOS JSON shape plus `networkAudit` (the sidecar's recorded
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
    // The vault's secrets for this command: all of them (a command cannot know which it will
    // use). Reading the keychain only happens when the vault has rows.
    // A locked or unavailable keychain, or one missing item, must not stop every command: the
    // command runs without secrets (none passed, vault hosts not merged, no TLS termination)
    // and says so. Any other failure (the host database) still fails the command.
    let (entries, vault_warning) = match host.vault_entries() {
        Ok(entries) => (entries, None),
        Err(error) if error.code.starts_with("VAULT_") => {
            (Vec::new(), Some(vault_warning_line(&error)))
        }
        Err(error) => return Err(error),
    };
    let tls = !entries.is_empty();
    let policy = with_vault_hosts(network, &entries);
    let network = if tls { policy.as_ref() } else { network };
    let command_id = new_command_id();
    // Before `wrap`: the sidecar's first ask can follow the wrap reply immediately, and the
    // bridge only attributes asks that name this command.
    active.set_command_id(&command_id);
    let script = pinned_script(root, script);
    let wire: Vec<WrapSecret> = entries
        .iter()
        .map(|entry| WrapSecret {
            env_var: &entry.meta.env_var,
            value: entry.value.expose(),
            hosts: &entry.meta.hosts,
            read_only: entry.meta.read_only,
        })
        .collect();
    let wrapped_in = wrap_in_sandbox(
        &host.sandbox,
        root,
        cwd,
        &script,
        &command_id,
        network,
        &wire,
        tls,
        |tls| start_instance(host, tls),
    );
    // The real values have done their job: drop (and so wipe) them before the command runs.
    let secret_names: Vec<String> = entries.iter().map(|e| e.meta.env_var.clone()).collect();
    drop(wire);
    drop(entries);
    let (instance, wrapped) =
        match wrapped_in {
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
    // Only the placeholders for the secrets this command was given; never the real values.
    let secret_env = wrapped
        .secret_env
        .into_iter()
        .filter(|(name, _)| secret_names.contains(name))
        .collect();
    let env = child_env(root, wrapped.env, secret_env);
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
        let stderr = match &vault_warning {
            Some(warning) => format!("{stderr}\n{warning}"),
            None => stderr,
        };
        let output = format!("{}{}", String::from_utf8_lossy(&run.stdout), stderr);
        let mut result = json!({
            "output": output.chars().take(max_chars).collect::<String>(),
            "exitCode": run.exit_code,
            "truncated": run.truncated || output.chars().count() > max_chars,
            "cancelled": run.cancelled,
        });
        if let Some(warning) = &vault_warning {
            result["vaultWarning"] = Value::String(warning.clone());
        }
        // Drained before `finish`, which makes the sidecar forget the command. A failed audit
        // never fails the command; it is reported honestly instead of as an empty list.
        match instance.sidecar.audit(&command_id) {
            Ok(entries) => result["networkAudit"] = Value::Array(entries),
            Err(error) => result["networkAuditError"] = Value::String(error.message),
        }
        result
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
            tls: None,
        };
        let sidecar = Sidecar::start_with_timeout(bundle, &init, Duration::from_secs(5))?;
        Ok(SandboxInstance::new(
            sidecar,
            roots.iter().map(PathBuf::from).collect(),
            false,
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
                &[],
                false,
                |_| {
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
                &[],
                false,
                |_| {
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
            &[],
            false,
            |_| {
                starts += 1;
                stub_instance(bundle.path(), &["/w", "/granted"])
            },
        )
        .unwrap();
        instance.finish("id");
        assert_eq!(starts, 1);
        let after = slot.lock().unwrap().clone().unwrap();
        assert!(!Arc::ptr_eq(&before, &after));
        assert!(after.covers(Path::new("/granted"), false));
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
        let start = |_: bool| stub_instance_at(bundle.path(), &["/w"], home);
        let w = Path::new("/w");
        // Two overlapping commands: the second is wrapped before the first has finished.
        let (first, _) = wrap_in_sandbox(&slot, w, w, "echo a", "cmd-a", None, &[], false, start).unwrap();
        let (second, _) = wrap_in_sandbox(&slot, w, w, "echo b", "cmd-b", None, &[], false, start).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        let failed = wrap_in_sandbox(&slot, w, w, "ERROR:POLICY_INVALID", "cmd-c", None, &[], false, start)
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
            &[],
            false,
            |_| {
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
            &[],
            false,
            |_| {
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
            &[],
            false,
            |_| stub_instance_at(dir.path(), &["/w"], home.to_str().unwrap()),
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
            &[],
            false,
            |_| Err(HostError::new("HELPER_MISSING", "stub")),
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
        let init = init_config(&base.join("sandbox/current"), base, vec![], false);
        assert_eq!(
            init.deny_roots,
            [
                "/home/u/.local/share/app/local-host",
                "/home/u/.local/share/app/sandbox"
            ]
        );
        assert_eq!(init.bwrap_path.as_deref(), Some(BWRAP_PATH));
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
        let active = host.network.begin("inv-1", Arc::default());
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
        let active = host.network.begin("inv-1", Arc::default());
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
        let active = host.network.begin("inv-1", Arc::default());
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
        let active = host.network.begin("inv-1", Arc::default());
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
        let active = host.network.begin("inv", Arc::default());
        let result = execute_command(
            &host, &root, &root, "AUDIT_FAIL", 20_000, 1000, Arc::default(), None, &active,
        )
        .unwrap();
        assert_eq!(result["exitCode"], 0);
        assert!(result.get("networkAudit").is_none());
        assert_eq!(result["networkAuditError"], "stub audit error");
    }

    #[test]
    fn result_keys_are_the_macos_ones_plus_the_audit() {
        let (_app, host, root) = host_with_stub_bundle();
        let active = host.network.begin("inv", Arc::default());
        let result = execute_command(
            &host, &root, &root, "echo hi", 20_000, 1000, Arc::default(), None, &active,
        )
        .unwrap();
        let mut keys: Vec<&str> = result.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["cancelled", "exitCode", "networkAudit", "output", "truncated"]
        );
    }

    #[test]
    fn a_replacement_sidecar_also_answers_asks_through_the_bridge() {
        let (_app, host, root) = host_with_stub_bundle();
        // Seed the slot with a sidecar that has already desynchronized (a wrap that never
        // answers), so the next wrap replaces it via the production `start_instance`.
        let bundle = bundle_dir(&host.base);
        let init = init_config(&bundle, &host.base, vec![host.base.join("task-workspaces").to_str().unwrap().to_string()], false);
        let dead = Sidecar::start_with_timeout(&bundle, &init, Duration::from_secs(5)).unwrap();
        assert!(dead
            .wrap("x", "HANG", &root, &root, None, &[])
            .is_err());
        *host.sandbox.lock().unwrap() = Some(Arc::new(SandboxInstance::new(
            dead,
            vec![host.base.join("task-workspaces")],
            false,
        )));
        let before = host.sandbox.lock().unwrap().clone().unwrap();

        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
        let _lease = host.network.attach(sender);
        let active = host.network.begin("inv-1", Arc::default());
        active.set_command_id("cmd");
        let (instance, _) = wrap_in_sandbox(
            &host.sandbox, &root, &root, "SLEEP_ASK:example.com:443", "cmd", None,
            &[], false, |tls| start_instance(&host, tls),
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

    use super::super::vault::tests::{secret, MemoryStore};

    fn output(result: &Value) -> &str {
        result["output"].as_str().unwrap()
    }

    fn vault_host() -> (tempfile::TempDir, LocalHost, PathBuf) {
        let (app, host, root) = host_with_stub_bundle();
        host.set_secret_store(Arc::new(MemoryStore::default()));
        (app, host, root)
    }

    fn run(host: &LocalHost, root: &Path, script: &str, network: Option<&NetworkPolicy>) -> Value {
        let active = host.network.begin("inv-vault", Arc::default());
        execute_command(host, root, root, script, 20_000, 20_000, Arc::default(), network, &active)
            .unwrap()
    }

    fn current(host: &LocalHost) -> Arc<SandboxInstance> {
        host.sandbox.lock().unwrap().clone().expect("a sidecar is running")
    }

    #[test]
    fn the_sidecar_follows_the_vault_in_and_out_of_tls() {
        let (_app, host, root) = vault_host();
        // Empty vault: exactly the Plan 4 sidecar, no init.tls.
        let first = run(&host, &root, "SHOW_INIT", None);
        assert_eq!(output(&first).trim(), "", "{first}");
        let plain = current(&host);
        assert!(!plain.tls);
        // Same state, same sidecar.
        run(&host, &root, "SHOW_INIT", None);
        assert!(Arc::ptr_eq(&plain, &current(&host)));
        // The vault becomes non-empty: a new sidecar with TLS termination.
        let meta = host.vault_set(secret("API_TOKEN", "stub-real-value", &["api.example.com"])).unwrap();
        let with = run(&host, &root, "SHOW_INIT", None);
        let ca_dir = host.base.join("sandbox").join("ca");
        assert!(
            output(&with).contains(&format!(r#""caDir":"{}""#, ca_dir.display())),
            "{with}"
        );
        let tls = current(&host);
        assert!(tls.tls && !Arc::ptr_eq(&plain, &tls));
        run(&host, &root, "SHOW_INIT", None);
        assert!(Arc::ptr_eq(&tls, &current(&host)), "no restart while the vault stays non-empty");
        // And empty again: back to a sidecar without TLS.
        host.vault_remove(&meta.id).unwrap();
        let after = run(&host, &root, "SHOW_INIT", None);
        assert_eq!(output(&after).trim(), "", "{after}");
        assert!(!current(&host).tls);
    }

    #[test]
    fn the_command_gets_placeholders_never_the_real_value() {
        let (_app, host, root) = vault_host();
        host.vault_set(secret("API_TOKEN", "stub-real-value-xyz", &["api.example.com"])).unwrap();
        host.vault_set(secret("OTHER_KEY", "stub-other-value-abc", &["other.example.com"])).unwrap();
        let result = run(&host, &root, "ENV_DUMP", None);
        let text = output(&result);
        assert!(text.contains("API_TOKEN=fake_value_API_TOKEN"), "{result}");
        assert!(text.contains("OTHER_KEY=fake_value_OTHER_KEY"), "{result}");
        // Not in the output, the audit, or anything else the result carries.
        let everything = result.to_string();
        assert!(!everything.contains("stub-real-value-xyz"), "{everything}");
        assert!(!everything.contains("stub-other-value-abc"), "{everything}");
        // Pinned values are still pinned.
        assert!(text.contains(&format!("HOME={}", root.display())), "{result}");
    }

    #[test]
    fn an_empty_vault_adds_no_environment() {
        let (_app, host, root) = vault_host();
        let result = run(&host, &root, "ENV_DUMP", None);
        assert!(!output(&result).contains("fake_value_"), "{result}");
    }

    #[test]
    fn a_placeholder_can_never_replace_a_pinned_variable() {
        let env = child_env(
            Path::new("/w/root"),
            vec![("FOO".into(), "bar".into()), ("PATH".into(), "/sidecar/path".into())],
            vec![
                ("PATH".into(), "fake_value_PATH".into()),
                ("HOME".into(), "fake_value_HOME".into()),
                ("TMPDIR".into(), "fake_value_TMPDIR".into()),
                ("API_TOKEN".into(), "fake_value_API_TOKEN".into()),
            ],
        );
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("HOME"), Some("/w/root"));
        assert_eq!(get("TMPDIR"), Some("/w/root/.tmp"));
        assert_ne!(get("PATH"), Some("fake_value_PATH"));
        assert_ne!(get("PATH"), Some("/sidecar/path"));
        assert_eq!(get("API_TOKEN"), Some("fake_value_API_TOKEN"));
        assert_eq!(get("FOO"), Some("bar"));
    }

    #[test]
    fn a_placeholder_for_a_secret_the_command_did_not_get_is_dropped() {
        // The stub invents a placeholder for every envVar in the request, so build the request
        // with one secret and check only that one comes through the filter.
        let (_app, host, root) = vault_host();
        host.vault_set(secret("API_TOKEN", "v", &["api.example.com"])).unwrap();
        let result = run(&host, &root, "ENV_DUMP", None);
        let placeholders = output(&result).lines().filter(|l| l.contains("fake_value_")).count();
        assert_eq!(placeholders, 1, "{result}");
    }

    #[test]
    fn vault_hosts_join_the_allow_list_except_in_open_mode() {
        let (_app, host, _root) = vault_host();
        host.vault_set(secret("A_TOKEN", "v", &["api.example.com", "api.example.org"])).unwrap();
        host.vault_set(secret("B_TOKEN", "v", &["api.example.com"])).unwrap();
        let entries = host.vault_entries().unwrap();
        let ask = NetworkPolicy {
            mode: NetworkMode::Ask,
            allow: vec!["registry.npmjs.org".into(), "api.example.com".into()],
            suggested: Default::default(),
        };
        let merged = with_vault_hosts(Some(&ask), &entries).unwrap();
        assert_eq!(
            merged.allow,
            ["registry.npmjs.org", "api.example.com", "api.example.org"]
        );
        let strict = NetworkPolicy { mode: NetworkMode::Strict, ..ask.clone() };
        assert_eq!(with_vault_hosts(Some(&strict), &entries).unwrap().mode, NetworkMode::Strict);
        assert_eq!(with_vault_hosts(Some(&strict), &entries).unwrap().allow.len(), 3);
        let open = NetworkPolicy { mode: NetworkMode::Open, allow: vec![], suggested: Default::default() };
        assert_eq!(with_vault_hosts(Some(&open), &entries).unwrap(), open);
        assert!(with_vault_hosts(None, &entries).is_none());
        assert_eq!(with_vault_hosts(Some(&ask), &[]).unwrap(), ask);
    }

    #[test]
    fn an_unavailable_keychain_runs_the_command_without_secrets_and_says_so() {
        let (_app, host, root) = host_with_stub_bundle();
        let store = Arc::new(MemoryStore::default());
        host.set_secret_store(store.clone());
        host.vault_set(secret("API_TOKEN", "stub-real-value-xyz", &["api.example.com"])).unwrap();
        let ask = NetworkPolicy { mode: NetworkMode::Ask, allow: vec![], suggested: Default::default() };

        // Locked keychain.
        *store.fail_get.lock().unwrap() = true;
        let locked = run(&host, &root, "ENV_DUMP", Some(&ask));
        assert_eq!(locked["exitCode"], 0, "{locked}");
        assert!(!output(&locked).contains("fake_value_"), "no secrets were passed: {locked}");
        let warning = locked["vaultWarning"].as_str().expect("vaultWarning");
        assert!(warning.starts_with("[sandbox vault unavailable: "), "{warning}");
        assert!(warning.ends_with("stored secrets were not available to this command]"), "{warning}");
        assert_eq!(output(&locked).matches("[sandbox vault unavailable").count(), 1, "{locked}");
        assert!(!locked.to_string().contains("stub-real-value-xyz"));
        // No TLS sidecar was started for it, and the vault hosts were not merged: the stub shows
        // what reached `wrap`.
        assert!(!current(&host).tls);
        let shown = run(&host, &root, "SHOW_NETWORK", Some(&ask));
        assert!(!output(&shown).contains("api.example.com"), "{shown}");

        // One item missing from the keychain.
        *store.fail_get.lock().unwrap() = false;
        let meta = host.vault_list().unwrap().secrets.remove(0);
        store.items.lock().unwrap().remove(&meta.id);
        let missing = run(&host, &root, "ENV_DUMP", None);
        assert!(!output(&missing).contains("fake_value_"), "{missing}");
        let warning = missing["vaultWarning"].as_str().unwrap();
        assert!(warning.contains("a stored secret is missing from the keychain"), "{warning}");
        assert!(!warning.contains(&meta.label), "the warning must not name the secret: {warning}");

        // Back to normal once the keychain has the item again.
        store.items.lock().unwrap().insert(meta.id.clone(), b"stub-real-value-xyz".to_vec());
        let fine = run(&host, &root, "ENV_DUMP", None);
        assert!(output(&fine).contains("API_TOKEN=fake_value_API_TOKEN"), "{fine}");
        assert!(fine.get("vaultWarning").is_none(), "{fine}");
        assert!(current(&host).tls);
    }

    #[test]
    fn the_merged_allow_list_never_exceeds_the_sidecar_limit() {
        let (_app, host, _root) = vault_host();
        // 200 distinct vault hosts (the vault's own cap).
        for n in 0..4 {
            let hosts: Vec<String> = (0..50).map(|i| format!("v{n}-{i}.vault.example.com")).collect();
            let refs: Vec<&str> = hosts.iter().map(String::as_str).collect();
            host.vault_set(secret(&format!("S_{n}"), "v", &refs)).unwrap();
        }
        let entries = host.vault_entries().unwrap();
        // 500 backend entries: one a case-variant duplicate of a vault host, one repeated.
        let mut allow: Vec<String> = (0..498).map(|i| format!("site{i}.example.org")).collect();
        allow.insert(10, "V0-0.Vault.Example.com".into());
        allow.push("SITE0.example.org".into());
        assert_eq!(allow.len(), 500);
        let ask = NetworkPolicy { mode: NetworkMode::Ask, allow, suggested: Default::default() };
        let merged = with_vault_hosts(Some(&ask), &entries).unwrap();
        assert_eq!(merged.allow.len(), MAX_ALLOW_ENTRIES, "{}", merged.allow.len());
        // All vault hosts are present, once, lower-cased.
        for n in 0..4 {
            for i in 0..50 {
                let name = format!("v{n}-{i}.vault.example.com");
                assert_eq!(merged.allow.iter().filter(|h| h.eq_ignore_ascii_case(&name)).count(), 1, "{name}");
            }
        }
        // Non-vault entries keep their order; the case-variant duplicates are gone, and the
        // trailing ones were dropped to make room.
        let others: Vec<&String> = merged.allow.iter().filter(|h| h.starts_with("site") || h.starts_with("SITE")).collect();
        assert_eq!(others.len(), 300);
        assert_eq!(others[0], "site0.example.org");
        assert_eq!(others[299], "site299.example.org");
        assert!(!merged.allow.iter().any(|h| h == "SITE0.example.org"));
        // The vault hosts come last.
        assert!(merged.allow[300..].iter().all(|h| h.ends_with(".vault.example.com")));
        // Already within limits: nothing is dropped.
        let small = NetworkPolicy { mode: NetworkMode::Strict, allow: vec!["a.example.org".into()], suggested: Default::default() };
        assert_eq!(with_vault_hosts(Some(&small), &entries).unwrap().allow.len(), 201);
    }
}
