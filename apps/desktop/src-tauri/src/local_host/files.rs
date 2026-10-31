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
        let mut file = open_file_beneath(&workspace.path, &parts, OpenKind::Read)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(HostError::new(
                "NOT_A_FILE",
                "Only ordinary files can be read.",
            ));
        }
        if link_count(&file, &metadata)? > 1 {
            return Err(HostError::new(
                "HARDLINK_NOT_ALLOWED",
                "Hard-linked files require an explicit import.",
            ));
        }
        if metadata.len() > max_bytes {
            return Err(HostError::new(
                "FILE_TOO_LARGE",
                format!("File exceeds the read limit of {max_bytes} bytes."),
            ));
        }
        let before = change_stamp(&file, &metadata)?;
        let mut bytes = Vec::new();
        (&mut file).take(max_bytes + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > max_bytes {
            return Err(HostError::new(
                "FILE_TOO_LARGE",
                "The file grew beyond the read limit.",
            ));
        }
        if before != change_stamp(&file, &file.metadata()?)? {
            return Err(HostError::new(
                "FILE_CHANGED",
                "File changed during the read. Read it again.",
            ));
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

/// How the final component of a path is opened by [`open_file_beneath`]: an ordinary file read
/// (a directory can be opened this way too, the caller then rejects it), or a directory to list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpenKind {
    Read,
    Dir,
}

#[cfg(unix)]
impl OpenKind {
    /// The `open(2)` flags of the final component (before `O_NOFOLLOW` and friends are added).
    fn flags(self) -> i32 {
        match self {
            OpenKind::Read => libc::O_RDONLY,
            OpenKind::Dir => libc::O_RDONLY | libc::O_DIRECTORY,
        }
    }
}

/// The number of hard links to an open file.
pub(crate) fn link_count(file: &File, metadata: &std::fs::Metadata) -> Result<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = file;
        Ok(metadata.nlink())
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        Ok(u64::from(nt::query(file)?.links))
    }
}

/// What identifies one version of an open file: size and modification/change times. Two stamps
/// taken around a read differ when the file was written or replaced meanwhile.
#[derive(PartialEq, Eq)]
struct ChangeStamp(i64, i64, i64, i64, i64);

fn change_stamp(file: &File, metadata: &std::fs::Metadata) -> Result<ChangeStamp> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = file;
        Ok(ChangeStamp(
            metadata.len() as i64,
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        ))
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        let info = nt::query(file)?;
        Ok(ChangeStamp(
            info.end_of_file,
            info.last_write,
            info.change_time,
            0,
            0,
        ))
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
    kind: OpenKind,
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
            kind.flags()
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
            let error = std::io::Error::last_os_error();
            return Err(HostError::new(
                if error.kind() == std::io::ErrorKind::NotFound {
                    "FILE_NOT_FOUND"
                } else {
                    "FILE_ACCESS_DENIED"
                },
                error.to_string(),
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

/// Whether two spellings of a Windows file name are the same name: equal up to case, which is
/// how NTFS compares them. Anything else (an 8.3 alias, say) is a different spelling.
#[cfg(any(windows, test))]
fn names_match(a: &str, b: &str) -> bool {
    a.chars()
        .flat_map(char::to_uppercase)
        .eq(b.chars().flat_map(char::to_uppercase))
}

#[cfg(windows)]
pub(crate) use nt::open_file_beneath;

#[cfg(not(any(unix, windows)))]
fn open_file_beneath(_: &Path, _: &[&std::ffi::OsStr], _: OpenKind) -> Result<File> {
    Err(HostError::new(
        "UNSUPPORTED_PLATFORM",
        "Local file access is not available on this platform.",
    ))
}

impl LocalHost {
    /// All directory traversal and file opening are descriptor-relative. Existing
    /// files require a previously read version and are backed up before replacement.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
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
            // No-replace protects a concurrently created destination for new files.
            rename_noreplace(parent.as_raw_fd(), &temporary, &name, exists)?;
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

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
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
            "Local file writes require macOS or Linux",
        ))
    }
}

/// Renames `from` to `to`, both relative to `dir`. When `exists` is false the rename fails
/// instead of replacing a destination that appeared concurrently; when it is true (the caller
/// already verified and backed up the destination) it is a plain rename.
#[cfg(target_os = "macos")]
fn rename_noreplace(
    dir: std::os::fd::RawFd,
    from: &std::ffi::CStr,
    to: &std::ffi::CStr,
    exists: bool,
) -> std::io::Result<()> {
    let renamed = unsafe {
        libc::renameatx_np(
            dir,
            from.as_ptr(),
            dir,
            to.as_ptr(),
            if exists { 0 } else { libc::RENAME_EXCL },
        )
    };
    if renamed != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Linux counterpart of the macOS `renameatx_np(RENAME_EXCL)` shim: `renameat2` with
/// `RENAME_NOREPLACE`, through the raw syscall so it does not depend on the glibc wrapper.
#[cfg(target_os = "linux")]
fn rename_noreplace(
    dir: std::os::fd::RawFd,
    from: &std::ffi::CStr,
    to: &std::ffi::CStr,
    exists: bool,
) -> std::io::Result<()> {
    let flags: libc::c_uint = if exists { 0 } else { libc::RENAME_NOREPLACE };
    let renamed = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            dir,
            from.as_ptr(),
            dir,
            to.as_ptr(),
            flags,
        )
    };
    if renamed != 0 {
        let error = std::io::Error::last_os_error();
        // Some filesystems (certain FUSE mounts, older NFS) and old kernels do not implement
        // RENAME_NOREPLACE; say so instead of a bare "Invalid argument". There is deliberately
        // no fallback to a plain rename, which could replace a file that appeared concurrently.
        return Err(match error.raw_os_error() {
            Some(libc::EINVAL | libc::ENOSYS) if !exists => std::io::Error::new(
                error.kind(),
                format!(
                    "this folder's filesystem does not support creating a file without \
                     replacing one (renameat2 RENAME_NOREPLACE): {error}"
                ),
            ),
            _ => error,
        });
    }
    Ok(())
}

/// Resets `errno` so a following `readdir` end-of-directory can be told apart from an error.
#[cfg(target_os = "macos")]
fn clear_errno() {
    unsafe {
        *libc::__error() = 0;
    }
}

#[cfg(target_os = "linux")]
fn clear_errno() {
    unsafe {
        *libc::__errno_location() = 0;
    }
}

/// Enumerate through a held descriptor: a renamed parent or swapped symlink must
/// not redirect a draft listing outside the picker-authorized directory.
#[cfg(any(target_os = "macos", target_os = "linux"))]
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
    let descriptor = open_file_beneath(root, &parts, OpenKind::Dir)?.into_raw_fd();
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
        clear_errno();
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

