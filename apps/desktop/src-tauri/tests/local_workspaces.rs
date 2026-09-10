#![cfg(target_os = "macos")]
use sourceweft_desktop::local_host::LocalHost;
use std::{fs, os::unix::fs::symlink};

#[test]
fn allocation_is_lazy_persistent_and_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    assert_eq!(fs::read_dir(host.workspace_base()).unwrap().count(), 0);
    let first = host.ensure_workspace("account-a", "thread-1").unwrap();
    fs::write(first.path.join("report.txt"), "preserved").unwrap();
    drop(host);
    let reopened = LocalHost::open(temp.path()).unwrap();
    let second = reopened.ensure_workspace("account-a", "thread-1").unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(
        reopened
            .read_text("account-a", "thread-1", &second.id, "report.txt")
            .unwrap(),
        "preserved"
    );
    assert_eq!(fs::read_dir(reopened.workspace_base()).unwrap().count(), 1);
}

#[test]
fn accounts_and_threads_cannot_share_implicit_roots() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let a = host.ensure_workspace("a", "same-thread").unwrap();
    let b = host.ensure_workspace("b", "same-thread").unwrap();
    assert_ne!(a.path, b.path);
    assert_eq!(
        host.get_workspace("a", "other-thread", &a.id)
            .unwrap_err()
            .code,
        "WORKSPACE_NOT_FOUND"
    );
    assert_eq!(
        host.get_workspace("b", "same-thread", &a.id)
            .unwrap_err()
            .code,
        "WORKSPACE_NOT_FOUND"
    );
    assert!(host.ensure_workspace("", "thread").is_err());
}

#[test]
fn deleted_or_replaced_ready_workspace_is_not_recreated() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let workspace = host.ensure_workspace("a", "thread").unwrap();
    fs::remove_dir(&workspace.path).unwrap();
    assert_eq!(
        host.ensure_workspace("a", "thread").unwrap_err().code,
        "WORKSPACE_MISSING"
    );
    assert!(!workspace.path.exists());
    symlink(outside.path(), &workspace.path).unwrap();
    assert!(host.ensure_workspace("a", "thread").is_err());
}

#[test]
fn reads_reject_traversal_symlinks_hardlinks_and_special_files() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let w = host.ensure_workspace("a", "thread").unwrap();
    fs::write(outside.path().join("secret"), "not authorized").unwrap();
    symlink(outside.path(), w.path.join("escape")).unwrap();
    symlink(outside.path().join("secret"), w.path.join("link")).unwrap();
    fs::hard_link(outside.path().join("secret"), w.path.join("hardlink")).unwrap();
    for path in [
        "../owner.json",
        "/etc/passwd",
        "escape/secret",
        "link",
        "hardlink",
        "",
        "a\0b",
    ] {
        assert!(
            host.read_text("a", "thread", &w.id, path).is_err(),
            "accepted {path:?}"
        );
    }
    assert_eq!(
        host.read_text("other", "thread", &w.id, "link")
            .unwrap_err()
            .code,
        "WORKSPACE_NOT_FOUND"
    );
}

#[test]
fn concurrent_allocations_use_one_root() {
    let temp = tempfile::tempdir().unwrap();
    LocalHost::open(temp.path()).unwrap();
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let path = temp.path().to_owned();
            std::thread::spawn(move || {
                LocalHost::open(&path)
                    .unwrap()
                    .ensure_workspace("a", "thread")
                    .unwrap()
                    .id
            })
        })
        .collect();
    let ids: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(ids.iter().all(|id| id == &ids[0]));
}

#[test]
fn bounded_text_reads_reject_binary_and_large_files() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let w = host.ensure_workspace("a", "t").unwrap();
    fs::write(w.path.join("binary"), [0xff, 0xfe]).unwrap();
    fs::write(w.path.join("large"), vec![b'a'; 1024 * 1024 + 1]).unwrap();
    assert_eq!(
        host.read_text("a", "t", &w.id, "binary").unwrap_err().code,
        "INVALID_UTF8"
    );
    assert_eq!(
        host.read_text("a", "t", &w.id, "large").unwrap_err().code,
        "FILE_TOO_LARGE"
    );
}

#[test]
fn recovery_finishes_reserved_allocation_but_does_not_adopt_unknown_data() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let db = rusqlite::Connection::open(temp.path().join("local-host/state.sqlite3")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    db.execute("INSERT INTO workspaces(id,owner_id,thread_id,state) VALUES(?1,'a','reserved','provisioning')", [&id]).unwrap();
    assert_eq!(host.ensure_workspace("a", "reserved").unwrap().id, id);

    let unknown = uuid::Uuid::new_v4().to_string();
    db.execute("INSERT INTO workspaces(id,owner_id,thread_id,state) VALUES(?1,'a','unknown','provisioning')", [&unknown]).unwrap();
    let allocation = host.workspace_base().join(&unknown);
    fs::create_dir(&allocation).unwrap();
    fs::write(allocation.join("user-file"), "preserve").unwrap();
    assert_eq!(
        host.ensure_workspace("a", "unknown").unwrap_err().code,
        "WORKSPACE_OWNERSHIP_MISMATCH"
    );
    assert_eq!(
        fs::read_to_string(allocation.join("user-file")).unwrap(),
        "preserve"
    );
}

