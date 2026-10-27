#![cfg(target_os = "linux")]
//! Linux-only checks against a real sandbox bundle and `bwrap`. Requires bubblewrap and a
//! built `sandbox-sidecar` bundle, so every test here is `#[ignore]`; run with
//! `cargo test --test linux_sandbox -- --include-ignored` on a Linux host (see the Docker recipe
//! in `.superpowers/sdd/2026-10-24-local-sandbox-cross-platform/task-6-report.md`).
//!
//! The readiness tests drive `readiness::probe_bundle` directly with an explicit `bwrap` path.
//! The execution tests go through the production `LocalHost::open` + `dispatch` path, which
//! starts the sidecar from `<app data>/sandbox/current` and uses the production bwrap at
//! `/opt/sourceweft/libexec/bwrap`.
//!
//! The proxy hostname test needs two `/etc/hosts` entries, `127.0.0.1 sw-loop.test` and
//! `10.0.0.1 sw-private.test` (the linux-sandbox CI job adds them; for Docker pass
//! `--add-host sw-loop.test:127.0.0.1 --add-host sw-private.test:10.0.0.1`), and fails with
//! that instruction when they are missing.
//!
//! No new environment variables may be added to the product, and that restriction extends to
//! how this test locates its fixtures: the bundle is located relative to
//! `CARGO_MANIFEST_DIR`, at `apps/desktop/sandbox-sidecar/dist/bundle` (git-ignored). The
//! verification recipe copies a container-built bundle there before running `cargo test`.
use serde_json::{json, Value};
use sourceweft_desktop::local_host::{
    execution::Executions,
    readiness::{
        bundle_dir, probe_bundle, Helpers, InitConfig, Platform, SandboxReadiness, SetupCode,
    },
    LocalHost, Workspace,
};
use sourceweft_desktop::local_host::{
    network::{NetworkBridge, OutboundLease},
    vault::{NewSecret, SecretStore},
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// `apps/desktop/sandbox-sidecar/dist/bundle`, built by that package's
/// `bun run build --rg "$(command -v rg)"`.
fn built_bundle_source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sandbox-sidecar/dist/bundle")
}

/// Copies the already-built bundle into `<temp>/sandbox/current`, matching the layout
/// `readiness::bundle_dir` expects under a real app-data directory.
fn copy_bundle_into(dest: &std::path::Path) {
    let source = built_bundle_source();
    assert!(
        source.join("srt-sidecar").is_file(),
        "expected a built sidecar bundle at {source:?}; run \
         `bun run build --rg \"$(command -v rg)\"` in apps/desktop/sandbox-sidecar first \
         (see the Docker recipe in the task-7 report)"
    );
    fs::create_dir_all(dest).unwrap();
    for entry in fs::read_dir(&source).unwrap() {
        let entry = entry.unwrap();
        let target = dest.join(entry.file_name());
        fs::copy(entry.path(), &target).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
    }
}

