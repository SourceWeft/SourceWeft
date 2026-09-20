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
fn availability_probe_never_allocates_or_repairs_a_directory() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    host.check_workspace("owner", "thread", None, None).unwrap();
    assert_eq!(fs::read_dir(host.workspace_base()).unwrap().count(), 0);
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    host.check_workspace("owner", "thread", Some(&workspace.id), None)
        .unwrap();
    fs::rename(&workspace.path, workspace.path.with_extension("moved")).unwrap();
    assert!(host
        .check_workspace("owner", "thread", Some(&workspace.id), None)
        .is_err());
    assert!(!workspace.path.exists());
}

#[test]
fn availability_probe_checks_selected_grant_ownership_and_root_identity() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(&temp.path().join("app")).unwrap();
    let selected = temp.path().join("selected");
    fs::create_dir(&selected).unwrap();
    let (grant, _) = host.grant_directory("owner", &selected).unwrap();
    host.check_workspace("owner", "thread", None, Some(&grant))
        .unwrap();
    assert_eq!(fs::read_dir(host.workspace_base()).unwrap().count(), 0);
    assert!(host
        .check_workspace("other", "thread", None, Some(&grant))
        .is_err());
    let workspace = host
        .ensure_workspace_with_grant("owner", "thread", Some(&grant))
        .unwrap();
    host.check_workspace("owner", "thread", Some(&workspace.id), Some(&grant))
        .unwrap();
    fs::rename(&selected, temp.path().join("moved")).unwrap();
    fs::create_dir(&selected).unwrap();
    assert!(host
        .check_workspace("owner", "thread", Some(&workspace.id), Some(&grant))
        .is_err());
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
        "FILE_VERSION_CONFLICT"
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

#[test]
fn both_v3_directory_schemas_upgrade_without_adopting_new_roots() {
    use std::os::unix::fs::MetadataExt;
    for legacy in [true, false] {
        let app = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().canonicalize().unwrap();
        fs::write(path.join("existing.txt"), "preserved").unwrap();
        fs::create_dir(app.path().join("local-host")).unwrap();
        let db_path = app.path().join("local-host/state.sqlite3");
        let db = rusqlite::Connection::open(&db_path).unwrap();
        let (table, selected, grant_column) = if legacy {
            ("folder_grants", "attached_path", "folder_id")
        } else {
            ("directory_grants", "selected_path", "directory_grant_id")
        };
        db.execute_batch(&format!("CREATE TABLE workspaces(id TEXT PRIMARY KEY,owner_id TEXT,thread_id TEXT,state TEXT,root_device INTEGER,root_inode INTEGER,{selected} TEXT,{grant_column} TEXT,UNIQUE(owner_id,thread_id)); CREATE TABLE {table}(id TEXT PRIMARY KEY,owner_id TEXT,path TEXT,root_device INTEGER,root_inode INTEGER); PRAGMA user_version=3;")).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let grant = uuid::Uuid::new_v4().to_string();
        let meta = fs::metadata(&path).unwrap();
        db.execute(
            &format!("INSERT INTO {table} VALUES(?1,'owner',?2,?3,?4)"),
            rusqlite::params![grant, path.to_str().unwrap(), meta.dev(), meta.ino()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO workspaces VALUES(?1,'owner','thread','ready',?2,?3,?4,?5)",
            rusqlite::params![id, meta.dev(), meta.ino(), path.to_str().unwrap(), grant],
        )
        .unwrap();
        drop(db);
        let host = LocalHost::open(app.path()).unwrap();
        assert_eq!(
            host.ensure_bound_workspace("owner", "thread", Some(&id), Some(&grant))
                .unwrap()
                .path,
            path
        );
        assert_eq!(
            host.read_text("owner", "thread", &id, "existing.txt")
                .unwrap(),
            "preserved"
        );
        assert!(host
            .ensure_bound_workspace("other", "other", None, Some(&grant))
            .is_err());
        drop(host);
        let db = rusqlite::Connection::open(&db_path).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        drop(db);
        // Reopening must not refresh the recorded inode of a replaced root.
        let old = app.path().join("old-folder");
        fs::rename(&path, &old).unwrap();
        fs::create_dir(&path).unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        assert!(host.get_workspace("owner", "thread", &id).is_err());
    }
}

#[test]
fn draft_folder_reads_are_authorized_bounded_and_do_not_allocate_a_workspace() {
    use serde_json::json;
    use sourceweft_desktop::local_host::execution::Executions;
    let data = tempfile::tempdir().unwrap();
    let selected = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let host = LocalHost::open(data.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    fs::write(selected.path().join("hello.txt"), "hello").unwrap();
    fs::create_dir(selected.path().join("sub")).unwrap();
    symlink(outside.path(), selected.path().join("escape")).unwrap();
    let (grant, granted_path) = host.grant_directory("owner", selected.path()).unwrap();
    let calls = Executions::default();
    let read = |owner: &str, action: &str, path: &str| {
        host.dispatch(
            &calls,
            &uuid::Uuid::new_v4().to_string(),
            owner,
            "",
            action,
            json!({"folderId":grant,"path":path}),
        )
    };
    let list = read("owner", "folder.list", "").unwrap();
    assert_eq!(list["root"], granted_path.to_str().unwrap());
    assert_eq!(list["files"].as_array().unwrap().len(), 2);
    assert_eq!(
        read("owner", "folder.read", "hello.txt").unwrap()["content"],
        "aGVsbG8="
    );
    assert_eq!(
        read("owner", "folder.list", "sub").unwrap()["files"],
        json!([])
    );
    assert!(read("other", "folder.list", "").is_err());
    assert!(read("owner", "folder.list", "../").is_err());
    assert!(read("owner", "folder.list", "escape").is_err());
    assert!(read("owner", "folder.read", outside.path().to_str().unwrap()).is_err());
    fs::write(selected.path().join("large"), vec![0u8; 1024 * 1024 + 1]).unwrap();
    assert_eq!(
        read("owner", "folder.read", "large").unwrap_err().code,
        "FILE_TOO_LARGE"
    );
    assert_eq!(fs::read_dir(host.workspace_base()).unwrap().count(), 0);
    let moved = selected
        .path()
        .with_file_name(format!("moved-draft-{}", uuid::Uuid::new_v4()));
    fs::rename(selected.path(), &moved).unwrap();
    fs::create_dir(selected.path()).unwrap();
    assert_eq!(
        read("owner", "folder.list", "").unwrap_err().code,
        "WORKSPACE_REPLACED"
    );
    fs::remove_dir_all(moved).unwrap();
}
