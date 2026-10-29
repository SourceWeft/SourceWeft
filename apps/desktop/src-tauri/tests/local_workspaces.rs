#![cfg(any(unix, windows))]
mod support;
use sourceweft_desktop::local_host::LocalHost;
use std::fs;
use support::{canonical, link_dir, link_file, stored_identity, wire};

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
    link_dir(outside.path(), &workspace.path);
    assert!(host.ensure_workspace("a", "thread").is_err());
}

#[test]
fn reads_reject_traversal_symlinks_hardlinks_and_special_files() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let w = host.ensure_workspace("a", "thread").unwrap();
    fs::write(outside.path().join("secret"), "not authorized").unwrap();
    link_dir(outside.path(), &w.path.join("escape"));
    assert!(
        link_file(&outside.path().join("secret"), &w.path.join("link")),
        "this process cannot create symbolic links"
    );
    fs::hard_link(outside.path().join("secret"), w.path.join("hardlink")).unwrap();
    for path in [
        "../owner.json",
        "/etc/passwd",
        "C:/Windows/win.ini",
        "C:\\Windows\\win.ini",
        "secret:stream",
        "CON",
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
    link_dir(outside.path(), &workspace.path.join("escape"));
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
    #[cfg(unix)]
    assert!(host
        .grant_directory("owner", std::path::Path::new("/"))
        .is_err());
    #[cfg(windows)]
    assert_eq!(
        host.grant_directory("owner", std::path::Path::new("C:\\"))
            .unwrap_err()
            .code,
        "FOLDER_TOO_BROAD"
    );
    fs::rename(
        folder.path().join("existing.txt"),
        folder.path().join("renamed.txt"),
    )
    .unwrap();
    #[cfg(unix)]
    {
        assert!(host
            .read_text("owner", "t", &first.id, "existing.txt")
            .is_err());
        assert_eq!(
            host.read_text("owner", "t", &first.id, "renamed.txt")
                .unwrap(),
            "user content"
        );
    }
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
    assert!(
        link_file(&w.path.join("a.txt"), &w.path.join("link")),
        "this process cannot create symbolic links"
    );
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
    for legacy in [true, false] {
        let app = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let path = canonical(folder.path());
        // What the database holds for the path: the wire form (plain on unix).
        let stored_path = wire(&path);
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
        let (device, inode) = stored_identity(&path);
        db.execute(
            &format!("INSERT INTO {table} VALUES(?1,'owner',?2,?3,?4)"),
            rusqlite::params![grant, stored_path, device, inode],
        )
        .unwrap();
        db.execute(
            "INSERT INTO workspaces VALUES(?1,'owner','thread','ready',?2,?3,?4,?5)",
            rusqlite::params![id, device, inode, stored_path, grant],
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
    link_dir(outside.path(), &selected.path().join("escape"));
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
    assert_eq!(list["root"], wire(&granted_path));
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

// ---------------------------------------------------------------------------------------------
// Windows: the path layer, the workspace store, the gates of `dispatch` and the handle-relative
// file operations: store creation, identity, wire paths, grant limits, `checked_path` (through
// `file.mkdir` / `file.list`), and writes, reads and draft-folder access that must refuse every
// kind of reparse point, alternate data stream and reserved name.
// ---------------------------------------------------------------------------------------------

#[cfg(windows)]
mod windows {
    use super::*;
    use serde_json::{json, Value};
    use sourceweft_desktop::local_host::execution::Executions;

    fn assert_wire(path: &Value) {
        let text = path.as_str().expect("a path string");
        assert!(
            text.len() >= 3 && text.as_bytes()[0].is_ascii_uppercase() && &text[1..3] == ":/",
            "not a wire path: {text}"
        );
        assert!(!text.contains('\\'), "backslash in {text}");
        assert!(!text.starts_with("//"), "UNC in {text}");
        assert!(!text.ends_with('/') || text.len() == 3, "trailing slash in {text}");
    }

    fn call(host: &LocalHost, owner: &str, thread: &str, action: &str, payload: Value) -> sourceweft_desktop::local_host::Result<Value> {
        host.dispatch(
            &Executions::default(),
            &uuid::Uuid::new_v4().to_string(),
            owner,
            thread,
            action,
            payload,
        )
    }

    #[test]
    fn open_creates_the_store_on_windows_and_a_reopen_keeps_it() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app data");
        let host = LocalHost::open(&app).unwrap();
        assert!(app.join("local-host/state.sqlite3").is_file());
        assert!(app.join("task-workspaces").is_dir());
        // The base is the canonical native path, not the verbatim form.
        let base = host.workspace_base();
        let text = base.to_str().unwrap();
        assert!(!text.starts_with(r"\\?\"), "{text}");
        assert!(text.ends_with(r"task-workspaces"));
        assert_eq!(base, canonical(&app).join("task-workspaces"));
        drop(host);
        LocalHost::open(&app).unwrap();
    }

    #[test]
    fn allocation_writes_the_marker_and_reports_wire_paths() {
        let temp = tempfile::tempdir().unwrap();
        let host = LocalHost::open(temp.path()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let workspace = host
            .ensure_bound_workspace("owner", "thread", Some(&id), None)
            .unwrap();
        let allocation = host.workspace_base().join(&id);
        assert_eq!(workspace.path, allocation.join("files"));
        assert!(workspace.path.is_dir());
        assert_eq!(
            fs::read(allocation.join("owner.json")).unwrap(),
            serde_json::to_vec(&("owner", "thread", &id)).unwrap()
        );
        // Serialization is the wire form, whatever the native spelling.
        let serialized = serde_json::to_value(&workspace).unwrap();
        assert_wire(&serialized["path"]);
        assert_eq!(serialized["path"], wire(&workspace.path));
        assert_eq!(
            serialized["path"].as_str().unwrap(),
            format!("{}/{id}/files", host.workspace_base_wire().unwrap())
        );
        assert_wire(&Value::String(host.workspace_base_wire().unwrap()));
        // The same through the dispatcher the backend talks to.
        host.initialize_invocation_journal().unwrap();
        let ensured = call(&host, "owner", "thread", "workspace.ensure", json!({"workspaceId": id})).unwrap();
        assert_wire(&ensured["path"]);
        assert_eq!(ensured["path"], serialized["path"]);
        assert_eq!(ensured["id"], json!(id));
    }

    #[test]
    fn workspace_identity_detects_rename_and_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let host = LocalHost::open(temp.path()).unwrap();
        let workspace = host.ensure_workspace("a", "t").unwrap();
        // Stable across calls and reopen.
        host.get_workspace("a", "t", &workspace.id).unwrap();
        drop(host);
        let host = LocalHost::open(temp.path()).unwrap();
        host.get_workspace("a", "t", &workspace.id).unwrap();
        // Renaming the directory away and putting a new one in its place is a different identity.
        let original = workspace.path.with_file_name("original-files");
        fs::rename(&workspace.path, &original).unwrap();
        fs::create_dir(&workspace.path).unwrap();
        assert_eq!(
            host.get_workspace("a", "t", &workspace.id).unwrap_err().code,
            "WORKSPACE_REPLACED"
        );
        // Moving the original back (same file id) is accepted again.
        fs::remove_dir(&workspace.path).unwrap();
        fs::rename(&original, &workspace.path).unwrap();
        host.get_workspace("a", "t", &workspace.id).unwrap();
    }

    #[test]
    fn a_junction_or_symlink_in_place_of_the_workspace_is_not_the_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let host = LocalHost::open(temp.path()).unwrap();
        let workspace = host.ensure_workspace("a", "t").unwrap();
        let moved = workspace.path.with_file_name("moved-files");
        fs::rename(&workspace.path, &moved).unwrap();
        link_dir(outside.path(), &workspace.path);
        assert!(host.get_workspace("a", "t", &workspace.id).is_err());
        assert!(host.ensure_workspace("a", "t").is_err());
    }

    #[test]
    fn granted_folders_are_stored_and_reported_in_wire_form_and_survive_a_restart() {
        let app = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        let registered = host.register_folder("owner", folder.path()).unwrap();
        assert_wire(&registered["path"]);
        assert_eq!(registered["path"], wire(&canonical(folder.path())));
        let (grant, native) = host.grant_directory("owner", folder.path()).unwrap();
        assert_eq!(native, canonical(folder.path()));
        // The database holds the wire string, so what the backend saw is what is stored.
        let db = rusqlite::Connection::open(app.path().join("local-host/state.sqlite3")).unwrap();
        let stored: String = db
            .query_row("SELECT path FROM directory_grants WHERE id=?1", [&grant], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, wire(&native));
        drop(host);
        let host = LocalHost::open(app.path()).unwrap();
        host.check_workspace("owner", "t", None, Some(&grant)).unwrap();
        let workspace = host
            .ensure_workspace_with_grant("owner", "t", Some(&grant))
            .unwrap();
        assert_eq!(workspace.path, native);
        assert_wire(&serde_json::to_value(&workspace).unwrap()["path"]);
        // A differently-cased spelling of the application storage is still application storage.
        let upper = app.path().to_str().unwrap().to_uppercase();
        assert_eq!(
            host.grant_directory("owner", std::path::Path::new(&upper))
                .map(|_| ())
                .unwrap_err()
                .code,
            "DIRECTORY_DENIED"
        );
    }

    #[test]
    fn broad_folders_are_refused_and_nested_ones_are_not() {
        let app = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        let profile = std::env::var("USERPROFILE").unwrap();
        let profile = std::path::PathBuf::from(profile);
        let mut broad = vec![
            std::path::PathBuf::from(r"C:\"),
            profile.clone(),
            profile.join("AppData"),
            profile.parent().unwrap().to_owned(),
        ];
        broad.extend(std::env::var("APPDATA").ok().map(std::path::PathBuf::from));
        broad.extend(std::env::var("LOCALAPPDATA").ok().map(std::path::PathBuf::from));
        for path in broad {
            assert_eq!(
                host.grant_directory("owner", &path)
                    .map(|_| ())
                    .unwrap_err()
                    .code,
                "FOLDER_TOO_BROAD",
                "{}",
                path.display()
            );
        }
        // Under AppData\Local\Temp, where the test directories live, is fine.
        let inner = tempfile::tempdir().unwrap();
        host.grant_directory("owner", inner.path()).unwrap();
    }

    #[test]
    fn checked_paths_refuse_what_windows_would_resolve_elsewhere() {
        let app = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        host.initialize_invocation_journal().unwrap();
        let workspace = host.ensure_workspace("owner", "t").unwrap();
        fs::create_dir(workspace.path.join("real")).unwrap();
        link_dir(outside.path(), &workspace.path.join("junction"));
        let mkdir = |path: &str| {
            call(&host, "owner", "t", "file.mkdir", json!({"workspaceId": workspace.id, "path": path}))
        };
        mkdir("real/nested").unwrap();
        assert!(workspace.path.join("real/nested").is_dir());
        mkdir("CJK目录/[brackets] (1)/spaces ok").unwrap();
        for path in [
            "junction/x",
            "junction",
            "stream:ads",
            "real/x:$DATA",
            "CON",
            "real/nul.txt",
            "real/COM1",
            "trailing.",
            "trailing ",
            "star*name",
            "back\\slash",
            "C:/Windows",
            "C:rel",
            "/rooted",
            "../escape",
            "real/../../escape",
        ] {
            assert_eq!(
                mkdir(path).unwrap_err().code,
                "PATH_DENIED",
                "{path}"
            );
        }
        assert!(!outside.path().join("x").exists());
        assert!(!workspace.path.join("stream").exists());
    }

    #[test]
    fn short_name_aliases_are_refused() {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
        let app = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        host.initialize_invocation_journal().unwrap();
        let workspace = host.ensure_workspace("owner", "t").unwrap();
        let long = workspace.path.join("a long directory name");
        fs::create_dir(&long).unwrap();
        let wide: Vec<u16> = long.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut buffer = vec![0u16; 1024];
        let written = unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), 1024) } as usize;
        assert!(written > 0, "GetShortPathNameW failed");
        let short = std::path::PathBuf::from(std::ffi::OsString::from_wide(&buffer[..written]));
        let alias = short.file_name().unwrap().to_str().unwrap().to_owned();
        if alias.eq_ignore_ascii_case("a long directory name") {
            eprintln!("8.3 names are disabled on this volume; the alias case cannot be exercised");
            return;
        }
        let mkdir = |path: &str| {
            call(&host, "owner", "t", "file.mkdir", json!({"workspaceId": workspace.id, "path": path}))
        };
        assert_eq!(mkdir(&format!("{alias}/inside")).unwrap_err().code, "PATH_DENIED");
        assert!(!long.join("inside").exists());
        // The real name (in any case) is fine.
        mkdir("A LONG DIRECTORY NAME/inside").unwrap();
    }

    #[test]
    fn listings_use_slashes_and_skip_links_hard_links_and_reparse_points() {
        let app = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        host.initialize_invocation_journal().unwrap();
        let w = host.ensure_workspace("owner", "t").unwrap();
        fs::create_dir_all(w.path.join("src/deep")).unwrap();
        fs::write(w.path.join("src/deep/a.txt"), "a").unwrap();
        fs::write(w.path.join("plain.txt"), "p").unwrap();
        fs::write(w.path.join("shared.txt"), "s").unwrap();
        fs::hard_link(w.path.join("shared.txt"), w.path.join("shared-link.txt")).unwrap();
        link_dir(outside.path(), &w.path.join("junction"));
        let symlink_made = link_file(&outside.path().join("target"), &w.path.join("symlink.txt"));
        if !symlink_made {
            eprintln!("skipped the file symlink case: SeCreateSymbolicLinkPrivilege is not held");
        }
        let listing = call(
            &host,
            "owner",
            "t",
            "file.list",
            json!({"workspaceId": w.id, "path": ".", "recursive": true}),
        )
        .unwrap();
        let mut paths: Vec<String> = listing["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap().to_owned())
            .collect();
        paths.sort();
        assert_eq!(paths, ["plain.txt", "src", "src/deep", "src/deep/a.txt"]);
        // A hard-linked file named directly is refused with its own code.
        assert_eq!(
            call(
                &host,
                "owner",
                "t",
                "file.list",
                json!({"workspaceId": w.id, "path": "shared.txt"})
            )
            .unwrap_err()
            .code,
            "HARDLINK_NOT_ALLOWED"
        );
        assert_eq!(
            call(&host, "owner", "t", "file.list", json!({"workspaceId": w.id, "path": "junction"}))
                .unwrap_err()
                .code,
            "PATH_DENIED"
        );
    }

    #[test]
    fn draft_folder_requests_are_authorized_and_converted_before_any_file_is_opened() {
        let data = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let host = LocalHost::open(data.path()).unwrap();
        host.initialize_invocation_journal().unwrap();
        fs::write(selected.path().join("hello.txt"), "hello").unwrap();
        link_dir(outside.path(), &selected.path().join("escape"));
        let (grant, granted) = host.grant_directory("owner", selected.path()).unwrap();
        let read = |owner: &str, action: &str, path: &str| {
            call(&host, owner, "", action, json!({"folderId": grant, "path": path}))
        };
        let root_wire = wire(&granted);
        // Outside the granted folder, in either spelling: refused by the path layer.
        for path in [
            wire(&canonical(outside.path())),
            format!("{root_wire}2/hello.txt"),
            "C:/".to_owned(),
            "/hello.txt".to_owned(),
            "escape".to_owned(),
            "../".to_owned(),
        ] {
            assert_eq!(
                read("owner", "folder.read", &path).unwrap_err().code,
                "PATH_DENIED",
                "{path}"
            );
        }
        // A backslash path is not the wire form.
        assert_eq!(
            read("owner", "folder.read", granted.to_str().unwrap()).unwrap_err().code,
            "INVALID_PATH"
        );
        // Another account cannot use the grant.
        assert!(read("other", "folder.list", "").is_err());
        // Inside the folder the request reaches the handle-relative open: any spelling of the
        // granted root (the host compares case-insensitively) reads the file.
        for path in [format!("{}/hello.txt", root_wire.to_uppercase()), "hello.txt".to_owned()] {
            assert_eq!(
                read("owner", "folder.read", &path).unwrap()["content"],
                "aGVsbG8=",
                "{path}"
            );
        }
    }

    #[test]
    fn draft_folder_listings_are_wire_form_and_skip_links() {
        let data = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let host = LocalHost::open(data.path()).unwrap();
        host.initialize_invocation_journal().unwrap();
        fs::create_dir(selected.path().join("sub")).unwrap();
        fs::write(selected.path().join("sub/文件 [1].txt"), "x").unwrap();
        fs::write(selected.path().join("plain.txt"), "p").unwrap();
        fs::write(selected.path().join("shared.txt"), "s").unwrap();
        fs::hard_link(selected.path().join("shared.txt"), selected.path().join("twin.txt")).unwrap();
        link_dir(outside.path(), &selected.path().join("escape"));
        let (grant, granted) = host.grant_directory("owner", selected.path()).unwrap();
        let list = |path: &str| {
            call(&host, "owner", "", "folder.list", json!({"folderId": grant, "path": path}))
        };
        let root = list("").unwrap();
        assert_wire(&root["root"]);
        assert_eq!(root["root"], wire(&granted));
        let mut names: Vec<String> = root["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                assert_wire(&entry["path"]);
                let path = entry["path"].as_str().unwrap();
                assert!(path.starts_with(&format!("{}/", wire(&granted))), "{path}");
                path.rsplit('/').next().unwrap().to_owned()
            })
            .collect();
        names.sort();
        assert_eq!(names, ["plain.txt", "sub"]);
        let sub = list("sub").unwrap();
        assert_eq!(sub["files"][0]["path"], format!("{}/sub/文件 [1].txt", wire(&granted)));
        assert_eq!(sub["files"][0]["is_dir"], false);
        // Reading the entry path the listing reported works, case-insensitively.
        let reported = sub["files"][0]["path"].as_str().unwrap().to_owned();
        assert_eq!(
            call(&host, "owner", "", "folder.read", json!({"folderId": grant, "path": reported}))
                .unwrap()["content"],
            "eA=="
        );
        // Hard links and reparse points are refused when named directly.
        for path in ["twin.txt", "shared.txt", "escape", "escape/anything"] {
            assert!(
                call(&host, "owner", "", "folder.read", json!({"folderId": grant, "path": path})).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn mkdir_and_list_report_missing_paths_and_files_in_the_way() {
        let app = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        host.initialize_invocation_journal().unwrap();
        let w = host.ensure_workspace("owner", "t").unwrap();
        fs::create_dir_all(w.path.join("CJK目录/[b] (2)")).unwrap();
        fs::write(w.path.join("CJK目录/[b] (2)/数据 1.txt"), "12345").unwrap();
        fs::write(w.path.join("file.txt"), "x").unwrap();
        let act = |action: &str, path: &str, recursive: bool| {
            call(
                &host,
                "owner",
                "t",
                action,
                json!({"workspaceId": w.id, "path": path, "recursive": recursive}),
            )
        };
        // A file where a directory is wanted, whether it is the target or an ancestor.
        assert_eq!(act("file.mkdir", "file.txt", false).unwrap_err().code, "NOT_A_DIRECTORY");
        assert_eq!(act("file.mkdir", "file.txt/x", false).unwrap_err().code, "NOT_A_DIRECTORY");
        // An existing directory is fine (and reported as created, as on unix).
        assert_eq!(act("file.mkdir", "cjk目录/[B] (2)", false).unwrap(), json!({"created": true}));
        assert!(!w.path.join("cjk目录/[B] (2)/x").exists());
        // Listing: a missing path, a single file, a nested directory with awkward names.
        assert_eq!(act("file.list", "absent", false).unwrap_err().code, "PATH_MISSING");
        assert_eq!(
            act("file.list", "file.txt", false).unwrap(),
            json!({"files": [{"path": "file.txt", "is_dir": false, "size": 1}]})
        );
        let nested = act("file.list", "CJK目录", true).unwrap();
        let mut found: Vec<(String, bool, u64)> = nested["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["path"].as_str().unwrap().to_owned(),
                    f["is_dir"].as_bool().unwrap(),
                    f["size"].as_u64().unwrap(),
                )
            })
            .collect();
        found.sort();
        assert_eq!(
            found,
            [
                ("CJK目录/[b] (2)".to_owned(), true, 0),
                ("CJK目录/[b] (2)/数据 1.txt".to_owned(), false, 5),
            ]
        );
        // Not recursive: one level.
        let shallow = act("file.list", "CJK目录", false).unwrap();
        assert_eq!(shallow["files"].as_array().unwrap().len(), 1);
    }

    fn new_workspace(app: &std::path::Path) -> (LocalHost, sourceweft_desktop::local_host::Workspace) {
        let host = LocalHost::open(app).unwrap();
        host.initialize_invocation_journal().unwrap();
        let workspace = host.ensure_workspace("owner", "t").unwrap();
        (host, workspace)
    }

    fn staging_leftovers(dir: &std::path::Path) -> Vec<String> {
        let mut found = Vec::new();
        for entry in walk(dir) {
            if entry.file_name().unwrap().to_str().unwrap().starts_with(".sourceweft-") {
                found.push(entry.display().to_string());
            }
        }
        found
    }

    fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut all = Vec::new();
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if fs::symlink_metadata(&path).unwrap().is_dir() {
                all.extend(walk(&path));
            }
            all.push(path);
        }
        all
    }

    #[test]
    fn files_are_created_replaced_and_backed_up_through_handles_with_awkward_names() {
        let app = tempfile::tempdir().unwrap();
        let (host, w) = new_workspace(app.path());
        fs::create_dir_all(w.path.join("目录/[x] (1)")).unwrap();
        let path = "目录/[x] (1)/文件 [2].txt";
        let created = host.write_bytes("owner", "t", &w.id, path, "你好".as_bytes(), None).unwrap();
        assert_eq!(created["bytes"], 6);
        assert!(created["backupId"].is_null());
        assert_eq!(host.read_text("owner", "t", &w.id, path).unwrap(), "你好");
        // Another spelling of the same name (case-insensitive file system semantics).
        assert_eq!(
            host.read_text("owner", "t", &w.id, "目录/[X] (1)/文件 [2].TXT").unwrap(),
            "你好"
        );
        let replaced = host
            .write_bytes("owner", "t", &w.id, path, b"second", Some("你好".as_bytes()))
            .unwrap();
        let backup = app
            .path()
            .join("local-host/backups")
            .join(replaced["backupId"].as_str().unwrap());
        assert_eq!(fs::read(backup).unwrap(), "你好".as_bytes());
        assert_eq!(fs::read(w.path.join(path)).unwrap(), b"second");
        // A missing parent is an error, not a created directory, and leaves nothing behind.
        assert!(host.write_bytes("owner", "t", &w.id, "nope/x.txt", b"x", None).is_err());
        assert!(!w.path.join("nope").exists());
        assert_eq!(staging_leftovers(&w.path), Vec::<String>::new());
        // Stale or missing expectations never replace anything.
        assert_eq!(
            host.write_bytes("owner", "t", &w.id, path, b"x", Some(b"stale")).unwrap_err().code,
            "FILE_VERSION_CONFLICT"
        );
        assert_eq!(
            host.write_bytes("owner", "t", &w.id, "absent.txt", b"x", Some(b"was here")).unwrap_err().code,
            "FILE_VERSION_CONFLICT"
        );
        assert_eq!(fs::read(w.path.join(path)).unwrap(), b"second");
        assert_eq!(staging_leftovers(&w.path), Vec::<String>::new());
    }

    #[test]
    fn writes_refuse_streams_reserved_names_and_every_kind_of_reparse_point() {
        let app = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (host, w) = new_workspace(app.path());
        fs::write(outside.path().join("secret"), "unchanged").unwrap();
        link_dir(outside.path(), &w.path.join("escape"));
        fs::write(w.path.join("real.txt"), "real").unwrap();
        for path in [
            "real.txt:hidden",
            "new.txt:hidden",
            "CON",
            "sub/nul.txt",
            "dots.",
            "space ",
            "star*.txt",
            "..\\x",
            "C:/Windows/x.txt",
            "../outside.txt",
            "escape/new.txt",
            "escape/secret",
        ] {
            assert!(
                host.write_bytes("owner", "t", &w.id, path, b"bad", None).is_err(),
                "accepted {path:?}"
            );
        }
        // The junction itself cannot be replaced or written through.
        assert!(host
            .write_bytes("owner", "t", &w.id, "escape", b"bad", Some(b"unchanged"))
            .is_err());
        assert_eq!(fs::read(outside.path().join("secret")).unwrap(), b"unchanged");
        assert!(!outside.path().join("new.txt").exists());
        assert_eq!(fs::read(w.path.join("real.txt")).unwrap(), b"real");
        assert!(!w.path.join("new.txt").exists());
        // No alternate data stream appeared on the real file.
        assert!(fs::read(w.path.join("real.txt:hidden")).is_err());
        // A file symlink is refused as a destination and as a source.
        if link_file(&outside.path().join("secret"), &w.path.join("flink")) {
            assert!(host.write_bytes("owner", "t", &w.id, "flink", b"bad", Some(b"unchanged")).is_err());
            assert!(host.write_bytes("owner", "t", &w.id, "flink", b"bad", None).is_err());
            assert_eq!(
                host.read_text("owner", "t", &w.id, "flink").unwrap_err().code,
                "FILE_ACCESS_DENIED"
            );
            assert_eq!(fs::read(outside.path().join("secret")).unwrap(), b"unchanged");
        } else {
            eprintln!("skipped the file symlink cases: SeCreateSymbolicLinkPrivilege is not held");
        }
        assert_eq!(staging_leftovers(&w.path), Vec::<String>::new());
    }

    #[test]
    fn hard_linked_files_are_neither_read_nor_replaced() {
        let app = tempfile::tempdir().unwrap();
        let (host, w) = new_workspace(app.path());
        fs::write(w.path.join("one.txt"), "shared").unwrap();
        fs::hard_link(w.path.join("one.txt"), w.path.join("two.txt")).unwrap();
        assert_eq!(
            host.read_text("owner", "t", &w.id, "one.txt").unwrap_err().code,
            "HARDLINK_NOT_ALLOWED"
        );
        assert_eq!(
            host.write_bytes("owner", "t", &w.id, "two.txt", b"x", Some(b"shared")).unwrap_err().code,
            "FILE_ACCESS_DENIED"
        );
        assert_eq!(fs::read(w.path.join("one.txt")).unwrap(), b"shared");
        assert_eq!(staging_leftovers(&w.path), Vec::<String>::new());
    }

    #[test]
    fn a_read_only_file_is_replaced_and_stays_read_only() {
        let app = tempfile::tempdir().unwrap();
        let (host, w) = new_workspace(app.path());
        let path = w.path.join("locked.txt");
        fs::write(&path, "old").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        host.write_bytes("owner", "t", &w.id, "locked.txt", b"new", Some(b"old")).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(fs::metadata(&path).unwrap().permissions().readonly());
        // Clear the attribute so the temporary directory can be removed.
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(staging_leftovers(&w.path), Vec::<String>::new());
    }

    #[test]
    fn reads_see_files_other_programs_hold_open_and_directories_are_not_files() {
        use std::os::windows::fs::OpenOptionsExt;
        let app = tempfile::tempdir().unwrap();
        let (host, w) = new_workspace(app.path());
        fs::write(w.path.join("open.txt"), "visible").unwrap();
        fs::create_dir(w.path.join("dir")).unwrap();
        // Another program holds the file for writing, sharing reads and deletes like editors do.
        let _held = fs::OpenOptions::new()
            .write(true)
            .share_mode(7)
            .open(w.path.join("open.txt"))
            .unwrap();
        assert_eq!(host.read_text("owner", "t", &w.id, "open.txt").unwrap(), "visible");
        assert_eq!(
            host.read_text("owner", "t", &w.id, "dir").unwrap_err().code,
            "NOT_A_FILE"
        );
        assert_eq!(
            host.read_text("owner", "t", &w.id, "missing.txt").unwrap_err().code,
            "FILE_NOT_FOUND"
        );
    }
}
