#![cfg(target_os = "macos")]
use serde_json::json;
use sourceweft_desktop::local_host::{execution::Executions, LocalHost};

#[test]
fn accepted_work_finishes_during_drain_but_new_work_is_rejected_and_cancel_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let host = LocalHost::open(dir.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    let calls = Executions::default();
    let accepted = host.admission.enter().unwrap();
    let drain = host.admission.drain().unwrap();
    let result = host.dispatch(
        &calls,
        "new",
        "owner",
        "thread",
        "workspace.check",
        json!({}),
    );
    assert!(result.unwrap_err().to_string().contains("HOST_UPDATING"));
    let result = host.dispatch_admitted(
        &accepted,
        &calls,
        "accepted",
        "owner",
        "thread",
        "workspace.check",
        json!({}),
    );
    assert!(
        result.is_ok(),
        "Previously accepted work must complete: {result:?}"
    );
    assert!(!drain.idle(), "Transport still owns the result-send lease");
    drop(accepted);
    assert!(drain.idle());
    drop(drain);
    assert!(host
        .dispatch(
            &calls,
            "after-cancel",
            "owner",
            "thread",
            "workspace.check",
            json!({})
        )
        .is_ok());
}
