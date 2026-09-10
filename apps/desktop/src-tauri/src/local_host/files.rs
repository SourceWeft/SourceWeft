use super::{HostError, LocalHost, Result};
use std::{
    fs::File,
    io::Read,
    path::{Component, Path},
};

pub const MAX_TEXT_BYTES: u64 = 1024 * 1024;

impl LocalHost {
    /// Descriptor-relative traversal rejects symlinks in every component, including
    /// the final file. Authorization is checked before resolving any user path.
    pub fn read_text(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        relative: &str,
    ) -> Result<String> {
        let bytes =
            self.read_bytes_limited(owner, thread, workspace_id, relative, MAX_TEXT_BYTES)?;
        String::from_utf8(bytes).map_err(|_| {
            HostError::new("INVALID_UTF8", "Use a binary file transfer for this file.")
        })
    }

    pub fn read_bytes(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        relative: &str,
    ) -> Result<Vec<u8>> {
        self.read_bytes_limited(owner, thread, workspace_id, relative, MAX_TEXT_BYTES)
    }
    pub fn read_bytes_limited(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        relative: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>> {
        let workspace = self.get_workspace(owner, thread, workspace_id)?;
        let parts = safe_components(relative)?;
        let mut file = open_file_beneath(&workspace.path, &parts, libc::O_RDONLY)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(HostError::new(
                "NOT_A_FILE",
                "Only ordinary text files can be read.",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() > 1 {
                return Err(HostError::new(
                    "HARDLINK_NOT_ALLOWED",
                    "Hard-linked files require an explicit import.",
                ));
            }
        }
        if metadata.len() > max_bytes {
            return Err(HostError::new(
                "FILE_TOO_LARGE",
                "Text reads are limited to 1 MiB.",
            ));
        }
        let mut bytes = Vec::new();
        (&mut file).take(max_bytes + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > max_bytes {
            return Err(HostError::new(
                "FILE_TOO_LARGE",
                "The file grew beyond the text limit.",
            ));
        }
        Ok(bytes)
    }
}

fn safe_components(relative: &str) -> Result<Vec<&std::ffi::OsStr>> {
    if relative.is_empty() || relative.contains('\0') || relative.contains('\\') {
        return Err(HostError::new(
            "INVALID_PATH",
            "A relative file path is required.",
        ));
    }
    let mut parts = Vec::new();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => parts.push(part),
            _ => {
                return Err(HostError::new(
                    "INVALID_PATH",
                    "Absolute paths and parent traversal are not allowed.",
                ))
            }
        }
    }
    if parts.is_empty() {
        return Err(HostError::new("INVALID_PATH", "A file path is required."));
    }
    Ok(parts)
}

#[cfg(unix)]
fn open_file_beneath(root: &Path, parts: &[&std::ffi::OsStr], final_flags: i32) -> Result<File> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
    };
    let mut directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)?;
    for (index, part) in parts.iter().enumerate() {
        let name = CString::new(part.as_bytes())
            .map_err(|_| HostError::new("INVALID_PATH", "NUL bytes are not allowed."))?;
        let final_part = index == parts.len() - 1;
        let flags = (if final_part {
            final_flags
        } else {
            libc::O_RDONLY
        }) | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if final_part { 0 } else { libc::O_DIRECTORY };
        // SAFETY: directory owns a valid descriptor; name is NUL-terminated. openat
        // returns a fresh descriptor whose sole owner is the File constructed below.
        let descriptor =
            unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        if descriptor < 0 {
            return Err(HostError::new(
                "FILE_ACCESS_DENIED",
                std::io::Error::last_os_error().to_string(),
            ));
        }
        let next = unsafe { File::from_raw_fd(descriptor) };
        if final_part {
            return Ok(next);
        }
        directory = next;
    }
    Err(HostError::new("INVALID_PATH", "A file path is required."))
}

