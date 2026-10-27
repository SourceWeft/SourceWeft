//! Shared helpers for the local-host integration tests: directory and file links, a canonical
//! native path and the stored directory identity, on every supported OS.
//!
//! Windows links: a directory *junction* (`mklink /J`, needs no privilege) stands in for a
//! directory symlink; file symlinks need `SeCreateSymbolicLinkPrivilege` (CI runners are
//! administrators), and `link_file` reports a missing privilege instead of silently passing.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// A directory link at `link` pointing at `target`: a symlink on unix, a junction on Windows.
pub fn link_dir(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// A symbolic link to a file. On Windows returns `false` when the process lacks the privilege to
/// create symbolic links (the caller must say so), `true` once the link exists.
pub fn link_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).unwrap();
        true
    }
    #[cfg(windows)]
    {
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => true,
            // ERROR_PRIVILEGE_NOT_HELD
            Err(error) if error.raw_os_error() == Some(1314) => false,
            Err(error) => panic!("symlink_file failed: {error}"),
        }
    }
}

/// `path` canonicalised the way the host stores it: `canonicalize()` on unix, the native
/// non-verbatim form on Windows (`C:\Users\...`, not `\\?\C:\Users\...`).
pub fn canonical(path: &Path) -> PathBuf {
    let canonical = path.canonicalize().unwrap();
    #[cfg(windows)]
    {
        sourceweft_desktop::local_host::winpath::to_native(&canonical).unwrap()
    }
    #[cfg(not(windows))]
    {
        canonical
    }
}

/// `path` as the host reports it to the backend (the wire form).
pub fn wire(path: &Path) -> String {
    sourceweft_desktop::local_host::winpath::host_to_wire(path).unwrap()
}

/// The `(root_device, root_inode)` pair the host records for a directory: the real device and
/// inode on unix, the hashed volume serial and file id on Windows (read back from a scratch host's
/// database, so the test needs no private API).
pub fn stored_identity(path: &Path) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(path).unwrap();
        (meta.dev(), meta.ino())
    }
    #[cfg(windows)]
    {
        let scratch = tempfile::tempdir().unwrap();
        let host = sourceweft_desktop::local_host::LocalHost::open(scratch.path()).unwrap();
        host.grant_directory("identity-probe", path).unwrap();
        let db =
            rusqlite::Connection::open(scratch.path().join("local-host/state.sqlite3")).unwrap();
        db.query_row(
            "SELECT root_device,root_inode FROM directory_grants",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }
}
