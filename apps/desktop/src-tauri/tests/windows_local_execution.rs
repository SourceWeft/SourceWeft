#![cfg(windows)]
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;
use sourceweft_desktop::local_host::{execution::Executions, windows_execution, LocalHost};
use std::{fs, sync::Arc, time::Duration};

#[test]
fn windows_files_preserve_owner_directory_identity_and_file_versions() {
    let app = tempfile::tempdir().unwrap();
    let selected = tempfile::tempdir().unwrap();
    let host = LocalHost::open(app.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    let (grant, _) = host.grant_directory("owner", selected.path()).unwrap();
    let workspace = host
        .ensure_workspace_with_grant("owner", "thread", Some(&grant))
        .unwrap();
    let calls = Executions::default();
    host.write_bytes(
        "owner",
        "thread",
        &workspace.id,
        "任务.txt",
        b"original",
        None,
    )
    .unwrap();
    assert_eq!(
        host.read_bytes("owner", "thread", &workspace.id, "任务.txt")
            .unwrap(),
        b"original"
    );
    assert!(host
        .read_bytes("other", "thread", &workspace.id, "任务.txt")
        .is_err());
    assert_eq!(
        host.write_bytes(
            "owner",
            "thread",
            &workspace.id,
            "任务.txt",
            b"changed",
            Some(b"stale")
        )
        .unwrap_err()
        .code,
        "FILE_VERSION_CONFLICT"
    );
    let result = host
        .write_bytes(
            "owner",
            "thread",
            &workspace.id,
            "任务.txt",
            b"changed",
            Some(b"original"),
        )
        .unwrap();
    assert!(result["backupId"].is_string());
    for path in [
        "../outside",
        "C:/outside",
        "任务.txt:stream",
        "NUL",
        "CON.txt",
        "file.",
        "sub\\file",
    ] {
        assert!(
            host.read_bytes("owner", "thread", &workspace.id, path)
                .is_err(),
            "{path}"
        );
    }
    fs::hard_link(
        workspace.path.join("任务.txt"),
        workspace.path.join("linked.txt"),
    )
    .unwrap();
    assert_eq!(
        host.read_bytes("owner", "thread", &workspace.id, "linked.txt")
            .unwrap_err()
            .code,
        "HARDLINK_NOT_ALLOWED"
    );
    fs::remove_file(workspace.path.join("linked.txt")).unwrap();
    // Junction fixtures do not require Windows Developer Mode/admin symlink rights.
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "outside").unwrap();
    let junction = workspace.path.join("junction");
    let system_cmd = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32")
        .join("cmd.exe");
    use std::os::windows::process::CommandExt;
    let link_path = sourceweft_desktop::local_host::wire_path(&junction).replace('/', "\\");
    let target_path = sourceweft_desktop::local_host::wire_path(outside.path()).replace('/', "\\");
    // cmd builtins require CMD quoting rather than Command's CRT argv quoting.
    assert!(!link_path.contains(['"', '%']) && !target_path.contains(['"', '%']));
    let created = std::process::Command::new(system_cmd)
        .raw_arg(format!("/d /c mklink /J \"{link_path}\" \"{target_path}\""))
        .output()
        .unwrap();
    assert!(
        created.status.success(),
        "Junction fixture {link_path} -> {target_path} must be created: {:?}",
        created
    );
    assert!(host
        .read_bytes("owner", "thread", &workspace.id, "junction/secret.txt")
        .is_err());
    assert!(host
        .write_bytes(
            "owner",
            "thread",
            &workspace.id,
            "junction/new.txt",
            b"denied",
            None
        )
        .is_err());
    assert!(host.grant_directory("owner", &junction).is_err());
    assert!(!outside.path().join("new.txt").exists());
    fs::remove_dir(&junction).unwrap();
    let draft = host
        .dispatch(
            &calls,
            "preview",
            "owner",
            "",
            "folder.read",
            json!({"folderId":grant,"path":"任务.txt"}),
        )
        .unwrap();
    assert_eq!(
        STANDARD.decode(draft["content"].as_str().unwrap()).unwrap(),
        b"changed"
    );
    host.dispatch(
        &calls,
        "mkdir",
        "owner",
        "thread",
        "file.mkdir",
        json!({"workspaceId":workspace.id,"path":"nested/目录"}),
    )
    .unwrap();
    host.write_bytes(
        "owner",
        "thread",
        &workspace.id,
        "nested/目录/report.txt",
        b"ok",
        None,
    )
    .unwrap();
    let listed = host
        .dispatch(
            &calls,
            "list",
            "owner",
            "thread",
            "file.list",
            json!({"workspaceId":workspace.id,"path":".","recursive":true}),
        )
        .unwrap();
    assert!(listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["path"] == "nested/目录/report.txt"));
    fs::rename(selected.path(), selected.path().with_extension("moved")).unwrap();
    fs::create_dir(selected.path()).unwrap();
    assert_eq!(
        host.check_workspace("owner", "thread", Some(&workspace.id), Some(&grant))
            .unwrap_err()
            .code,
        "WORKSPACE_REPLACED"
    );
    fs::remove_dir_all(selected.path().with_extension("moved")).unwrap();
}