#[cfg(not(unix))]
fn open_file_beneath(_: &Path, _: &[&std::ffi::OsStr], _: i32) -> Result<File> {
    Err(HostError::new(
        "UNSUPPORTED_PLATFORM",
        "Local file access is currently implemented for macOS only.",
    ))
}

impl LocalHost {
    /// All directory traversal and file opening are descriptor-relative. Existing
    /// files require a previously read version and are backed up before replacement.
    #[cfg(target_os = "macos")]
    pub fn write_bytes(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        relative: &str,
        content: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<serde_json::Value> {
        use std::{
            ffi::CString,
            io::Write,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::{
                    ffi::OsStrExt,
                    fs::{MetadataExt, OpenOptionsExt},
                },
            },
        };
        let workspace = self.get_workspace(owner, thread, workspace_id)?;
        let parts = safe_components(relative)?;
        let mut parent = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&workspace.path)?;
        for part in &parts[..parts.len() - 1] {
            let name = CString::new(part.as_bytes())
                .map_err(|_| HostError::new("INVALID_PATH", "Invalid path"))?;
            let fd = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            parent = unsafe { File::from_raw_fd(fd) };
        }
        let name = CString::new(parts.last().unwrap().as_bytes())
            .map_err(|_| HostError::new("INVALID_PATH", "Invalid path"))?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        let mut backup = None;
        let mut mode = 0o600;
        let exists = fd >= 0;
        if exists {
            let mut file = unsafe { File::from_raw_fd(fd) };
            let meta = file.metadata()?;
            mode = meta.mode() & 0o777;
            if !meta.is_file() || meta.nlink() != 1 || meta.len() > MAX_TEXT_BYTES {
                return Err(HostError::new(
                    "FILE_ACCESS_DENIED",
                    "Only bounded ordinary files can be replaced",
                ));
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take(MAX_TEXT_BYTES + 1)
                .read_to_end(&mut bytes)?;
            if expected != Some(bytes.as_slice()) {
                return Err(HostError::new(
                    "FILE_VERSION_CONFLICT",
                    "Read the current file before replacing it",
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let base = self.backup_base()?;
            let mut saved = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(base.join(&id))?;
            saved.write_all(&bytes)?;
            saved.sync_all()?;
            let metadata = serde_json::json!({"owner":owner,"thread":thread,"workspaceId":workspace_id,"path":relative});
            let mut marker = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(base.join(format!("{id}.json")))?;
            marker.write_all(metadata.to_string().as_bytes())?;
            marker.sync_all()?;
            backup = Some(id);
        } else {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENOENT) {
                return Err(error.into());
            }
            if expected.is_some() {
                return Err(HostError::new(
                    "FILE_VERSION_CONFLICT",
                    "The previously read file was removed",
                ));
            }
        }
        let temporary = CString::new(format!(".sourceweft-{}", uuid::Uuid::new_v4())).unwrap();
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut staged = unsafe { File::from_raw_fd(fd) };
        let result = (|| -> Result<()> {
            use std::os::unix::fs::PermissionsExt;
            staged.set_permissions(std::fs::Permissions::from_mode(mode))?;
            staged.write_all(content)?;
            staged.sync_all()?;
            // RENAME_EXCL protects a concurrently created destination for new files.
            let renamed = unsafe {
                libc::renameatx_np(
                    parent.as_raw_fd(),
                    temporary.as_ptr(),
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    if exists { 0 } else { libc::RENAME_EXCL },
                )
            };
            if renamed != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            parent.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            unsafe { libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0) };
        }
        result?;
        Ok(serde_json::json!({"bytes":content.len(),"backupId":backup}))
    }
}

#[cfg(not(target_os = "macos"))]
impl LocalHost {
    pub fn write_bytes(
        &self,
        _owner: &str,
        _thread: &str,
        _workspace_id: &str,
        _relative: &str,
        _content: &[u8],
        _expected: Option<&[u8]>,
    ) -> Result<serde_json::Value> {
        Err(HostError::new(
            "UNSUPPORTED_PLATFORM",
            "Local file writes require macOS",
        ))
    }
}
