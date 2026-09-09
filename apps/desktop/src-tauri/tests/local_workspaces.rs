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
fn bound_allocation_uses_server_id_and_cannot_be_retargeted() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let first = host
        .ensure_bound_workspace("owner", "thread", Some(&id), None)
        .unwrap();
    assert_eq!(first.id, id);
    assert!(host
        .ensure_bound_workspace(
            "owner",
            "thread",
            Some(&uuid::Uuid::new_v4().to_string()),
            None
        )
        .is_err());
    assert!(host
        .ensure_bound_workspace("owner", "other", Some("../escape"), None)
        .is_err());
}

#[test]
fn attached_folder_preserves_identity_and_owner_across_restart() {
    let temp = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let grant = host.register_folder("owner", folder.path()).unwrap();
    let folder_id = grant["id"].as_str().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let workspace = host
        .ensure_bound_workspace("owner", "thread", Some(&id), Some(folder_id))
        .unwrap();
    std::fs::write(workspace.path.join("hello.txt"), "original").unwrap();
    assert!(host
        .ensure_bound_workspace(
            "other",
            "thread",
            Some(&uuid::Uuid::new_v4().to_string()),
            Some(folder_id)
        )
        .is_err());
    drop(host);
    let host = LocalHost::open(temp.path()).unwrap();
    assert_eq!(
        host.read_text("owner", "thread", &id, "hello.txt").unwrap(),
        "original"
    );
    let moved = folder.path().with_extension("moved");
    std::fs::rename(folder.path(), &moved).unwrap();
    std::fs::create_dir(folder.path()).unwrap();
    assert!(host.get_workspace("owner", "thread", &id).is_err());
    std::fs::remove_dir_all(moved).unwrap();
}

#[test]
fn file_updates_require_read_version_and_backup_original_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    host.write_bytes(
        "owner",
        "thread",
        &workspace.id,
        "report.txt",
        b"first",
        None,
    )
    .unwrap();
    assert!(host
        .write_bytes(
            "owner",
            "thread",
            &workspace.id,
            "report.txt",
            b"second",
            None
        )
        .is_err());
    assert!(host
        .write_bytes(
            "owner",
            "thread",
            &workspace.id,
            "report.txt",
            b"second",
            Some(b"stale")
        )
        .is_err());
    let updated = host
        .write_bytes(
            "owner",
            "thread",
            &workspace.id,
            "report.txt",
            b"second",
            Some(b"first"),
        )
        .unwrap();
    let backup = temp
        .path()
        .join("local-host/backups")
        .join(updated["backupId"].as_str().unwrap());
    assert_eq!(std::fs::read(backup).unwrap(), b"first");
    assert_eq!(
        host.read_text("owner", "thread", &workspace.id, "report.txt")
            .unwrap(),
        "second"
    );
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), "unchanged").unwrap();
    std::os::unix::fs::symlink(outside.path(), workspace.path.join("escape")).unwrap();
    assert!(host
        .write_bytes(
            "owner",
            "thread",
            &workspace.id,
            "escape/secret",
            b"changed",
            Some(b"unchanged")
        )
        .is_err());
    assert_eq!(
        std::fs::read(outside.path().join("secret")).unwrap(),
        b"unchanged"
    );
}
