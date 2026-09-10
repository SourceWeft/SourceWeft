#![cfg(target_os = "macos")]
use serde_json::json;
use sourceweft_desktop::local_host::{execution::Executions, LocalHost};
use std::{fs, sync::Arc, time::Duration};

#[test]
#[ignore = "requires real macOS sandbox_apply"]
fn command_creates_real_file_and_duplicate_delivery_does_not_run_twice() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    let workspace = host.ensure_workspace("test-owner", "test-thread").unwrap();
    let executions = Executions::default();
    let payload = json!({"workspaceId":workspace.id,"command":"printf 'one\\n' >> result.txt; /bin/pwd; /bin/cat result.txt","cwd":".","timeoutMs":10000,"maxOutputChars":2000});
    let first = host
        .dispatch(
            &executions,
            "call-1",
            "test-owner",
            "test-thread",
            "command.execute",
            payload.clone(),
        )
        .unwrap();
    assert_eq!(first["exitCode"], 0);
    assert!(first["output"]
        .as_str()
        .unwrap()
        .contains(workspace.path.to_str().unwrap()));
    let replay = host
        .dispatch(
            &executions,
            "call-1",
            "test-owner",
            "test-thread",
            "command.execute",
            payload,
        )
        .unwrap();
    assert_eq!(first, replay);
    assert_eq!(
        fs::read_to_string(workspace.path.join("result.txt")).unwrap(),
        "one\n"
    );
}

#[test]
#[ignore = "requires real macOS sandbox_apply"]
fn running_command_can_be_cancelled_and_cannot_write_after_cancel() {
    let temp = tempfile::tempdir().unwrap();
    let host = Arc::new(LocalHost::open(temp.path()).unwrap());
    host.initialize_invocation_journal().unwrap();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let executions = Arc::new(Executions::default());
    let worker = {
        let host = host.clone();
        let executions = executions.clone();
        let id = workspace.id.clone();
        std::thread::spawn(move || {
            host.dispatch(&executions,"cancel-me","owner","thread","command.execute",json!({"workspaceId":id,"command":"printf started > started.txt; sleep 20; printf forbidden > after.txt","timeoutMs":30000}))
        })
    };
    for _ in 0..500 {
        if workspace.path.join("started.txt").exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        workspace.path.join("started.txt").exists(),
        "Command must start before cancellation"
    );
    assert!(executions.cancel("cancel-me"));
    let result = worker.join().unwrap().unwrap();
    assert_eq!(result["cancelled"], true);
    assert!(!workspace.path.join("after.txt").exists());
}

#[test]
#[ignore = "requires real macOS sandbox_apply"]
fn proxy_rejects_loopback_and_direct_egress() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    let w = host.ensure_workspace("a", "t").unwrap();
    let result=host.dispatch(&Executions::default(),"network","a","t","command.execute",json!({"workspaceId":w.id,"command":"/usr/bin/curl --max-time 5 -s -o /dev/null -w '%{http_code}' http://127.0.0.1/","timeoutMs":10000})).unwrap();
    assert_eq!(result["output"], "403", "{result}");
}

#[test]
#[ignore = "requires real macOS sandbox_apply"]
fn selected_directory_command_and_file_tools_share_physical_files() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let app = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let host = LocalHost::open(app.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    let (grant, root) = host.grant_directory("owner", directory.path()).unwrap();
    let w = host
        .ensure_workspace_with_grant("owner", "t", Some(&grant))
        .unwrap();
    let calls = Executions::default();
    host.dispatch(
        &calls,
        "write-input",
        "owner",
        "t",
        "file.write",
        json!({"workspaceId":w.id,"path":"input.txt","content":STANDARD.encode("original")}),
    )
    .unwrap();
    let executed = host.dispatch(&calls, "execute", "owner", "t", "command.execute", json!({"workspaceId":w.id,"command":"cat input.txt > output.txt; /bin/pwd","timeoutMs":10000})).unwrap();
    assert_eq!(executed["exitCode"], 0, "{executed}");
    assert_eq!(
        executed["output"].as_str().unwrap().trim(),
        root.to_str().unwrap()
    );
    let listed = host
        .dispatch(
            &calls,
            "list",
            "owner",
            "t",
            "file.list",
            json!({"workspaceId":w.id,"path":"."}),
        )
        .unwrap();
    assert_eq!(listed["files"].as_array().unwrap().len(), 2);
    host.dispatch(&calls, "edit", "owner", "t", "file.replace", json!({"workspaceId":w.id,"path":"output.txt","expected":STANDARD.encode("original"),"content":STANDARD.encode("edited")})).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("output.txt")).unwrap(),
        "edited"
    );
    fs::write(root.join("output.txt"), "external").unwrap();
    let read = host
        .dispatch(
            &calls,
            "read",
            "owner",
            "t",
            "file.read",
            json!({"workspaceId":w.id,"path":"output.txt"}),
        )
        .unwrap();
    assert_eq!(
        STANDARD.decode(read["content"].as_str().unwrap()).unwrap(),
        b"external"
    );
}
