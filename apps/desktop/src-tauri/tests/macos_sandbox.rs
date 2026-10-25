#![cfg(target_os = "macos")]
//! Run explicitly on an unrestricted macOS test host:
//! cargo test --test macos_sandbox -- --ignored
//! The outer Codex sandbox cannot call sandbox_apply; do not skip or silently
//! replace this test with unconfined command execution.
use sourceweft_desktop::local_host::sandbox::{isolation_probe_profile, probe_seatbelt};
use std::{fs, process::Command};

fn run(profile: &str, command: &str, args: &[&str]) -> std::process::Output {
    Command::new("/usr/bin/sandbox-exec")
        .args(["-p", profile, command])
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap()
}

#[test]
#[ignore = "requires sandbox_apply on a real macOS host"]
fn seatbelt_enforces_filesystem_network_and_child_process_boundaries() {
    let working = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    probe_seatbelt(working.path()).unwrap();
    let policy = isolation_probe_profile(working.path()).unwrap();
    let allowed = working.path().join("output.txt");
    let denied = outside.path().join("secret.txt");
    fs::write(&denied, "private-data").unwrap();
    let output = run(
        &policy,
        "/bin/sh",
        &[
            "-c",
            "printf success > \"$1\"",
            "sh",
            allowed.to_str().unwrap(),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::read_to_string(&allowed).unwrap(), "success");
    let read = run(&policy, "/bin/cat", &[denied.to_str().unwrap()]);
    assert!(!read.status.success());
    assert!(!String::from_utf8_lossy(&read.stdout).contains("private-data"));
    let write = run(
        &policy,
        "/bin/sh",
        &[
            "-c",
            "printf overwritten > \"$1\"",
            "sh",
            denied.to_str().unwrap(),
        ],
    );
    assert!(!write.status.success());
    assert_eq!(fs::read_to_string(&denied).unwrap(), "private-data");
    let child = run(
        &policy,
        "/bin/sh",
        &["-c", "/bin/cat \"$1\"", "sh", denied.to_str().unwrap()],
    );
    assert!(!child.status.success());
    std::os::unix::fs::symlink(&denied, working.path().join("escape")).unwrap();
    assert!(!run(
        &policy,
        "/bin/cat",
        &[working.path().join("escape").to_str().unwrap()]
    )
    .status
    .success());

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let control = Command::new("/usr/bin/nc")
        .args(["-z", "-w", "1", "127.0.0.1", &port])
        .status()
        .unwrap();
    assert!(
        control.success(),
        "Network control must prove the endpoint is available"
    );
    let network = run(
        &policy,
        "/usr/bin/nc",
        &["-z", "-w", "1", "127.0.0.1", &port],
    );
    assert!(
        !network.status.success(),
        "Block-all probe unexpectedly reached localhost"
    );
}

#[test]
fn profile_cannot_be_injected_through_a_workspace_name() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("quoted\"(allow network*)");
    fs::create_dir(&path).unwrap();
    let profile = isolation_probe_profile(&path).unwrap();
    assert!(profile.contains("quoted\\\"(allow network*)"));
}

