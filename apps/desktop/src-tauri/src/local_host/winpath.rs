//! The Windows path layer of the local host.
//!
//! # Wire form (Plan 6, W10)
//!
//! The backend assumes POSIX-style absolute paths (`startsWith("/")`, `${base}/${id}/files`,
//! string equality of host-returned paths). The Windows host therefore speaks **forward-slash
//! drive paths** on the wire (`C:/Users/me/AppData/Roaming/app/task-workspaces/<id>/files`):
//! upper-case drive letter, `/` separators, no trailing slash (except a drive root, `C:/`), never a
//! `\\?\` verbatim prefix and never a UNC path. `std::fs::canonicalize` returns `\\?\C:\...` on
//! Windows, so **every path that leaves the host goes through [`host_to_wire`]/[`to_wire`] and every
//! path that enters goes through [`from_wire`]**. Inside the host, paths are the *native*
//! non-verbatim form (`C:\Users\me\...`, produced by [`to_native`]), so the sandbox sidecar, which
//! refuses `\\?\` and UNC roots, and `Path::join` see one consistent spelling.
//!
//! The parsing, validation, normalisation and hashing functions here are pure string functions:
//! they compile and are unit-tested on every OS. Only the handle-based file identity, link count
//! and reparse-point probes are `cfg(windows)`.
//!
//! # What is refused, and why
//!
//! * UNC and network paths, `\\.\` device paths, drive-relative paths (`C:foo`): a workspace must be
//!   a local directory whose NTFS ACL the sandbox account can be granted.
//! * Components that Windows resolves to something other than the spelled file: device names
//!   (`CON`, `NUL`, `COM1`, also with an extension), alternate data streams (`:`), trailing dots and
//!   spaces, characters Win32 forbids.
//! * Folders that are too broad to receive a persistent write grant (W11).

use super::{HostError, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn invalid(message: impl Into<String>) -> HostError {
    HostError::new("INVALID_PATH", message)
}

fn unsupported(message: impl Into<String>) -> HostError {
    HostError::new("PATH_UNSUPPORTED", message)
}

fn is_separator(c: char) -> bool {
    c == '\\' || c == '/'
}

/// How a path starts: a local drive, or a network (UNC) share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Root {
    Drive(char),
    Unc,
}

/// Splits `raw` into its root and the text after it (empty, or starting with a separator for a
/// drive; the part after the leading slashes for UNC). `None` for anything that is neither: a
/// relative path, a drive-relative path (`C:foo`), a `\\.\` device path, a `\\?\Volume{..}` path.
fn split_root(raw: &str) -> Option<(Root, &str)> {
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        if rest.len() >= 4 && rest.is_char_boundary(4) && rest[..4].eq_ignore_ascii_case("UNC\\") {
            return Some((Root::Unc, &rest[4..]));
        }
        return drive_root(rest);
    }
    if raw.starts_with(r"\\.\") {
        return None;
    }
    if raw.starts_with(r"\\") || raw.starts_with("//") {
        return Some((Root::Unc, &raw[2..]));
    }
    drive_root(raw)
}

fn drive_root(text: &str) -> Option<(Root, &str)> {
    let mut chars = text.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }
    let rest = &text[2..];
    if rest.is_empty() || rest.starts_with(is_separator) {
        Some((Root::Drive(letter.to_ascii_uppercase()), rest))
    } else {
        None
    }
}

/// Windows device names, which resolve to a device whatever the extension or directory.
fn is_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let upper: Vec<char> = stem.chars().map(|c| c.to_ascii_uppercase()).collect();
    let text: String = upper.iter().collect();
    if matches!(
        text.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    upper.len() == 4
        && (text.starts_with("COM") || text.starts_with("LPT"))
        && matches!(upper[3], '0'..='9' | '¹' | '²' | '³')
}