#[test]
fn replaced_real_directory_is_not_treated_as_the_original_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let w = host.ensure_workspace("a", "t").unwrap();
    fs::rename(&w.path, w.path.with_file_name("original-files")).unwrap();
    fs::create_dir(&w.path).unwrap();
    assert_eq!(
        host.ensure_workspace("a", "t").unwrap_err().code,
        "WORKSPACE_REPLACED"
    );
    assert_eq!(
        host.get_workspace("a", "t", &w.id).unwrap_err().code,
        "WORKSPACE_REPLACED"
    );
}

#[test]
fn selected_directory_is_owned_immutable_shared_and_persistent() {
    let app = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    fs::write(folder.path().join("existing.txt"), "user content").unwrap();
    let host = LocalHost::open(app.path()).unwrap();
    let (grant, root) = host.grant_directory("owner", folder.path()).unwrap();
    assert!(host
        .ensure_workspace_with_grant("other", "t", Some(&grant))
        .is_err());
    let first = host
        .ensure_workspace_with_grant("owner", "t", Some(&grant))
        .unwrap();
    assert_eq!(first.path, root);
    assert_eq!(
        host.read_text("owner", "t", &first.id, "existing.txt")
            .unwrap(),
        "user content"
    );
    assert!(host.ensure_workspace("owner", "t").is_err());
    let second = host
        .ensure_workspace_with_grant("owner", "t2", Some(&grant))
        .unwrap();
    assert_eq!(first.path, second.path);
    assert_ne!(first.id, second.id);
    drop(host);
    let host = LocalHost::open(app.path()).unwrap();
    assert_eq!(
        host.ensure_workspace_with_grant("owner", "t", Some(&grant))
            .unwrap()
            .id,
        first.id
    );
    assert_eq!(
        fs::read_dir(folder.path()).unwrap().count(),
        1,
        "No ownership metadata added to user directory"
    );
    assert!(host.grant_directory("owner", app.path()).is_err());
    assert!(host
        .grant_directory("owner", std::path::Path::new("/"))
        .is_err());
    fs::rename(
        folder.path().join("existing.txt"),
        folder.path().join("renamed.txt"),
    )
    .unwrap();
    assert!(host
        .read_text("owner", "t", &first.id, "existing.txt")
        .is_err());
    assert_eq!(
        host.read_text("owner", "t", &first.id, "renamed.txt")
            .unwrap(),
        "user content"
    );
}

#[test]
fn local_edits_detect_external_changes_and_reject_links() {
    let app = tempfile::tempdir().unwrap();
    let host = LocalHost::open(app.path()).unwrap();
    let w = host.ensure_workspace("owner", "t").unwrap();
    host.write_bytes("owner", "t", &w.id, "a.txt", b"before", None)
        .unwrap();
    host.write_bytes("owner", "t", &w.id, "a.txt", b"after", Some(b"before"))
        .unwrap();
    assert_eq!(fs::read(w.path.join("a.txt")).unwrap(), b"after");
    fs::write(w.path.join("a.txt"), b"external").unwrap();
    assert_eq!(
        host.write_bytes("owner", "t", &w.id, "a.txt", b"wrong", Some(b"after"))
            .unwrap_err()
            .code,
        "FILE_CHANGED"
    );
    assert_eq!(fs::read(w.path.join("a.txt")).unwrap(), b"external");
    assert!(host
        .write_bytes("owner", "t", &w.id, "a.txt", b"overwrite", None)
        .is_err());
    symlink(w.path.join("a.txt"), w.path.join("link")).unwrap();
    fs::hard_link(w.path.join("a.txt"), w.path.join("hard")).unwrap();
    for path in ["link", "hard", "../outside"] {
        assert!(host
            .write_bytes("owner", "t", &w.id, path, b"bad", Some(b"external"))
            .is_err());
    }
    assert_eq!(fs::read(w.path.join("a.txt")).unwrap(), b"external");
    host.write_bytes("owner", "t", &w.id, "binary", &[0, 255, 1], None)
        .unwrap();
    assert_eq!(
        host.read_bytes("owner", "t", &w.id, "binary").unwrap(),
        [0, 255, 1]
    );
    assert!(host.read_text("owner", "t", &w.id, "binary").is_err());
}

#[test]
fn selected_directory_replacement_is_not_adopted() {
    let app = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let chosen = parent.path().join("chosen");
    fs::create_dir(&chosen).unwrap();
    let host = LocalHost::open(app.path()).unwrap();
    let (grant, _) = host.grant_directory("owner", &chosen).unwrap();
    let w = host
        .ensure_workspace_with_grant("owner", "t", Some(&grant))
        .unwrap();
    fs::rename(&chosen, parent.path().join("original")).unwrap();
    fs::create_dir(&chosen).unwrap();
    assert_eq!(
        host.ensure_workspace_with_grant("owner", "t", Some(&grant))
            .unwrap_err()
            .code,
        "WORKSPACE_REPLACED"
    );
    assert!(host.get_workspace("owner", "t", &w.id).is_err());
}

#[test]
fn malformed_directory_grants_do_not_allocate_an_automatic_directory() {
    use serde_json::json;
    use sourceweft_desktop::local_host::execution::Executions;
    let app = tempfile::tempdir().unwrap();
    let host = LocalHost::open(app.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    for (index, grant) in [json!(null), json!(123), json!("")].into_iter().enumerate() {
        let error = host
            .dispatch(
                &Executions::default(),
                &format!("invalid-{index}"),
                "owner",
                "t",
                "workspace.ensure",
                json!({"directoryGrantId":grant}),
            )
            .unwrap_err();
        assert_eq!(error.code, "INVALID_DIRECTORY_GRANT");
    }
    assert_eq!(fs::read_dir(host.workspace_base()).unwrap().count(), 0);
}
