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
        let workspace = self.get_workspace(owner, thread, workspace_id)?;
        let parts = safe_components(relative)?;
        let mut file = open_file_beneath(&workspace.path, &parts)?;
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
        if metadata.len() > MAX_TEXT_BYTES {
            return Err(HostError::new(
                "FILE_TOO_LARGE",
                "Text reads are limited to 1 MiB.",
            ));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_TEXT_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_TEXT_BYTES {
            return Err(HostError::new(
                "FILE_TOO_LARGE",
                "The file grew beyond the text limit.",
            ));
        }
        String::from_utf8(bytes).map_err(|_| {
            HostError::new("INVALID_UTF8", "Use a binary file transfer for this file.")
        })
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
fn open_file_beneath(root: &Path, parts: &[&std::ffi::OsStr]) -> Result<File> {
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
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if final_part { 0 } else { libc::O_DIRECTORY };
        // SAFETY: directory owns a valid descriptor; name is NUL-terminated. openat
        // returns a fresh descriptor whose sole owner is the File constructed below.
        let descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
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
fn open_file_beneath(_: &Path, _: &[&std::ffi::OsStr]) -> Result<File> {
    Err(HostError::new(
        "UNSUPPORTED_PLATFORM",
        "Local file access is currently implemented for macOS only.",
    ))
}