/// Minimal real-sandbox regression suite for Task 2's tight macOS read policy, run through the
/// production `LocalHost` + `dispatch` path against a built `sandbox-sidecar` bundle (copied into
/// `<temp app data>/sandbox/current`, like `linux_sandbox.rs`). Every test is `#[ignore]`; run on
/// a real macOS host with:
///
///   cargo test --test macos_sandbox -- --include-ignored
///
/// Kept deliberately small and self-contained — Task 4 rewrites this file into the full macOS
/// real-sandbox suite. The subtle "a granted fake `$HOME` still hides its `Library/Keychains`"
/// case is a policy-shape property proven in `sandbox-sidecar/tests/policy.test.ts`
/// (`DARWIN_CREDENTIALS`) and by hand against the real sidecar; here the sandbox's `home` is the
/// real `$HOME`, so the equivalent check is `keychains_are_unreadable`.
#[cfg(test)]
mod tight_reads {
    use serde_json::{json, Value};
    use sourceweft_desktop::local_host::{execution::Executions, LocalHost, Workspace};
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn built_bundle_source() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sandbox-sidecar/dist/bundle")
    }

    fn copy_bundle_into(dest: &Path) {
        let source = built_bundle_source();
        assert!(
            source.join("srt-sidecar").is_file(),
            "expected a built sidecar bundle at {source:?}; run `bun run build --rg \
             \"$(command -v rg)\"` in apps/desktop/sandbox-sidecar first"
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

    /// srt treats an existing `/tmp/claude` as its own writable TMPDIR (the state on any machine
    /// that also runs Claude Code); create it once so every test runs in that configuration.
    fn ensure_tmp_claude() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            fs::create_dir_all("/tmp/claude").expect("create /tmp/claude");
        });
    }

    fn host_with_bundle() -> (tempfile::TempDir, LocalHost) {
        ensure_tmp_claude();
        let app = tempfile::tempdir().unwrap();
        copy_bundle_into(&app.path().join("sandbox/current"));
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

    /// Runs `command` after a positive control that must succeed inside the sandbox, so a denial
    /// test cannot pass merely because the command never ran (e.g. a missing binary).
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

    fn quoted(path: &Path) -> String {
        format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
    }

    struct RemoveOnDrop(PathBuf);
    impl Drop for RemoveOnDrop {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    #[ignore = "requires sandbox_apply and the sandbox bundle"]
    fn tight_policy_allows_the_toolchain_and_the_workspace() {
        let (_app, host) = host_with_bundle();
        let workspace = host.ensure_workspace("owner", "thread").unwrap();
        let result = execute(
            &host,
            "toolchain",
            &workspace,
            // Workspace write+read, a system tool (/usr/bin), a login-PATH toolchain (node), and
            // the /etc symlink spelling all under the tight read policy.
            "printf hi > f.txt && cat f.txt && /usr/bin/grep -c hi f.txt && \
             node -e 'console.log(\"node\",process.version)' && head -c1 /etc/hosts >/dev/null && \
             echo toolchain-ok",
        );
        assert_eq!(result["exitCode"], 0, "{result}");
        assert!(output(&result).contains("toolchain-ok"), "{result}");
        assert_eq!(fs::read_to_string(workspace.path.join("f.txt")).unwrap(), "hi");
    }

    #[test]
    #[ignore = "requires sandbox_apply and the sandbox bundle"]
    fn keychains_are_unreadable() {
        let (_app, host) = host_with_bundle();
        let workspace = host.ensure_workspace("owner", "thread").unwrap();
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        // ~/Library/Keychains (login keychain) and the system keychain: both must be denied, and
        // nothing of their bytes may surface. No content is written anywhere by this test.
        let result = execute_denied(
            &host,
            "keychains",
            &workspace,
            &format!(
                "ls {} 2>&1; cat /Library/Keychains/System.keychain 2>&1 | head -c0",
                quoted(&home.join("Library/Keychains"))
            ),
        );
        assert!(
            output(&result).contains("Operation not permitted")
                || output(&result).contains("Permission denied"),
            "keychains directory was not denied: {result}"
        );
        // Direct read of the login keychain db file, if present, must also be denied.
        let login = home.join("Library/Keychains/login.keychain-db");
        if login.exists() {
            let r = execute_denied(&host, "login-kc", &workspace, &format!("cat {}", quoted(&login)));
            assert_ne!(r["exitCode"], 0, "login keychain was readable: {r}");
        }
    }

    #[test]
    #[ignore = "requires sandbox_apply and the sandbox bundle"]
    fn home_and_system_secrets_are_denied() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        // A planted home secret (outside any workspace) and the shadow password file.
        let secret_path = home.join(".sw-test-secret");
        let secret = format!("sw-secret-{}", uuid::Uuid::new_v4().simple());
        fs::write(&secret_path, &secret).unwrap();
        let _cleanup = RemoveOnDrop(secret_path.clone());

        let (_app, host) = host_with_bundle();
        let workspace = host.ensure_workspace("owner", "thread").unwrap();
        let result = execute_denied(
            &host,
            "secrets",
            &workspace,
            &format!(
                "cat {} 2>&1; cat /etc/master.passwd 2>&1; ls {} 2>&1; ls /Users 2>&1",
                quoted(&secret_path),
                quoted(&home.join(".ssh"))
            ),
        );
        assert!(
            !output(&result).contains(&secret),
            "home secret leaked into the sandbox: {result}"
        );
        assert!(
            !output(&result).contains("root:"),
            "/etc/master.passwd contents leaked: {result}"
        );
    }

    #[test]
    #[ignore = "requires sandbox_apply and the sandbox bundle"]
    fn granted_folder_outside_home_is_usable_and_still_hides_keychains() {
        let (_app, host) = host_with_bundle();
        // A granted folder outside $HOME (a temp dir under /var/folders-style storage), made the
        // workspace through the native-picker grant path.
        let outside = tempfile::tempdir().unwrap();
        let grant = host.register_folder("owner", outside.path()).unwrap();
        let grant_id = grant["id"].as_str().unwrap();
        let workspace = host
            .ensure_workspace_with_grant("owner", "thread", Some(grant_id))
            .unwrap();
        let result = execute(
            &host,
            "granted",
            &workspace,
            "printf out > g.txt && cat g.txt && echo granted-ok",
        );
        assert_eq!(result["exitCode"], 0, "{result}");
        assert!(output(&result).contains("granted-ok"), "{result}");
        // The keychains stay hidden even from a workspace outside $HOME.
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let denied = execute_denied(
            &host,
            "granted-kc",
            &workspace,
            &format!("ls {} 2>&1", quoted(&home.join("Library/Keychains"))),
        );
        assert!(
            denied["exitCode"] != 0
                || output(&denied).contains("Operation not permitted")
                || output(&denied).contains("Permission denied"),
            "keychains readable from a granted folder: {denied}"
        );
    }
}
