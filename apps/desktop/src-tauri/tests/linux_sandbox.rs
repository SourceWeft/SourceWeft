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
//! No new environment variables may be added to the product, and that restriction extends to
//! how this test locates its fixtures: the bundle is located relative to
//! `CARGO_MANIFEST_DIR`, at `apps/desktop/sandbox-sidecar/dist/bundle` (git-ignored). The
//! verification recipe copies a container-built bundle there before running `cargo test`.
use serde_json::{json, Value};
use sourceweft_desktop::local_host::{
    execution::Executions,
    readiness::{bundle_dir, probe_bundle, Helpers, InitConfig, Platform, SandboxReadiness},
    LocalHost, Workspace,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
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
        helpers: Helpers {
            ripgrep: "/usr/bin/rg".to_string(),
            apply_seccomp: None,
            java_agent_jar: None,
        },
        bwrap_path: Some(bwrap_path.to_string()),
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
    let temp = tempfile::tempdir().unwrap();
    let bundle = bundle_dir(temp.path());
    copy_bundle_into(&bundle);
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();

    let readiness = probe_bundle(&bundle, &harness_init("/usr/bin/bwrap", &workspace));
    match readiness {
        SandboxReadiness::NeedsSetup { reason } => {
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
    // Local-only counterpart to the test above: this Mac's Docker Desktop Linux container has
    // no AppArmor, so /usr/bin/bwrap is unrestricted here and the same harness should report
    // Ready. The RTM_NEWADDR/NeedsSetup assertion above is proven only on a real Ubuntu 24.04
    // kernel in Task 9 CI, not in this container.
    let temp = tempfile::tempdir().unwrap();
    let bundle = bundle_dir(temp.path());
    copy_bundle_into(&bundle);
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();

    let readiness = probe_bundle(&bundle, &harness_init("/usr/bin/bwrap", &workspace));
    assert!(
        matches!(readiness, SandboxReadiness::Ready { .. }),
        "expected Ready against a working /usr/bin/bwrap in this unrestricted container, got \
         {readiness:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// Execution through the production `LocalHost` path.
// ---------------------------------------------------------------------------------------------

/// A `LocalHost` over a fresh temporary app-data directory with the built bundle installed at
/// `<app data>/sandbox/current`, exactly where production looks for it.
fn host_with_bundle() -> (tempfile::TempDir, LocalHost) {
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
        ["cancelled", "exitCode", "output", "truncated"],
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
    let result = execute(
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
    let result = execute(
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
