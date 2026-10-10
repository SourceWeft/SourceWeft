//! Handle-pinned Windows traversal. Reparse points, alternate streams and hard
//! links are rejected. Ancestors cannot be renamed while an operation is active.
use super::{HostError, Result};
use std::{
    fs::{File, OpenOptions},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Component, Path, PathBuf},
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

pub(crate) fn information(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(HostError::new(
            "PATH_DENIED",
            "Reparse points are not allowed.",
        ));
    }
    Ok(info)
}

pub(crate) fn validate_part(part: &std::ffi::OsStr) -> Result<()> {
    let name = part
        .to_str()
        .ok_or_else(|| HostError::new("INVALID_PATH", "Invalid path encoding."))?;
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if name.is_empty()
        || name
            .chars()
            .any(|c| c.is_control() || ":<>\"|?*/\\".contains(c))
        || name.ends_with(['.', ' '])
        || name == "."
        || name == ".."
        || matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && (matches!(stem.chars().nth(3), Some('0'..='9' | '¹' | '²' | '³'))
                && stem.chars().count() == 4))
    {
        return Err(HostError::new(
            "INVALID_PATH",
            "Expected an ordinary Windows file name.",
        ));
    }
    Ok(())
}

fn directory(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    information(&file)?;
    if !file.metadata()?.is_dir() {
        return Err(HostError::new("NOT_A_DIRECTORY", "Expected a directory."));
    }
    Ok(file)
}

pub(crate) struct PinnedDirectory {
    pub path: PathBuf,
    _handles: Vec<File>,
}

pub(crate) fn pin_directory(root: &Path, relative: &Path) -> Result<PinnedDirectory> {
    // Do not canonicalize user input: that would follow a junction before checking it.
    let mut path = PathBuf::new();
    let mut handles = Vec::new();
    for component in root.components() {
        match component {
            Component::Prefix(prefix) => {
                if !matches!(
                    prefix.kind(),
                    std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
                ) {
                    return Err(HostError::new(
                        "PATH_DENIED",
                        "Windows local execution requires a local drive directory.",
                    ));
                }
                path.push(component.as_os_str());
            }
            Component::RootDir => path.push(component.as_os_str()),
            Component::Normal(part) => {
                validate_part(part)?;
                path.push(part);
                handles.push(directory(&path)?);
            }
            _ => {
                return Err(HostError::new(
                    "PATH_DENIED",
                    "Expected an absolute directory.",
                ))
            }
        }
    }
    if !root.is_absolute() || handles.is_empty() {
        return Err(HostError::new(
            "PATH_DENIED",
            "Expected an absolute task directory.",
        ));
    }
    for component in relative.components() {
        match component {
            Component::CurDir => (),
            Component::Normal(part) => {
                validate_part(part)?;
                path.push(part);
                handles.push(directory(&path)?);
            }
            _ => {
                return Err(HostError::new(
                    "PATH_DENIED",
                    "Expected a relative directory.",
                ))
            }
        }
    }
    Ok(PinnedDirectory {
        path,
        _handles: handles,
    })
}

