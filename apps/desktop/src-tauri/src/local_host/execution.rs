use super::{HostError, LocalHost, Result};
use rusqlite::{params, OptionalExtension};
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
use serde_json::json;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
use std::path::Path;
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
use std::io::Read;

#[derive(Default)]
pub struct Executions {
    cancelled: Mutex<HashSet<String>>,
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
impl Executions {
    pub fn is_cancelled(&self, id: &str) -> bool {
        self.cancelled
            .lock()
            .map(|s| s.contains(id))
            .unwrap_or(true)
    }
    pub fn cancel(&self, id: &str) -> bool {
        if let Ok(mut cancelled) = self.cancelled.lock() {
            cancelled.insert(id.to_owned());
        }
        if let Ok(active) = self.active.lock() {
            if let Some(cancel) = active.get(id) {
                cancel.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }
    pub fn cancel_all(&self) {
        if let Ok(active) = self.active.lock() {
            for cancel in active.values() {
                cancel.store(true, Ordering::SeqCst);
            }
        }
    }
}

impl LocalHost {
    pub fn initialize_invocation_journal(&self) -> Result<()> {
        self.db.lock().map_err(|_| HostError::new("HOST_UNAVAILABLE", "Database lock failed"))?.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_invocations(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
             UPDATE local_invocations SET state='unknown' WHERE state='running';")?;
        Ok(())
    }

    pub fn dispatch(
        &self,
        calls: &Executions,
        id: &str,
        owner: &str,
        thread: &str,
        action: &str,
        payload: Value,
    ) -> Result<Value> {
        let lease = self.admission.enter().map_err(|code| HostError::new(code, "Local host is preparing an update"))?;
        self.dispatch_admitted(&lease, calls, id, owner, thread, action, payload)
    }

    /// The transport holds the admission lease until the result has been sent.
    pub fn dispatch_admitted(
        &self, _lease: &super::maintenance::Lease, calls: &Executions, id: &str,
        owner: &str, thread: &str, action: &str, payload: Value,
    ) -> Result<Value> {
        if calls.is_cancelled(id) {
            return Err(HostError::new(
                "CALL_CANCELLED",
                "Invocation was cancelled before execution",
            ));
        }
        let fingerprint = serde_json::to_string(&(owner, thread, action, &payload))
            .map_err(|e| HostError::new("INVALID_CALL", e.to_string()))?;
        {
            let db = self
                .db
                .lock()
                .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Database lock failed"))?;
            let saved: Option<(String, String, Option<String>)> = db
                .query_row(
                    "SELECT payload,state,result FROM local_invocations WHERE id=?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            if let Some((old, state, result)) = saved {
                if old != fingerprint {
                    return Err(HostError::new(
                        "INVOCATION_CONFLICT",
                        "Invocation parameters changed",
                    ));
                }
                if state == "done" {
                    return serde_json::from_str(&result.unwrap_or_default())
                        .map_err(|e| HostError::new("INVALID_JOURNAL", e.to_string()));
                }
                return Err(HostError::new(
                    "OUTCOME_UNKNOWN",
                    "This call was already started. It will not be executed twice.",
                ));
            }
            db.execute(
                "INSERT INTO local_invocations(id,payload,state) VALUES(?1,?2,'running')",
                params![id, fingerprint],
            )?;
        }
        let outcome = self.perform(calls, id, owner, thread, action, &payload);
        if let Ok(value) = &outcome {
            let journal_value = if action == "folder.read" {
                serde_json::json!({"expired":true})
            } else {
                value.clone()
            };
            let serialized = serde_json::to_string(&journal_value)
                .map_err(|e| HostError::new("INVALID_RESULT", e.to_string()))?;
            self.db
                .lock()
                .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Database lock failed"))?
                .execute(
                    "UPDATE local_invocations SET state='done',result=?2 WHERE id=?1",
                    params![id, serialized],
                )?;
        }
        outcome
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    fn perform(
        &self,
        _calls: &Executions,
        _id: &str,
        _owner: &str,
        _thread: &str,
        _action: &str,
        _payload: &Value,
    ) -> Result<Value> {
        Err(HostError::new(
            "UNSUPPORTED_PLATFORM",
            "Local execution currently requires macOS, Linux or Windows.",
        ))
    }

    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    fn perform(
        &self,
        calls: &Executions,
        id: &str,
        owner: &str,
        thread: &str,
        action: &str,
        payload: &Value,
    ) -> Result<Value> {
        if action == "folder.list" || action == "folder.read" {
            if !thread.is_empty() {
                return Err(HostError::new(
                    "INVALID_CALL",
                    "Draft folder reads cannot use a conversation.",
                ));
            }
            let grant = text(payload, "folderId")?;
            let root = self.granted_directory(owner, grant)?;
            let requested = text(payload, "path")?;
            let relative = folder_relative(&root, requested)?;
            let relative = relative.as_str();
            let path = checked_path(&root, relative, true)?;
            if action == "folder.read" {
                use base64::Engine;
                let parts = Path::new(relative)
                    .components()
                    .filter_map(|p| match p {
                        std::path::Component::Normal(v) => Some(v),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let mut file =
                    super::files::open_file_beneath(&root, &parts, super::files::OpenKind::Read)?;
                let meta = file.metadata()?;
                if !meta.is_file() || super::files::link_count(&file, &meta)? != 1 {
                    return Err(HostError::new(
                        "FILE_ACCESS_DENIED",
                        "Only regular, non-hardlinked files can be previewed.",
                    ));
                }
                let mut bytes = Vec::new();
                (&mut file).take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
                if bytes.len() > 1024 * 1024 {
                    return Err(HostError::new(
                        "FILE_TOO_LARGE",
                        "Draft previews are limited to 1 MiB.",
                    ));
                }
                self.granted_directory(owner, grant)?;
                return Ok(
                    json!({"content":base64::engine::general_purpose::STANDARD.encode(bytes)}),
                );
            }
            let files = super::files::list_granted_directory(&root, Path::new(relative))?;
            self.granted_directory(owner, grant)?;
            return Ok(json!({
                "root": super::winpath::host_to_wire(&root)?,
                "path": super::winpath::host_to_wire(&path)?,
                "files": files
            }));
        }
        if action == "workspace.check" {
            self.check_workspace(
                owner,
                thread,
                payload.get("workspaceId").and_then(Value::as_str),
                payload.get("directoryGrantId").and_then(Value::as_str),
            )?;
            return Ok(json!({"ready":true}));
        }
        if action == "workspace.ensure" {
            if payload.get("folderId").is_some() && payload.get("directoryGrantId").is_some() {
                return Err(HostError::new(
                    "INVALID_DIRECTORY_GRANT",
                    "Specify one directory grant.",
                ));
            }
            let grant = match payload
                .get("folderId")
                .or_else(|| payload.get("directoryGrantId"))
            {
                None => None,
                Some(Value::String(value)) if !value.is_empty() => Some(value.as_str()),
                _ => {
                    return Err(HostError::new(
                        "INVALID_DIRECTORY_GRANT",
                        "A non-empty native directory grant is required.",
                    ))
                }
            };
            return serde_json::to_value(self.ensure_bound_workspace(
                owner,
                thread,
                payload.get("workspaceId").and_then(Value::as_str),
                grant,
            )?)
            .map_err(|e| HostError::new("INVALID_RESULT", e.to_string()));
        }
        if action == "command.cancel" {
            let target = text(payload, "executionId")?;
            calls.cancel(target);
            return Ok(json!({"confirmed":false}));
        }
        let workspace = self.get_workspace(owner, thread, text(payload, "workspaceId")?)?;
        if action == "command.execute" {
            let command = text(payload, "command")?;
            if command.len() > 64 * 1024 {
                return Err(HostError::new("COMMAND_TOO_LARGE", "Command is too large"));
            }
            let cwd = checked_path(
                &workspace.path,
                payload.get("cwd").and_then(Value::as_str).unwrap_or("."),
                true,
            )?;
            let timeout = payload
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(30000)
                .clamp(1, 120000);
            let max_output = payload
                .get("maxOutputChars")
                .and_then(Value::as_u64)
                .unwrap_or(20000)
                .clamp(1, 100000) as usize;
            let cancel = Arc::new(AtomicBool::new(false));
            calls
                .active
                .lock()
                .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Execution lock failed"))?
                .insert(id.into(), cancel.clone());
            let result = super::srt_exec::execute_command(
                self,
                &workspace.path,
                &cwd,
                command,
                timeout,
                max_output,
                cancel,
            );
            if let Ok(mut active) = calls.active.lock() {
                active.remove(id);
            }
            return result;
        }
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let relative = text(payload, "path")?;
        match action {
            "file.grep" => {
                let pattern = text(payload, "pattern")?;
                let paths: Vec<String> =
                    serde_json::from_value(payload.get("paths").cloned().unwrap_or_default())
                        .map_err(|_| {
                            HostError::new("INVALID_PATHS", "An explicit file list is required")
                        })?;
                let cancel = Arc::new(AtomicBool::new(false));
                {
                    let mut active = calls
                        .active
                        .lock()
                        .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Execution lock failed"))?;
                    if active.len() >= 4 {
                        return Err(HostError::new(
                            "HOST_BUSY",
                            "Too many active file operations",
                        ));
                    }
                    active.insert(id.into(), cancel.clone());
                }
                let result = self.grep_files(
                    owner,
                    thread,
                    &workspace.id,
                    &paths,
                    pattern,
                    payload
                        .get("ignoreCase")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    payload
                        .get("firstPerFile")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    payload
                        .get("literal")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    Some(&cancel),
                );
                if let Ok(mut active) = calls.active.lock() {
                    active.remove(id);
                }
                result
            }
            "file.binary.begin" => self.begin_binary_read(owner, thread, &workspace.id, relative),
            "file.binary.chunk" => {
                let offset = payload
                    .get("offset")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| HostError::new("INVALID_RANGE", "A valid offset is required"))?;
                self.read_binary_chunk(
                    owner,
                    thread,
                    &workspace.id,
                    relative,
                    text(payload, "transferId")?,
                    offset,
                )
            }
            "file.binary.close" => {
                self.close_binary_read(owner, thread, &workspace.id, text(payload, "transferId")?)
            }
            "file.read" => {
                // Text reads retain the smaller bound; binary reads use explicit sessions.
                let content =
                    self.read_bytes_limited(owner, thread, &workspace.id, relative, 1024 * 1024)?;
                Ok(json!({"content":STANDARD.encode(&content)}))
            }
            "file.write" | "file.replace" => {
                let bytes = STANDARD
                    .decode(text(payload, "content")?)
                    .map_err(|e| HostError::new("INVALID_CONTENT", e.to_string()))?;
                if bytes.len() > 1024 * 1024 {
                    return Err(HostError::new("FILE_TOO_LARGE", "File exceeds 1 MiB"));
                }
                let expected_key = if action == "file.replace" {
                    "expected"
                } else {
                    "expectedContent"
                };
                if action == "file.replace" {
                    text(payload, "expected")?;
                }
                let expected = payload
                    .get(expected_key)
                    .and_then(Value::as_str)
                    .map(|v| STANDARD.decode(v))
                    .transpose()
                    .map_err(|_| {
                        HostError::new("INVALID_CONTENT", "Invalid expected file content")
                    })?;
                self.write_bytes(
                    owner,
                    thread,
                    &workspace.id,
                    relative,
                    &bytes,
                    expected.as_deref(),
                )
            }

            "file.mkdir" => {
                let path = checked_path(&workspace.path, relative, false)?;
                make_directories(&workspace.path, relative, &path)?;
                Ok(json!({"created":true}))
            }
            "file.list" => {
                let path = checked_path(&workspace.path, relative, true)?;
                let recursive = payload
                    .get("recursive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                list_entries(&workspace.path, relative, path, recursive)
            }
            _ => Err(HostError::new(
                "UNSUPPORTED_ACTION",
                "The local action is not implemented",
            )),
        }
    }
}

/// `file.mkdir`: creates `path` (already validated by `checked_path` from `relative` below `root`)
/// and any missing parents, and refuses a path that exists as something other than a directory.
#[cfg(unix)]
fn make_directories(root: &Path, relative: &str, path: &Path) -> Result<()> {
    let _ = (root, relative);
    if !path.exists() {
        std::fs::create_dir_all(path)?;
    }
    if !path.is_dir() {
        return Err(HostError::new("NOT_A_DIRECTORY", "Path is not a directory"));
    }
    Ok(())
}

/// Windows: every directory is created and entered through its parent's handle, so a directory
/// swapped for a junction after `checked_path` looked cannot redirect the creation.
#[cfg(windows)]
fn make_directories(root: &Path, relative: &str, path: &Path) -> Result<()> {
    let _ = path;
    let parts = relative_parts(relative);
    super::files::nt::create_dir_all_beneath(root, &parts)
}

/// The normal components of a workspace-relative path (`checked_path` has validated them).
#[cfg(windows)]
fn relative_parts(relative: &str) -> Vec<&std::ffi::OsStr> {
    Path::new(relative)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect()
}

/// `file.list`: a single file, or the entries of a directory (and below it when `recursive`), as
/// `{"files":[{"path","is_dir","size"}]}` with paths relative to `root`. `path` is `relative`
/// resolved by `checked_path`.
#[cfg(unix)]
fn list_entries(root: &Path, relative: &str, path: std::path::PathBuf, recursive: bool) -> Result<Value> {
    let mut files = Vec::new();
    let meta = path.symlink_metadata()?;
    if meta.is_file() {
        if has_other_links(&path, &meta)? {
            return Err(HostError::new(
                "HARDLINK_NOT_ALLOWED",
                "Hard-linked files cannot be searched.",
            ));
        }
        return Ok(json!({"files":[{"path":relative,"is_dir":false,"size":meta.len()}]}));
    }
    let mut pending = vec![path];
    while let Some(directory) = pending.pop() {
        // Recheck each visited path; never traverse a symbolic link.
        let rel = directory
            .strip_prefix(root)
            .map_err(|_| HostError::new("PATH_DENIED", "Outside directory"))?;
        let directory = checked_path(root, &relative_for_check(rel)?, true)?;
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let meta = entry.path().symlink_metadata()?;
            if is_link(&meta)
                || (!meta.is_dir() && (!meta.is_file() || has_other_links(&entry.path(), &meta)?))
            {
                continue;
            }
            if files.len() >= 500 {
                return Err(HostError::new(
                    "DIRECTORY_TOO_LARGE",
                    "More than 500 entries. Choose a narrower directory.",
                ));
            }
            if recursive && meta.is_dir() {
                pending.push(entry.path());
            }
            files.push(json!({"path":relative_wire(entry.path().strip_prefix(root).map_err(|_|HostError::new("PATH_DENIED","Outside workspace"))?),"is_dir":meta.is_dir(),"size":meta.len()}));
        }
    }
    Ok(json!({"files":files}))
}

/// Windows: read through handles (see `files::list_workspace_in`).
#[cfg(windows)]
fn list_entries(root: &Path, relative: &str, path: std::path::PathBuf, recursive: bool) -> Result<Value> {
    let _ = path;
    let parts = relative_parts(relative);
    let directory = super::files::nt::open_walk_root(root, super::files::nt::Role::Dir)?;
    super::files::list_workspace_in(&directory, &parts, relative, recursive)
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn text<'a>(payload: &'a Value, key: &str) -> Result<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::new("INVALID_CALL", format!("Missing {key}")))
}

/// A draft-folder request path (`folder.list` / `folder.read`) reduced to a path relative to the
/// granted `root`. The backend may send the absolute path the host reported, which must lie inside
/// `root`; on Windows that is the wire form (`C:/proj/a.txt`, see `winpath`).
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn folder_relative(root: &Path, requested: &str) -> Result<String> {
    #[cfg(unix)]
    {
        if requested.starts_with('/') {
            Ok(Path::new(requested)
                .strip_prefix(root)
                .map_err(|_| HostError::new("PATH_DENIED", "Outside the selected folder"))?
                .to_str()
                .ok_or_else(|| HostError::new("INVALID_PATH", "Invalid path"))?
                .to_owned())
        } else {
            Ok(requested.to_owned())
        }
    }
    #[cfg(windows)]
    {
        super::winpath::folder_request_relative(root, requested)
    }
}

/// Whether a directory entry is a symbolic link, which the unix listing must skip. (Windows
/// listings and path checks go through directory handles, `files::nt`, and never look at paths.)
#[cfg(unix)]
fn is_link(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// Whether a regular file has more than one hard link.
#[cfg(unix)]
fn has_other_links(path: &Path, meta: &std::fs::Metadata) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let _ = path;
    Ok(meta.nlink() > 1)
}

/// A workspace-relative path as reported to the backend.
#[cfg(unix)]
fn relative_wire(relative: &Path) -> String {
    relative.to_string_lossy().into_owned()
}

/// The relative path of a visited directory in the form `checked_path` takes.
#[cfg(unix)]
fn relative_for_check(relative: &Path) -> Result<String> {
    Ok(relative
        .to_str()
        .ok_or_else(|| HostError::new("INVALID_PATH", "Non-UTF8 path"))?
        .to_owned())
}

/// Resolves `relative` below `root`, refusing anything that is not a plain path inside it.
/// Unix: no symbolic link on the way. Windows: no reparse point on the way (symlink, junction,
/// mount point, cloud placeholder), no component Win32 would resolve to something other than the
/// spelled name (device names, alternate data streams, trailing dots/spaces, `\`), and no 8.3
/// short-name alias (the spelled path must be the on-disk path, up to case). On Windows the check
/// walks directory handles from `root` (`files::nt::check_in`), so each component is judged as the
/// object it opens, not as a path that can change under the check.
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn checked_path(root: &Path, relative: &str, must_exist: bool) -> Result<std::path::PathBuf> {
    use std::path::Component;
    #[cfg(windows)]
    if relative.contains('\\') {
        return Err(HostError::new(
            "PATH_DENIED",
            "Expected a workspace-relative path with / separators",
        ));
    }
    let mut result = root.to_owned();
    #[cfg(windows)]
    let mut parts: Vec<&std::ffi::OsStr> = Vec::new();
    for component in Path::new(relative).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => {
                #[cfg(windows)]
                {
                    part.to_str()
                        .ok_or_else(|| HostError::new("PATH_DENIED", "Path is not valid UTF-8"))
                        .and_then(super::winpath::validate_component)
                        .map_err(|error| HostError::new("PATH_DENIED", error.message))?;
                    parts.push(part);
                }
                result.push(part);
                #[cfg(unix)]
                if let Ok(meta) = result.symlink_metadata() {
                    if is_link(&meta) {
                        return Err(HostError::new(
                            "PATH_DENIED",
                            "Symbolic links are not allowed",
                        ));
                    }
                }
            }
            _ => {
                return Err(HostError::new(
                    "PATH_DENIED",
                    "Expected a workspace-relative path",
                ))
            }
        }
    }
    #[cfg(windows)]
    super::files::nt::check_beneath(root, &parts, must_exist)?;
    #[cfg(unix)]
    if must_exist && !result.exists() {
        return Err(HostError::new("PATH_MISSING", "Path does not exist"));
    }
    Ok(result)
}