/// One path component as the host will accept it: no separators, no characters Win32 forbids, not
/// `.`/`..`, no trailing dot or space, not a device name (with or without an extension), no
/// alternate data stream (`:`), at most 255 UTF-16 units.
pub fn validate_component(name: &str) -> Result<()> {
    let deny = |why: &str| {
        Err(invalid(format!(
            "The path component {name:?} is not usable on Windows: {why}."
        )))
    };
    if name.is_empty() {
        return deny("it is empty");
    }
    if name == "." || name == ".." {
        return deny("relative components are not allowed");
    }
    if name.encode_utf16().count() > 255 {
        return deny("it is longer than 255 characters");
    }
    if name.chars().any(|c| {
        (c as u32) < 0x20 || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return deny("it contains a reserved character or an alternate data stream");
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return deny("it ends with a dot or a space");
    }
    if is_device_name(name) {
        return deny("it is a reserved device name");
    }
    Ok(())
}

/// The wire form of a Windows path given as text: `\\?\C:\Users\me`, `C:\Users\me` or
/// `C:/Users/me` all become `C:/Users/me`. Strict: UNC, device and relative paths, empty, `.` and
/// `..` segments and invalid components are errors, so a path that cannot be read back by
/// [`from_wire`] never leaves the host.
pub fn to_wire_str(raw: &str) -> Result<String> {
    let (root, rest) = split_root(raw)
        .ok_or_else(|| unsupported(format!("{raw:?} is not an absolute local drive path.")))?;
    let letter = match root {
        Root::Drive(letter) => letter,
        Root::Unc => {
            return Err(unsupported(
                "Network (UNC) paths cannot be used; choose a folder on a local drive.",
            ))
        }
    };
    if rest.is_empty() {
        return Err(unsupported(format!(
            "{raw:?} is relative to a drive's current directory; use an absolute path."
        )));
    }
    let mut wire = format!("{letter}:/");
    let after = rest.strip_prefix(is_separator).unwrap_or(rest);
    if after.is_empty() {
        return Ok(wire);
    }
    let body = after.strip_suffix(is_separator).unwrap_or(after);
    let mut first = true;
    for part in body.split(is_separator) {
        validate_component(part)?;
        if !first {
            wire.push('/');
        }
        wire.push_str(part);
        first = false;
    }
    Ok(wire)
}

/// [`to_wire_str`] for a [`Path`] (which must be valid UTF-8).
pub fn to_wire(path: &Path) -> Result<String> {
    let text = path
        .to_str()
        .ok_or_else(|| invalid("The path is not valid UTF-8."))?;
    to_wire_str(text)
}

/// A wire path from the backend as a native path: `C:/a/b` becomes `C:\a\b`. Accepts only the wire
/// form: a drive letter, `/` separators, valid components, no `..`, no backslash, no UNC (`//host`),
/// no trailing slash except on the drive root.
pub fn from_wire(wire: &str) -> Result<PathBuf> {
    let bytes = wire.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'/' {
        return Err(invalid(format!(
            "{wire:?} is not a Windows wire path (expected C:/folder/file)."
        )));
    }
    if wire.contains('\\') {
        return Err(invalid("Backslashes are not allowed in a wire path."));
    }
    let letter = (bytes[0] as char).to_ascii_uppercase();
    let rest = &wire[3..];
    let mut native = format!("{letter}:\\");
    if rest.is_empty() {
        return Ok(PathBuf::from(native));
    }
    let mut first = true;
    for part in rest.split('/') {
        validate_component(part)?;
        if !first {
            native.push('\\');
        }
        native.push_str(part);
        first = false;
    }
    Ok(PathBuf::from(native))
}

/// The native, non-verbatim form of a host path (typically a `canonicalize()` result):
/// `\\?\C:\Users\me` becomes `C:\Users\me`. Fails like [`to_wire`] for what cannot be represented.
pub fn to_native(path: &Path) -> Result<PathBuf> {
    from_wire(&to_wire(path)?)
}

/// The wire form of a host path, on every platform. On Windows this is [`to_wire`]; elsewhere
/// paths are already POSIX and only have to be UTF-8 (what serde would have required).
pub fn host_to_wire(path: &Path) -> Result<String> {
    #[cfg(windows)]
    {
        to_wire(path)
    }
    #[cfg(not(windows))]
    {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| invalid("The path is not valid UTF-8."))
    }
}

/// Simple per-character upper-casing, which is how NTFS compares names (it uses a table of simple
/// mappings, not full Unicode folding: `ß` does not become `SS`).
fn fold(segment: &str) -> String {
    segment
        .chars()
        .map(|c| {
            let mut upper = c.to_uppercase();
            match (upper.next(), upper.next()) {
                (Some(single), None) => single,
                _ => c,
            }
        })
        .collect()
}

/// A path split for comparison, without touching the file system.
struct Lexical {
    root: Root,
    /// As spelled.
    segments: Vec<String>,
    has_parent: bool,
}

fn lexical(raw: &str) -> Option<Lexical> {
    let (root, rest) = split_root(raw)?;
    let segments: Vec<String> = rest
        .split(is_separator)
        .filter(|part| !part.is_empty() && *part != ".")
        .map(str::to_owned)
        .collect();
    let has_parent = segments.iter().any(|part| part == "..");
    Some(Lexical {
        root,
        segments,
        has_parent,
    })
}

impl Lexical {
    fn of(path: &Path) -> Option<Self> {
        lexical(path.to_str()?)
    }

    fn contains(&self, child: &Lexical) -> bool {
        self.root == child.root
            && !self.has_parent
            && !child.has_parent
            && child.segments.len() >= self.segments.len()
            && self
                .segments
                .iter()
                .zip(&child.segments)
                .all(|(a, b)| fold(a) == fold(b))
    }
}

/// Whether `child` is `parent` or lies below it. Case-insensitive, separator-insensitive and blind
/// to the `\\?\` prefix. A path that is not an absolute drive/UNC path, is not UTF-8 or contains
/// `..` is never inside anything (and nothing is inside it).
pub fn is_inside(child: &Path, parent: &Path) -> bool {
    match (Lexical::of(parent), Lexical::of(child)) {
        (Some(parent), Some(child)) => parent.contains(&child),
        _ => false,
    }
}