pub(crate) fn identity(path: &Path) -> Result<(u64, u64)> {
    let pinned = pin_directory(path, Path::new("."))?;
    let info = information(pinned._handles.last().unwrap())?;
    Ok((
        info.dwVolumeSerialNumber as u64,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}

pub(crate) fn open_file(root: &Path, parts: &[&std::ffi::OsStr]) -> Result<File> {
    let (name, parents) = parts
        .split_last()
        .ok_or_else(|| HostError::new("INVALID_PATH", "A file path is required."))?;
    validate_part(name)?;
    let parent: PathBuf = parents.iter().collect();
    let pinned = pin_directory(root, &parent)?;
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(pinned.path.join(name))?;
    ordinary_file(&file)?;
    // The final handle denies rename/write and remains valid after ancestors close.
    Ok(file)
}

fn ordinary_file(file: &File) -> Result<()> {
    let info = information(file)?;
    if !file.metadata()?.is_file() || info.nNumberOfLinks != 1 {
        return Err(HostError::new(
            "HARDLINK_NOT_ALLOWED",
            "Only ordinary, non-hardlinked files are allowed.",
        ));
    }
    Ok(())
}

pub(crate) fn list(root: &Path, relative: &Path) -> Result<Vec<serde_json::Value>> {
    let pinned = pin_directory(root, relative)?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&pinned.path)? {
        let entry = entry?;
        let meta = entry.path().symlink_metadata()?;
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            continue;
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(entry.path())?;
        let info = information(&file)?;
        if !meta.is_dir() && (!meta.is_file() || info.nNumberOfLinks != 1) {
            continue;
        }
        if files.len() >= 500 {
            return Err(HostError::new(
                "DIRECTORY_TOO_LARGE",
                "More than 500 entries. Choose a narrower directory.",
            ));
        }
        files.push(serde_json::json!({"path":super::wire_path(&entry.path()),"is_dir":meta.is_dir(),"size":meta.len()}));
    }
    Ok(files)
}

pub(crate) fn mkdir(root: &Path, relative: &str) -> Result<serde_json::Value> {
    let mut path = PathBuf::new();
    for component in Path::new(relative).components() {
        match component {
            Component::CurDir => (),
            Component::Normal(part) => {
                validate_part(part)?;
                let pinned = pin_directory(root, &path)?;
                let next = pinned.path.join(part);
                match std::fs::create_dir(&next) {
                    Ok(()) => (),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                    Err(error) => return Err(error.into()),
                }
                path.push(part);
                pin_directory(root, &path)?;
            }
            _ => {
                return Err(HostError::new(
                    "PATH_DENIED",
                    "Expected a relative directory.",
                ))
            }
        }
    }
    Ok(serde_json::json!({"created":true}))
}

pub(crate) fn list_workspace(
    root: &Path,
    relative: &str,
    recursive: bool,
) -> Result<serde_json::Value> {
    let mut pending = vec![PathBuf::from(relative)];
    let mut files = Vec::new();
    let path = root.join(relative);
    if path.is_file() {
        let parts = super::files::safe_components(relative)?;
        let file = open_file(root, &parts)?;
        return Ok(
            serde_json::json!({"files":[{"path":relative,"is_dir":false,"size":file.metadata()?.len()}]}),
        );
    }
    let wire_root = super::wire_path(root);
    while let Some(relative) = pending.pop() {
        for mut entry in list(root, &relative)? {
            let absolute = entry["path"]
                .as_str()
                .ok_or_else(|| HostError::new("INVALID_PATH", "Invalid directory entry."))?;
            let child = absolute
                .strip_prefix(&format!("{wire_root}/"))
                .ok_or_else(|| HostError::new("PATH_DENIED", "Outside the workspace."))?
                .to_owned();
            if recursive && entry["is_dir"] == true {
                pending.push(PathBuf::from(&child));
            }
            entry["path"] = serde_json::Value::String(child);
            if files.len() >= 500 {
                return Err(HostError::new(
                    "DIRECTORY_TOO_LARGE",
                    "More than 500 entries. Choose a narrower directory.",
                ));
            }
            files.push(entry);
        }
    }
    Ok(serde_json::json!({"files":files}))
}

impl super::LocalHost {
    pub fn write_bytes(
        &self,
        owner: &str,
        thread: &str,
        workspace_id: &str,
        relative: &str,
        content: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<serde_json::Value> {
        use std::io::{Read, Seek, Write};
        if content.len() as u64 > super::files::MAX_TEXT_BYTES {
            return Err(HostError::new("FILE_TOO_LARGE", "File exceeds 1 MiB."));
        }
        let workspace = self.get_workspace(owner, thread, workspace_id)?;
        let parts = super::files::safe_components(relative)?;
        let (name, parents) = parts.split_last().unwrap();
        let parent: PathBuf = parents.iter().collect();
        let pinned = pin_directory(&workspace.path, &parent)?;
        let path = pinned.path.join(name);
        let existing = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path);
        let mut backup = None;
        let mut file = match existing {
            Ok(mut file) => {
                ordinary_file(&file)?;
                let mut bytes = Vec::new();
                (&mut file)
                    .take(super::files::MAX_TEXT_BYTES + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() as u64 > super::files::MAX_TEXT_BYTES {
                    return Err(HostError::new("FILE_TOO_LARGE", "File exceeds 1 MiB."));
                }
                if expected != Some(bytes.as_slice()) {
                    return Err(HostError::new(
                        "FILE_VERSION_CONFLICT",
                        "Read the current file before replacing it.",
                    ));
                }
                let id = uuid::Uuid::new_v4().to_string();
                let base = self.backup_base()?;
                let _backup_pin = pin_directory(&base, Path::new("."))?;
                let mut saved = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(base.join(&id))?;
                saved.write_all(&bytes)?;
                saved.sync_all()?;
                let mut marker = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(base.join(format!("{id}.json")))?;
                marker.write_all(serde_json::json!({"owner":owner,"thread":thread,"workspaceId":workspace_id,"path":relative}).to_string().as_bytes())?;
                marker.sync_all()?;
                backup = Some(id);
                file.rewind()?;
                file
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if expected.is_some() {
                    return Err(HostError::new(
                        "FILE_VERSION_CONFLICT",
                        "The previously read file was removed.",
                    ));
                }
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .share_mode(FILE_SHARE_READ)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&path)?
            }
            Err(error) => return Err(error.into()),
        };
        ordinary_file(&file)?;
        // A held exclusive-write handle prevents concurrent replacement. The old
        // content is durably backed up; Windows writes are not atomic rename commits.
        file.write_all(content)?;
        file.set_len(content.len() as u64)?;
        file.sync_all()?;
        Ok(serde_json::json!({"bytes":content.len(),"backupId":backup}))
    }
}
