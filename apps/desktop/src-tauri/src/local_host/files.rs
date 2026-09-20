use super::{HostError, LocalHost, Result};
use std::{
    fs::File,
    io::Read,
    path::{Component, Path},
};

pub const MAX_TEXT_BYTES: u64 = 1024 * 1024;
pub const MAX_BINARY_BYTES: u64 = 20 * 1024 * 1024;
const BINARY_CHUNK_BYTES: usize = 512 * 1024;

pub(crate) struct BinaryReadSession {
    owner: String,
    thread: String,
    workspace_id: String,
    path: String,
    content: Vec<u8>,
    created: std::time::Instant,
}

impl LocalHost {
    pub fn grep_files(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        paths: &[String],
        pattern: &str,
        ignore_case: bool,
        first_per_file: bool,
        literal: bool,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<serde_json::Value> {
        if paths.len() > 100 || pattern.len() > 4096 {
            return Err(HostError::new(
                "SEARCH_LIMIT",
                "Search at most 100 files with a bounded pattern.",
            ));
        }
        self.get_workspace(owner, thread, workspace_id)?;
        let expression_pattern = if literal {
            regex::escape(pattern)
        } else {
            pattern.to_owned()
        };
        let expression = regex::RegexBuilder::new(&expression_pattern)
            .case_insensitive(ignore_case)
            .size_limit(2 * 1024 * 1024)
            .build()
            .map_err(|error| HostError::new("INVALID_PATTERN", error.to_string()))?;
        let started = std::time::Instant::now();
        let mut matches = Vec::new();
        let mut skipped = Vec::new();
        let mut visited = 0;
        let mut truncated = false;
        'files: for path in paths {
            if cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
                return Err(HostError::new("CALL_CANCELLED", "File search cancelled"));
            }
            if started.elapsed().as_secs() >= 25 {
                truncated = true;
                break;
            }
            let content = match self.read_bytes_limited(
                owner,
                thread,
                workspace_id,
                path,
                MAX_BINARY_BYTES,
            ) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) if !text.contains('\0') => text,
                    _ => {
                        skipped.push(path.clone());
                        visited += 1;
                        continue;
                    }
                },
                Err(error)
                    if error.code == "FILE_TOO_LARGE"
                        || error.code == "FILE_CHANGED"
                        || error.code == "HARDLINK_NOT_ALLOWED" =>
                {
                    skipped.push(path.clone());
                    visited += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            visited += 1;
            for (index, line) in content.lines().enumerate() {
                if let Some(found) = expression.find(line) {
                    let start = line[..found.start()]
                        .char_indices()
                        .rev()
                        .nth(159)
                        .map(|(index, _)| index)
                        .unwrap_or(0);
                    matches.push(serde_json::json!({"path":path,"line":index+1,"text":line[start..].chars().take(1000).collect::<String>()}));
                    if matches.len() >= 100 {
                        truncated = !first_per_file || visited < paths.len();
                        break 'files;
                    }
                    if first_per_file {
                        break;
                    }
                }
            }
        }
        self.get_workspace(owner, thread, workspace_id)?;
        Ok(
            serde_json::json!({"matches":matches,"visited":visited,"skipped":skipped,"truncated":truncated}),
        )
    }

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
                "Only ordinary files can be read.",
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
                format!("File exceeds the read limit of {max_bytes} bytes."),
            ));
        }
        let mut bytes = Vec::new();
        (&mut file).take(max_bytes + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > max_bytes {
            return Err(HostError::new(
                "FILE_TOO_LARGE",
                "The file grew beyond the read limit.",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let after = file.metadata()?;
            if metadata.len() != after.len()
                || metadata.mtime() != after.mtime()
                || metadata.mtime_nsec() != after.mtime_nsec()
                || metadata.ctime() != after.ctime()
                || metadata.ctime_nsec() != after.ctime_nsec()
            {
                return Err(HostError::new(
                    "FILE_CHANGED",
                    "File changed during the read. Read it again.",
                ));
            }
        }
        Ok(bytes)
    }

    pub fn begin_binary_read(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        path: &str,
    ) -> Result<serde_json::Value> {
        let mut sessions = self
            .binary_reads
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "File transfer lock failed"))?;
        sessions.retain(|_, session| session.created.elapsed().as_secs() < 60);
        if sessions.len() >= 4
            || sessions
                .values()
                .filter(|session| session.owner == owner)
                .count()
                >= 2
        {
            return Err(HostError::new(
                "FILE_TRANSFER_BUSY",
                "Too many active file transfers",
            ));
        }
        let content =
            self.read_bytes_limited(owner, thread, workspace_id, path, MAX_BINARY_BYTES)?;
        let size = content.len();
        let id = uuid::Uuid::new_v4().to_string();
        sessions.insert(
            id.clone(),
            BinaryReadSession {
                owner: owner.into(),
                thread: thread.into(),
                workspace_id: workspace_id.into(),
                path: path.into(),
                content,
                created: std::time::Instant::now(),
            },
        );
        Ok(
            serde_json::json!({"transferId": id, "sizeBytes": size, "chunkBytes": BINARY_CHUNK_BYTES}),
        )
    }

    pub fn read_binary_chunk(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        path: &str,
        transfer_id: &str,
        offset: usize,
    ) -> Result<serde_json::Value> {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        self.get_workspace(owner, thread, workspace_id)?;
        let sessions = self
            .binary_reads
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "File transfer lock failed"))?;
        let session = sessions.get(transfer_id).ok_or_else(|| {
            HostError::new("FILE_TRANSFER_EXPIRED", "File transfer is unavailable")
        })?;
        if session.owner != owner
            || session.thread != thread
            || session.workspace_id != workspace_id
            || session.path != path
        {
            return Err(HostError::new(
                "FILE_ACCESS_DENIED",
                "File transfer scope mismatch",
            ));
        }
        if session.created.elapsed().as_secs() >= 60 {
            return Err(HostError::new(
                "FILE_TRANSFER_EXPIRED",
                "File transfer expired",
            ));
        }
        if offset > session.content.len() || offset % BINARY_CHUNK_BYTES != 0 {
            return Err(HostError::new("INVALID_RANGE", "Invalid file chunk offset"));
        }
        let end = (offset + BINARY_CHUNK_BYTES).min(session.content.len());
        Ok(
            serde_json::json!({"transferId": transfer_id, "offset": offset, "content": STANDARD.encode(&session.content[offset..end]), "done": end == session.content.len()}),
        )
    }

    pub fn close_binary_read(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        transfer_id: &str,
    ) -> Result<serde_json::Value> {
        self.get_workspace(owner, thread, workspace_id)?;
        let mut sessions = self
            .binary_reads
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "File transfer lock failed"))?;
        if let Some(session) = sessions.get(transfer_id) {
            if session.owner != owner
                || session.thread != thread
                || session.workspace_id != workspace_id
            {
                return Err(HostError::new(
                    "FILE_ACCESS_DENIED",
                    "File transfer scope mismatch",
                ));
            }
        }
        sessions.remove(transfer_id);
        Ok(serde_json::json!({"closed": true}))
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
pub(crate) fn open_file_beneath(
    root: &Path,
    parts: &[&std::ffi::OsStr],
    final_flags: i32,
) -> Result<File> {
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

/// Enumerate through a held descriptor: a renamed parent or swapped symlink must
/// not redirect a draft listing outside the picker-authorized directory.
#[cfg(target_os = "macos")]
pub(crate) fn list_granted_directory(
    root: &Path,
    relative: &Path,
) -> Result<Vec<serde_json::Value>> {
    use std::{
        ffi::{CStr, OsStr},
        os::{fd::IntoRawFd, unix::ffi::OsStrExt},
    };
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part),
            Component::CurDir => (),
            _ => {
                return Err(HostError::new(
                    "PATH_DENIED",
                    "Outside the selected directory",
                ))
            }
        }
    }
    if parts.is_empty() {
        parts.push(OsStr::new("."));
    }
    let descriptor =
        open_file_beneath(root, &parts, libc::O_RDONLY | libc::O_DIRECTORY)?.into_raw_fd();
    let raw = unsafe { libc::fdopendir(descriptor) };
    if raw.is_null() {
        unsafe {
            libc::close(descriptor);
        }
        return Err(std::io::Error::last_os_error().into());
    }
    struct Directory(*mut libc::DIR);
    impl Drop for Directory {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let directory = Directory(raw);
    let mut files = Vec::new();
    loop {
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(directory.0) };
        if entry.is_null() {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(0) {
                return Err(error.into());
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        let mut meta: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                descriptor,
                name.as_ptr(),
                &mut meta,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let kind = meta.st_mode & libc::S_IFMT;
        let is_dir = kind == libc::S_IFDIR;
        if !is_dir && (kind != libc::S_IFREG || meta.st_nlink > 1) {
            continue;
        }
        if files.len() >= 500 {
            return Err(HostError::new(
                "DIRECTORY_TOO_LARGE",
                "More than 500 entries. Choose a narrower directory.",
            ));
        }
        files.push(serde_json::json!({"path":root.join(relative).join(OsStr::from_bytes(name.to_bytes())),"is_dir":is_dir,"size":meta.st_size}));
    }
    Ok(files)
}