/// Whether two paths name the same location, compared as [`is_inside`] does.
pub fn same_path(a: &Path, b: &Path) -> bool {
    is_inside(a, b) && is_inside(b, a)
}

/// `abs` relative to `root` in wire form (`/`-separated, spelled as in `abs`; empty for the root
/// itself), or `None` when `abs` is not inside `root`.
pub fn relative_below(root: &Path, abs: &Path) -> Option<String> {
    let root = Lexical::of(root)?;
    let abs = Lexical::of(abs)?;
    root.contains(&abs)
        .then(|| abs.segments[root.segments.len()..].join("/"))
}

/// A draft-folder request path as the backend sends it, reduced to a path relative to the granted
/// `root` (`folder.list` / `folder.read`). A wire absolute path (`C:/proj/src/a.txt`) must lie inside
/// `root`; anything rooted without a drive (`/x`, `\x`) is outside by definition; a relative path is
/// returned unchanged for `checked_path` to validate.
pub fn folder_request_relative(root: &Path, requested: &str) -> Result<String> {
    let looks_absolute = {
        let mut chars = requested.chars();
        matches!(
            (chars.next(), chars.next()),
            (Some(letter), Some(':')) if letter.is_ascii_alphabetic()
        )
    };
    if looks_absolute {
        let absolute = from_wire(requested)?;
        return relative_below(root, &absolute)
            .ok_or_else(|| HostError::new("PATH_DENIED", "Outside the selected folder"));
    }
    if requested.starts_with(is_separator) {
        return Err(HostError::new("PATH_DENIED", "Outside the selected folder"));
    }
    Ok(requested.to_owned())
}

/// The credential locations below the profile (relative, backslash-separated) that no workspace
/// or read root may equal or lie inside: the one list the sandbox sidecar's policy reads too
/// (`sandbox-sidecar/src/windows-protected-paths.json`).
const PROTECTED_LOCATIONS_JSON: &str =
    include_str!("../../../sandbox-sidecar/src/windows-protected-paths.json");

/// The relative credential locations from [`PROTECTED_LOCATIONS_JSON`].
pub fn protected_relative_locations() -> Vec<String> {
    #[derive(serde::Deserialize)]
    struct List {
        #[serde(rename = "relativeToHome")]
        relative_to_home: Vec<String>,
    }
    // The file is embedded at compile time and a test parses it: a malformed list is a build
    // defect, never a runtime state, so there is no fallback to an empty list.
    serde_json::from_str::<List>(PROTECTED_LOCATIONS_JSON)
        .expect("windows-protected-paths.json is valid")
        .relative_to_home
}

/// The credential locations under `profile`, as native paths.
pub fn protected_locations(profile: &Path) -> Vec<PathBuf> {
    let base = profile.to_string_lossy().trim_end_matches(is_separator).to_owned();
    protected_relative_locations()
        .into_iter()
        .map(|relative| PathBuf::from(format!("{base}\\{relative}")))
        .collect()
}

/// Windows refuses to turn these into a workspace (W11): a write grant is a persistent NTFS ACL
/// walk over the whole tree, kept until the sandbox is uninstalled. Refused: a drive root, the
/// user's profile directory, any ancestor of the profile, and `AppData` and its `Roaming`/`Local`
/// style children (every entry of `app_data_roots` and every ancestor of one). Folders *inside*
/// those (`AppData\Local\Temp\x`, `Documents\proj`) are fine.
///
/// Also refused (`FOLDER_PROTECTED`): a folder that equals or lies INSIDE a credential location of
/// the profile (`~\.ssh\proj`, `~\AppData\Roaming\Mozilla\Firefox\Profiles\x`, see
/// [`protected_locations`]). The sandbox denies protected paths that lie *within* a granted root,
/// so a root placed inside one would be granted with no deny at all. On Windows the folder is also
/// checked under its canonical long-name spelling (an 8.3 short name such as `RUNNER~1` must not
/// hide it from the comparison with the canonical `profile`).
pub fn refuse_broad_grant(path: &Path, profile: &Path, app_data_roots: &[PathBuf]) -> Result<()> {
    refuse_spelled_grant(path, profile, app_data_roots)?;
    #[cfg(windows)]
    if let Some(long) = long_spelling(path) {
        if !same_path(&long, path) {
            refuse_spelled_grant(&long, profile, app_data_roots)?;
        }
    }
    Ok(())
}

/// The folder as the file system spells it: `canonicalize` (which expands 8.3 short names and
/// resolves links) in the native, non-verbatim form; `None` when it does not exist.
#[cfg(windows)]
fn long_spelling(path: &Path) -> Option<PathBuf> {
    to_native(&path.canonicalize().ok()?).ok()
}