fn harness_init(bwrap_path: &str, workspace_root: &std::path::Path) -> InitConfig {
    InitConfig {
        platform: Platform::Linux,
        home: std::env::var("HOME").unwrap_or_default(),
        workspace_roots: vec![workspace_root.to_string_lossy().into_owned()],
        read_roots: vec![],
        deny_roots: vec![],
        helpers: Helpers {
            ripgrep: "/usr/bin/rg".to_string(),
            apply_seccomp: None,
            java_agent_jar: None,
        },
        bwrap_path: Some(bwrap_path.to_string()),
        tls: None,
    }
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn readiness_needs_setup_without_profile() {
    // On a real Ubuntu 24.04 kernel with kernel.apparmor_restrict_unprivileged_userns=1 (CI,
    // Task 9), bwrap at /usr/bin/bwrap has no AppArmor profile scoped to it, and the sandboxed
    // child's own network-namespace setup fails with RTM_NEWADDR. That failure is the whole
    // point of pinning bwrap to /opt/sourceweft/libexec/bwrap with a scoped profile instead of
    // ever loosening /usr/bin/bwrap or the sysctl; this test proves the unscoped path really
    // does fail closed rather than silently running unsandboxed.
    ensure_tmp_claude();
    let temp = tempfile::tempdir().unwrap();
    let bundle = bundle_dir(temp.path());
    copy_bundle_into(&bundle);
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();

    let readiness = probe_bundle(&bundle, &harness_init("/usr/bin/bwrap", &workspace));
    match readiness {
        SandboxReadiness::NeedsSetup { code, reason, .. } => {
            assert_eq!(
                code,
                SetupCode::UserNamespaceRestricted,
                "the AppArmor-restricted-userns failure must classify as userNamespaceRestricted, \
                 got {code:?}: {reason}"
            );
            assert!(
                reason.contains("RTM_NEWADDR"),
                "expected the AppArmor-restricted-userns failure to surface RTM_NEWADDR, got: \
                 {reason}"
            );
        }
        other => panic!(
            "expected NeedsSetup on a kernel with kernel.apparmor_restrict_unprivileged_userns=1, \
             got {other:?}"
        ),
    }
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn readiness_ready_with_working_bwrap() {
    // Counterpart to the test above, against the production bwrap path instead of the system
    // one: on this Mac's Docker Desktop Linux container there is no AppArmor at all, so
    // /opt/sourceweft/libexec/bwrap (copied there by the verification recipe, same as
    // /usr/bin/bwrap) is unrestricted and the harness should report Ready. On a real Ubuntu
    // 24.04 kernel with kernel.apparmor_restrict_unprivileged_userns=1 (CI, Task 9),
    // /opt/sourceweft/libexec/bwrap is also Ready there, but for a different reason: the CI job
    // loads an AppArmor profile scoped to exactly that path that grants `userns`, so the
    // restricted sysctl no longer blocks it. Probing /usr/bin/bwrap here would fail on that
    // restricted runner (see readiness_needs_setup_without_profile, which deliberately keeps
    // probing /usr/bin/bwrap to prove the unscoped path still fails closed).
    ensure_tmp_claude();
    let temp = tempfile::tempdir().unwrap();
    let bundle = bundle_dir(temp.path());
    copy_bundle_into(&bundle);
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();

    let readiness = probe_bundle(
        &bundle,
        &harness_init("/opt/sourceweft/libexec/bwrap", &workspace),
    );
    assert!(
        matches!(readiness, SandboxReadiness::Ready { .. }),
        "expected Ready against a working /opt/sourceweft/libexec/bwrap, got {readiness:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// Execution through the production `LocalHost` path.
// ---------------------------------------------------------------------------------------------

/// Host fixtures every test needs before any test in this binary starts a sidecar or reads the
/// login-shell `PATH` (which the host captures once per process):
///
/// - `/tmp/claude`, never removed: srt treats an existing `/tmp/claude` as its own writable
///   TMPDIR (the state on any machine that also runs Claude Code), so every execution test runs
///   in that configuration, and `cannot_write_srt_tmp_claude` proves the sidecar's write deny
///   covers it. Creating or removing it while another test's command is between wrap and exec
///   would race srt's bind.
/// - `~/.local/bin`: Ubuntu's `~/.profile` puts it on the login `PATH` only when it exists at
///   login, and `cannot_read_host_database_under_local_share` needs it there. Creating it inside
///   that test raced whichever test captured the `PATH` first.
fn ensure_tmp_claude() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        fs::create_dir_all("/tmp/claude").expect("create /tmp/claude");
        fs::create_dir_all(home_dir().join(".local/bin")).expect("create ~/.local/bin");
    });
    assert!(
        Path::new("/tmp/claude").is_dir(),
        "/tmp/claude must be a directory"
    );
}

/// A `LocalHost` over a fresh temporary app-data directory with the built bundle installed at
/// `<app data>/sandbox/current`, exactly where production looks for it.
fn host_with_bundle() -> (tempfile::TempDir, LocalHost) {
    ensure_tmp_claude();
    let app = tempfile::tempdir().unwrap();
    copy_bundle_into(&bundle_dir(app.path()));
    let host = LocalHost::open(app.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    (app, host)
}

fn execute(host: &LocalHost, call: &str, workspace: &Workspace, command: &str) -> Value {
    host.dispatch(
        &Executions::default(),
        call,
        "owner",
        &workspace.thread_id,
        "command.execute",
        json!({"workspaceId": workspace.id, "command": command, "timeoutMs": 60000, "maxOutputChars": 20000}),
    )
    .unwrap_or_else(|error| panic!("command.execute failed: {error}"))
}

fn output(result: &Value) -> &str {
    result["output"].as_str().unwrap()
}

/// Runs `command` after a positive control that must succeed inside the sandbox, and asserts
/// the control ran, so a denial test cannot pass merely because the sandbox failed to start the
/// command at all (e.g. exit 127 from a missing helper).
fn execute_denied(host: &LocalHost, call: &str, workspace: &Workspace, command: &str) -> Value {
    let control = workspace.path.join(".sw-control");
    let _ = fs::remove_file(&control);
    let result = execute(
        host,
        call,
        workspace,
        &format!("printf ran > .sw-control && {command}"),
    );
    assert_eq!(
        fs::read_to_string(&control).ok().as_deref(),
        Some("ran"),
        "the sandboxed command never ran: {result}"
    );
    result
}

/// Single-quotes `path` for `/bin/sh`.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn writes_inside_workspace() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let root = workspace.path.to_str().unwrap().to_string();
    let result = execute(
        &host,
        "write",
        &workspace,
        "printf hello > out.txt && /bin/pwd && printf '%s\\n' \"$HOME\" \"$TMPDIR\" \"$npm_config_cache\" \"$PIP_CACHE_DIR\" \"$NODE_USE_ENV_PROXY\" && mktemp",
    );
    // Exactly the macOS result shape.
    let mut keys: Vec<&str> = result
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["cancelled", "exitCode", "networkAudit", "output", "truncated"],
        "{result}"
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(result["cancelled"], false, "{result}");
    assert_eq!(result["truncated"], false, "{result}");
    assert_eq!(
        fs::read_to_string(workspace.path.join("out.txt")).unwrap(),
        "hello"
    );
    let lines: Vec<&str> = output(&result).lines().collect();
    assert_eq!(lines[0], root, "{result}");
    assert_eq!(lines[1], root, "HOME: {result}");
    assert_eq!(lines[2], format!("{root}/.tmp"), "TMPDIR: {result}");
    assert_eq!(
        lines[3],
        format!("{root}/.cache/npm"),
        "npm_config_cache: {result}"
    );
    assert_eq!(
        lines[4],
        format!("{root}/.cache/pip"),
        "PIP_CACHE_DIR: {result}"
    );
    assert_eq!(lines[5], "1", "NODE_USE_ENV_PROXY: {result}");
    assert!(
        lines[6].starts_with(&format!("{root}/.tmp/")),
        "mktemp must land in the workspace TMPDIR: {result}"
    );
}

/// Removes the planted secret even when an assertion fails.
struct RemoveOnDrop(PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cannot_read_home_secret() {
    let home = PathBuf::from(std::env::var("HOME").expect("HOME must be set for this test"));
    let secret_path = home.join(".sw-test-secret");
    let secret = format!("sw-secret-{}", uuid::Uuid::new_v4().simple());
    fs::write(&secret_path, &secret).unwrap();
    let _cleanup = RemoveOnDrop(secret_path.clone());

    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute_denied(
        &host,
        "read-secret",
        &workspace,
        &format!("cat {}", quoted(&secret_path)),
    );
    assert!(
        !output(&result).contains(&secret),
        "home secret leaked into the sandbox: {result}"
    );
    assert_ne!(result["exitCode"], 0, "{result}");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cannot_write_outside() {
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("escape.txt");
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute_denied(
        &host,
        "escape",
        &workspace,
        &format!("printf x > {}", quoted(&target)),
    );
    assert!(
        !target.exists(),
        "a sandboxed command wrote outside its workspace: {result}"
    );
    assert_ne!(result["exitCode"], 0, "{result}");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn public_https_allowed() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute(
        &host,
        "public",
        &workspace,
        "curl -sS -o /dev/null -w %{http_code} https://registry.npmjs.org/left-pad",
    );
    assert_eq!(output(&result).trim(), "200", "{result}");
    assert_eq!(result["exitCode"], 0, "{result}");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn private_literal_blocked() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    // srt puts 10.0.0.0/8 in the child's NO_PROXY, so a plain request skips the proxy and
    // must fail on the sandbox's empty network namespace; `--noproxy ''` forces the same
    // request through the sandbox proxy, whose address guard must refuse it.
    let direct = execute(
        &host,
        "private-direct",
        &workspace,
        "curl -sS --max-time 10 -o /dev/null -w %{http_code} http://10.0.0.1/",
    );
    assert_ne!(direct["exitCode"], 0, "{direct}");
    assert!(output(&direct).starts_with("000"), "{direct}");
    let proxied = execute(
        &host,
        "private-proxied",
        &workspace,
        "curl -sS --noproxy '' --max-time 10 -o /dev/null -w %{http_code} http://10.0.0.1/",
    );
    let text = output(&proxied);
    assert!(
        text.contains("sandbox_violations") || text.contains("403"),
        "a private literal address must be refused by the sandbox proxy: {proxied}"
    );
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cancel_kills_command() {
    let (_app, host) = host_with_bundle();
    let host = Arc::new(host);
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let executions = Arc::new(Executions::default());
    let worker = {
        let host = host.clone();
        let executions = executions.clone();
        let id = workspace.id.clone();
        std::thread::spawn(move || {
            host.dispatch(
                &executions,
                "cancel-me",
                "owner",
                "thread",
                "command.execute",
                json!({"workspaceId": id, "command": "printf started > started.txt; sleep 20; printf forbidden > after.txt", "timeoutMs": 60000}),
            )
        })
    };
    for _ in 0..1000 {
        if workspace.path.join("started.txt").exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        workspace.path.join("started.txt").exists(),
        "command must start before cancellation"
    );
    assert!(executions.cancel("cancel-me"));
    let result = worker.join().unwrap().unwrap();
    assert_eq!(result["cancelled"], true, "{result}");
    // Longer than the remaining `sleep 20` would take if anything survived the kill.
    std::thread::sleep(Duration::from_secs(1));
    assert!(!workspace.path.join("after.txt").exists(), "{result}");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn workspace_with_brackets_and_cjk() {
    let (_app, host) = host_with_bundle();
    // Start the sidecar first with only the automatic workspace base in its init, so the
    // folder granted below is outside that set and forces a restart with the updated roots.
    let automatic = host.ensure_workspace("owner", "first-thread").unwrap();
    let warm = execute(&host, "warm", &automatic, "true");
    assert_eq!(warm["exitCode"], 0, "{warm}");

    let parent = tempfile::tempdir().unwrap();
    let selected = parent.path().join("ws [测试]");
    fs::create_dir(&selected).unwrap();
    let (grant, root) = host.grant_directory("owner", &selected).unwrap();
    let workspace = host
        .ensure_workspace_with_grant("owner", "granted-thread", Some(&grant))
        .unwrap();
    let result = execute(
        &host,
        "granted",
        &workspace,
        "printf ok > 'a [b] 测试.txt' && /bin/pwd",
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(output(&result).trim(), root.to_str().unwrap(), "{result}");
    assert_eq!(
        fs::read_to_string(root.join("a [b] 测试.txt")).unwrap(),
        "ok"
    );
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME must be set for this test"))
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cannot_read_another_granted_workspace() {
    // Ruling R14: every granted directory is in the sidecar's init roots, but a command is only
    // re-allowed its own workspace root (plus toolchain read roots) inside the denied home.
    let (_app, host) = host_with_bundle();
    let other = tempfile::tempdir_in(home_dir()).unwrap();
    let secret = format!("sw-other-workspace-{}", uuid::Uuid::new_v4().simple());
    fs::write(other.path().join("secret.txt"), &secret).unwrap();
    let (grant, other_root) = host.grant_directory("owner", other.path()).unwrap();
    let granted = host
        .ensure_workspace_with_grant("owner", "granted-thread", Some(&grant))
        .unwrap();
    let own = execute(&host, "own-read", &granted, "cat secret.txt");
    assert_eq!(output(&own), secret, "positive control: {own}");

    let automatic = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute_denied(
        &host,
        "cross-read",
        &automatic,
        &format!("cat {}", quoted(&other_root.join("secret.txt"))),
    );
    assert!(
        !output(&result).contains(&secret),
        "read another workspace: {result}"
    );
    assert_ne!(result["exitCode"], 0, "{result}");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cannot_write_srt_tmp_claude() {
    // Ruling R15: srt makes an existing /tmp/claude writable by default; the sidecar denies it.
    let (_app, host) = host_with_bundle();
    let shared = Path::new("/tmp/claude");
    assert!(
        shared.is_dir(),
        "/tmp/claude must exist on the host for this test"
    );
    let target = shared.join(format!("sw-escape-{}", uuid::Uuid::new_v4().simple()));
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute_denied(
        &host,
        "tmp-claude",
        &workspace,
        &format!("printf x > {}", quoted(&target)),
    );
    let escaped = target.exists();
    let _ = fs::remove_file(&target);
    assert!(
        !escaped,
        "a sandboxed command wrote to /tmp/claude: {result}"
    );
    assert_ne!(result["exitCode"], 0, "{result}");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cannot_read_host_database_under_local_share() {
    // Ruling R16: with the app data under ~/.local/share (the production layout) and
    // ~/.local/bin on the login PATH, no read root may expose `<base>/local-host`.
    let home = home_dir();
    fs::create_dir_all(home.join(".local/bin")).unwrap();
    let share = home.join(".local/share");
    fs::create_dir_all(&share).unwrap();
    ensure_tmp_claude();
    let app = tempfile::tempdir_in(&share).unwrap();
    copy_bundle_into(&bundle_dir(app.path()));
    let host = LocalHost::open(app.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    let database = app
        .path()
        .canonicalize()
        .unwrap()
        .join("local-host/state.sqlite3");
    assert!(database.is_file());
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute_denied(
        &host,
        "database",
        &workspace,
        &format!("printf '%s\\n' \"$PATH\"; head -c 15 {}", quoted(&database)),
    );
    let text = output(&result);
    let local_bin = home.join(".local/bin");
    assert!(
        text.lines()
            .next()
            .unwrap_or_default()
            .split(':')
            .any(|entry| Path::new(entry) == local_bin),
        "precondition: ~/.local/bin must be on the sandboxed PATH: {result}"
    );
    assert!(
        !text.contains("SQLite format 3"),
        "host database readable: {result}"
    );
    assert_ne!(result["exitCode"], 0, "{result}");
}

// ---------------------------------------------------------------------------------------------
// Network: what the sandbox proxy actually dials (final review C1, I6). Each probe speaks the
// proxy protocol by hand from inside the sandbox, so the client never normalises the host the
// way curl would: the proxy sees exactly the spelling under test.
// ---------------------------------------------------------------------------------------------

/// A listener bound only to the host's 127.0.0.1 that answers every connection with a unique
/// marker. A sandboxed command that ever sees the marker reached host loopback.
fn host_only_listener() -> (u16, String) {
    use std::io::Write;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let marker = format!("HOST-LOOPBACK-REACHED-{}", uuid::Uuid::new_v4().simple());
    let reply = format!(
        "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{marker}",
        marker.len()
    );
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (port, marker)
}

/// `CONNECT <host>:<port>` to the sandbox's HTTP proxy, authenticated with the credentials srt
/// put in the sandboxed command's own `HTTPS_PROXY`, then whatever the tunnel returns. The status
/// line is read before anything else is written, and SIGPIPE is ignored: a refused CONNECT is
/// answered with a 403 and the connection is closed straight away, so a later write must not kill
/// the probe (exit 141) and lose the 403 that was already sent.
const CONNECT_PROBE: &str = r#"trap '' PIPE
p="$HTTPS_PROXY"; rest="${p#http://}"; cred="${rest%@*}"; hp="${rest##*@}"
auth=$(printf %s "$cred" | base64 -w0)
exec 3<>"/dev/tcp/${hp%:*}/${hp##*:}"
printf 'CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: Basic %s\r\n\r\n' '@TARGET@' '@TARGET@' "$auth" >&3
IFS= read -r -t 5 status <&3
printf '%s\n' "$status" | tr -d '\r'
printf 'GET / HTTP/1.0\r\n\r\n' >&3 2>/dev/null
timeout 5 cat <&3 | tr -d '\r'
true"#;

/// A SOCKS5 CONNECT with a DOMAINNAME (address type 3) destination to the sandbox's SOCKS
/// proxy (`FTP_PROXY` names it), using the username/password from that URL. Prints each reply
/// as hex (`greeting=0502`, `auth=0100`, `reply=05..`), then whatever the tunnel returns.
const SOCKS_PROBE: &str = r#"trap '' PIPE
p="$FTP_PROXY"; rest="${p#socks5h://}"; cred="${rest%@*}"; hp="${rest##*@}"
user="${cred%%:*}"; pass="${cred#*:}"; host='@HOST@'; port=@PORT@
hex() { od -An -tx1 | tr -d ' \n'; }
byte() { printf "\\$(printf %03o "$1")"; }
exec 3<>"/dev/tcp/${hp%:*}/${hp##*:}"
printf '\005\001\002' >&3
printf 'greeting=%s\n' "$(head -c 2 <&3 | hex)"
{ printf '\001'; byte ${#user}; printf %s "$user"; byte ${#pass}; printf %s "$pass"; } >&3
printf 'auth=%s\n' "$(head -c 2 <&3 | hex)"
{ printf '\005\001\000\003'; byte ${#host}; printf %s "$host"; byte $((port >> 8)); byte $((port & 255)); } >&3
printf 'reply=%s\n' "$(timeout 10 head -c 2 <&3 | hex)"
printf 'GET / HTTP/1.0\r\n\r\n' >&3 2>/dev/null
timeout 5 cat <&3 | tr -d '\r'
true"#;

fn connect_probe(host: &LocalHost, workspace: &Workspace, target: &str) -> Value {
    execute(
        host,
        &format!("connect-{target}"),
        workspace,
        &CONNECT_PROBE.replace("@TARGET@", target),
    )
}

fn socks_probe(host: &LocalHost, workspace: &Workspace, dest: &str, port: u16) -> Value {
    execute(
        host,
        &format!("socks-{dest}-{port}"),
        workspace,
        &SOCKS_PROBE
            .replace("@HOST@", dest)
            .replace("@PORT@", &port.to_string()),
    )
}

/// The proxy answered the CONNECT, and refused it with a 403.
fn assert_connect_refused(result: &Value, target: &str, marker: Option<&str>) {
    let text = output(result);
    let status = text.lines().next().unwrap_or_default();
    assert!(
        status.starts_with("HTTP/1.1 403"),
        "CONNECT {target} must be refused with 403 by the sandbox proxy: {result}"
    );
    if let Some(marker) = marker {
        assert!(
            !text.contains(marker),
            "CONNECT {target} reached the host-only listener: {result}"
        );
    }
}

/// The SOCKS handshake and authentication succeeded (so the probe really talked to the proxy),
/// and the CONNECT itself was refused (reply code other than 00 succeeded).
fn assert_socks_refused(result: &Value, dest: &str, marker: Option<&str>) {
    let text = output(result);
    assert!(
        text.contains("greeting=0502") && text.contains("auth=0100"),
        "the SOCKS probe never authenticated with the sandbox proxy for {dest}: {result}"
    );
    let reply = text
        .lines()
        .find_map(|line| line.strip_prefix("reply="))
        .unwrap_or_default();
    assert!(
        reply.len() == 4 && reply.starts_with("05") && reply != "0500",
        "SOCKS CONNECT to {dest} must be refused (got reply {reply:?}): {result}"
    );
    if let Some(marker) = marker {
        assert!(
            !text.contains(marker),
            "SOCKS CONNECT to {dest} reached the host-only listener: {result}"
        );
    }
}

/// Spellings of host loopback that an inet_aton-style parser (and the WHATWG URL parser srt
/// dials through) turns into 127.0.0.1.
const LOOPBACK_SPELLINGS: [&str; 4] = ["127.0.0.1", "127.1", "2130706433", "0x7f.0.0.1"];

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn connect_to_loopback_spellings_is_refused() {
    let (port, marker) = host_only_listener();
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    for spelling in LOOPBACK_SPELLINGS {
        let target = format!("{spelling}:{port}");
        let result = connect_probe(&host, &workspace, &target);
        assert_connect_refused(&result, &target, Some(&marker));
        assert!(
            output(&result).contains("public internet only"),
            "CONNECT {target} must be refused by the sidecar's address guard: {result}"
        );
    }
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn socks_to_loopback_spellings_is_refused() {
    let (port, marker) = host_only_listener();
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    for spelling in LOOPBACK_SPELLINGS {
        let result = socks_probe(&host, &workspace, spelling, port);
        assert_socks_refused(&result, spelling, Some(&marker));
    }
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn metadata_and_private_shorthand_literals_are_refused() {
    // 2852039166 is 169.254.169.254 (cloud metadata); 10.1 is 10.0.0.1.
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    for (spelling, port) in [("2852039166", 80u16), ("10.1", 80u16)] {
        let target = format!("{spelling}:{port}");
        let result = connect_probe(&host, &workspace, &target);
        assert_connect_refused(&result, &target, None);
        assert!(
            output(&result).contains("public internet only"),
            "CONNECT {target} must be refused by the sidecar's address guard: {result}"
        );
        let result = socks_probe(&host, &workspace, spelling, port);
        assert_socks_refused(&result, spelling, None);
    }
}

/// Asserts `/etc/hosts` maps `name` to `address`. The linux-sandbox CI job and the Docker
/// recipe add these entries; without them a hostname test would prove nothing.
fn require_hosts_entry(name: &str, address: &str) {
    let hosts = fs::read_to_string("/etc/hosts").expect("read /etc/hosts");
    let present = hosts.lines().any(|line| {
        let mut fields = line.split('#').next().unwrap_or_default().split_whitespace();
        fields.next() == Some(address) && fields.any(|field| field == name)
    });
    assert!(
        present,
        "/etc/hosts must map {name} to {address} for this test: add the line \
         `{address} {name}` (the linux-sandbox CI job does; for Docker pass \
         `--add-host {name}:{address}`)"
    );
}

#[test]
#[ignore = "requires bubblewrap, the sandbox bundle and /etc/hosts test entries"]
fn hostnames_resolving_to_private_addresses_are_refused() {
    require_hosts_entry("sw-loop.test", "127.0.0.1");
    require_hosts_entry("sw-private.test", "10.0.0.1");
    let (port, marker) = host_only_listener();
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    for (name, port) in [("sw-loop.test", port), ("sw-private.test", 80)] {
        let target = format!("{name}:{port}");
        let result = connect_probe(&host, &workspace, &target);
        assert_connect_refused(&result, &target, Some(&marker));
        let result = socks_probe(&host, &workspace, name, port);
        assert_socks_refused(&result, name, Some(&marker));
    }
}

// ---------------------------------------------------------------------------------------------
// Reads outside the home directory (final review I1, I2).
// ---------------------------------------------------------------------------------------------

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cannot_read_tmp_outside_workspace() {
    let secret_path = std::env::temp_dir().join(format!(
        "sw-tmp-secret-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let secret = format!("sw-tmp-secret-{}", uuid::Uuid::new_v4().simple());
    fs::write(&secret_path, &secret).unwrap();
    let _cleanup = RemoveOnDrop(secret_path.clone());

    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    assert!(
        !secret_path.starts_with(&workspace.path),
        "precondition: the planted file must lie outside the workspace"
    );
    let result = execute_denied(
        &host,
        "tmp-read",
        &workspace,
        &format!("cat {}", quoted(&secret_path)),
    );
    assert!(
        !output(&result).contains(&secret),
        "a file in /tmp outside the workspace was readable: {result}"
    );
    assert_ne!(result["exitCode"], 0, "{result}");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cannot_read_another_granted_workspace_outside_home() {
    // Ruling R24: granted folders outside $HOME are isolated per wrap exactly like those inside.
    let (_app, host) = host_with_bundle();
    let other = tempfile::tempdir().unwrap();
    assert!(
        !other.path().starts_with(home_dir()),
        "precondition: the granted folder must lie outside $HOME"
    );
    let secret = format!("sw-outside-home-{}", uuid::Uuid::new_v4().simple());
    fs::write(other.path().join("secret.txt"), &secret).unwrap();
    let (grant, other_root) = host.grant_directory("owner", other.path()).unwrap();
    let granted = host
        .ensure_workspace_with_grant("owner", "granted-thread", Some(&grant))
        .unwrap();
    let own = execute(&host, "own-read", &granted, "cat secret.txt");
    assert_eq!(output(&own), secret, "positive control: {own}");

    let automatic = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute_denied(
        &host,
        "cross-read",
        &automatic,
        &format!("cat {}", quoted(&other_root.join("secret.txt"))),
    );
    assert!(
        !output(&result).contains(&secret),
        "read another workspace outside home: {result}"
    );
    assert_ne!(result["exitCode"], 0, "{result}");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cannot_read_cargo_credentials_under_a_toolchain_read_root() {
    // Ruling R25: `~/.cargo/bin` on PATH re-allows `~/.cargo` (R13), but the registry token
    // file inside it stays denied. An existing credentials file is never overwritten, printed
    // or removed: the probe only reports whether it could be opened.
    let cargo = home_dir().join(".cargo");
    let credentials = cargo.join("credentials.toml");
    let planted = if credentials.exists() {
        None
    } else {
        fs::create_dir_all(&cargo).unwrap();
        fs::write(&credentials, "[registry]\ntoken = \"sw-test-not-a-token\"\n").unwrap();
        Some(RemoveOnDrop(credentials.clone()))
    };
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let cargo_bin = cargo.join("bin");
    let result = execute_denied(
        &host,
        "cargo-credentials",
        &workspace,
        &format!(
            "printf '%s\\n' \"$PATH\"; ls {} >/dev/null && echo TOOLCHAIN-READABLE; \
             if cat {} >/dev/null 2>&1; then echo CREDENTIALS-READABLE; else echo CREDENTIALS-DENIED; fi",
            quoted(&cargo_bin),
            quoted(&credentials)
        ),
    );
    let text = output(&result);
    assert!(
        text.lines()
            .next()
            .unwrap_or_default()
            .split(':')
            .any(|entry| Path::new(entry) == cargo_bin),
        "precondition: ~/.cargo/bin must be on the sandboxed PATH: {result}"
    );
    assert!(
        text.contains("TOOLCHAIN-READABLE"),
        "positive control: ~/.cargo must stay readable as a toolchain read root: {result}"
    );
    assert!(
        text.contains("CREDENTIALS-DENIED") && !text.contains("CREDENTIALS-READABLE"),
        "~/.cargo/credentials.toml was readable inside the sandbox: {result}"
    );
    drop(planted);
}

// ---------------------------------------------------------------------------------------------
// Network approvals: modes, rules, the address guard, and the audit trail.
//
// The backend half is replaced by `ApprovalBridge`: it plays the WebSocket in-process by
// installing an outbound channel on `host.network`, recording every `network.ask` frame and
// answering through `host.network.resolve` exactly as `remote_host.rs` does for a
// `network.decision`. These tests reach the public internet (registry.npmjs.org and
// example.com), like `public_https_allowed`.
// ---------------------------------------------------------------------------------------------

const NPM_URL: &str = "https://registry.npmjs.org/left-pad";
const FETCH_NPM: &str = "curl -sS -o /dev/null -w %{http_code} https://registry.npmjs.org/left-pad";

/// A `network` payload for `command.execute`.
fn policy(mode: &str, allow: &[&str]) -> Value {
    json!({"mode": mode, "allow": allow, "suggested": {}})
}

/// `command.execute` with an explicit network policy (`None` omits the field entirely).
fn execute_net(
    host: &LocalHost,
    call: &str,
    workspace: &Workspace,
    command: &str,
    network: Option<Value>,
) -> Value {
    host.dispatch(
        &Executions::default(),
        call,
        "owner",
        &workspace.thread_id,
        "command.execute",
        net_payload(workspace, command, network),
    )
    .unwrap_or_else(|error| panic!("command.execute failed: {error}"))
}

fn net_payload(workspace: &Workspace, command: &str, network: Option<Value>) -> Value {
    let mut payload = json!({"workspaceId": workspace.id, "command": command, "timeoutMs": 60000, "maxOutputChars": 20000});
    if let Some(network) = network {
        payload["network"] = network;
    }
    payload
}

/// What the stand-in backend does with each `network.ask`: wait `delay`, then answer.
#[derive(Clone)]
struct Answer {
    delay: Duration,
    allow: bool,
    reason: Option<&'static str>,
}

/// Installs an outbound channel on `host.network` for its lifetime. With `answer` it resolves
/// every ask after the delay; without, it only records them (the ask stays pending).
struct ApprovalBridge {
    bridge: NetworkBridge,
    lease: Option<OutboundLease>,
    asks: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl ApprovalBridge {
    fn start(host: &LocalHost, answer: Option<Answer>) -> Self {
        let bridge = host.network.clone();
        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let lease = bridge.attach(sender);
        let asks = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let (bridge, asks, stop) = (bridge.clone(), asks.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    match frames.try_recv() {
                        Ok(frame) => {
                            asks.lock().unwrap().push(frame.clone());
                            if let Some(answer) = &answer {
                                std::thread::sleep(answer.delay);
                                let ask_id = frame["askId"].as_str().unwrap();
                                // Like the updated backend, echo `kind` for request asks (a decision
                                // without it cannot allow a request ask).
                                let kind = (frame["kind"] == "request").then_some("request");
                                bridge.resolve_kind(ask_id, answer.allow, answer.reason.map(str::to_string), kind);
                            }
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(10)),
                    }
                }
            })
        };
        Self {
            bridge,
            lease: Some(lease),
            asks,
            stop,
            worker: Some(worker),
        }
    }

    fn allowing(host: &LocalHost, delay_ms: u64) -> Self {
        Self::start(
            host,
            Some(Answer {
                delay: Duration::from_millis(delay_ms),
                allow: true,
                reason: None,
            }),
        )
    }

    fn asks(&self) -> Vec<Value> {
        self.asks.lock().unwrap().clone()
    }

    fn wait_for_ask(&self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(first) = self.asks().first() {
                return first.clone();
            }
            assert!(Instant::now() < deadline, "no network.ask was sent within 30 s");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for ApprovalBridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        drop(self.lease.take());
    }
}

fn audit(result: &Value) -> &Vec<Value> {
    result["networkAudit"]
        .as_array()
        .unwrap_or_else(|| panic!("result has no networkAudit: {result}"))
}

/// The first audit entry for which `matches` holds.
fn audit_entry<'a>(result: &'a Value, matches: impl Fn(&Value) -> bool) -> &'a Value {
    audit(result)
        .iter()
        .find(|entry| matches(entry))
        .unwrap_or_else(|| panic!("no matching audit entry in: {result}"))
}

fn npm_connection(entry: &Value, decision: &str, source: &str) -> bool {
    entry["kind"] == "connection"
        && entry["host"] == "registry.npmjs.org"
        && entry["port"] == 443
        && entry["decision"] == decision
        && entry["source"] == source
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn ask_mode_blocks_until_decision_then_connects() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let approvals = ApprovalBridge::allowing(&host, 300);
    let started = Instant::now();
    let result = execute_net(&host, "ask-allow", &workspace, FETCH_NPM, Some(policy("ask", &[])));
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "the connection cannot complete before the decision"
    );
    assert_eq!(output(&result).trim(), "200", "{result}");
    assert_eq!(result["exitCode"], 0, "{result}");
    let asks = approvals.asks();
    assert_eq!(asks.len(), 1, "exactly one network.ask: {asks:?}");
    assert_eq!(asks[0]["type"], "network.ask");
    assert_eq!(asks[0]["id"], "ask-allow");
    assert_eq!(asks[0]["host"], "registry.npmjs.org");
    assert_eq!(asks[0]["port"], 443);
    audit_entry(&result, |entry| npm_connection(entry, "allow", "approval"));
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn ask_mode_deny_reaches_model_text() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    // A real user denial: the backend's exact text ("denied by user") is what the sidecar
    // recognises as the user saying no.
    let approvals = ApprovalBridge::start(
        &host,
        Some(Answer {
            delay: Duration::from_millis(100),
            allow: false,
            reason: Some("denied by user"),
        }),
    );
    let result = execute_net(
        &host,
        "ask-deny",
        &workspace,
        &format!("{FETCH_NPM}; true"),
        Some(policy("ask", &[])),
    );
    assert_eq!(approvals.asks().len(), 1);
    let text = output(&result);
    assert!(text.contains("<sandbox_violations>"), "{result}");
    assert!(text.contains("denied by user"), "{result}");
    assert!(!text.starts_with("200"), "the request must not succeed: {result}");
    let entry = audit_entry(&result, |entry| npm_connection(entry, "deny", "user"));
    assert_eq!(entry["reason"], "denied by user");
    drop(approvals);

    // Any other reason is a system denial (a cancelled command, a timeout, an unavailable
    // approval...), not the user's decision: same model-visible text, source `unavailable`.
    let approvals = ApprovalBridge::start(
        &host,
        Some(Answer {
            delay: Duration::from_millis(100),
            allow: false,
            reason: Some("blocked by the test policy"),
        }),
    );
    let other = execute_net(
        &host,
        "ask-deny-system",
        &workspace,
        &format!("{FETCH_NPM}; true"),
        Some(policy("ask", &[])),
    );
    assert_eq!(approvals.asks().len(), 1);
    assert!(output(&other).contains("<sandbox_violations>"), "{other}");
    assert!(output(&other).contains("blocked by the test policy"), "{other}");
    let entry = audit_entry(&other, |entry| npm_connection(entry, "deny", "unavailable"));
    assert_eq!(entry["reason"], "blocked by the test policy");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn strict_mode_denies_without_asking() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    // A bridge that would allow anything, to prove it is never consulted.
    let approvals = ApprovalBridge::allowing(&host, 0);
    let result = execute_net(
        &host,
        "strict",
        &workspace,
        &format!("{FETCH_NPM}; true"),
        Some(policy("strict", &[])),
    );
    assert!(approvals.asks().is_empty(), "strict mode must not ask: {:?}", approvals.asks());
    assert!(output(&result).contains("<sandbox_violations>"), "{result}");
    audit_entry(&result, |entry| npm_connection(entry, "deny", "strict"));
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn rule_allows_without_asking() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let approvals = ApprovalBridge::allowing(&host, 0);
    let result = execute_net(
        &host,
        "rule",
        &workspace,
        FETCH_NPM,
        Some(policy("ask", &["registry.npmjs.org"])),
    );
    assert_eq!(output(&result).trim(), "200", "{result}");
    assert!(approvals.asks().is_empty(), "a rule match must not ask");
    audit_entry(&result, |entry| npm_connection(entry, "allow", "rule"));
    // The same rule in strict mode connects too.
    let strict = execute_net(
        &host,
        "rule-strict",
        &workspace,
        FETCH_NPM,
        Some(policy("strict", &["registry.npmjs.org"])),
    );
    assert_eq!(output(&strict).trim(), "200", "{strict}");
    assert!(approvals.asks().is_empty());
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn open_mode_unchanged() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let approvals = ApprovalBridge::allowing(&host, 0);
    let open = execute_net(&host, "open", &workspace, FETCH_NPM, Some(policy("open", &[])));
    assert_eq!(output(&open).trim(), "200", "{open}");
    audit_entry(&open, |entry| npm_connection(entry, "allow", "open"));
    // No network field at all behaves as open.
    let absent = execute_net(&host, "absent", &workspace, FETCH_NPM, None);
    assert_eq!(output(&absent).trim(), "200", "{absent}");
    audit_entry(&absent, |entry| npm_connection(entry, "allow", "open"));
    assert!(approvals.asks().is_empty(), "open mode must not ask");
}

#[test]
#[ignore = "requires bubblewrap, the sandbox bundle and /etc/hosts test entries"]
fn guard_beats_rule_and_approval() {
    require_hosts_entry("sw-private.test", "10.0.0.1");
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    // Every way to say yes: a rule for the target and a bridge that approves anything.
    let approvals = ApprovalBridge::allowing(&host, 0);
    for (call, target) in [
        ("guard-literal", "10.0.0.1:80"),
        ("guard-name", "sw-private.test:80"),
    ] {
        let allow = [target.split(':').next().unwrap(), target];
        let result = execute_net(
            &host,
            call,
            &workspace,
            &CONNECT_PROBE.replace("@TARGET@", target),
            Some(policy("ask", &allow)),
        );
        assert_connect_refused(&result, target, None);
        if call == "guard-literal" {
            // The sidecar's own guard refuses a literal address before any rule or approval.
            // (A name that merely resolves to a private address is refused by srt's dial-time
            // check instead, with a different message, so only the 403 is asserted for it.)
            assert!(
                output(&result).contains("public internet only"),
                "{target} must be refused by the address guard: {result}"
            );
            audit_entry(&result, |entry| {
                entry["decision"] == "deny" && entry["source"] == "guard" && entry["host"] == "10.0.0.1"
            });
        }
        assert!(
            audit(&result)
                .iter()
                .all(|entry| entry["decision"] == "deny" || entry["kind"] != "connection" || call == "guard-name"),
            "no connection to {target} may be audited as allowed: {result}"
        );
    }
    assert!(
        approvals.asks().is_empty(),
        "the bridge must not even be asked about guarded addresses: {:?}",
        approvals.asks()
    );
    // And the literal in `curl` form, mirroring `private_literal_blocked`.
    let curl = execute_net(
        &host,
        "guard-curl",
        &workspace,
        "curl -sS --noproxy '' --max-time 10 -o /dev/null -w %{http_code} http://10.0.0.1/; true",
        Some(policy("ask", &["10.0.0.1"])),
    );
    assert!(
        output(&curl).contains("sandbox_violations") || output(&curl).contains("403"),
        "{curl}"
    );
    audit_entry(&curl, |entry| {
        entry["decision"] == "deny" && entry["source"] == "guard" && entry["host"] == "10.0.0.1"
    });
    assert!(approvals.asks().is_empty());
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn concurrent_connections_share_one_ask() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    // A long answer delay, so the second curl's connection arrives while the first ask is
    // still in flight (and would raise a second one if asks were not shared).
    let approvals = ApprovalBridge::allowing(&host, 1500);
    let result = execute_net(
        &host,
        "concurrent",
        &workspace,
        r#"curl -sS -o /dev/null -w 'a=%{http_code}\n' https://registry.npmjs.org/left-pad & curl -sS -o /dev/null -w 'b=%{http_code}\n' https://registry.npmjs.org/is-number & wait"#,
        Some(policy("ask", &[])),
    );
    let text = output(&result);
    assert!(text.contains("a=200") && text.contains("b=200"), "{result}");
    let asks = approvals.asks();
    assert_eq!(asks.len(), 1, "two connections to one host:port share one ask: {asks:?}");
    assert_eq!(asks[0]["host"], "registry.npmjs.org");
    audit_entry(&result, |entry| npm_connection(entry, "allow", "approval"));
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn cancel_denies_pending_ask() {
    let (_app, host) = host_with_bundle();
    let host = Arc::new(host);
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    // Records asks but never answers, so the connection stays pending until the cancel.
    let approvals = ApprovalBridge::start(&host, None);
    let executions = Arc::new(Executions::default());
    let worker = {
        let host = host.clone();
        let executions = executions.clone();
        let payload = net_payload(
            &workspace,
            &format!("curl -sS --max-time 90 -o /dev/null {NPM_URL}; true"),
            Some(policy("ask", &[])),
        );
        let thread_id = workspace.thread_id.clone();
        std::thread::spawn(move || {
            host.dispatch(&executions, "cancel-ask", "owner", &thread_id, "command.execute", payload)
        })
    };
    let ask = approvals.wait_for_ask();
    let ask_id = ask["askId"].as_str().unwrap().to_string();
    assert_eq!(ask["id"], "cancel-ask");
    assert!(executions.cancel("cancel-ask"));
    let result = worker.join().unwrap().unwrap();
    assert_eq!(result["cancelled"], true, "{result}");
    // The pending ask was answered (denied) by the cancel: a late decision finds nothing.
    assert!(
        !approvals.bridge.resolve(&ask_id, true, None),
        "the cancelled command's ask must no longer be pending"
    );
    if let Some(entries) = result["networkAudit"].as_array() {
        assert!(
            entries
                .iter()
                .all(|entry| !(entry["kind"] == "connection" && entry["decision"] == "allow")),
            "a cancelled, unanswered ask must never be audited as allowed: {result}"
        );
    }
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn ask_timeout_denies() {
    let (_app, mut host) = host_with_bundle();
    // The sidecar starts lazily on the first command and captures the bridge then, so a bridge
    // with a short deadline swapped in now governs every ask of this test.
    host.network = NetworkBridge::with_timeout(Duration::from_secs(2));
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let approvals = ApprovalBridge::start(&host, None);
    let started = Instant::now();
    let result = execute_net(
        &host,
        "ask-timeout",
        &workspace,
        &format!("{FETCH_NPM}; true"),
        Some(policy("ask", &[])),
    );
    assert!(started.elapsed() >= Duration::from_secs(2), "{result}");
    assert_eq!(approvals.asks().len(), 1);
    let text = output(&result);
    assert!(text.contains("<sandbox_violations>"), "{result}");
    assert!(text.contains("approval timed out"), "{result}");
    // A timeout is the system's denial, not the user's: source `unavailable`.
    let entry = audit_entry(&result, |entry| npm_connection(entry, "deny", "unavailable"));
    assert_eq!(entry["reason"], "approval timed out");
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn plain_http_audit_has_method_and_path() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let _approvals = ApprovalBridge::allowing(&host, 0);
    let result = execute_net(
        &host,
        "plain-http",
        &workspace,
        "curl -sS -o /dev/null -w %{http_code} http://example.com/",
        Some(policy("ask", &["example.com"])),
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    let entry = audit_entry(&result, |entry| entry["kind"] == "http");
    assert_eq!(entry["method"], "GET", "{result}");
    assert_eq!(entry["host"], "example.com", "{result}");
    assert_eq!(entry["path"], "/", "{result}");
    assert_eq!(entry["decision"], "allow", "{result}");
    assert_eq!(entry["source"], "rule", "{result}");
    assert!(entry["status"].is_u64(), "status must be numeric: {result}");
}

// ---------------------------------------------------------------------------------------------
// Device vault: secret placeholders, injection into requests to the bound hosts, request
// approvals, and the TLS-termination CA.
//
// Why the upstream is a public echo service. The sandbox's address guard refuses loopback,
// private and own-interface addresses in every mode, so a stub server on the CI runner is
// unreachable by design, and the runner has no documentation-range network to host one. These
// tests therefore call two public echo endpoints that return the request headers, with throwaway
// `test-secret-<random>` values (never a real credential): `httpbin.org` for the bound host and
// `postman-echo.com` for "some other host". `require_endpoint` probes both first; an unreachable
// endpoint FAILS the test with its name (a silent skip would hide a broken suite).
// ---------------------------------------------------------------------------------------------

const BOUND_HEADERS: &str = "https://httpbin.org/headers";
const OTHER_HEADERS: &str = "https://postman-echo.com/headers";

/// An in-memory keychain for the vault.
#[derive(Default)]
struct MemoryVault(Mutex<std::collections::HashMap<String, Vec<u8>>>);

impl SecretStore for MemoryVault {
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.to_string(), secret.to_vec());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

fn host_with_vault() -> (tempfile::TempDir, LocalHost) {
    let (app, host) = host_with_bundle();
    host.set_secret_store(Arc::new(MemoryVault::default()));
    (app, host)
}

/// A throwaway secret value for one test.
fn test_value() -> String {
    format!("test-secret-{}", uuid::Uuid::new_v4().simple())
}

fn add_secret(host: &LocalHost, env_var: &str, value: &str, hosts: &[&str], read_only: bool) {
    host.vault_set(NewSecret {
        label: format!("{env_var} (test)"),
        env_var: env_var.to_string(),
        value: value.to_string(),
        hosts: hosts.iter().map(|h| h.to_string()).collect(),
        read_only,
        acknowledged_interception: Some(true),
    })
    .unwrap_or_else(|error| panic!("vault_set failed: {error}"));
}

/// Fails (does not skip) unless `url` answers 200 to a direct request from this machine, with a
/// few retries. Direct means no proxy: CI exports poisoned `http_proxy`/`https_proxy` variables
/// for this suite.
fn require_endpoint(url: &str) {
    let mut last = String::new();
    for attempt in 0..4 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2));
        }
        let probe = std::process::Command::new("curl")
            .args(["--noproxy", "*", "-sS", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code}", url])
            .output();
        match probe {
            Ok(out) if String::from_utf8_lossy(&out.stdout).trim() == "200" => return,
            Ok(out) => {
                last = format!(
                    "HTTP {} {}",
                    String::from_utf8_lossy(&out.stdout).trim(),
                    String::from_utf8_lossy(&out.stderr).trim()
                )
            }
            Err(error) => last = error.to_string(),
        }
    }
    panic!(
        "the echo endpoint {url} is unreachable from this machine ({last}); the secret-injection \
         suite needs it and does not skip silently"
    );
}

fn require_echo_endpoints() {
    require_endpoint(BOUND_HEADERS);
    require_endpoint(OTHER_HEADERS);
}

/// Sends `Authorization: Bearer $TEST_TOKEN` to `url` from inside the sandbox and prints
/// `PLACEHOLDER=<what the command's variable holds>` and the echoed headers.
fn echo_command(url: &str) -> String {
    format!(
        "printf 'PLACEHOLDER=%s\\n' \"$TEST_TOKEN\"; \
         curl -sS --max-time 40 -H \"Authorization: Bearer $TEST_TOKEN\" {url}"
    )
}

fn placeholder_of(result: &Value) -> String {
    output(result)
        .lines()
        .find_map(|line| line.strip_prefix("PLACEHOLDER="))
        .unwrap_or_else(|| panic!("no PLACEHOLDER line in: {result}"))
        .trim()
        .to_string()
}

#[test]
#[ignore = "requires bubblewrap, the sandbox bundle and public echo endpoints"]
fn fake_value_in_env_and_real_value_upstream() {
    require_echo_endpoints();
    let (_app, host) = host_with_vault();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let value = test_value();
    add_secret(&host, "TEST_TOKEN", &value, &["httpbin.org"], true);
    let result = execute_net(
        &host,
        "inject",
        &workspace,
        &format!("env | grep '^TEST_TOKEN=fake_value_'; {}", echo_command(BOUND_HEADERS)),
        Some(policy("open", &[])),
    );
    let text = output(&result);
    // bwrap passed the placeholder through to the child's environment...
    assert!(text.contains("TEST_TOKEN=fake_value_"), "{result}");
    let placeholder = placeholder_of(&result);
    assert!(placeholder.starts_with("fake_value_"), "{placeholder}");
    assert!(!placeholder.contains(&value));
    // ...and the upstream saw the real value, not the placeholder.
    assert!(text.contains(&format!("Bearer {value}")), "upstream must receive the real value: {result}");
    assert!(!text.contains(&format!("Bearer {placeholder}")), "{result}");
}

#[test]
#[ignore = "requires bubblewrap, the sandbox bundle and public echo endpoints"]
fn other_host_gets_placeholder_not_secret() {
    require_echo_endpoints();
    let (_app, host) = host_with_vault();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let value = test_value();
    add_secret(&host, "TEST_TOKEN", &value, &["httpbin.org"], true);
    // The same variable, sent to a host the secret is not bound to.
    let result = execute_net(
        &host,
        "other-host",
        &workspace,
        &echo_command(OTHER_HEADERS),
        Some(policy("open", &[])),
    );
    let text = output(&result);
    let placeholder = placeholder_of(&result);
    assert!(
        text.matches(&placeholder).count() >= 2,
        "the other host must be sent (and echo) the placeholder: {result}"
    );
    assert!(!text.contains(&value), "the real value must never reach another host: {result}");
}

#[test]
#[ignore = "requires bubblewrap, the sandbox bundle and public echo endpoints"]
fn write_needs_approval_read_does_not() {
    require_echo_endpoints();
    let (_app, host) = host_with_vault();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    add_secret(&host, "TEST_TOKEN", &test_value(), &["httpbin.org"], true);
    let post = "curl -sS --max-time 40 -X POST -d x=1 -H \"Authorization: Bearer $TEST_TOKEN\" \
                -w '\\nSTATUS=%{http_code}\\n' https://httpbin.org/post";
    let get = "curl -sS --max-time 40 -o /dev/null -w 'STATUS=%{http_code}\\n' \
               -H \"Authorization: Bearer $TEST_TOKEN\" https://httpbin.org/headers";

    // A read needs no approval (and the bound host needs no host-level ask either: its being
    // bound to the secret already allows it).
    let approvals = ApprovalBridge::allowing(&host, 0);
    let read = execute_net(&host, "vault-get", &workspace, get, Some(policy("ask", &[])));
    assert!(output(&read).contains("STATUS=200"), "{read}");
    assert!(approvals.asks().is_empty(), "a GET must not ask: {:?}", approvals.asks());

    // A write asks, as a request-kind approval, and goes through once allowed.
    let written = execute_net(&host, "vault-post-allow", &workspace, post, Some(policy("ask", &[])));
    assert!(output(&written).contains("STATUS=200"), "{written}");
    let asks = approvals.asks();
    assert_eq!(asks.len(), 1, "{asks:?}");
    assert_eq!(asks[0]["kind"], "request");
    assert_eq!(asks[0]["method"], "POST");
    assert_eq!(asks[0]["path"], "/post");
    assert_eq!(asks[0]["host"], "httpbin.org");
    assert_eq!(asks[0]["port"], 443);
    drop(approvals);

    // Denied: the request is answered 403 and the model is told why.
    let denying = ApprovalBridge::start(
        &host,
        Some(Answer {
            delay: Duration::from_millis(50),
            allow: false,
            reason: Some("no writes today"),
        }),
    );
    let denied = execute_net(&host, "vault-post-deny", &workspace, post, Some(policy("ask", &[])));
    let text = output(&denied);
    assert!(text.contains("STATUS=403"), "{denied}");
    assert!(text.contains("no writes today"), "{denied}");
    assert_eq!(denying.asks().len(), 1);
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn ca_key_unreadable_in_sandbox() {
    let (app, host) = host_with_vault();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    add_secret(&host, "TEST_TOKEN", &test_value(), &["httpbin.org"], true);
    let ca_dir = app.path().canonicalize().unwrap().join("sandbox/ca");
    let result = execute_net(
        &host,
        "ca-key",
        &workspace,
        &format!(
            "printf ran > .sw-control; cat {key} 2>&1; echo KEY_EXIT=$?; ls {dir} 2>&1; echo LS_EXIT=$?",
            key = quoted(&ca_dir.join("ca.key")),
            dir = quoted(&ca_dir),
        ),
        Some(policy("open", &[])),
    );
    assert_eq!(fs::read_to_string(workspace.path.join(".sw-control")).unwrap(), "ran", "{result}");
    let text = output(&result);
    assert!(!text.contains("PRIVATE KEY"), "the CA key must not be readable in the sandbox: {result}");
    assert!(!text.contains("KEY_EXIT=0"), "{result}");
    // The CA exists on the host (TLS termination really was on) and its key is owner-only.
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(ca_dir.join("ca.key")).expect("ca.key was created").permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    assert!(ca_dir.join("ca.crt").is_file());
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn no_tls_when_vault_empty() {
    let (app, host) = host_with_vault();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute_net(
        &host,
        "no-tls",
        &workspace,
        "env | grep -E '^(SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|GIT_SSL_CAINFO|PIP_CERT|CARGO_HTTP_CAINFO)=' ; \
         echo TRUST_ENV_DONE; \
         curl -sS --max-time 40 -o /dev/null -w 'STATUS=%{http_code} VERIFY=%{ssl_verify_result}\\n' https://registry.npmjs.org/left-pad",
        Some(policy("open", &[])),
    );
    let text = output(&result);
    // No trust-bundle variables: nothing re-signs this traffic.
    let before_done = text.split("TRUST_ENV_DONE").next().unwrap();
    assert!(before_done.trim().is_empty(), "no CA trust variable may be set with an empty vault: {result}");
    // The upstream's own certificate chain verified against the system trust store.
    assert!(text.contains("STATUS=200 VERIFY=0"), "{result}");
    assert!(
        !app.path().canonicalize().unwrap().join("sandbox/ca").exists(),
        "no CA is created while the vault is empty"
    );
}

#[test]
#[ignore = "requires bubblewrap, the sandbox bundle and public echo endpoints"]
fn https_audit_has_method_path_status() {
    require_echo_endpoints();
    let (_app, host) = host_with_vault();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    add_secret(&host, "TEST_TOKEN", &test_value(), &["httpbin.org"], true);
    let result = execute_net(
        &host,
        "https-audit",
        &workspace,
        "curl -sS --max-time 40 -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer $TEST_TOKEN\" 'https://httpbin.org/headers?token=do-not-record'",
        Some(policy("open", &[])),
    );
    assert_eq!(output(&result).trim(), "200", "{result}");
    let entry = audit_entry(&result, |entry| entry["kind"] == "http");
    assert_eq!(entry["method"], "GET", "{result}");
    assert_eq!(entry["host"], "httpbin.org", "{result}");
    assert_eq!(entry["port"], 443, "{result}");
    assert_eq!(entry["path"], "/headers", "the query string must not be audited: {result}");
    assert_eq!(entry["status"], 200, "{result}");
    assert!(!result.to_string().contains("do-not-record"), "{result}");
}

#[test]
#[ignore = "requires bubblewrap, the sandbox bundle and public echo endpoints"]
fn real_value_absent_from_all_outputs() {
    require_echo_endpoints();
    let (_app, host) = host_with_vault();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let value = test_value();
    add_secret(&host, "TEST_TOKEN", &value, &["httpbin.org"], true);
    // Everything a command can print about itself, plus requests that succeed, are denied, and
    // go to another host. Response bodies are discarded so the upstream's echo cannot appear.
    let script = "env; printenv TEST_TOKEN; \
         curl -sS --max-time 40 -o /dev/null -w 'GET=%{http_code}\\n' -H \"Authorization: Bearer $TEST_TOKEN\" https://httpbin.org/headers; \
         curl -sS --max-time 40 -o /dev/null -w 'POST=%{http_code}\\n' -X POST -d x=1 -H \"Authorization: Bearer $TEST_TOKEN\" https://httpbin.org/post; \
         curl -sS --max-time 40 -o /dev/null -w 'OTHER=%{http_code}\\n' -H \"Authorization: Bearer $TEST_TOKEN\" https://postman-echo.com/headers; \
         echo \"$TEST_TOKEN\" > placeholder.txt; ls -la; true";
    // Once with the write allowed, once denied.
    for (call, allow) in [("scan-allow", true), ("scan-deny", false)] {
        let approvals = ApprovalBridge::start(
            &host,
            Some(Answer {
                delay: Duration::from_millis(50),
                allow,
                reason: Some("scan reason"),
            }),
        );
        let result = execute_net(&host, call, &workspace, script, Some(policy("ask", &["postman-echo.com"])));
        drop(approvals);
        let everything = result.to_string();
        assert!(!everything.contains(&value), "{call}: the real value leaked into the result JSON: {everything}");
        assert!(output(&result).contains("TEST_TOKEN=fake_value_"), "{call}: {result}");
        assert!(output(&result).contains("GET=200"), "{call}: {result}");
        for entry in audit(&result) {
            assert!(!entry.to_string().contains(&value), "{call}: {entry}");
        }
        // Not in the files the command wrote either (it only ever had the placeholder).
        let written = fs::read_to_string(workspace.path.join("placeholder.txt")).unwrap();
        assert!(written.trim().starts_with("fake_value_") && !written.contains(&value));
    }
}