#[cfg(windows)]
impl LocalHost {
    /// All directory traversal and file opening are handle-relative (`NtCreateFile` with the
    /// parent directory as `RootDirectory`, `FILE_OPEN_REPARSE_POINT`, every handle checked for a
    /// reparse point before it is used as a parent). Existing files require a previously read
    /// version and are backed up before replacement; the new content is staged next to the
    /// destination and published with a rename that never replaces a file this call did not verify.
    pub fn write_bytes(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        relative: &str,
        content: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<serde_json::Value> {
        use std::io::Write;
        let workspace = self.get_workspace(owner, thread, workspace_id)?;
        let parts = safe_components(relative)?;
        let (last, parents) = parts
            .split_last()
            .ok_or_else(|| HostError::new("INVALID_PATH", "A file path is required."))?;
        let name = nt::component(last)?;
        let parent = nt::open_beneath(&workspace.path, parents, nt::Role::Parent)?;
        let mut backup = None;
        let mut attributes = 0;
        let exists = match nt::open_entry(&parent, name, nt::Role::Read) {
            Ok((mut file, info)) => {
                let meta = file.metadata()?;
                if !meta.is_file() || info.links != 1 || meta.len() > MAX_TEXT_BYTES {
                    return Err(HostError::new(
                        "FILE_ACCESS_DENIED",
                        "Only bounded ordinary files can be replaced",
                    ));
                }
                attributes = info.attributes;
                let mut bytes = Vec::new();
                (&mut file)
                    .take(MAX_TEXT_BYTES + 1)
                    .read_to_end(&mut bytes)?;
                // The destination must not be held open by this call while it is replaced.
                drop(file);
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
                    .open(base.join(&id))?;
                saved.write_all(&bytes)?;
                saved.sync_all()?;
                let metadata = serde_json::json!({"owner":owner,"thread":thread,"workspaceId":workspace_id,"path":relative});
                let mut marker = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(base.join(format!("{id}.json")))?;
                marker.write_all(metadata.to_string().as_bytes())?;
                marker.sync_all()?;
                backup = Some(id);
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if expected.is_some() {
                    return Err(HostError::new(
                        "FILE_VERSION_CONFLICT",
                        "The previously read file was removed",
                    ));
                }
                false
            }
            Err(error) => return Err(error.into()),
        };
        let temporary = format!(".sourceweft-{}", uuid::Uuid::new_v4());
        let mut staged = nt::create_staged(&parent, &temporary)?;
        let result = (|| -> Result<()> {
            // The read-only, hidden and system attributes of the replaced file carry over, as the
            // permission bits do on unix.
            let carried = attributes & nt::CARRIED_ATTRIBUTES;
            if carried != 0 {
                nt::set_attributes(&staged, carried)?;
            }
            staged.write_all(content)?;
            staged.sync_all()?;
            // No-replace protects a concurrently created destination for new files.
            nt::rename_noreplace(
                &parent,
                &staged,
                name,
                exists,
                carried & nt::READ_ONLY != 0,
            )?;
            Ok(())
        })();
        if result.is_err() {
            nt::discard(&staged);
        }
        result?;
        Ok(serde_json::json!({"bytes":content.len(),"backupId":backup}))
    }
}

/// Windows counterpart of the unix listing: enumerates through the held directory handle, skips
/// reparse points (symlinks, junctions, mount points), hard-linked files and names the host could
/// not address again, and reports wire-form paths.
#[cfg(windows)]
pub(crate) fn list_granted_directory(
    root: &Path,
    relative: &Path,
) -> Result<Vec<serde_json::Value>> {
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
    // No parts lists the root itself, as on unix (where the empty walk opens ".").
    let directory = if parts.is_empty() {
        nt::open_beneath(root, &parts, nt::Role::Dir)?
    } else {
        open_file_beneath(root, &parts, OpenKind::Dir)?
    };
    let mut base = root.to_owned();
    for part in &parts {
        base.push(part);
    }
    let mut files = Vec::new();
    nt::enumerate(&directory, |entry| {
        if entry.is_reparse_point()
            || super::winpath::validate_component(&entry.name).is_err()
        {
            return Ok(());
        }
        let is_dir = entry.is_directory();
        if !is_dir {
            // The directory listing carries no link count: ask the entry itself, through the
            // held directory, so a name swapped for a link meanwhile is skipped too.
            match nt::open_entry(&directory, &entry.name, nt::Role::Stat) {
                Ok((_, info)) if info.links > 1 => return Ok(()),
                Ok(_) => (),
                Err(error) if nt::is_vanished_or_link(&error) => return Ok(()),
                Err(error) => return Err(error.into()),
            }
        }
        if files.len() >= 500 {
            return Err(HostError::new(
                "DIRECTORY_TOO_LARGE",
                "More than 500 entries. Choose a narrower directory.",
            ));
        }
        files.push(serde_json::json!({
            "path": super::winpath::host_to_wire(&base.join(&entry.name))?,
            "is_dir": is_dir,
            "size": entry.size
        }));
        Ok(())
    })?;
    Ok(files)
}

/// `file.list` on Windows: the entries of `parts` below the open workspace root `root` (a single
/// file, or a directory, optionally with everything below it), as `{path, is_dir, size}` with
/// `path` relative to the workspace root and `/`-separated; `relative` is the spelling the request
/// used (the path reported for a single file, and the prefix of what is found below a directory).
///
/// Everything is read through handles: the target is opened by walking the workspace root's
/// handle, every subdirectory is opened through its parent's handle, and entries are enumerated
/// from the handle in hand, so a directory swapped for a junction (or renamed away) while the
/// listing runs cannot redirect it outside the workspace. Reparse points, hard-linked files and
/// names the host could not address again are skipped, as on unix.
#[cfg(windows)]
pub(crate) fn list_workspace_in(
    root: &File,
    parts: &[&std::ffi::OsStr],
    relative: &str,
    recursive: bool,
) -> Result<serde_json::Value> {
    let (target, info) = nt::open_listing_target(root, parts)?;
    if !info.directory {
        if info.links > 1 {
            return Err(HostError::new(
                "HARDLINK_NOT_ALLOWED",
                "Hard-linked files cannot be searched.",
            ));
        }
        return Ok(serde_json::json!({
            "files": [{"path": relative, "is_dir": false, "size": info.end_of_file}]
        }));
    }
    let mut prefix = String::new();
    for part in parts {
        prefix.push_str(&part.to_string_lossy());
        prefix.push('/');
    }
    let mut files: Vec<serde_json::Value> = Vec::new();
    let mut pending = vec![(target, prefix)];
    while let Some((directory, prefix)) = pending.pop() {
        let mut found = Vec::new();
        nt::enumerate(&directory, |entry| {
            if entry.is_reparse_point()
                || super::winpath::validate_component(&entry.name).is_err()
            {
                return Ok(());
            }
            let is_dir = entry.is_directory();
            if !is_dir {
                // The directory listing carries no link count: ask the entry itself, through the
                // held directory, so a name swapped for a link meanwhile is skipped too.
                match nt::open_entry(&directory, &entry.name, nt::Role::Stat) {
                    Ok((_, info)) if info.links > 1 => return Ok(()),
                    Ok(_) => (),
                    Err(error) if nt::is_vanished_or_link(&error) => return Ok(()),
                    Err(error) => return Err(error.into()),
                }
            }
            found.push((entry.name, is_dir, entry.size));
            Ok(())
        })?;
        for (name, is_dir, size) in found {
            if files.len() >= 500 {
                return Err(HostError::new(
                    "DIRECTORY_TOO_LARGE",
                    "More than 500 entries. Choose a narrower directory.",
                ));
            }
            let path = format!("{prefix}{name}");
            if recursive && is_dir {
                match nt::open_entry(&directory, &name, nt::Role::Dir) {
                    Ok((child, _)) => pending.push((child, format!("{path}/"))),
                    // Vanished or turned into a link since it was enumerated: not listed below.
                    Err(error) if nt::is_vanished_or_link(&error) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            files.push(serde_json::json!({"path": path, "is_dir": is_dir, "size": size}));
        }
    }
    Ok(serde_json::json!({"files": files}))
}

/// The Windows primitives under the file operations. Everything is relative to a directory
/// handle that this module opened and checked itself; no path is ever re-resolved.
///
/// Why this is the symlink-escape defence, and not a check-then-open: `NtCreateFile` with a
/// `RootDirectory` handle resolves one name inside the directory *object* the handle refers to.
/// `FILE_OPEN_REPARSE_POINT` makes it open a reparse point (symlink, junction, mount point,
/// placeholder) itself instead of following it, and the attribute-tag query on the **opened
/// handle** tells whether it is one, so the answer describes the object about to be used and not
/// whatever the name points at a moment later. A reparse point is refused before it is ever used
/// as a parent. Renaming or replacing a directory behind the handle's back does not redirect the
/// walk: the handle keeps referring to the original directory.
#[cfg(windows)]
pub(crate) mod nt {
    use super::{HostError, OpenKind, Result};
    use std::{
        ffi::{c_void, OsStr},
        fs::File,
        io,
        mem::{offset_of, size_of, zeroed, MaybeUninit},
        os::windows::{
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle},
        },
        path::Path,
        ptr,
    };
    use windows_sys::{
        Wdk::{
            Foundation::OBJECT_ATTRIBUTES,
            Storage::FileSystem::{
                FileRenameInformationEx, NtCreateFile, NtSetInformationFile, FILE_CREATE,
                FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
                FILE_SYNCHRONOUS_IO_NONALERT,
            },
        },
        Win32::{
            Foundation::{
                RtlNtStatusToDosError, ERROR_CANT_ACCESS_FILE, ERROR_DIRECTORY,
                ERROR_INVALID_NAME, ERROR_NO_MORE_FILES, HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE,
                UNICODE_STRING,
            },
            Storage::FileSystem::{
                FileAttributeTagInfo, FileBasicInfo, FileDispositionInfoEx,
                FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, FileStandardInfo,
                GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
                SetFileInformationByHandle, DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY,
                FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN,
                FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_REPARSE_POINT,
                FILE_ATTRIBUTE_SYSTEM, FILE_ATTRIBUTE_TAG_INFO, FILE_BASIC_INFO,
                FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
                FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
                FILE_ID_BOTH_DIR_INFO, FILE_INFO_BY_HANDLE_CLASS, FILE_LIST_DIRECTORY,
                FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ,
                FILE_SHARE_WRITE, FILE_STANDARD_INFO, FILE_TRAVERSE, SYNCHRONIZE,
                FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
            },
            System::IO::IO_STATUS_BLOCK,
        },
    };

    /// The attribute bits a replacement inherits from the file it replaces.
    pub(crate) const CARRIED_ATTRIBUTES: u32 =
        FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM;
    pub(crate) const READ_ONLY: u32 = FILE_ATTRIBUTE_READONLY;

    // FILE_RENAME_INFORMATION_EX flags (not exported by windows-sys).
    const RENAME_REPLACE_IF_EXISTS: u32 = 0x1;
    const RENAME_POSIX_SEMANTICS: u32 = 0x2;
    const RENAME_IGNORE_READONLY_ATTRIBUTE: u32 = 0x40;

    const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
    const DIRECTORY_ACCESS: u32 =
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

    /// What a component is opened for.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Role {
        /// A directory to traverse or list.
        Dir,
        /// A directory that receives a new entry (it additionally needs `FILE_ADD_FILE` and
        /// `FILE_ADD_SUBDIRECTORY`).
        Parent,
        /// Anything readable: a file to read, or (rejected by the caller) a directory.
        Read,
        /// Attributes only.
        Stat,
    }

    impl Role {
        fn access(self) -> u32 {
            match self {
                Role::Dir => DIRECTORY_ACCESS,
                Role::Parent => DIRECTORY_ACCESS | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY,
                Role::Read => FILE_GENERIC_READ,
                Role::Stat => FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            }
        }

        fn options(self) -> u32 {
            match self {
                Role::Dir | Role::Parent => FILE_DIRECTORY_FILE,
                Role::Read | Role::Stat => 0,
            }
        }
    }

    /// What the host needs to know about an open handle.
    #[derive(Clone, Copy, Debug)]
    pub(crate) struct Info {
        pub attributes: u32,
        pub links: u32,
        pub directory: bool,
        pub end_of_file: i64,
        pub last_write: i64,
        pub change_time: i64,
    }

    fn status_error(status: NTSTATUS) -> io::Error {
        // SAFETY: a pure status-code translation.
        io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
    }

    fn cannot_access() -> io::Error {
        io::Error::from_raw_os_error(ERROR_CANT_ACCESS_FILE as i32)
    }

    /// A path component as the host accepts it (UTF-8, valid on Windows, see `winpath`).
    pub(crate) fn component(part: &OsStr) -> Result<&str> {
        let name = part
            .to_str()
            .ok_or_else(|| HostError::new("INVALID_PATH", "The path is not valid UTF-8."))?;
        super::super::winpath::validate_component(name)?;
        Ok(name)
    }

    /// One `NtCreateFile` relative to `dir`. The name is matched case-insensitively, like Win32.
    fn create(
        dir: &File,
        name: &str,
        access: u32,
        disposition: u32,
        options: u32,
        attributes: u32,
    ) -> io::Result<File> {
        let wide: Vec<u16> = name.encode_utf16().collect();
        let bytes = u16::try_from(wide.len() * 2)
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let object_name = UNICODE_STRING {
            Length: bytes,
            MaximumLength: bytes,
            Buffer: wide.as_ptr() as *mut u16,
        };
        let object = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: dir.as_raw_handle(),
            ObjectName: &object_name,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: ptr::null(),
            SecurityQualityOfService: ptr::null(),
        };
        let mut handle: HANDLE = ptr::null_mut();
        // SAFETY: a zeroed IO_STATUS_BLOCK is a valid output buffer.
        let mut block: IO_STATUS_BLOCK = unsafe { zeroed() };
        // SAFETY: every pointer refers to a live local; `dir` owns a valid directory handle for
        // the duration of the call; `wide` outlives the call.
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                access,
                &object,
                &mut block,
                ptr::null(),
                attributes,
                SHARE_ALL,
                disposition,
                options | FILE_SYNCHRONOUS_IO_NONALERT,
                ptr::null(),
                0,
            )
        };
        if status < 0 {
            return Err(status_error(status));
        }
        // SAFETY: NtCreateFile succeeded, so `handle` is a fresh handle this File now owns.
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    fn get<T: Copy>(file: &File, class: FILE_INFO_BY_HANDLE_CLASS) -> io::Result<T> {
        let mut value = MaybeUninit::<T>::zeroed();
        // SAFETY: `file` owns a valid handle; the buffer is `size_of::<T>()` writable bytes and
        // all-zero bytes are a valid value of the plain-data information structures used here.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                class,
                value.as_mut_ptr().cast::<c_void>(),
                size_of::<T>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the call filled the buffer.
        Ok(unsafe { value.assume_init() })
    }

    /// Attributes, link count, size and timestamps of an open handle.
    pub(crate) fn query(file: &File) -> io::Result<Info> {
        let tag: FILE_ATTRIBUTE_TAG_INFO = get(file, FileAttributeTagInfo)?;
        let standard: FILE_STANDARD_INFO = get(file, FileStandardInfo)?;
        let basic: FILE_BASIC_INFO = get(file, FileBasicInfo)?;
        Ok(Info {
            attributes: tag.FileAttributes,
            links: standard.NumberOfLinks,
            directory: standard.Directory,
            end_of_file: standard.EndOfFile,
            last_write: basic.LastWriteTime,
            change_time: basic.ChangeTime,
        })
    }

    /// Opens the root of a walk (an ordinary path: its own ancestors are the host's business, as
    /// on unix) without following a reparse point in the final component.
    fn open_root(root: &Path, role: Role) -> io::Result<File> {
        let file = std::fs::OpenOptions::new()
            .access_mode(role.access())
            .share_mode(SHARE_ALL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(root)?;
        let info = query(&file)?;
        if info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(cannot_access());
        }
        if !info.directory {
            return Err(io::Error::from_raw_os_error(ERROR_DIRECTORY as i32));
        }
        Ok(file)
    }

    /// Opens the existing entry `name` of `dir` and refuses it if it is a reparse point of any
    /// kind. The check is made on the opened handle.
    pub(crate) fn open_entry(dir: &File, name: &str, role: Role) -> io::Result<(File, Info)> {
        let file = create(
            dir,
            name,
            role.access(),
            FILE_OPEN,
            role.options() | FILE_OPEN_REPARSE_POINT,
            0,
        )?;
        let info = query(&file)?;
        if info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(cannot_access());
        }
        Ok((file, info))
    }

    fn classify(error: io::Error) -> HostError {
        HostError::new(
            if error.kind() == io::ErrorKind::NotFound {
                "FILE_NOT_FOUND"
            } else {
                "FILE_ACCESS_DENIED"
            },
            error.to_string(),
        )
    }

    /// Walks `parts` below `root` one handle at a time; every intermediate component is a
    /// directory and none is a reparse point. The last one is opened as `last`; with no parts
    /// the root itself is returned.
    pub(crate) fn open_beneath(root: &Path, parts: &[&OsStr], last: Role) -> Result<File> {
        let mut directory =
            open_root(root, if parts.is_empty() { last } else { Role::Dir }).map_err(classify)?;
        for (index, part) in parts.iter().enumerate() {
            let name = component(part)?;
            let final_part = index == parts.len() - 1;
            let role = if final_part { last } else { Role::Dir };
            let (next, _) = open_entry(&directory, name, role).map_err(classify)?;
            // The same alias refusal as the write and list walks (`step`): the host must act on
            // the name it validated, not on an 8.3 alias of it.
            match verify_name(&next, name) {
                Ok(()) => {}
                Err(error) if error.raw_os_error() == Some(ERROR_INVALID_NAME as i32) => {
                    return Err(denied("Short (8.3) name aliases and redirected paths are not allowed"));
                }
                Err(error) => return Err(classify(error)),
            }
            if final_part {
                return Ok(next);
            }
            directory = next;
        }
        Ok(directory)
    }

    pub(crate) fn open_file_beneath(
        root: &Path,
        parts: &[&OsStr],
        kind: OpenKind,
    ) -> Result<File> {
        if parts.is_empty() {
            return Err(HostError::new("INVALID_PATH", "A file path is required."));
        }
        open_beneath(
            root,
            parts,
            match kind {
                OpenKind::Read => Role::Read,
                OpenKind::Dir => Role::Dir,
            },
        )
    }

    /// Whether a failed attribute probe means the entry is gone or has become a link.
    pub(crate) fn is_vanished_or_link(error: &io::Error) -> bool {
        error.kind() == io::ErrorKind::NotFound
            || error.raw_os_error() == Some(ERROR_CANT_ACCESS_FILE as i32)
    }

    /// The name `file` has on disk (the last component of its final path), as the file system
    /// spells it: the long name for an 8.3 alias, the stored case for any case.
    fn on_disk_name(file: &File) -> io::Result<String> {
        let mut buffer = vec![0u16; 512];
        loop {
            // SAFETY: `file` owns a valid handle; the buffer is `buffer.len()` writable units.
            let written = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            } as usize;
            if written == 0 {
                return Err(io::Error::last_os_error());
            }
            if written < buffer.len() {
                buffer.truncate(written);
                break;
            }
            // Too small: `written` is the size needed, including the terminator.
            buffer = vec![0u16; written + 1];
        }
        let path = String::from_utf16(&buffer)
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        path.rsplit('\\')
            .next()
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))
    }

    /// Fails with `ERROR_INVALID_NAME` when the entry `file` was opened as `spelled` is on disk
    /// under another name (not just another case): an 8.3 short-name alias such as `PROGRA~1`.
    /// The host would be acting on a different name than the one it validated.
    fn verify_name(file: &File, spelled: &str) -> io::Result<()> {
        if super::names_match(&on_disk_name(file)?, spelled) {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(ERROR_INVALID_NAME as i32))
        }
    }

    fn denied(message: &str) -> HostError {
        HostError::new("PATH_DENIED", message)
    }

    /// Opens the existing entry `name` of `dir` for a walk of the workspace: a reparse point of
    /// any kind, and an 8.3 alias of the real name, are `PATH_DENIED`; `None` when it does not
    /// exist; an entry that is a file where a directory is needed is `NOT_A_DIRECTORY`.
    fn step(dir: &File, name: &str, role: Role) -> Result<Option<(File, Info)>> {
        match open_entry(dir, name, role) {
            Ok((file, info)) => match verify_name(&file, name) {
                Ok(()) => Ok(Some((file, info))),
                Err(error) if error.raw_os_error() == Some(ERROR_INVALID_NAME as i32) => Err(denied(
                    "Short (8.3) name aliases and redirected paths are not allowed",
                )),
                Err(error) => Err(classify(error)),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) if error.raw_os_error() == Some(ERROR_CANT_ACCESS_FILE as i32) => {
                Err(denied("Symbolic links are not allowed"))
            }
            Err(error) if error.raw_os_error() == Some(ERROR_DIRECTORY as i32) => {
                Err(HostError::new("NOT_A_DIRECTORY", "Path is not a directory"))
            }
            Err(error) => Err(classify(error)),
        }
    }

    /// Checks `parts` below the open directory `root` one handle at a time, as `checked_path`
    /// promises: no reparse point on the way, no 8.3 alias, and (with `must_exist`) the path
    /// exists, `PATH_MISSING` otherwise. A part that does not exist ends the check: nothing
    /// below it exists either.
    pub(crate) fn check_in(root: &File, parts: &[&OsStr], must_exist: bool) -> Result<()> {
        let mut directory = root.try_clone()?;
        for (index, part) in parts.iter().enumerate() {
            let name = component(part)?;
            let role = if index == parts.len() - 1 { Role::Stat } else { Role::Dir };
            match step(&directory, name, role)? {
                Some((next, _)) => directory = next,
                None if must_exist => {
                    return Err(HostError::new("PATH_MISSING", "Path does not exist"))
                }
                None => return Ok(()),
            }
        }
        Ok(())
    }

    /// [`check_in`] for the workspace `root` named by a path (opened without following a
    /// reparse point in its final component).
    pub(crate) fn check_beneath(root: &Path, parts: &[&OsStr], must_exist: bool) -> Result<()> {
        check_in(&open_root(root, Role::Dir).map_err(classify)?, parts, must_exist)
    }

    /// Creates the directories `parts` below the open directory `root` (those that exist are
    /// reused), every one created and entered through its parent's handle. Fails like
    /// [`check_in`] on a link or an alias, with `NOT_A_DIRECTORY` for a file in the way.
    pub(crate) fn create_dir_all_in(root: &File, parts: &[&OsStr]) -> Result<()> {
        let mut directory = root.try_clone()?;
        for part in parts {
            let name = component(part)?;
            let mut attempts = 0;
            directory = loop {
                if let Some((next, _)) = step(&directory, name, Role::Parent)? {
                    break next;
                }
                attempts += 1;
                match create(
                    &directory,
                    name,
                    Role::Parent.access(),
                    FILE_CREATE,
                    Role::Parent.options(),
                    FILE_ATTRIBUTE_NORMAL,
                ) {
                    Ok(created) => break created,
                    // Created by someone else meanwhile: open what is there (and check it).
                    Err(error)
                        if error.kind() == io::ErrorKind::AlreadyExists && attempts < 3 => {}
                    Err(error) => return Err(classify(error)),
                }
            };
        }
        Ok(())
    }

    /// [`create_dir_all_in`] for the workspace `root` named by a path.
    pub(crate) fn create_dir_all_beneath(root: &Path, parts: &[&OsStr]) -> Result<()> {
        create_dir_all_in(&open_root(root, Role::Parent).map_err(classify)?, parts)
    }

    /// Opens the entry a listing starts from: `parts` below the open directory `root`, with its
    /// attributes. A directory is returned open for listing; a file, for its attributes only. No
    /// parts is the root itself (which the caller opened for listing).
    pub(crate) fn open_listing_target(root: &File, parts: &[&OsStr]) -> Result<(File, Info)> {
        let missing = || HostError::new("PATH_MISSING", "Path does not exist");
        let Some((last, parents)) = parts.split_last() else {
            return Ok((root.try_clone()?, query(root)?));
        };
        let mut parent = root.try_clone()?;
        for part in parents {
            parent = step(&parent, component(part)?, Role::Dir)?.ok_or_else(missing)?.0;
        }
        let name = component(last)?;
        let (entry, info) = step(&parent, name, Role::Stat)?.ok_or_else(missing)?;
        if !info.directory {
            return Ok((entry, info));
        }
        // A directory: open it again for listing, through the same parent (and check it again).
        step(&parent, name, Role::Dir)?.ok_or_else(missing)
    }

    /// Opens the root of a workspace walk by path (see `open_root`).
    pub(crate) fn open_walk_root(root: &Path, role: Role) -> Result<File> {
        open_root(root, role).map_err(classify)
    }

    /// Creates the staging file `name` in `dir` (fails if the name exists, like `O_EXCL`).
    pub(crate) fn create_staged(dir: &File, name: &str) -> io::Result<File> {
        create(
            dir,
            name,
            FILE_GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
            FILE_ATTRIBUTE_NORMAL,
        )
    }

    /// Sets the attribute bits of an open file (timestamps are left alone).
    pub(crate) fn set_attributes(file: &File, attributes: u32) -> io::Result<()> {
        let info = FILE_BASIC_INFO {
            CreationTime: 0,
            LastAccessTime: 0,
            LastWriteTime: 0,
            ChangeTime: 0,
            FileAttributes: attributes,
        };
        // SAFETY: `file` owns a valid handle; `info` is a fully initialised FILE_BASIC_INFO.
        let ok = unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileBasicInfo,
                (&info as *const FILE_BASIC_INFO).cast::<c_void>(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Deletes an open staging file (best effort; used on failure paths only). Read-only and
    /// hidden bits are cleared first so they cannot keep the file alive.
    pub(crate) fn discard(file: &File) {
        let _ = set_attributes(file, FILE_ATTRIBUTE_NORMAL);
        for flags in [
            FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
            FILE_DISPOSITION_FLAG_DELETE,
        ] {
            let info = FILE_DISPOSITION_INFO_EX { Flags: flags };
            // SAFETY: `file` owns a valid handle; `info` is a fully initialised structure.
            let ok = unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FileDispositionInfoEx,
                    (&info as *const FILE_DISPOSITION_INFO_EX).cast::<c_void>(),
                    size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
                )
            };
            if ok != 0 {
                return;
            }
        }
    }

    /// Renames the open staging file `staged` to `to` inside `dir`. When `exists` is false the
    /// rename fails (`ERROR_ALREADY_EXISTS`, the counterpart of `EEXIST`) instead of replacing a
    /// destination that appeared concurrently; when it is true (the caller already verified and
    /// backed up the destination) it replaces it with POSIX semantics, so a destination that other
    /// programs hold open with `FILE_SHARE_DELETE` is replaced atomically.
    pub(crate) fn rename_noreplace(
        dir: &File,
        staged: &File,
        to: &str,
        exists: bool,
        replace_read_only: bool,
    ) -> io::Result<()> {
        let flags = if exists {
            RENAME_REPLACE_IF_EXISTS
                | RENAME_POSIX_SEMANTICS
                | if replace_read_only {
                    RENAME_IGNORE_READONLY_ATTRIBUTE
                } else {
                    0
                }
        } else {
            0
        };
        let wide: Vec<u16> = to.encode_utf16().collect();
        let name_bytes = wide.len() * 2;
        let length = offset_of!(FILE_RENAME_INFO, FileName) + name_bytes;
        // 8-byte aligned storage for a FILE_RENAME_INFORMATION_EX, which FILE_RENAME_INFO matches
        // field for field.
        let mut buffer = vec![0u64; length.div_ceil(8)];
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // SAFETY: `buffer` is at least `length` bytes, aligned for FILE_RENAME_INFO; the name is
        // copied into the tail of that same allocation.
        unsafe {
            (*info).Anonymous.Flags = flags;
            (*info).RootDirectory = dir.as_raw_handle();
            (*info).FileNameLength = name_bytes as u32;
            ptr::copy_nonoverlapping(
                wide.as_ptr(),
                ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
                wide.len(),
            );
        }
        // SAFETY: a zeroed IO_STATUS_BLOCK is a valid output buffer.
        let mut block: IO_STATUS_BLOCK = unsafe { zeroed() };
        // SAFETY: `staged` and `dir` own valid handles; the buffer holds `length` initialised
        // bytes in the layout the information class expects.
        let status = unsafe {
            NtSetInformationFile(
                staged.as_raw_handle(),
                &mut block,
                buffer.as_ptr().cast::<c_void>(),
                length as u32,
                FileRenameInformationEx,
            )
        };
        if status < 0 {
            let error = status_error(status);
            // ERROR_INVALID_FUNCTION / ERROR_NOT_SUPPORTED / ERROR_INVALID_PARAMETER: a file
            // system that cannot do an atomic replacement. Say so, and never fall back to a
            // delete-then-rename that could lose the destination.
            return Err(match error.raw_os_error() {
                Some(1 | 50 | 87) if exists => io::Error::new(
                    error.kind(),
                    format!(
                        "this folder's file system does not support replacing a file atomically \
                         (FILE_RENAME_FLAG_POSIX_SEMANTICS): {error}"
                    ),
                ),
                _ => error,
            });
        }
        Ok(())
    }

    /// One directory entry as `GetFileInformationByHandleEx` reports it.
    pub(crate) struct Entry {
        pub name: String,
        pub attributes: u32,
        pub size: i64,
    }

    impl Entry {
        pub(crate) fn is_directory(&self) -> bool {
            self.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
        }
        pub(crate) fn is_reparse_point(&self) -> bool {
            self.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        }
    }

    /// Calls `visit` for every entry of the directory behind `dir` except `.` and `..` (and names
    /// that are not valid UTF-16), reading through the held handle in 64 KiB batches. The first
    /// error from `visit` stops the enumeration.
    pub(crate) fn enumerate(
        dir: &File,
        mut visit: impl FnMut(Entry) -> Result<()>,
    ) -> Result<()> {
        const BUFFER_BYTES: usize = 64 * 1024;
        let mut buffer = vec![0u64; BUFFER_BYTES / 8];
        let mut class = FileIdBothDirectoryRestartInfo;
        loop {
            // SAFETY: `dir` owns a valid directory handle; the buffer is BUFFER_BYTES writable
            // bytes.
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    dir.as_raw_handle(),
                    class,
                    buffer.as_mut_ptr().cast::<c_void>(),
                    BUFFER_BYTES as u32,
                )
            };
            class = FileIdBothDirectoryInfo;
            if ok == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                    return Ok(());
                }
                return Err(error.into());
            }
            let base = buffer.as_ptr().cast::<u8>();
            let mut offset = 0usize;
            loop {
                // SAFETY: the kernel filled the buffer with a chain of FILE_ID_BOTH_DIR_INFO
                // records, each 8-byte aligned, linked by NextEntryOffset and ending with 0.
                let record = unsafe { base.add(offset) }.cast::<FILE_ID_BOTH_DIR_INFO>();
                let (next, attributes, size, units) = unsafe {
                    (
                        (*record).NextEntryOffset as usize,
                        (*record).FileAttributes,
                        (*record).EndOfFile,
                        std::slice::from_raw_parts(
                            ptr::addr_of!((*record).FileName).cast::<u16>(),
                            (*record).FileNameLength as usize / 2,
                        ),
                    )
                };
                if let Ok(name) = String::from_utf16(units) {
                    if name != "." && name != ".." {
                        visit(Entry {
                            name,
                            attributes,
                            size,
                        })?;
                    }
                }
                if next == 0 {
                    break;
                }
                offset += next;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn parts<'a>(names: &[&'a str]) -> Vec<&'a OsStr> {
        names.iter().map(|name| OsStr::new(*name)).collect()
    }

    /// A directory link to `target` at `link`: a symlink on unix, a junction on Windows.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let output = std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "New-Item -ItemType Junction -Path $env:SW_LINK -Target $env:SW_TARGET -ErrorAction Stop | Out-Null",
                ])
                .env("SW_LINK", link)
                .env("SW_TARGET", target)
                .output()
                .unwrap();
            assert!(output.status.success(), "junction creation failed: {output:?}");
        }
    }

    /// A file symlink; `false` when the process may not create one (Windows without the
    /// privilege), which the caller reports instead of passing silently.
    fn link_file(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).unwrap();
            true
        }
        #[cfg(windows)]
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => true,
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!("skipped: SeCreateSymbolicLinkPrivilege is not held");
                false
            }
            Err(error) => panic!("symlink_file failed: {error}"),
        }
    }

    fn code<T>(result: Result<T>) -> &'static str {
        match result {
            Ok(_) => panic!("expected an error"),
            Err(error) => error.code,
        }
    }

    #[test]
    fn file_names_match_up_to_case_only() {
        assert!(names_match("Docs", "dOCS"));
        assert!(names_match("读我.TXT", "读我.txt"));
        assert!(names_match("a long directory name", "A LONG DIRECTORY NAME"));
        // An 8.3 alias is another spelling, not another case.
        assert!(!names_match("a long directory name", "ALONGD~1"));
        assert!(!names_match("Program Files", "PROGRA~1"));
        assert!(!names_match("abc", "abcd"));
    }

    #[cfg(unix)]
    #[test]
    fn open_kind_keeps_the_unix_flags() {
        assert_eq!(OpenKind::Read.flags(), libc::O_RDONLY);
        assert_eq!(
            OpenKind::Dir.flags(),
            libc::O_RDONLY | libc::O_DIRECTORY
        );
    }

    #[test]
    fn components_are_plain_names_only() {
        for bad in ["", "a\0b", "a\\b", "/abs", "../x", "a/../b", "./x"] {
            assert_eq!(
                code(safe_components(bad)),
                "INVALID_PATH",
                "accepted {bad:?}"
            );
        }
        assert_eq!(safe_components("a//b/c.txt").unwrap().len(), 3);
        assert_eq!(safe_components("目录/[x] (1)/f").unwrap().len(), 3);
    }

    #[test]
    fn nested_files_open_and_missing_ones_are_reported_as_missing() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a/b")).unwrap();
        std::fs::write(root.path().join("a/b/f.txt"), "hello").unwrap();
        let mut file =
            open_file_beneath(root.path(), &parts(&["a", "b", "f.txt"]), OpenKind::Read).unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "hello");
        assert_eq!(
            code(open_file_beneath(
                root.path(),
                &parts(&["a", "b", "missing.txt"]),
                OpenKind::Read
            )),
            "FILE_NOT_FOUND"
        );
        assert_eq!(
            code(open_file_beneath(
                root.path(),
                &parts(&["nope", "f.txt"]),
                OpenKind::Read
            )),
            "FILE_NOT_FOUND"
        );
        // Through a regular file, or as a directory when it is one, is refused.
        assert_eq!(
            code(open_file_beneath(
                root.path(),
                &parts(&["a", "b", "f.txt", "x"]),
                OpenKind::Read
            )),
            "FILE_ACCESS_DENIED"
        );
        assert_eq!(
            code(open_file_beneath(
                root.path(),
                &parts(&["a", "b", "f.txt"]),
                OpenKind::Dir
            )),
            "FILE_ACCESS_DENIED"
        );
        // A directory opens as a directory (a Read open is rejected later by the caller).
        let directory =
            open_file_beneath(root.path(), &parts(&["a", "b"]), OpenKind::Dir).unwrap();
        assert!(directory.metadata().unwrap().is_dir());
        let directory = open_file_beneath(root.path(), &parts(&["a"]), OpenKind::Read).unwrap();
        assert!(directory.metadata().unwrap().is_dir());
    }

    #[test]
    fn unicode_and_bracket_names_open() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("目录/[x] (1)")).unwrap();
        std::fs::write(root.path().join("目录/[x] (1)/文件 [2].txt"), "ok").unwrap();
        let mut file = open_file_beneath(
            root.path(),
            &parts(&["目录", "[x] (1)", "文件 [2].txt"]),
            OpenKind::Read,
        )
        .unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "ok");
    }

    #[test]
    fn links_are_refused_in_every_position() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "no").unwrap();
        link_dir(outside.path(), &root.path().join("escape"));
        assert_eq!(
            code(open_file_beneath(
                root.path(),
                &parts(&["escape", "secret"]),
                OpenKind::Read
            )),
            "FILE_ACCESS_DENIED"
        );
        // The link itself, as the final component, is not opened either way.
        for kind in [OpenKind::Read, OpenKind::Dir] {
            assert_eq!(
                code(open_file_beneath(root.path(), &parts(&["escape"]), kind)),
                "FILE_ACCESS_DENIED"
            );
        }
        if link_file(&outside.path().join("secret"), &root.path().join("flink")) {
            assert_eq!(
                code(open_file_beneath(
                    root.path(),
                    &parts(&["flink"]),
                    OpenKind::Read
                )),
                "FILE_ACCESS_DENIED"
            );
        }
        // A root that is itself a link is not a root.
        assert!(open_file_beneath(&root.path().join("escape"), &parts(&["secret"]), OpenKind::Read)
            .is_err());
    }

    #[test]
    fn hard_links_are_counted() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("one"), "x").unwrap();
        let file = open_file_beneath(root.path(), &parts(&["one"]), OpenKind::Read).unwrap();
        assert_eq!(link_count(&file, &file.metadata().unwrap()).unwrap(), 1);
        std::fs::hard_link(root.path().join("one"), root.path().join("two")).unwrap();
        let file = open_file_beneath(root.path(), &parts(&["one"]), OpenKind::Read).unwrap();
        assert_eq!(link_count(&file, &file.metadata().unwrap()).unwrap(), 2);
    }

    #[test]
    fn the_change_stamp_moves_when_the_file_does() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("f");
        std::fs::write(&path, "aaaa").unwrap();
        let open = || open_file_beneath(root.path(), &parts(&["f"]), OpenKind::Read).unwrap();
        let stamp = |file: &File| change_stamp(file, &file.metadata().unwrap()).unwrap();
        let first = stamp(&open());
        assert!(first == stamp(&open()), "a stamp is stable while nothing changes");
        // Same length, later modification time (file systems stamp in coarse ticks).
        std::thread::sleep(std::time::Duration::from_millis(80));
        std::fs::write(&path, "bbbb").unwrap();
        let second = stamp(&open());
        assert!(first != second, "a same-length rewrite is not detected");
        std::fs::write(&path, "bbbbbbbb").unwrap();
        assert!(second != stamp(&open()), "a longer file is not detected");
    }

    #[test]
    fn listings_skip_links_and_hard_links_and_stop_at_five_hundred() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("sub/inner")).unwrap();
        std::fs::write(root.path().join("sub/plain.txt"), "p").unwrap();
        std::fs::write(root.path().join("sub/文件 [1].txt"), "cjk").unwrap();
        std::fs::write(root.path().join("sub/shared.txt"), "s").unwrap();
        std::fs::hard_link(
            root.path().join("sub/shared.txt"),
            root.path().join("sub/shared-too.txt"),
        )
        .unwrap();
        link_dir(outside.path(), &root.path().join("sub/escape"));
        link_file(&outside.path().join("t"), &root.path().join("sub/flink"));
        let listing = list_granted_directory(root.path(), Path::new("sub")).unwrap();
        let mut names: Vec<(String, bool)> = listing
            .iter()
            .map(|entry| {
                (
                    entry["path"].as_str().unwrap().rsplit('/').next().unwrap().to_owned(),
                    entry["is_dir"].as_bool().unwrap(),
                )
            })
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                ("inner".to_owned(), true),
                ("plain.txt".to_owned(), false),
                ("文件 [1].txt".to_owned(), false),
            ]
        );
        let plain = listing
            .iter()
            .find(|entry| entry["path"].as_str().unwrap().ends_with("/plain.txt"))
            .unwrap();
        assert_eq!(plain["size"], 1);
        assert_eq!(
            plain["path"],
            crate::local_host::winpath::host_to_wire(&root.path().join("sub").join("plain.txt"))
                .unwrap()
        );
        // The root itself, with "." and an empty relative path.
        assert_eq!(list_granted_directory(root.path(), Path::new("")).unwrap().len(), 1);
        assert_eq!(list_granted_directory(root.path(), Path::new(".")).unwrap().len(), 1);
        // Outside the listing's root, through a link, or beyond it is refused.
        for bad in ["../x", "escape", "sub/escape", "sub/plain.txt"] {
            assert!(
                list_granted_directory(root.path(), Path::new(bad)).is_err(),
                "listed {bad}"
            );
        }
        let many = root.path().join("many");
        std::fs::create_dir(&many).unwrap();
        for index in 0..500 {
            std::fs::write(many.join(format!("f{index}")), "").unwrap();
        }
        assert_eq!(
            list_granted_directory(root.path(), Path::new("many"))
                .unwrap()
                .len(),
            500
        );
        std::fs::write(many.join("one-too-many"), "").unwrap();
        assert_eq!(
            code(list_granted_directory(root.path(), Path::new("many"))),
            "DIRECTORY_TOO_LARGE"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_new_file_never_replaces_a_destination_that_appeared_concurrently() {
        use std::{ffi::CString, os::fd::AsRawFd};
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("staged"), "new").unwrap();
        std::fs::write(dir.path().join("dest"), "theirs").unwrap();
        let handle = File::open(dir.path()).unwrap();
        let staged = CString::new("staged").unwrap();
        let dest = CString::new("dest").unwrap();
        let error = rename_noreplace(handle.as_raw_fd(), &staged, &dest, false).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(dir.path().join("dest")).unwrap(), b"theirs");
        assert!(dir.path().join("staged").exists());
        // The caller verified and backed up the destination: now it is replaced.
        rename_noreplace(handle.as_raw_fd(), &staged, &dest, true).unwrap();
        assert_eq!(std::fs::read(dir.path().join("dest")).unwrap(), b"new");
        assert!(!dir.path().join("staged").exists());
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::{ffi::OsStr, io::Write, os::windows::fs::MetadataExt};

    fn parts<'a>(names: &[&'a str]) -> Vec<&'a OsStr> {
        names.iter().map(|name| OsStr::new(*name)).collect()
    }

    fn code<T>(result: Result<T>) -> &'static str {
        match result {
            Ok(_) => panic!("expected an error"),
            Err(error) => error.code,
        }
    }

    #[test]
    fn names_windows_would_resolve_elsewhere_are_refused_before_any_open() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.txt"), "x").unwrap();
        for bad in [
            "a.txt:stream",
            "a.txt:stream:$DATA",
            "CON",
            "nul.txt",
            "COM1",
            "a.txt.",
            "a.txt ",
            "a*.txt",
            "a?.txt",
        ] {
            assert_eq!(
                code(open_file_beneath(root.path(), &parts(&[bad]), OpenKind::Read)),
                "INVALID_PATH",
                "{bad:?}"
            );
        }
        // Non-UTF-8 names cannot be validated and are refused too.
        use std::os::windows::ffi::OsStringExt;
        let lone_surrogate = std::ffi::OsString::from_wide(&[0x61, 0xD800]);
        assert_eq!(
            code(open_file_beneath(
                root.path(),
                &[lone_surrogate.as_os_str()],
                OpenKind::Read
            )),
            "INVALID_PATH"
        );
        // An empty walk has no file to open.
        assert_eq!(
            code(open_file_beneath(root.path(), &[], OpenKind::Read)),
            "INVALID_PATH"
        );
    }

    #[test]
    fn names_match_case_insensitively_like_win32() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("Docs")).unwrap();
        std::fs::write(root.path().join("Docs/ReadMe.TXT"), "hi").unwrap();
        let mut file = open_file_beneath(
            root.path(),
            &parts(&["dOCS", "readme.txt"]),
            OpenKind::Read,
        )
        .unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "hi");
    }

    #[test]
    fn a_held_directory_keeps_naming_the_original_after_the_path_is_swapped_for_a_junction() {
        // The point of handle-relative opens: the walk cannot be redirected by swapping a
        // directory for a link between two steps, because the parent is an object, not a path.
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("dir")).unwrap();
        std::fs::write(root.path().join("dir/data.txt"), "inside").unwrap();
        std::fs::write(outside.path().join("data.txt"), "outside").unwrap();
        let held = nt::open_beneath(root.path(), &parts(&["dir"]), nt::Role::Dir).unwrap();
        std::fs::rename(root.path().join("dir"), root.path().join("moved")).unwrap();
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "New-Item -ItemType Junction -Path $env:SW_LINK -Target $env:SW_TARGET -ErrorAction Stop | Out-Null",
            ])
            .env("SW_LINK", root.path().join("dir"))
            .env("SW_TARGET", outside.path())
            .output()
            .unwrap();
        assert!(output.status.success(), "junction creation failed: {output:?}");
        // The path now leads outside; the held handle still leads to the original directory.
        assert!(open_file_beneath(root.path(), &parts(&["dir", "data.txt"]), OpenKind::Read).is_err());
        let (mut file, _) = nt::open_entry(&held, "data.txt", nt::Role::Read).unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "inside");
    }

    fn junction(link: &std::path::Path, target: &std::path::Path) {
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "New-Item -ItemType Junction -Path $env:SW_LINK -Target $env:SW_TARGET -ErrorAction Stop | Out-Null",
            ])
            .env("SW_LINK", link)
            .env("SW_TARGET", target)
            .output()
            .unwrap();
        assert!(output.status.success(), "junction creation failed: {output:?}");
    }

    /// Opens `<root>\work` and then swaps it: the directory is renamed away and a junction to
    /// `outside` takes its name. Returns the handle to the original directory and its new name.
    fn held_then_swapped(
        root: &std::path::Path,
        outside: &std::path::Path,
    ) -> (File, std::path::PathBuf) {
        let held = nt::open_beneath(root, &parts(&["work"]), nt::Role::Parent).unwrap();
        std::fs::rename(root.join("work"), root.join("moved")).unwrap();
        junction(&root.join("work"), outside);
        (held, root.join("moved"))
    }

    #[test]
    fn directories_are_created_through_the_held_directory_not_the_path() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("work")).unwrap();
        let (held, moved) = held_then_swapped(root.path(), outside.path());
        // The path now leads outside; creating through the path is refused as a link ...
        assert_eq!(
            code(nt::create_dir_all_beneath(root.path(), &parts(&["work", "a", "b"]))),
            "PATH_DENIED"
        );
        // ... and creating below the handle lands in the original directory, never outside.
        nt::create_dir_all_in(&held, &parts(&["a", "b"])).unwrap();
        assert!(moved.join("a").join("b").is_dir());
        assert!(!outside.path().join("a").exists());
    }

    #[test]
    fn a_listing_follows_the_directory_it_opened_not_the_path() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("work")).unwrap();
        std::fs::write(root.path().join("work/inside.txt"), "i").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
        let held = nt::open_beneath(root.path(), &[], nt::Role::Dir).unwrap();
        // The listing target is opened (through the held root) before the swap ...
        let (target, info) = nt::open_listing_target(&held, &parts(&["work"])).unwrap();
        assert!(info.directory);
        std::fs::rename(root.path().join("work"), root.path().join("moved")).unwrap();
        junction(&root.path().join("work"), outside.path());
        // ... so what it enumerates is the original content, and a fresh walk is refused.
        let mut names = Vec::new();
        nt::enumerate(&target, |entry| {
            names.push(entry.name);
            Ok(())
        })
        .unwrap();
        assert_eq!(names, ["inside.txt"]);
        assert_eq!(
            code(list_workspace_in(&held, &parts(&["work"]), "work", true)),
            "PATH_DENIED"
        );
        let listing = list_workspace_in(&held, &parts(&["moved"]), "moved", true).unwrap();
        assert_eq!(listing["files"][0]["path"], "moved/inside.txt");
    }

    #[test]
    fn a_recursive_listing_does_not_descend_into_a_directory_swapped_after_it_was_listed() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a/sub")).unwrap();
        std::fs::write(root.path().join("a/sub/in.txt"), "i").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
        let held = nt::open_beneath(root.path(), &[], nt::Role::Dir).unwrap();
        let listing = list_workspace_in(&held, &[], "", true).unwrap();
        let mut paths: Vec<String> = listing["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap().to_owned())
            .collect();
        paths.sort();
        assert_eq!(paths, ["a", "a/sub", "a/sub/in.txt"]);
        // A listing that meets the junction skips it: a reparse point is never listed or entered.
        std::fs::rename(root.path().join("a"), root.path().join("a-moved")).unwrap();
        junction(&root.path().join("a"), outside.path());
        let listing = list_workspace_in(&held, &[], "", true).unwrap();
        let paths: Vec<&str> = listing["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap())
            .collect();
        assert!(!paths.iter().any(|p| p.contains("secret")), "{paths:?}");
        assert!(!paths.contains(&"a"), "the junction is not listed: {paths:?}");
        assert!(paths.contains(&"a-moved/sub/in.txt"), "{paths:?}");
    }

    #[test]
    fn the_walk_check_refuses_links_and_reports_missing_paths() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("real/inner")).unwrap();
        std::fs::write(root.path().join("real/file.txt"), "x").unwrap();
        junction(&root.path().join("link"), outside.path());
        let check = |names: &[&str], must_exist| {
            nt::check_beneath(root.path(), &parts(names), must_exist)
        };
        check(&["real", "inner"], true).unwrap();
        check(&["REAL", "Inner"], true).unwrap();
        check(&[], true).unwrap();
        check(&["real", "new", "deeper"], false).unwrap();
        assert_eq!(code(check(&["real", "new"], true)), "PATH_MISSING");
        assert_eq!(code(check(&["link"], false)), "PATH_DENIED");
        assert_eq!(code(check(&["link", "x"], false)), "PATH_DENIED");
        assert_eq!(code(check(&["real", "file.txt", "x"], false)), "NOT_A_DIRECTORY");
    }

    #[test]
    fn short_name_aliases_are_refused_by_the_walk() {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
        let root = tempfile::tempdir().unwrap();
        let long = root.path().join("a long directory name");
        std::fs::create_dir(&long).unwrap();
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
        assert_eq!(
            code(nt::check_beneath(root.path(), &parts(&[alias.as_str(), "x"]), false)),
            "PATH_DENIED"
        );
        assert_eq!(
            code(nt::create_dir_all_beneath(root.path(), &parts(&[alias.as_str(), "x"]))),
            "PATH_DENIED"
        );
        assert!(!long.join("x").exists());
        // Reads go through the same refusal: an alias of the directory, and an alias of the file.
        std::fs::write(long.join("a long file name.txt"), "secret").unwrap();
        let file_wide: Vec<u16> = long.join("a long file name.txt").as_os_str().encode_wide().chain(Some(0)).collect();
        let mut file_buffer = vec![0u16; 1024];
        let file_written =
            unsafe { GetShortPathNameW(file_wide.as_ptr(), file_buffer.as_mut_ptr(), 1024) } as usize;
        assert!(file_written > 0, "GetShortPathNameW failed for the file");
        let file_alias = std::path::PathBuf::from(std::ffi::OsString::from_wide(&file_buffer[..file_written]))
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        for read_parts in [
            vec![alias.as_str(), "a long file name.txt"],
            vec!["a long directory name", file_alias.as_str()],
        ] {
            assert_eq!(
                code(nt::open_file_beneath(root.path(), &parts(&read_parts), super::OpenKind::Read)),
                "PATH_DENIED",
                "{read_parts:?}"
            );
        }
        nt::open_file_beneath(
            root.path(),
            &parts(&["A LONG DIRECTORY NAME", "A Long File Name.TXT"]),
            super::OpenKind::Read,
        )
        .unwrap();
        // The real name in another case is the same name.
        nt::create_dir_all_beneath(root.path(), &parts(&["A LONG DIRECTORY NAME", "x"])).unwrap();
        assert!(long.join("x").is_dir());
    }

    #[test]
    fn existing_directories_are_reused_and_a_file_in_the_way_is_not_a_directory() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a/b")).unwrap();
        std::fs::write(root.path().join("a/file.txt"), "x").unwrap();
        nt::create_dir_all_beneath(root.path(), &parts(&["a", "b"])).unwrap();
        nt::create_dir_all_beneath(root.path(), &parts(&["CJK目录", "[x] (1)", "with space"])).unwrap();
        assert!(root.path().join("CJK目录/[x] (1)/with space").is_dir());
        assert_eq!(
            code(nt::create_dir_all_beneath(root.path(), &parts(&["a", "file.txt"]))),
            "NOT_A_DIRECTORY"
        );
        assert_eq!(
            code(nt::create_dir_all_beneath(root.path(), &parts(&["a", "file.txt", "x"]))),
            "NOT_A_DIRECTORY"
        );
    }

    #[test]
    fn a_single_file_listing_reports_its_size_and_refuses_a_hard_link() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("one.txt"), "12345").unwrap();
        std::fs::write(root.path().join("two.txt"), "x").unwrap();
        std::fs::hard_link(root.path().join("two.txt"), root.path().join("three.txt")).unwrap();
        let held = nt::open_beneath(root.path(), &[], nt::Role::Dir).unwrap();
        let listing = list_workspace_in(&held, &parts(&["one.txt"]), "one.txt", false).unwrap();
        assert_eq!(
            listing,
            serde_json::json!({"files":[{"path":"one.txt","is_dir":false,"size":5}]})
        );
        assert_eq!(
            code(list_workspace_in(&held, &parts(&["two.txt"]), "two.txt", false)),
            "HARDLINK_NOT_ALLOWED"
        );
        assert_eq!(
            code(list_workspace_in(&held, &parts(&["absent.txt"]), "absent.txt", false)),
            "PATH_MISSING"
        );
    }

    #[test]
    fn staged_files_are_published_without_replacing_a_concurrent_destination() {
        let dir = tempfile::tempdir().unwrap();
        let handle = nt::open_beneath(dir.path(), &[], nt::Role::Parent).unwrap();
        std::fs::write(dir.path().join("dest"), "theirs").unwrap();
        let mut staged = nt::create_staged(&handle, ".sourceweft-test").unwrap();
        staged.write_all(b"new").unwrap();
        staged.sync_all().unwrap();
        // A destination that appeared meanwhile: the same error shape as the unix EEXIST.
        let error = nt::rename_noreplace(&handle, &staged, "dest", false, false).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists, "{error}");
        assert_eq!(std::fs::read(dir.path().join("dest")).unwrap(), b"theirs");
        assert!(dir.path().join(".sourceweft-test").exists());
        // Verified and backed up: replaced, atomically, while the staged handle is still open.
        nt::rename_noreplace(&handle, &staged, "dest", true, false).unwrap();
        assert_eq!(std::fs::read(dir.path().join("dest")).unwrap(), b"new");
        assert!(!dir.path().join(".sourceweft-test").exists());
        // A brand-new name needs no replacement.
        let mut second = nt::create_staged(&handle, ".sourceweft-two").unwrap();
        second.write_all(b"fresh").unwrap();
        nt::rename_noreplace(&handle, &second, "created", false, false).unwrap();
        assert_eq!(std::fs::read(dir.path().join("created")).unwrap(), b"fresh");
    }

    #[test]
    fn a_read_only_destination_is_replaced_and_its_attributes_carry_over() {
        let dir = tempfile::tempdir().unwrap();
        let handle = nt::open_beneath(dir.path(), &[], nt::Role::Parent).unwrap();
        let dest = dir.path().join("dest");
        std::fs::write(&dest, "old").unwrap();
        let mut permissions = std::fs::metadata(&dest).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&dest, permissions).unwrap();
        let attributes = std::fs::metadata(&dest).unwrap().file_attributes();
        let mut staged = nt::create_staged(&handle, ".sourceweft-ro").unwrap();
        nt::set_attributes(&staged, attributes & nt::CARRIED_ATTRIBUTES).unwrap();
        staged.write_all(b"new").unwrap();
        nt::rename_noreplace(&handle, &staged, "dest", true, true).unwrap();
        drop(staged);
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert!(std::fs::metadata(&dest).unwrap().permissions().readonly());
    }

    #[test]
    fn discarding_a_staged_file_removes_it_even_when_it_is_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let handle = nt::open_beneath(dir.path(), &[], nt::Role::Parent).unwrap();
        let staged = nt::create_staged(&handle, ".sourceweft-gone").unwrap();
        nt::set_attributes(&staged, nt::READ_ONLY).unwrap();
        nt::discard(&staged);
        drop(staged);
        assert!(!dir.path().join(".sourceweft-gone").exists());
    }

    #[test]
    fn a_staging_name_that_exists_is_not_reused() {
        let dir = tempfile::tempdir().unwrap();
        let handle = nt::open_beneath(dir.path(), &[], nt::Role::Parent).unwrap();
        std::fs::write(dir.path().join(".sourceweft-taken"), "x").unwrap();
        let error = nt::create_staged(&handle, ".sourceweft-taken").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
    }
}
