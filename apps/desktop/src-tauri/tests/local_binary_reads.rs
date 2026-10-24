#![cfg(unix)]
use base64::{engine::general_purpose::STANDARD, Engine as _};
use sourceweft_desktop::local_host::LocalHost;
use std::fs;

#[test]
fn chunks_are_an_immutable_scoped_snapshot_and_close_releases_them() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let bytes = vec![137u8; 1024 * 1024 + 37];
    fs::write(workspace.path.join("image.png"), &bytes).unwrap();
    assert_eq!(
        host.read_text("owner", "thread", &workspace.id, "image.png")
            .unwrap_err()
            .code,
        "FILE_TOO_LARGE"
    );
    let begin = host
        .begin_binary_read("owner", "thread", &workspace.id, "image.png")
        .unwrap();
    let id = begin["transferId"].as_str().unwrap();
    fs::write(workspace.path.join("image.png"), b"changed after begin").unwrap();
    let mut received = Vec::new();
    for offset in [0, 512 * 1024, 1024 * 1024] {
        let part = host
            .read_binary_chunk("owner", "thread", &workspace.id, "image.png", id, offset)
            .unwrap();
        received.extend(STANDARD.decode(part["content"].as_str().unwrap()).unwrap());
    }
    assert_eq!(received, bytes);
    assert!(host
        .read_binary_chunk("owner", "thread", &workspace.id, "other.png", id, 0)
        .is_err());
    assert!(host
        .read_binary_chunk("other", "thread", &workspace.id, "image.png", id, 0)
        .is_err());
    assert!(host
        .read_binary_chunk("owner", "thread", &workspace.id, "image.png", id, 1)
        .is_err());
    host.close_binary_read("owner", "thread", &workspace.id, id)
        .unwrap();
    assert_eq!(
        host.read_binary_chunk("owner", "thread", &workspace.id, "image.png", id, 0)
            .unwrap_err()
            .code,
        "FILE_TRANSFER_EXPIRED"
    );
}

#[test]
fn transfer_capacity_is_bounded_and_paths_cannot_escape() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    fs::write(workspace.path.join("file.bin"), [0, 1, 2]).unwrap();
    assert!(host
        .begin_binary_read("owner", "thread", &workspace.id, "../file.bin")
        .is_err());
    let first = host
        .begin_binary_read("owner", "thread", &workspace.id, "file.bin")
        .unwrap();
    host.begin_binary_read("owner", "thread", &workspace.id, "file.bin")
        .unwrap();
    assert_eq!(
        host.begin_binary_read("owner", "thread", &workspace.id, "file.bin")
            .unwrap_err()
            .code,
        "FILE_TRANSFER_BUSY"
    );
    host.close_binary_read(
        "owner",
        "thread",
        &workspace.id,
        first["transferId"].as_str().unwrap(),
    )
    .unwrap();
    host.begin_binary_read("owner", "thread", &workspace.id, "file.bin")
        .unwrap();
}

#[test]
fn native_search_keeps_literal_matching_and_file_scope_on_the_host() {
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    fs::write(
        workspace.path.join("match.txt"),
        "first\nUnicode 你好 a.b value\n",
    )
    .unwrap();
    fs::write(workspace.path.join("other.txt"), "aXb").unwrap();
    fs::write(workspace.path.join("binary.bin"), [0, 255]).unwrap();
    let paths = vec!["match.txt".into(), "other.txt".into(), "binary.bin".into()];
    let result = host
        .grep_files(
            "owner",
            "thread",
            &workspace.id,
            &paths,
            "a.b",
            true,
            true,
            true,
            None,
        )
        .unwrap();
    assert_eq!(result["visited"], 3);
    assert_eq!(result["matches"].as_array().unwrap().len(), 1);
    assert_eq!(result["matches"][0]["path"], "match.txt");
    assert_eq!(result["matches"][0]["line"], 2);
    assert_eq!(result["skipped"][0], "binary.bin");
    assert!(host
        .grep_files(
            "owner",
            "thread",
            &workspace.id,
            &["../secret".into()],
            "secret",
            false,
            true,
            true,
            None
        )
        .is_err());
    let cancelled = std::sync::atomic::AtomicBool::new(true);
    assert_eq!(
        host.grep_files(
            "owner",
            "thread",
            &workspace.id,
            &paths,
            "value",
            false,
            true,
            true,
            Some(&cancelled)
        )
        .unwrap_err()
        .code,
        "CALL_CANCELLED"
    );
}

#[test]
fn missing_binary_file_has_structured_code_without_weakening_path_denials() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let host = LocalHost::open(temp.path()).unwrap();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    assert_eq!(
        host.begin_binary_read("owner", "thread", &workspace.id, "missing.bin")
            .unwrap_err()
            .code,
        "FILE_NOT_FOUND"
    );
    fs::write(workspace.path.join("target.bin"), b"present").unwrap();
    symlink(
        workspace.path.join("target.bin"),
        workspace.path.join("link.bin"),
    )
    .unwrap();
    assert_eq!(
        host.begin_binary_read("owner", "thread", &workspace.id, "link.bin")
            .unwrap_err()
            .code,
        "FILE_ACCESS_DENIED"
    );
    assert_ne!(
        host.begin_binary_read("owner", "thread", &workspace.id, "../missing.bin")
            .unwrap_err()
            .code,
        "FILE_NOT_FOUND"
    );
    assert_ne!(
        host.begin_binary_read("other", "thread", &workspace.id, "missing.bin")
            .unwrap_err()
            .code,
        "FILE_NOT_FOUND"
    );
}

#[test]
fn io_error_classification_only_marks_not_found_as_missing() {
    use sourceweft_desktop::local_host::HostError;
    let missing: HostError = std::io::Error::from(std::io::ErrorKind::NotFound).into();
    assert_eq!(missing.code, "FILE_NOT_FOUND");
    for kind in [
        std::io::ErrorKind::PermissionDenied,
        std::io::ErrorKind::Interrupted,
        std::io::ErrorKind::Other,
    ] {
        let error: HostError = std::io::Error::from(kind).into();
        assert_eq!(error.code, "LOCAL_IO_ERROR");
    }
}