#[test]
fn windows_automatic_workspace_is_persistent_and_queued_cancellation_never_executes() {
    let app = tempfile::tempdir().unwrap();
    let host = LocalHost::open(app.path()).unwrap();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    host.write_bytes("owner", "thread", &workspace.id, "kept.txt", b"kept", None)
        .unwrap();
    drop(host);
    let host = LocalHost::open(app.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    assert_eq!(
        host.ensure_workspace("owner", "thread").unwrap().id,
        workspace.id
    );
    let calls = Executions::default();
    calls.cancel("queued");
    assert_eq!(
        host.dispatch(
            &calls,
            "queued",
            "owner",
            "thread",
            "file.write",
            json!({"workspaceId":workspace.id,"path":"forbidden.txt","content":"eA=="})
        )
        .unwrap_err()
        .code,
        "CALL_CANCELLED"
    );
    assert!(!workspace.path.join("forbidden.txt").exists());
}

#[test]
fn real_niubash_executes_once_bounds_output_and_terminates_descendants() {
    // Exercise the bundled default with neither an installed Shell nor opt-in.
    struct RestoreEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for RestoreEnvironment {
        fn drop(&mut self) {
            for (key, value) in &self.0 {
                if let Some(value) = value {
                    std::env::set_var(key, value);
                } else {
                    std::env::remove_var(key);
                }
            }
        }
    }
    let _restore = RestoreEnvironment(
        [
            "SOURCEWEFT_NIUBASH_PATH",
            "SOURCEWEFT_WINDOWS_TRUSTED_LOCAL_EXECUTION",
            "SOURCEWEFT_TEST_SECRET",
            "BASH_ENV",
            "NIU_ENV",
            "PATH",
        ]
        .into_iter()
        .map(|name| (name, std::env::var_os(name)))
        .collect(),
    );
    std::env::remove_var("SOURCEWEFT_NIUBASH_PATH");
    std::env::remove_var("SOURCEWEFT_WINDOWS_TRUSTED_LOCAL_EXECUTION");
    let niubash = windows_execution::resolve_niubash()
        .expect("Prepare bundled niubash before running Windows execution tests");
    assert!(niubash.ends_with("resources/niubash/niu.exe"));
    windows_execution::require_trusted_execution().unwrap();
    std::env::set_var("SOURCEWEFT_WINDOWS_TRUSTED_LOCAL_EXECUTION", "false");
    assert_eq!(
        windows_execution::require_trusted_execution()
            .unwrap_err()
            .code,
        "WINDOWS_LOCAL_EXECUTION_DISABLED"
    );
    std::env::set_var("SOURCEWEFT_WINDOWS_TRUSTED_LOCAL_EXECUTION", "invalid");
    assert_eq!(
        windows_execution::require_trusted_execution()
            .unwrap_err()
            .code,
        "INVALID_LOCAL_EXECUTION_CONFIG"
    );
    std::env::remove_var("SOURCEWEFT_WINDOWS_TRUSTED_LOCAL_EXECUTION");
    let app = tempfile::tempdir().unwrap();
    std::env::set_var(
        "SOURCEWEFT_NIUBASH_PATH",
        app.path().join("missing-niu.exe"),
    );
    assert_eq!(
        windows_execution::require_trusted_execution()
            .unwrap_err()
            .code,
        "NIUBASH_UNAVAILABLE"
    );
    // An invalid explicit override fails even with a valid bundled runtime.
    std::env::set_var("SOURCEWEFT_NIUBASH_PATH", &niubash);
    assert_eq!(windows_execution::resolve_niubash().unwrap(), niubash);
    std::env::remove_var("SOURCEWEFT_NIUBASH_PATH");
    let host = Arc::new(LocalHost::open(app.path()).unwrap());
    host.initialize_invocation_journal().unwrap();
    let w = host.ensure_workspace("owner", "thread").unwrap();
    let calls = Arc::new(Executions::default());
    let execute = |id: &str, script: &str, timeout: u64, max: usize| {
        host.dispatch(
            &calls,
            id,
            "owner",
            "thread",
            "command.execute",
            json!({"workspaceId":w.id,"command":script,"timeoutMs":timeout,"maxOutputChars":max}),
        )
    };
    let native_path = std::env::var_os("PATH");
    std::env::set_var("PATH", "");
    let bundled = execute("bundled", "printf bundled-ready | cat", 10000, 100).unwrap();
    assert_eq!(bundled["exitCode"], 0, "{bundled}");
    assert_eq!(bundled["output"], "bundled-ready");
    if let Some(path) = native_path {
        std::env::set_var("PATH", path);
    } else {
        std::env::remove_var("PATH");
    }
    let payload = json!({"workspaceId":w.id,"command":"printf 'one\\n' >> result.txt; cat result.txt","timeoutMs":10000,"maxOutputChars":2000});
    let first = host
        .dispatch(
            &calls,
            "once",
            "owner",
            "thread",
            "command.execute",
            payload.clone(),
        )
        .unwrap();
    assert_eq!(first["exitCode"], 0, "{first}");
    assert_eq!(
        host.dispatch(
            &calls,
            "once",
            "owner",
            "thread",
            "command.execute",
            payload
        )
        .unwrap(),
        first
    );
    assert_eq!(
        fs::read_to_string(w.path.join("result.txt")).unwrap(),
        "one\n"
    );
    assert_eq!(
        host.read_text("owner", "thread", &w.id, "result.txt")
            .unwrap(),
        "one\n"
    );
    host.write_bytes(
        "owner",
        "thread",
        &w.id,
        "result.txt",
        b"edited",
        Some(b"one\n"),
    )
    .unwrap();
    assert_eq!(
        execute("edited", "cat result.txt", 10000, 100).unwrap()["output"],
        "edited"
    );
    assert_eq!(
        execute("exit", "exit 7", 10000, 100).unwrap()["exitCode"],
        7
    );
    let args = execute(
        "args",
        "node -e 'console.log(JSON.stringify(process.argv.slice(1)))' 'a b' '' '中文'",
        10000,
        1000,
    )
    .unwrap();
    assert_eq!(
        args["output"].as_str().unwrap().trim(),
        "[\"a b\",\"\",\"中文\"]"
    );
    let limited = execute(
        "bounded",
        "node -e 'process.stdout.write(\"x\".repeat(200000))'",
        10000,
        100,
    )
    .unwrap();
    assert_eq!(limited["output"].as_str().unwrap().len(), 100);
    assert_eq!(limited["truncated"], true);
    std::env::set_var("SOURCEWEFT_TEST_SECRET", "should-not-be-inherited");
    std::env::set_var("BASH_ENV", w.path.join("hook.sh"));
    std::env::set_var("NIU_ENV", w.path.join("hook.sh"));
    fs::write(w.path.join("hook.sh"), "echo startup-hook-ran").unwrap();
    let env = execute(
        "env",
        "node -e 'console.log(process.env.SOURCEWEFT_TEST_SECRET || \"clean\")'",
        10000,
        100,
    )
    .unwrap();
    assert_eq!(env["output"].as_str().unwrap().trim(), "clean");
    std::env::remove_var("BASH_ENV");
    std::env::remove_var("SOURCEWEFT_TEST_SECRET");
    let timeout = execute(
        "timeout",
        "node -e 'setTimeout(()=>require(\"fs\").writeFileSync(\"late.txt\",\"bad\"),3000)'",
        300,
        100,
    )
    .unwrap();
    assert_eq!(timeout["cancelled"], true);
    assert!(!w.path.join("late.txt").exists());
    let worker = {
        let host = host.clone();
        let calls = calls.clone();
        let id = w.id.clone();
        std::thread::spawn(move || {
            host.dispatch(&calls, "cancel", "owner", "thread", "command.execute", json!({"workspaceId":id,
            "command":"node -e 'require(\"fs\").writeFileSync(\"started.txt\",\"yes\");require(\"child_process\").spawn(process.execPath,[\"-e\",\"setTimeout(()=>require(\\\"fs\\\").writeFileSync(\\\"after.txt\\\",\\\"bad\\\"),3000)\"],{stdio:\"inherit\"});setTimeout(()=>{},20000)'","timeoutMs":30000}))
        })
    };
    for _ in 0..500 {
        if w.path.join("started.txt").exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(w.path.join("started.txt").exists());
    assert!(calls.cancel("cancel"));
    assert_eq!(worker.join().unwrap().unwrap()["cancelled"], true);
    std::thread::sleep(Duration::from_millis(3200));
    assert!(!w.path.join("after.txt").exists());
    std::env::remove_var("SOURCEWEFT_WINDOWS_TRUSTED_LOCAL_EXECUTION");
}