fn refuse_spelled_grant(path: &Path, profile: &Path, app_data_roots: &[PathBuf]) -> Result<()> {
    let too_broad = || {
        HostError::new(
            "FOLDER_TOO_BROAD",
            "Choose a narrower folder: a whole drive, your user profile folder, AppData or a folder \
             that contains them cannot be used as a working folder.",
        )
    };
    let lexical = Lexical::of(path)
        .ok_or_else(|| unsupported("The folder must be an absolute path on a local drive."))?;
    if lexical.root == Root::Unc {
        return Err(unsupported(
            "Network (UNC) paths cannot be used; choose a folder on a local drive.",
        ));
    }
    if lexical.segments.is_empty() {
        return Err(too_broad());
    }
    if is_inside(profile, path) || app_data_roots.iter().any(|root| is_inside(root, path)) {
        return Err(too_broad());
    }
    if protected_locations(profile)
        .iter()
        .any(|protected| is_inside(path, protected))
    {
        return Err(HostError::new(
            "FOLDER_PROTECTED",
            "That folder holds sign-in data (for example SSH keys, browser profiles or cloud \
             credentials) or is inside a folder that does. Choose another folder.",
        ));
    }
    Ok(())
}

/// The well-known per-user locations a grant must not cover, given the profile directory and the
/// `APPDATA`/`LOCALAPPDATA` values (when set): `AppData\Roaming`, `AppData\Local`,
/// `AppData\LocalLow` under the profile, plus the two variables. `AppData` itself is covered as an
/// ancestor of these by [`refuse_broad_grant`].
pub fn app_data_roots(profile: &str, appdata: Option<&str>, local: Option<&str>) -> Vec<String> {
    let profile = profile.trim_end_matches(is_separator);
    let mut roots: Vec<String> = ["Roaming", "Local", "LocalLow"]
        .iter()
        .map(|name| format!("{profile}\\AppData\\{name}"))
        .collect();
    roots.extend(appdata.filter(|v| !v.is_empty()).map(str::to_owned));
    roots.extend(local.filter(|v| !v.is_empty()).map(str::to_owned));
    roots
}

/// A stable, storable identity for a directory, from the volume serial number and the 128-bit file
/// id that `GetFileInformationByHandleEx(FileIdInfo)` reports. The host database stores identities
/// in two `INTEGER` columns (SQLite integers are signed 64-bit), so each column holds the low 63
/// bits of a domain-separated SHA-256: `device` over the serial alone, `inode` over serial and id.
/// Two 63-bit hashes are far beyond what is needed to detect a replaced directory (an identity
/// check, not a security boundary on its own) and keep the schema unchanged: no migration.
pub fn hash_identity(volume_serial: u64, file_id: [u8; 16]) -> (u64, u64) {
    let low63 = |parts: &[&[u8]]| {
        let mut hasher = Sha256::new();
        hasher.update(b"sourceweft-root-identity-v1\0");
        for part in parts {
            hasher.update(part);
        }
        let digest = hasher.finalize();
        let mut word = [0u8; 8];
        word.copy_from_slice(&digest[..8]);
        u64::from_le_bytes(word) & (i64::MAX as u64)
    };
    let serial = volume_serial.to_le_bytes();
    (
        low63(&[b"device", &serial]),
        low63(&[b"inode", &serial, &file_id]),
    )
}

// ---------------------------------------------------------------------------------------------
// Windows-only: handle-based probes. Everything below needs a real file system.
// ---------------------------------------------------------------------------------------------

/// Opens `path` for attribute queries only, without following a final reparse point and with the
/// backup-semantics flag that lets a directory be opened.
#[cfg(windows)]
fn open_for_query(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

/// `(volume serial number, 128-bit file id)` of `path` itself (a final reparse point is not
/// followed). The file id survives renames of the file or of its parents and changes when the
/// directory is deleted and recreated, which is what the workspace identity check relies on.
/// File systems without stable file ids (FAT, exFAT) make this fail rather than guess.
#[cfg(windows)]
pub fn file_identity(path: &Path) -> std::io::Result<(u64, [u8; 16])> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };
    let file = open_for_query(path)?;
    let mut info = FILE_ID_INFO {
        VolumeSerialNumber: 0,
        FileId: Default::default(),
    };
    // SAFETY: `file` owns a valid handle for the duration of the call; `info` is a properly sized
    // and aligned FILE_ID_INFO that the call fills in.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            &mut info as *mut FILE_ID_INFO as *mut core::ffi::c_void,
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((info.VolumeSerialNumber, info.FileId.Identifier))
}

/// Whether an entry is any kind of reparse point: symbolic link, junction, mount point, cloud
/// placeholder, dedup stub. Task paths refuse all of them.
#[cfg(windows)]
pub fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// The user's profile directory and the `AppData` locations a grant must not cover, canonicalised
/// into native form. Fails when the profile cannot be determined: a folder grant is never allowed
/// without knowing what it must not contain.
#[cfg(windows)]
pub fn user_locations() -> Result<(PathBuf, Vec<PathBuf>)> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let unavailable = || {
        HostError::new(
            "PROFILE_UNAVAILABLE",
            "The user profile directory could not be determined, so a folder cannot be checked.",
        )
    };
    let canonical =
        |raw: &str| -> Option<PathBuf> { to_native(&Path::new(raw).canonicalize().ok()?).ok() };
    let profile_raw = var("USERPROFILE").ok_or_else(unavailable)?;
    let profile = canonical(&profile_raw).ok_or_else(unavailable)?;
    let profile_text = profile.to_str().ok_or_else(unavailable)?;
    let appdata = var("APPDATA");
    let local = var("LOCALAPPDATA");
    let roots = app_data_roots(profile_text, appdata.as_deref(), local.as_deref())
        .into_iter()
        .map(|raw| canonical(&raw).unwrap_or_else(|| PathBuf::from(raw)))
        .collect();
    Ok((profile, roots))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(raw: &str) -> String {
        to_wire_str(raw).unwrap()
    }

    #[test]
    fn to_wire_strips_the_verbatim_prefix_and_normalises_separators_and_drive_case() {
        for (raw, expected) in [
            (r"\\?\C:\Users\me\proj", "C:/Users/me/proj"),
            (r"C:\Users\me\proj", "C:/Users/me/proj"),
            ("C:/Users/me/proj", "C:/Users/me/proj"),
            (r"c:\x\y", "C:/x/y"),
            (r"\\?\c:\x", "C:/x"),
            (r"C:\x\y\", "C:/x/y"),
            ("C:/x/y/", "C:/x/y"),
            (r"C:\", "C:/"),
            ("C:/", "C:/"),
            (r"\\?\C:\", "C:/"),
            (
                r"C:\项目\报告 [final] (1).txt",
                "C:/项目/报告 [final] (1).txt",
            ),
            (r"D:\a b\c-d_e.f", "D:/a b/c-d_e.f"),
        ] {
            assert_eq!(wire(raw), expected, "{raw}");
        }
    }

    #[test]
    fn to_wire_refuses_what_cannot_be_read_back() {
        for raw in [
            r"\\server\share\x",
            "//server/share/x",
            r"\\?\UNC\server\share\x",
            r"\\?\unc\server\share",
            r"\\.\pipe\name",
            r"\\.\C:\x",
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\x",
            r"relative\path",
            "x",
            "",
            "C:file",
            "C:",
            r"\\?\C:",
            r"C:\a\..\b",
            r"C:\a\.\b",
            r"C:\a\\b",
            r"C:\\",
            r"C:\a\CON",
            r"C:\a\nul.txt",
            r"C:\a\Com1",
            r"C:\a\lpt9.log",
            r"C:\a\b.",
            r"C:\a\b ",
            r"C:\a\f:stream",
            r"C:\a\b*",
            r"C:\a\b?",
            "C:\\a\\b\u{1}",
        ] {
            assert!(to_wire_str(raw).is_err(), "accepted {raw:?}");
        }
        assert_eq!(
            to_wire_str(r"\\server\share").unwrap_err().code,
            "PATH_UNSUPPORTED"
        );
    }

    #[test]
    fn from_wire_accepts_only_the_wire_form() {
        assert_eq!(
            from_wire("C:/Users/me/proj").unwrap(),
            PathBuf::from(r"C:\Users\me\proj")
        );
        assert_eq!(from_wire("c:/x").unwrap(), PathBuf::from(r"C:\x"));
        assert_eq!(from_wire("D:/").unwrap(), PathBuf::from(r"D:\"));
        assert_eq!(
            from_wire("C:/项目/a [1].txt").unwrap(),
            PathBuf::from(r"C:\项目\a [1].txt")
        );
        for bad in [
            "//server/share",
            "//server/share/x",
            "/x",
            "x",
            "",
            "C:",
            "C:x",
            r"C:\x",
            r"C:/a\b",
            r"\\?\C:/x",
            "C:/a/../b",
            "C:/a/./b",
            "C:/a//b",
            "C:/a/",
            "C:/a:b",
            "C:/a/b:stream",
            "C:/a/CON",
            "C:/a/con.txt",
            "C:/a/Aux",
            "C:/a/COM1",
            "C:/a/COM9.txt",
            "C:/a/LPT1",
            "C:/a/NUL",
            "C:/a/PRN.log",
            "C:/a/x.",
            "C:/a/x ",
            "C:/a/x*",
            "C:/a/x?y",
            "C:/a/<x>",
            "C:/a/\"q\"",
            "C:/a/x|y",
        ] {
            assert!(from_wire(bad).is_err(), "accepted {bad:?}");
        }
        // A name that merely starts like a device is fine.
        assert!(from_wire("C:/a/console").is_ok());
        assert!(from_wire("C:/a/com10").is_ok());
        assert!(from_wire("C:/a/nulled.txt").is_ok());
    }

    #[test]
    fn wire_and_native_round_trip() {
        for raw in [
            r"\\?\C:\Users\me\AppData\Roaming\app\task-workspaces\id\files",
            r"d:\work\项目",
        ] {
            let native = to_native(Path::new(raw)).unwrap();
            let text = native.to_str().unwrap();
            assert!(!text.starts_with(r"\\?\"), "{text}");
            assert!(!text.contains('/'), "{text}");
            assert_eq!(to_wire(&native).unwrap(), wire(raw));
            assert_eq!(from_wire(&wire(raw)).unwrap(), native);
        }
    }

    #[test]
    fn host_to_wire_matches_the_platform_form() {
        #[cfg(windows)]
        assert_eq!(host_to_wire(Path::new(r"\\?\C:\a\b")).unwrap(), "C:/a/b");
        #[cfg(not(windows))]
        assert_eq!(host_to_wire(Path::new("/a/b")).unwrap(), "/a/b");
    }

    #[test]
    fn comparison_ignores_prefix_case_and_separators_but_not_names() {
        let a = Path::new(r"\\?\C:\Users\Me\Proj");
        assert!(same_path(a, Path::new(r"c:\users\me\proj")));
        assert!(same_path(a, Path::new("C:/Users/Me/Proj/")));
        assert!(same_path(Path::new(r"C:\项目"), Path::new(r"\\?\c:\项目")));
        assert!(!same_path(a, Path::new(r"C:\Users\Me\Proj2")));
        assert!(!same_path(a, Path::new(r"D:\Users\Me\Proj")));
        assert!(!same_path(a, Path::new(r"\\Users\Me\Proj")));

        let parent = Path::new(r"C:\proj");
        assert!(is_inside(Path::new(r"\\?\C:\PROJ\src\a.rs"), parent));
        assert!(is_inside(parent, parent));
        assert!(!is_inside(Path::new(r"C:\proj2"), parent), "name prefix");
        assert!(!is_inside(Path::new(r"C:\"), parent), "ancestor");
        assert!(
            !is_inside(Path::new(r"C:\proj\..\other"), parent),
            "dot-dot"
        );
        assert!(!is_inside(parent, Path::new(r"C:\proj\..")));
        assert!(!is_inside(Path::new("relative"), parent));
        assert!(!is_inside(parent, Path::new("relative")));
        // UNC paths compare among themselves and never against a drive.
        assert!(is_inside(
            Path::new(r"\\?\UNC\srv\share\x"),
            Path::new(r"\\SRV\Share")
        ));
        assert!(!is_inside(Path::new(r"\\srv\share"), Path::new(r"C:\srv")));
    }

    #[test]
    fn upper_casing_follows_simple_mappings_like_ntfs() {
        assert!(same_path(Path::new(r"C:\Straße"), Path::new(r"C:\STRAßE")));
        assert!(!same_path(
            Path::new(r"C:\Straße"),
            Path::new(r"C:\STRASSE")
        ));
        assert!(same_path(Path::new(r"C:\ÄÖÜ"), Path::new(r"C:\äöü")));
    }

    #[test]
    fn relative_below_keeps_the_spelling_of_the_inner_path() {
        let root = Path::new(r"C:\Users\me\proj");
        assert_eq!(
            relative_below(root, Path::new(r"c:\users\ME\proj\Src\a b.txt")).as_deref(),
            Some("Src/a b.txt")
        );
        assert_eq!(
            relative_below(root, Path::new(r"\\?\C:\Users\me\proj")).as_deref(),
            Some("")
        );
        assert_eq!(
            relative_below(root, Path::new(r"C:\Users\me\proj2\a")),
            None
        );
        assert_eq!(relative_below(root, Path::new(r"C:\Users\me")), None);
    }

    #[test]
    fn folder_requests_are_relative_or_wire_paths_inside_the_root() {
        let root = Path::new(r"C:\Users\me\proj");
        assert_eq!(folder_request_relative(root, "").unwrap(), "");
        assert_eq!(
            folder_request_relative(root, "sub/a.txt").unwrap(),
            "sub/a.txt"
        );
        assert_eq!(
            folder_request_relative(root, "C:/Users/me/proj/sub/a.txt").unwrap(),
            "sub/a.txt"
        );
        assert_eq!(
            folder_request_relative(root, "c:/users/me/PROJ").unwrap(),
            ""
        );
        for outside in [
            "C:/Users/me/other/a.txt",
            "C:/Users/me/proj2/a.txt",
            "D:/Users/me/proj/a.txt",
            "C:/",
            "/Users/me/proj/a.txt",
            r"\Users\me\proj\a.txt",
        ] {
            assert_eq!(
                folder_request_relative(root, outside).unwrap_err().code,
                "PATH_DENIED",
                "{outside}"
            );
        }
        for malformed in [
            r"C:\Users\me\proj\a.txt",
            "C:a.txt",
            "C:/Users/me/proj/../x",
            "C:/proj/CON",
        ] {
            assert_eq!(
                folder_request_relative(root, malformed).unwrap_err().code,
                "INVALID_PATH",
                "{malformed}"
            );
        }
    }

    fn broad(path: &str) -> Result<()> {
        let profile = Path::new(r"C:\Users\me");
        let roots: Vec<PathBuf> = app_data_roots(
            r"C:\Users\me",
            Some(r"C:\Users\me\AppData\Roaming"),
            Some(r"C:\Users\me\AppData\Local"),
        )
        .into_iter()
        .map(PathBuf::from)
        .collect();
        refuse_broad_grant(Path::new(path), profile, &roots)
    }

    #[test]
    fn drive_roots_the_profile_appdata_and_their_ancestors_are_too_broad() {
        for path in [
            r"C:\",
            r"\\?\C:\",
            r"D:\",
            r"C:\Users",
            r"C:\Users\me",
            r"\\?\C:\USERS\ME",
            r"C:\Users\me\AppData",
            r"C:\Users\me\AppData\Roaming",
            r"C:\Users\me\AppData\Local",
            r"C:\Users\me\AppData\LocalLow",
        ] {
            assert_eq!(broad(path).unwrap_err().code, "FOLDER_TOO_BROAD", "{path}");
        }
    }

    #[test]
    fn folders_below_the_profile_and_other_drives_are_fine() {
        for path in [
            r"C:\Users\me\Documents",
            r"C:\Users\me\Documents\proj",
            r"C:\Users\me\AppData\Local\Temp\x",
            r"C:\Users\me\AppData\Roaming\app",
            r"C:\Users\me\source",
            r"C:\Users\other",
            r"C:\work",
            r"D:\work",
            r"\\?\E:\data\项目",
        ] {
            broad(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        }
        assert_eq!(
            broad(r"\\srv\share\x").unwrap_err().code,
            "PATH_UNSUPPORTED"
        );
        assert_eq!(broad("relative").unwrap_err().code, "PATH_UNSUPPORTED");
    }

    #[test]
    fn folders_that_are_or_lie_inside_a_credential_location_are_protected() {
        for path in [
            r"C:\Users\me\.ssh",
            r"C:\Users\me\.ssh\proj",
            r"c:\users\ME\.SSH\a\b",
            r"\\?\C:\Users\me\.aws\creds-copy",
            r"C:\Users\me\.claude",
            r"C:\Users\me\.codex\work",
            r"C:\Users\me\.config\op",
            r"C:\Users\me\.config\rclone\x",
            r"C:\Users\me\.oci",
            r"C:\Users\me\.terraform.d\plugins",
            r"C:\Users\me\.m2\settings.xml",
            r"C:\Users\me\.gradle\gradle.properties",
            r"C:\Users\me\.nuget\NuGet.Config",
            r"C:\Users\me\.pgpass",
            r"C:\Users\me\AppData\Roaming\Mozilla\Firefox\Profiles\x",
            r"C:\Users\me\AppData\Roaming\Code\User\globalStorage\ext",
            r"C:\Users\me\AppData\Roaming\npm\etc\npmrc",
            r"C:\Users\me\AppData\Local\Google\Chrome\User Data\Default",
            r"C:\Users\me\AppData\Local\Packages\Some.App_8wekyb3d8bbwe\LocalState",
        ] {
            assert_eq!(broad(path).unwrap_err().code, "FOLDER_PROTECTED", "{path}");
        }
    }

    #[test]
    fn neighbours_and_ancestors_of_a_credential_location_are_not_protected_by_that_rule() {
        for path in [
            r"C:\Users\me\.sshx",
            r"C:\Users\me\.ssh-keys-backup",
            r"C:\Users\me\.claude-notes",
            r"C:\Users\me\.config\rclones",
            r"C:\Users\me\.config\other",
            r"C:\Users\me\AppData\Roaming\Code\User\settings",
            r"C:\Users\me\AppData\Roaming\Code\User",
            r"C:\Users\me\AppData\Roaming\npm",
            r"C:\Users\me\AppData\Roaming\npm\etc",
            r"C:\Users\me\AppData\Roaming\npm\node_modules",
            r"C:\Users\me\AppData\Local\Google\Chrome",
            r"C:\Users\other\.ssh\proj",
            r"D:\Users\me\.ssh\proj",
        ] {
            broad(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        }
        // An ancestor that contains a credential location is a broad folder or fine, but never
        // "protected": the sandbox denies the credential location inside it per command.
        broad(r"C:\Users\me\Documents").unwrap();
    }

    #[test]
    fn the_protected_list_is_the_sidecars_list() {
        let relative = protected_relative_locations();
        assert!(relative.len() >= 40, "{relative:?}");
        for must in [
            ".ssh", ".pgpass", ".m2\\settings.xml", ".gradle\\gradle.properties", ".nuget\\NuGet.Config",
            ".config\\rclone", ".oci", ".terraform.d", ".claude", ".codex", ".config\\op",
            "AppData\\Roaming\\Code\\User\\globalStorage", "AppData\\Roaming\\npm\\etc\\npmrc",
        ] {
            assert!(relative.iter().any(|entry| entry == must), "{must}");
        }
        // Relative, backslash-separated, no duplicates (case-insensitively).
        let mut seen = std::collections::HashSet::new();
        for entry in &relative {
            assert!(!entry.contains('/') && !entry.starts_with('\\') && !entry.ends_with('\\') && !entry.contains(':'), "{entry}");
            assert!(seen.insert(entry.to_lowercase()), "duplicate {entry}");
        }
        let located = protected_locations(Path::new(r"C:\Users\me\"));
        assert_eq!(located.len(), relative.len());
        assert_eq!(located[0], PathBuf::from(r"C:\Users\me\.ssh"));
    }

    #[cfg(windows)]
    #[test]
    fn a_real_folder_inside_a_credential_location_is_refused_on_disk() {
        let profile = tempfile::tempdir().unwrap();
        let profile_path = to_native(&profile.path().canonicalize().unwrap()).unwrap();
        let project = profile_path.join(".ssh").join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let roots: Vec<PathBuf> = Vec::new();
        assert_eq!(
            refuse_broad_grant(&project, &profile_path, &roots).unwrap_err().code,
            "FOLDER_PROTECTED"
        );
        // The same folder spelled in upper case and with a verbatim prefix.
        let verbatim = PathBuf::from(format!(r"\\?\{}", project.display().to_string().to_uppercase()));
        assert_eq!(
            refuse_broad_grant(&verbatim, &profile_path, &roots).unwrap_err().code,
            "FOLDER_PROTECTED"
        );
        let fine = profile_path.join("work");
        std::fs::create_dir_all(&fine).unwrap();
        refuse_broad_grant(&fine, &profile_path, &roots).unwrap();
    }

    #[test]
    fn app_data_roots_cover_the_standard_children_and_the_variables() {
        assert_eq!(
            app_data_roots(r"C:\Users\me\", None, None),
            vec![
                r"C:\Users\me\AppData\Roaming",
                r"C:\Users\me\AppData\Local",
                r"C:\Users\me\AppData\LocalLow"
            ]
        );
        let relocated = app_data_roots(r"C:\Users\me", Some(r"D:\roam"), Some(""));
        assert_eq!(relocated.len(), 4);
        assert_eq!(relocated[3], r"D:\roam");
    }

    #[test]
    fn identity_hash_is_stable_distinct_and_fits_a_signed_column() {
        let id = [7u8; 16];
        let (device, inode) = hash_identity(0xdead_beef_cafe_f00d, id);
        assert_eq!(hash_identity(0xdead_beef_cafe_f00d, id), (device, inode));
        assert!(device <= i64::MAX as u64 && inode <= i64::MAX as u64);
        // The device column depends on the volume only; the inode column on volume and file.
        let (other_device, other_inode) = hash_identity(0xdead_beef_cafe_f00d, [8u8; 16]);
        assert_eq!(other_device, device);
        assert_ne!(other_inode, inode);
        let (volume_device, volume_inode) = hash_identity(1, id);
        assert_ne!(volume_device, device);
        assert_ne!(volume_inode, inode);
        assert_ne!(device, inode);
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::process::Command;

    fn junction(link: &Path, target: &Path) {
        let status = Command::new("powershell.exe")
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
        assert!(status.status.success(), "junction creation failed: {status:?}");
    }

    #[test]
    fn identity_is_stable_per_directory_and_survives_a_rename() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let first = file_identity(&a).unwrap();
        assert_eq!(file_identity(&a).unwrap(), first);
        assert_ne!(file_identity(&b).unwrap(), first);
        // The verbatim and the plain spelling name the same directory.
        let verbatim = a.canonicalize().unwrap();
        assert_eq!(file_identity(&verbatim).unwrap(), first);
        let moved = temp.path().join("moved");
        std::fs::rename(&a, &moved).unwrap();
        assert_eq!(file_identity(&moved).unwrap(), first);
        assert!(file_identity(&a).is_err());
    }

    #[test]
    fn identity_of_a_junction_is_the_junctions_own() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link");
        std::fs::create_dir(&target).unwrap();
        junction(&link, &target);
        // The final reparse point is not followed: swapping a directory for a junction to the
        // original cannot reproduce the original's identity.
        assert_ne!(
            file_identity(&link).unwrap(),
            file_identity(&target).unwrap()
        );
        assert!(is_reparse_point(&std::fs::symlink_metadata(&link).unwrap()));
        assert!(!is_reparse_point(
            &std::fs::symlink_metadata(&target).unwrap()
        ));
    }

    #[test]
    fn the_profile_is_known_and_canonical_and_a_temp_folder_is_grantable() {
        let (profile, roots) = user_locations().unwrap();
        assert!(!profile.to_str().unwrap().starts_with(r"\\?\"));
        assert!(roots.len() >= 3);
        let temp = tempfile::tempdir().unwrap();
        let canonical = to_native(&temp.path().canonicalize().unwrap()).unwrap();
        refuse_broad_grant(&canonical, &profile, &roots).unwrap();
        assert_eq!(
            refuse_broad_grant(&profile, &profile, &roots)
                .unwrap_err()
                .code,
            "FOLDER_TOO_BROAD"
        );
        assert_eq!(
            refuse_broad_grant(Path::new(r"C:\"), &profile, &roots)
                .unwrap_err()
                .code,
            "FOLDER_TOO_BROAD"
        );
    }
}
