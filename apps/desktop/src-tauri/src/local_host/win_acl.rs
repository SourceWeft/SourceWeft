//! Ancestor traversal grants for the Windows sandbox account.
//!
//! # Why this exists
//!
//! The sandbox runs commands as a separate local account (`sourceweft-sandbox`). That account holds
//! the srt grants on the workspace itself and nothing else inside the user's profile (the profile
//! is deliberately not granted, decision W3). But programs resolve the path they are started in:
//! Node's `realpathSync` calls `lstat` on *every ancestor* of a script, Git `stat`s the workspace's
//! parents. Under the profile (`...\AppData\Local\Temp\x` in CI, `%APPDATA%\<app>\task-workspaces\<id>`
//! in production) those ancestors are readable by nobody but the user, so a sandboxed
//! `node <script in the workspace>` died with `EPERM: operation not permitted, lstat
//! 'C:\Users\runneradmin\AppData'` and `git` with `failed to stat '<workspace>': Permission denied`.
//!
//! # What is granted
//!
//! Before a Windows sandbox instance starts for a workspace root, the sandbox account gets one
//! **non-inheriting** allow ACE ("this folder only", `NO_INHERIT_ACE`) on every *strict ancestor
//! directory of the workspace root and of each read root that lies inside the user's profile*, the
//! profile directory included. The drive root, `C:\Users` and anything outside the profile are
//! readable by default and are not touched. The mask is
//! `FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE`: no `FILE_LIST_DIRECTORY`
//! (the account cannot list the directory, so it learns no sibling names), no file read, nothing
//! inherited by children. This is the shape srt-win itself uses for the pass-through directories of
//! its optional profile grant (`Mask::DIR_LIST`/`NO_INHERIT` in `acl.rs`), which this app never runs.
//!
//! What it exposes: that each of those directories exists and its attributes and security
//! descriptor (`READ_CONTROL`), to the sandbox account. Not names of other entries, not contents.
//!
//! # How it is written
//!
//! The host (the owner of its own profile subtree) writes these DACLs without elevation. The DACL is
//! never replaced wholesale and the protection flags are never changed: the directory is opened
//! (never following a reparse point, which is refused), its DACL is read, one ACE is inserted at the
//! canonical position, and the result is written back with `SetKernelObjectSecurity`, carrying the
//! descriptor's `SE_DACL_PROTECTED` and `SE_DACL_AUTO_INHERITED` marks over unchanged. That call
//! writes the object alone: `SetNamedSecurityInfoW` would also walk the whole tree below `AppData`.
//! An ACE the account already effectively has (ours from an earlier run, or one inherited from a
//! parent) is not added again, so a second call is a no-op.
//!
//! # Revocation
//!
//! What was added is recorded in `<app data>/sandbox/ancestor-grants.json` (written atomically,
//! *before* the DACL is touched) so that [`revoke_ancestor_traversal`] removes exactly those ACEs
//! (same trustee SID, mask and flags) and nothing else; it is called when the sandbox is uninstalled.
//! The record stores the SID itself, so revocation still works after the account was deleted.
//!
//! The ACL parsing, the grant/revoke decisions, the ancestor computation and the record format are
//! pure and tested on every OS against an in-memory model of the directory DACLs; only
//! [`WindowsDirAcls`] and the account lookup touch the machine.
#![cfg_attr(not(windows), allow(dead_code))]

use super::{winpath, HostError, Result};
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// The local account the namespaced srt-win provisions (fixed at build time in the fork).
pub(crate) const SANDBOX_ACCOUNT: &str = "sourceweft-sandbox";

const FILE_TRAVERSE: u32 = 0x0000_0020;
const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
const READ_CONTROL: u32 = 0x0002_0000;
const SYNCHRONIZE: u32 = 0x0010_0000;
/// What the sandbox account is granted on an ancestor directory.
pub(crate) const TRAVERSE_MASK: u32 = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;

const NO_INHERIT_ACE: u8 = 0x04;
const INHERIT_ONLY_ACE: u8 = 0x08;
const INHERITED_ACE: u8 = 0x10;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
const ACCESS_DENIED_OBJECT_ACE_TYPE: u8 = 6;
const ACCESS_DENIED_CALLBACK_ACE_TYPE: u8 = 10;
const ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE: u8 = 12;
const ACL_REVISION: u8 = 2;
const ACL_HEADER: usize = 8;

// ---------------------------------------------------------------------------------------------
// The ACL as bytes
// ---------------------------------------------------------------------------------------------

/// One access-control entry, as its raw bytes (`ACE_HEADER` + body).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Ace(Vec<u8>);

/// A DACL: its revision and its entries, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Acl {
    pub revision: u8,
    pub aces: Vec<Ace>,
}

impl Ace {
    fn kind(&self) -> u8 {
        self.0[0]
    }

    fn flags(&self) -> u8 {
        self.0[1]
    }

    /// The mask and trustee SID of a plain allow or deny entry. Other entry types (object,
    /// callback, audit) are opaque to this module: never matched, always kept.
    fn plain(&self) -> Option<(u32, &[u8])> {
        if !matches!(self.kind(), ACCESS_ALLOWED_ACE_TYPE | ACCESS_DENIED_ACE_TYPE) || self.0.len() < 16 {
            return None;
        }
        let mask = u32::from_le_bytes(self.0[4..8].try_into().ok()?);
        let sid_len = 8 + 4 * usize::from(self.0[9]);
        let sid = self.0.get(8..8 + sid_len)?;
        Some((mask, sid))
    }

    /// An explicit entry (not inherited from the parent) that denies.
    fn is_explicit_deny(&self) -> bool {
        self.flags() & INHERITED_ACE == 0
            && matches!(
                self.kind(),
                ACCESS_DENIED_ACE_TYPE
                    | ACCESS_DENIED_OBJECT_ACE_TYPE
                    | ACCESS_DENIED_CALLBACK_ACE_TYPE
                    | ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE
            )
    }
}

/// Parses the bytes of an `ACL` structure (header, then `AceCount` entries).
pub(crate) fn parse_acl(bytes: &[u8]) -> std::result::Result<Acl, String> {
    if bytes.len() < ACL_HEADER {
        return Err("the ACL is shorter than its header".into());
    }
    let size = usize::from(u16::from_le_bytes([bytes[2], bytes[3]]));
    let count = usize::from(u16::from_le_bytes([bytes[4], bytes[5]]));
    if size < ACL_HEADER || size > bytes.len() {
        return Err("the ACL size is inconsistent".into());
    }
    let mut aces = Vec::with_capacity(count);
    let mut offset = ACL_HEADER;
    for index in 0..count {
        if offset + 4 > size {
            return Err(format!("entry {index} lies outside the ACL"));
        }
        let ace_size = usize::from(u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]));
        if ace_size < 4 || offset + ace_size > size {
            return Err(format!("entry {index} has an inconsistent size"));
        }
        aces.push(Ace(bytes[offset..offset + ace_size].to_vec()));
        offset += ace_size;
    }
    Ok(Acl {
        revision: bytes[0],
        aces,
    })
}

/// The bytes of `acl` as an `ACL` structure.
pub(crate) fn build_acl(acl: &Acl) -> std::result::Result<Vec<u8>, String> {
    let total = ACL_HEADER + acl.aces.iter().map(|ace| ace.0.len()).sum::<usize>();
    let size = u16::try_from(total).map_err(|_| "the access list would exceed 64 KiB".to_string())?;
    let count = u16::try_from(acl.aces.len()).map_err(|_| "too many entries".to_string())?;
    let mut bytes = Vec::with_capacity(total);
    bytes.extend_from_slice(&[acl.revision, 0]);
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.extend_from_slice(&count.to_le_bytes());
    bytes.extend_from_slice(&[0, 0]);
    for ace in &acl.aces {
        bytes.extend_from_slice(&ace.0);
    }
    Ok(bytes)
}

fn valid_sid(sid: &[u8]) -> bool {
    sid.len() >= 8 && sid[0] == 1 && sid.len() == 8 + 4 * usize::from(sid[1])
}

/// The grant: an allow entry for `sid` with [`TRAVERSE_MASK`] that children do not inherit.
fn traversal_ace(sid: &[u8]) -> std::result::Result<Ace, String> {
    if !valid_sid(sid) {
        return Err("the sandbox account's SID is malformed".into());
    }
    let size = u16::try_from(8 + sid.len()).map_err(|_| "SID too long".to_string())?;
    let mut bytes = vec![ACCESS_ALLOWED_ACE_TYPE, NO_INHERIT_ACE];
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.extend_from_slice(&TRAVERSE_MASK.to_le_bytes());
    bytes.extend_from_slice(sid);
    Ok(Ace(bytes))
}

/// Whether `acl` already lets `sid` traverse the directory it belongs to: an allow entry for
/// that SID covering [`TRAVERSE_MASK`] that applies to the object itself (not inherit-only). Ours
/// from an earlier run qualifies, and so does anything else that gives the account the same.
pub(crate) fn grants_traversal(acl: &Acl, sid: &[u8]) -> bool {
    acl.aces.iter().any(|ace| {
        ace.kind() == ACCESS_ALLOWED_ACE_TYPE
            && ace.flags() & INHERIT_ONLY_ACE == 0
            && ace
                .plain()
                .is_some_and(|(mask, trustee)| trustee == sid && mask & TRAVERSE_MASK == TRAVERSE_MASK)
    })
}

/// Where a new explicit allow entry goes to keep the DACL in canonical order: after the explicit
/// deny entries, before the other explicit allows and the inherited entries.
fn insert_index(acl: &Acl) -> usize {
    acl.aces
        .iter()
        .position(|ace| !ace.is_explicit_deny())
        .unwrap_or(acl.aces.len())
}

/// `acl` with the traversal entry for `sid` inserted; `None` when `sid` already has it.
pub(crate) fn add_traversal(acl: &Acl, sid: &[u8]) -> std::result::Result<Option<Acl>, String> {
    if grants_traversal(acl, sid) {
        return Ok(None);
    }
    let ace = traversal_ace(sid)?;
    let mut next = acl.clone();
    next.revision = next.revision.max(ACL_REVISION);
    next.aces.insert(insert_index(acl), ace);
    Ok(Some(next))
}

/// `acl` without the entries that are exactly `(allow, sid, mask, flags)`; `None` when there are
/// none. Every other entry — including any other entry of the same trustee — is kept as it is.
pub(crate) fn remove_exact(acl: &Acl, sid: &[u8], mask: u32, flags: u8) -> Option<Acl> {
    let ours = |ace: &Ace| {
        ace.kind() == ACCESS_ALLOWED_ACE_TYPE
            && ace.flags() == flags
            && ace.plain().is_some_and(|(m, trustee)| m == mask && trustee == sid)
    };
    if !acl.aces.iter().any(ours) {
        return None;
    }
    Some(Acl {
        revision: acl.revision,
        aces: acl.aces.iter().filter(|ace| !ours(ace)).cloned().collect(),
    })
}

/// The groups every account of this kind belongs to: `Everyone`, `Authenticated Users` and
/// `BUILTIN\Users`. (The sandbox account is a member of all three.)
fn well_known_groups() -> [Vec<u8>; 3] {
    [
        vec![1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
        vec![1, 1, 0, 0, 0, 0, 0, 5, 11, 0, 0, 0],
        vec![1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 33, 2, 0, 0],
    ]
}

/// Whether `sid` can traverse the directory `acl` belongs to through the account's own entries or
/// through `Everyone`, `Authenticated Users` or `Users`: the allow entries that apply to the
/// directory itself together cover [`TRAVERSE_MASK`], and no applicable deny entry of those
/// trustees touches it. This is how a directory whose access list this app may not change (for
/// example one owned by someone else) can still be fine: it already admits the account.
pub(crate) fn effective_via_groups(acl: &Acl, sid: &[u8]) -> bool {
    let mut trustees = well_known_groups().to_vec();
    trustees.push(sid.to_vec());
    let mut allowed = 0u32;
    for ace in &acl.aces {
        if ace.flags() & INHERIT_ONLY_ACE != 0 {
            continue;
        }
        let Some((mask, trustee)) = ace.plain() else { continue };
        if !trustees.iter().any(|known| known == trustee) {
            continue;
        }
        match ace.kind() {
            ACCESS_DENIED_ACE_TYPE if mask & TRAVERSE_MASK != 0 => return false,
            ACCESS_ALLOWED_ACE_TYPE => allowed |= mask,
            _ => {}
        }
    }
    allowed & TRAVERSE_MASK == TRAVERSE_MASK
}

/// `IO_REPARSE_TAG_*` values carry the "name surrogate" bit (`0x2000_0000`) when the entry names
/// another file system object: symbolic links and mount points/junctions. Cloud placeholders
/// (OneDrive and the like, tags `0x9000_001A` and `0x9000_xxxx`), deduplication and WSL entries
/// do not: they are ordinary folders as far as paths go.
const REPARSE_NAME_SURROGATE: u32 = 0x2000_0000;
const FILE_ATTRIBUTE_REPARSE: u32 = 0x0000_0400;

/// Whether a directory with these attributes and reparse tag redirects elsewhere (a link or
/// junction), which this module refuses to change. A cloud placeholder is not one.
pub(crate) fn redirects_elsewhere(attributes: u32, reparse_tag: u32) -> bool {
    attributes & FILE_ATTRIBUTE_REPARSE != 0 && reparse_tag & REPARSE_NAME_SURROGATE != 0
}

// ---------------------------------------------------------------------------------------------
// Which directories
// ---------------------------------------------------------------------------------------------

/// The strict ancestors of `target` that lie inside (or are) `profile`, outermost first. Drive root,
/// `C:\Users` and anything outside the profile are not returned. `target` itself is not either: it
/// carries its own srt grant. Empty when `target` is not a drive path or not inside the profile.
pub(crate) fn ancestor_directories(target: &Path, profile: &Path) -> Vec<PathBuf> {
    let Ok(wire) = winpath::to_wire(target) else {
        return Vec::new();
    };
    let segments: Vec<&str> = wire[3..].split('/').filter(|s| !s.is_empty()).collect();
    let drive = &wire[..2];
    (1..segments.len())
        .map(|k| PathBuf::from(format!("{drive}\\{}", segments[..k].join("\\"))))
        .filter(|candidate| winpath::is_inside(candidate, profile))
        .collect()
}

/// The ancestor directories of every path in `targets`, each once (compared like Windows does),
/// outermost first.
pub(crate) fn ancestors_of_all(targets: &[PathBuf], profile: &Path) -> Vec<PathBuf> {
    let mut all: Vec<PathBuf> = Vec::new();
    for target in targets {
        for directory in ancestor_directories(target, profile) {
            if !all.iter().any(|seen| winpath::same_path(seen, &directory)) {
                all.push(directory);
            }
        }
    }
    all.sort_by_key(|directory| directory.to_string_lossy().matches('\\').count());
    all
}

// ---------------------------------------------------------------------------------------------
// The record of what was added
// ---------------------------------------------------------------------------------------------

const RECORD_VERSION: u32 = 1;

/// One ACE this module added.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RecordedGrant {
    pub path: String,
    /// The trustee SID, as hex of its binary form.
    pub sid: String,
    pub mask: u32,
    pub flags: u8,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct GrantRecord {
    pub version: u32,
    pub grants: Vec<RecordedGrant>,
}

/// Where the record lives for a host whose app data is `base`.
pub(crate) fn record_path(base: &Path) -> PathBuf {
    base.join("sandbox").join("ancestor-grants.json")
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

/// The record at `path`; an absent file is an empty record. A file that cannot be read or does
/// not parse is an error (never silently replaced: it says which ACEs to remove).
pub(crate) fn read_record(path: &Path) -> std::result::Result<GrantRecord, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(GrantRecord {
                version: RECORD_VERSION,
                grants: Vec::new(),
            })
        }
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let record: GrantRecord =
        serde_json::from_str(&text).map_err(|error| format!("{} is not valid: {error}", path.display()))?;
    if record.version != RECORD_VERSION {
        return Err(format!(
            "{} has version {}, this app writes version {RECORD_VERSION}",
            path.display(),
            record.version
        ));
    }
    Ok(record)
}

/// Writes `record` to `path` atomically (a temporary file in the same folder, then a rename), or
/// removes the file when there is nothing left to record.
pub(crate) fn write_record(path: &Path, record: &GrantRecord) -> std::result::Result<(), String> {
    if record.grants.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("{}: {error}", path.display())),
        };
    }
    let parent = path.parent().ok_or("the record has no folder")?;
    std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    let text = serde_json::to_string_pretty(record).map_err(|error| error.to_string())?;
    let staged = parent.join(format!(".ancestor-grants-{}.tmp", uuid::Uuid::new_v4()));
    let outcome = std::fs::write(&staged, text).and_then(|()| std::fs::rename(&staged, path));
    if let Err(error) = outcome {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("{}: {error}", path.display()));
    }
    Ok(())
}

fn same_grant(a: &RecordedGrant, b: &RecordedGrant) -> bool {
    a.sid == b.sid
        && a.mask == b.mask
        && a.flags == b.flags
        && winpath::same_path(Path::new(&a.path), Path::new(&b.path))
}

// ---------------------------------------------------------------------------------------------
// Reading and writing a directory's DACL, and the two operations on top
// ---------------------------------------------------------------------------------------------

/// Why a directory's DACL could not be changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AclError {
    /// The directory is gone.
    Missing,
    /// Windows refused this app permission to change the directory's access list (`WRITE_DAC`).
    Denied(String),
    Failed(String),
}

impl std::fmt::Display for AclError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AclError::Missing => write!(f, "the directory does not exist"),
            AclError::Denied(reason) | AclError::Failed(reason) => write!(f, "{reason}"),
        }
    }
}

/// What a caller does to a DACL: sees the current one (`None` for a NULL DACL) and returns the
/// replacement, or `None` to leave it alone.
pub(crate) type AclChange<'a> =
    &'a mut dyn FnMut(Option<&Acl>) -> std::result::Result<Option<Acl>, String>;

/// The directory DACLs: a read that needs only `READ_CONTROL`, and an atomic read-modify-write
/// per directory that additionally needs `WRITE_DAC`.
pub(crate) trait DirAcls {
    /// Opens `dir` (a directory; a link or junction is refused, a cloud placeholder is not) for
    /// reading and returns its DACL (`None` for a NULL DACL, which already admits everyone). Never
    /// asks for permission to change anything.
    fn read(&self, dir: &Path) -> std::result::Result<Option<Acl>, AclError>;

    /// Opens `dir` (a directory, not a reparse point), reads its DACL (`None` for a NULL DACL,
    /// which already admits everyone), and passes it to `change`. `Ok(None)` from `change` leaves
    /// the directory alone; `Ok(Some(acl))` is written back with the descriptor's protection
    /// marks unchanged. Returns whether anything was written.
    fn modify(
        &self,
        dir: &Path,
        change: AclChange<'_>,
    ) -> std::result::Result<bool, AclError>;
}

/// Serialises every read-modify-write of a directory DACL and of the record in this process, so two
/// workspaces starting at once cannot interleave on a shared ancestor.
static ACL_LOCK: Mutex<()> = Mutex::new(());

fn lock_acls() -> std::sync::MutexGuard<'static, ()> {
    ACL_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Gives `sid` the traversal entry on each of `dirs` that does not have it, recording each new
/// entry first. Returns the directories that were changed.
pub(crate) fn ensure_with(
    store: &dyn DirAcls,
    record_file: &Path,
    sid: &[u8],
    dirs: &[PathBuf],
) -> std::result::Result<Vec<PathBuf>, String> {
    let _guard = lock_acls();
    let mut missing: Vec<&PathBuf> = Vec::new();
    // Read-only first pass: needs READ_CONTROL only, so a directory this app may not change is
    // not a problem unless it actually needs the entry.
    for dir in dirs {
        let needed = match store
            .read(dir)
            .map_err(|error| format!("{}: {error}", dir.display()))?
        {
            Some(acl) => add_traversal(&acl, sid)?.is_some() && !effective_via_groups(&acl, sid),
            None => false,
        };
        if needed {
            missing.push(dir);
        }
    }
    if missing.is_empty() {
        return Ok(Vec::new());
    }
    // Record before touching any DACL: a crash in between leaves a record entry whose ACE does
    // not exist, which revocation treats as already done; the other order would leak an ACE.
    let mut record = read_record(record_file)?;
    for dir in &missing {
        let grant = RecordedGrant {
            path: dir.to_string_lossy().into_owned(),
            sid: to_hex(sid),
            mask: TRAVERSE_MASK,
            flags: NO_INHERIT_ACE,
        };
        if !record.grants.iter().any(|known| same_grant(known, &grant)) {
            record.grants.push(grant);
        }
    }
    record.version = RECORD_VERSION;
    write_record(record_file, &record)?;
    let mut changed = Vec::new();
    for dir in missing {
        let outcome = store.modify(dir, &mut |acl| match acl {
            Some(acl) => add_traversal(acl, sid),
            None => Ok(None),
        });
        match outcome {
            Ok(true) => changed.push(dir.clone()),
            Ok(false) => {}
            // Windows will not let this app change the list. Fine if the account is admitted by
            // the entries that are there; otherwise fail closed and say what to do.
            Err(AclError::Denied(reason)) => {
                let admitted = matches!(
                    store.read(dir),
                    Ok(Some(ref acl)) if effective_via_groups(acl, sid) || grants_traversal(acl, sid)
                );
                if !admitted {
                    return Err(format!(
                        "{}: {reason}. The sandbox account ({SANDBOX_ACCOUNT}) must be able to traverse this \
                         folder to run programs from the workspace below it, and this app may not change its \
                         permissions. Give {SANDBOX_ACCOUNT} (or the Users group) read and traverse access to \
                         the folder, or choose a working folder elsewhere.",
                        dir.display()
                    ));
                }
            }
            Err(error) => return Err(format!("{}: {error}", dir.display())),
        }
    }
    Ok(changed)
}

/// What [`revoke_with`] did.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RevokeReport {
    /// ACE removals made (directories that no longer exist count as done, and are not counted here).
    pub removed: usize,
    /// One message per grant that could not be removed; these stay in the record.
    pub failed: Vec<String>,
}

/// Removes every entry the record lists, and nothing else, then rewrites the record with whatever
/// could not be removed (deleting it when nothing is left).
pub(crate) fn revoke_with(store: &dyn DirAcls, record_file: &Path) -> RevokeReport {
    let _guard = lock_acls();
    let mut report = RevokeReport::default();
    let record = match read_record(record_file) {
        Ok(record) => record,
        Err(error) => {
            report.failed.push(error);
            return report;
        }
    };
    let mut remaining = Vec::new();
    for grant in record.grants {
        let Some(sid) = from_hex(&grant.sid).filter(|sid| valid_sid(sid)) else {
            report
                .failed
                .push(format!("{}: the recorded SID is not valid", grant.path));
            remaining.push(grant);
            continue;
        };
        let outcome = store.modify(Path::new(&grant.path), &mut |acl| {
            Ok(acl.and_then(|acl| remove_exact(acl, &sid, grant.mask, grant.flags)))
        });
        match outcome {
            Ok(true) => report.removed += 1,
            Ok(false) | Err(AclError::Missing) => {}
            Err(AclError::Failed(reason) | AclError::Denied(reason)) => {
                report.failed.push(format!("{}: {reason}", grant.path));
                remaining.push(grant);
            }
        }
    }
    let rewritten = GrantRecord {
        version: RECORD_VERSION,
        grants: remaining,
    };
    if let Err(error) = write_record(record_file, &rewritten) {
        report.failed.push(error);
    }
    report
}

/// The readiness-style error for a machine whose sandbox account does not exist.
fn not_installed() -> HostError {
    HostError::new(
        "SANDBOX_UNAVAILABLE",
        format!(
            "[not_provisioned] The sandbox account ({SANDBOX_ACCOUNT}) does not exist on this computer."
        ),
    )
}

/// Grants the sandbox account traversal of the profile directories above `targets` (the workspace
/// root and the read roots) through `store`, with the account's SID given by `sid`. `None` is a
/// machine without the account: the sandbox is not installed, which fails closed.
pub(crate) fn ensure_for(
    store: &dyn DirAcls,
    base: &Path,
    profile: &Path,
    targets: &[PathBuf],
    sid: Option<&[u8]>,
) -> Result<()> {
    let sid = sid.ok_or_else(not_installed)?;
    let dirs = ancestors_of_all(targets, profile);
    ensure_with(store, &record_path(base), sid, &dirs).map(drop).map_err(|reason| {
        HostError::new(
            "SANDBOX_GRANT_FAILED",
            format!(
                "The sandbox account could not be given access to the folders leading to the \
                 workspace: {reason}"
            ),
        )
    })
}

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------

/// Ensures the sandbox account can traverse every profile directory above the workspace `root` and
/// the `read_roots` (see the module doc). Idempotent; a missing account is
/// `SANDBOX_UNAVAILABLE` `[not_provisioned]`, a directory whose DACL cannot be written is
/// `SANDBOX_GRANT_FAILED` naming it.
#[cfg(windows)]
pub(crate) fn ensure_ancestor_traversal(
    base: &Path,
    profile: &Path,
    targets: &[PathBuf],
) -> Result<()> {
    let sid = win::sandbox_account_sid().map_err(|lookup| match lookup {
        win::SidLookup::NotFound => not_installed(),
        win::SidLookup::Failed(reason) => HostError::new(
            "SANDBOX_UNAVAILABLE",
            format!("The sandbox account could not be looked up: {reason}"),
        ),
    })?;
    ensure_for(&win::WindowsDirAcls, base, profile, targets, Some(&sid))
}

/// Removes the entries [`ensure_ancestor_traversal`] added, as the record lists them. Works after
/// the account was deleted (the record holds its SID).
#[cfg(windows)]
pub(crate) fn revoke_ancestor_traversal(base: &Path) -> RevokeReport {
    revoke_with(&win::WindowsDirAcls, &record_path(base))
}

#[cfg(windows)]
impl super::LocalHost {
    /// Removes the ancestor traversal entries this host added ([`revoke_ancestor_traversal`]).
    /// Entries that could not be removed stay recorded, so a later call finishes the job; they are
    /// reported, never ignored.
    pub fn revoke_ancestor_grants(&self) -> std::result::Result<(), String> {
        let report = revoke_ancestor_traversal(&self.base);
        if report.failed.is_empty() {
            return Ok(());
        }
        Err(format!(
            "The sandbox was removed, but its access to {} folder(s) above your workspaces could \
             not be taken back: {}",
            report.failed.len(),
            report.failed.join("; ")
        ))
    }
}

#[cfg(windows)]
pub(crate) mod win {
    use super::{build_acl, parse_acl, Acl, AclError, DirAcls, SANDBOX_ACCOUNT};
    use std::{
        mem::zeroed,
        os::windows::{
            fs::OpenOptionsExt,
            io::AsRawHandle,
        },
        path::Path,
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{
            LocalFree, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER,
            ERROR_NONE_MAPPED, ERROR_PATH_NOT_FOUND, HANDLE,
        },
        Security::{
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
            GetSecurityDescriptorControl, InitializeSecurityDescriptor, IsValidAcl,
            LookupAccountNameW, SetKernelObjectSecurity, SetSecurityDescriptorControl,
            SetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            SECURITY_DESCRIPTOR, SE_DACL_AUTO_INHERITED, SE_DACL_AUTO_INHERIT_REQ,
            SE_DACL_PROTECTED, SidTypeUser,
        },
        Storage::FileSystem::{
            FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            READ_CONTROL, WRITE_DAC,
        },
    };

    /// The result of looking the sandbox account up.
    pub(crate) enum SidLookup {
        NotFound,
        Failed(String),
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// The binary SID of the local sandbox account.
    pub(crate) fn sandbox_account_sid() -> std::result::Result<Vec<u8>, SidLookup> {
        let name = wide(SANDBOX_ACCOUNT);
        let mut sid_len = 0u32;
        let mut domain_len = 0u32;
        let mut kind = 0i32;
        // SAFETY: the first call only asks for the buffer sizes (null buffers, zero lengths).
        let sized = unsafe {
            LookupAccountNameW(
                ptr::null(),
                name.as_ptr(),
                ptr::null_mut(),
                &mut sid_len,
                ptr::null_mut(),
                &mut domain_len,
                &mut kind,
            )
        };
        let error = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
        if sized != 0 || error != ERROR_INSUFFICIENT_BUFFER {
            return Err(if error == ERROR_NONE_MAPPED {
                SidLookup::NotFound
            } else {
                SidLookup::Failed(format!("LookupAccountNameW failed (os error {error})"))
            });
        }
        let mut sid = vec![0u8; sid_len as usize];
        let mut domain = vec![0u16; domain_len as usize];
        // SAFETY: the buffers have the sizes the first call asked for.
        let found = unsafe {
            LookupAccountNameW(
                ptr::null(),
                name.as_ptr(),
                sid.as_mut_ptr().cast(),
                &mut sid_len,
                domain.as_mut_ptr(),
                &mut domain_len,
                &mut kind,
            )
        };
        if found == 0 {
            let error = std::io::Error::last_os_error();
            return Err(if error.raw_os_error() == Some(ERROR_NONE_MAPPED as i32) {
                SidLookup::NotFound
            } else {
                SidLookup::Failed(error.to_string())
            });
        }
        if kind != SidTypeUser {
            return Err(SidLookup::Failed(format!(
                "{SANDBOX_ACCOUNT} resolves to something other than a user account"
            )));
        }
        sid.truncate(sid_len as usize);
        Ok(sid)
    }

    /// `LocalFree`s a descriptor `GetSecurityInfo` allocated.
    struct LocalAllocation(PSECURITY_DESCRIPTOR);

    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: the pointer came from GetSecurityInfo, which allocates with LocalAlloc.
                unsafe { LocalFree(self.0) };
            }
        }
    }

    fn failed(context: &str, error: impl std::fmt::Display) -> AclError {
        AclError::Failed(format!("{context}: {error}"))
    }

    fn win32(context: &str, code: u32) -> AclError {
        failed(context, std::io::Error::from_raw_os_error(code as i32))
    }

    /// The DACL of an open object and the marks of its descriptor.
    fn read_dacl(handle: HANDLE) -> std::result::Result<(Option<Acl>, u16), AclError> {
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: `handle` is a valid open handle with READ_CONTROL; the out pointers are valid.
        let code = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if code != 0 {
            return Err(win32("GetSecurityInfo", code));
        }
        let _free = LocalAllocation(descriptor);
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: `descriptor` is the valid descriptor just returned.
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            return Err(failed("GetSecurityDescriptorControl", std::io::Error::last_os_error()));
        }
        if dacl.is_null() {
            return Ok((None, control));
        }
        // SAFETY: a non-null DACL pointer returned by GetSecurityInfo points into `descriptor`.
        if unsafe { IsValidAcl(dacl) } == 0 {
            return Err(AclError::Failed("the directory's access list is not valid".into()));
        }
        // SAFETY: the ACL is valid, so its header's AclSize bytes are readable.
        let size = unsafe { u16::from_le_bytes([*dacl.cast::<u8>().add(2), *dacl.cast::<u8>().add(3)]) };
        // SAFETY: as above.
        let bytes = unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), usize::from(size)) };
        let acl = parse_acl(bytes).map_err(AclError::Failed)?;
        Ok((Some(acl), control))
    }

    const KEPT_MARKS: u16 = SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED;

    /// Writes `acl` as the DACL of `handle`, on that object alone, carrying the descriptor's
    /// protection and auto-inheritance marks over (`control` is what was read).
    fn write_dacl(handle: HANDLE, acl: &Acl, control: u16) -> std::result::Result<(), AclError> {
        let bytes = build_acl(acl).map_err(AclError::Failed)?;
        // ACLs must be DWORD-aligned.
        let mut aligned = vec![0u32; bytes.len().div_ceil(4)];
        // SAFETY: `aligned` has at least `bytes.len()` bytes.
        unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), aligned.as_mut_ptr().cast::<u8>(), bytes.len()) };
        // SAFETY: a zeroed SECURITY_DESCRIPTOR is storage for InitializeSecurityDescriptor.
        let mut storage: SECURITY_DESCRIPTOR = unsafe { zeroed() };
        let descriptor = (&mut storage as *mut SECURITY_DESCRIPTOR).cast();
        let mut set = control & KEPT_MARKS;
        if control & SE_DACL_AUTO_INHERITED != 0 {
            // The system keeps the auto-inherited mark only when the descriptor asks for it.
            set |= SE_DACL_AUTO_INHERIT_REQ;
        }
        // SAFETY: `descriptor` points to `storage`; `aligned` holds a valid ACL and outlives the
        // calls; `handle` is a valid handle with WRITE_DAC.
        unsafe {
            if InitializeSecurityDescriptor(descriptor, 1) == 0 {
                return Err(failed("InitializeSecurityDescriptor", std::io::Error::last_os_error()));
            }
            if SetSecurityDescriptorDacl(descriptor, 1, aligned.as_ptr().cast::<ACL>(), 0) == 0 {
                return Err(failed("SetSecurityDescriptorDacl", std::io::Error::last_os_error()));
            }
            if SetSecurityDescriptorControl(
                descriptor,
                SE_DACL_AUTO_INHERIT_REQ | SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED,
                set,
            ) == 0
            {
                return Err(failed("SetSecurityDescriptorControl", std::io::Error::last_os_error()));
            }
            if SetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION, descriptor) == 0 {
                let error = std::io::Error::last_os_error();
                return Err(if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                    AclError::Denied("Windows refused permission to change its access list".into())
                } else {
                    failed("SetKernelObjectSecurity", error)
                });
            }
        }
        Ok(())
    }

    /// The real directory DACLs.
    pub(crate) struct WindowsDirAcls;

    /// Opens the directory itself (never what a final reparse point points at) with
    /// `READ_CONTROL`, and with `WRITE_DAC` too when `write`. A link or junction is refused; a
    /// cloud placeholder (a reparse point that names no other object) is an ordinary folder.
    fn open_directory(dir: &Path, write: bool) -> std::result::Result<std::fs::File, AclError> {
        let access = FILE_READ_ATTRIBUTES | READ_CONTROL | if write { WRITE_DAC } else { 0 };
        let file = std::fs::OpenOptions::new()
            .access_mode(access)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(dir)
            .map_err(|error| match error.raw_os_error().map(|code| code as u32) {
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) => AclError::Missing,
                Some(ERROR_ACCESS_DENIED) if write => {
                    AclError::Denied("Windows refused permission to change its access list".into())
                }
                _ => failed("open", error),
            })?;
        let mut tag: FILE_ATTRIBUTE_TAG_INFO = unsafe { zeroed() };
        // SAFETY: `file` owns a valid handle opened with FILE_READ_ATTRIBUTES; `tag` is a
        // correctly sized, writable FILE_ATTRIBUTE_TAG_INFO.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as HANDLE,
                FileAttributeTagInfo,
                (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(failed("attributes", std::io::Error::last_os_error()));
        }
        if super::redirects_elsewhere(tag.FileAttributes, tag.ReparseTag) {
            return Err(AclError::Failed(format!(
                "it is a link or junction (reparse tag {:#x}); refusing to change it",
                tag.ReparseTag
            )));
        }
        if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(AclError::Failed("it is not a directory".into()));
        }
        Ok(file)
    }

    impl DirAcls for WindowsDirAcls {
        fn read(&self, dir: &Path) -> std::result::Result<Option<Acl>, AclError> {
            let file = open_directory(dir, false)?;
            Ok(read_dacl(file.as_raw_handle() as HANDLE)?.0)
        }

        fn modify(
            &self,
            dir: &Path,
            change: super::AclChange<'_>,
        ) -> std::result::Result<bool, AclError> {
            let file = open_directory(dir, true)?;
            let handle = file.as_raw_handle() as HANDLE;
            let (current, control) = read_dacl(handle)?;
            let Some(next) = change(current.as_ref()).map_err(AclError::Failed)? else {
                return Ok(false);
            };
            write_dacl(handle, &next, control)?;
            // Whatever the system did to the marks, it must not have changed inheritance.
            let (_, after) = read_dacl(handle)?;
            if after & KEPT_MARKS != control & KEPT_MARKS {
                return Err(AclError::Failed(
                    "writing the access list changed the directory's inheritance state".into(),
                ));
            }
            Ok(true)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// A SID `S-1-5-<subs...>`.
    fn sid(subs: &[u32]) -> Vec<u8> {
        let mut bytes = vec![1, subs.len() as u8, 0, 0, 0, 0, 0, 5];
        for sub in subs {
            bytes.extend_from_slice(&sub.to_le_bytes());
        }
        bytes
    }

    fn ace(kind: u8, flags: u8, mask: u32, sid: &[u8]) -> Ace {
        let mut bytes = vec![kind, flags];
        bytes.extend_from_slice(&((8 + sid.len()) as u16).to_le_bytes());
        bytes.extend_from_slice(&mask.to_le_bytes());
        bytes.extend_from_slice(sid);
        Ace(bytes)
    }

    fn sandbox() -> Vec<u8> {
        sid(&[21, 1, 2, 3, 1001])
    }

    fn admins() -> Vec<u8> {
        sid(&[32, 544])
    }

    fn users() -> Vec<u8> {
        sid(&[32, 545])
    }

    const FULL: u32 = 0x001f_01ff;
    const READ_EXEC: u32 = 0x0012_00a9;

    /// A typical directory under a profile: inherited entries only.
    fn typical() -> Acl {
        Acl {
            revision: 2,
            aces: vec![
                ace(0, INHERITED_ACE | 0x03, FULL, &admins()),
                ace(0, INHERITED_ACE | 0x03, FULL, &sid(&[21, 9, 9, 9, 1000])),
            ],
        }
    }

    #[test]
    fn the_mask_is_traverse_attributes_read_control_and_synchronize_only() {
        assert_eq!(TRAVERSE_MASK, 0x0012_00a0);
        // Not list-directory, add-file, add-subdirectory, either extended-attribute right,
        // delete-child, write-attributes, delete, write-dac or write-owner.
        for forbidden in [0x1, 0x2, 0x4, 0x8, 0x10, 0x40, 0x100, 0x1_0000, 0x4_0000, 0x8_0000] {
            assert_eq!(TRAVERSE_MASK & forbidden, 0, "{forbidden:#x}");
        }
    }

    #[test]
    fn acl_bytes_round_trip() {
        let acl = Acl {
            revision: 2,
            aces: vec![
                ace(1, 0, 0x2, &users()),
                ace(0, NO_INHERIT_ACE, TRAVERSE_MASK, &sandbox()),
                ace(0, INHERITED_ACE, FULL, &admins()),
            ],
        };
        let bytes = build_acl(&acl).unwrap();
        assert_eq!(usize::from(u16::from_le_bytes([bytes[2], bytes[3]])), bytes.len());
        assert_eq!(parse_acl(&bytes).unwrap(), acl);
        // Trailing free space in the buffer is ignored.
        let mut padded = bytes.clone();
        padded.extend_from_slice(&[0; 16]);
        assert_eq!(parse_acl(&padded).unwrap(), acl);
    }

    #[test]
    fn malformed_acls_are_rejected() {
        assert!(parse_acl(&[0; 4]).is_err());
        let mut bytes = build_acl(&typical()).unwrap();
        bytes[4] = 9; // count larger than the entries present
        assert!(parse_acl(&bytes).is_err());
        let mut bytes = build_acl(&typical()).unwrap();
        bytes[2] = 0xff;
        bytes[3] = 0xff; // size beyond the buffer
        assert!(parse_acl(&bytes).is_err());
        let mut bytes = build_acl(&typical()).unwrap();
        bytes[ACL_HEADER + 2] = 2; // entry size smaller than its header
        bytes[ACL_HEADER + 3] = 0;
        assert!(parse_acl(&bytes).is_err());
    }

    #[test]
    fn the_grant_is_one_non_inheriting_allow_entry_for_the_account() {
        let acl = add_traversal(&typical(), &sandbox()).unwrap().expect("added");
        assert_eq!(acl.aces.len(), 3);
        let added = &acl.aces[0];
        assert_eq!(added.kind(), ACCESS_ALLOWED_ACE_TYPE);
        assert_eq!(added.flags(), NO_INHERIT_ACE, "this folder only, explicit");
        let sandbox = sandbox();
        assert_eq!(added.plain(), Some((TRAVERSE_MASK, sandbox.as_slice())));
        // The other entries are untouched, in order.
        assert_eq!(&acl.aces[1..], &typical().aces[..]);
    }

    #[test]
    fn a_second_grant_is_a_no_op() {
        let once = add_traversal(&typical(), &sandbox()).unwrap().unwrap();
        assert_eq!(add_traversal(&once, &sandbox()).unwrap(), None);
    }

    #[test]
    fn what_the_account_already_has_is_enough() {
        // An inheriting entry with a wider mask applies to the object itself.
        let acl = Acl {
            revision: 2,
            aces: vec![ace(0, 0x03, 0x001f_01ff, &sandbox())],
        };
        assert!(grants_traversal(&acl, &sandbox()));
        // An inherited one too.
        let acl = Acl {
            revision: 2,
            aces: vec![ace(0, INHERITED_ACE | 0x03, READ_EXEC | TRAVERSE_MASK, &sandbox())],
        };
        assert!(grants_traversal(&acl, &sandbox()));
        assert_eq!(add_traversal(&acl, &sandbox()).unwrap(), None);
    }

    #[test]
    fn entries_that_do_not_count_as_the_grant() {
        // Inherit-only does not apply to the directory itself.
        let acl = Acl {
            revision: 2,
            aces: vec![ace(0, 0x03 | INHERIT_ONLY_ACE, FULL, &sandbox())],
        };
        assert!(!grants_traversal(&acl, &sandbox()));
        // A narrower mask, another trustee, a deny.
        for entry in [
            ace(0, 0, FILE_TRAVERSE | FILE_READ_ATTRIBUTES, &sandbox()),
            ace(0, 0, FULL, &users()),
            ace(1, 0, FULL, &sandbox()),
        ] {
            let acl = Acl { revision: 2, aces: vec![entry] };
            assert!(!grants_traversal(&acl, &sandbox()));
        }
        // The group the account belongs to is a different trustee: its entry is not ours.
        let acl = Acl {
            revision: 2,
            aces: vec![ace(0, 0, FULL, &sid(&[21, 1, 2, 3, 1002]))],
        };
        assert!(!grants_traversal(&acl, &sandbox()));
    }

    #[test]
    fn the_new_entry_goes_after_explicit_denies_and_before_everything_else() {
        let deny = ace(1, 0, 0x2, &users());
        let explicit_allow = ace(0, 0, FULL, &admins());
        let inherited = ace(0, INHERITED_ACE, FULL, &admins());
        let inherited_deny = ace(1, INHERITED_ACE, 0x2, &users());
        let acl = Acl {
            revision: 2,
            aces: vec![deny.clone(), explicit_allow.clone(), inherited.clone()],
        };
        let next = add_traversal(&acl, &sandbox()).unwrap().unwrap();
        assert_eq!(next.aces[0], deny);
        assert_eq!(next.aces[1].flags(), NO_INHERIT_ACE);
        assert_eq!(&next.aces[2..], &[explicit_allow, inherited][..]);
        // Inherited denies are not "explicit denies": the new entry still comes first.
        let acl = Acl { revision: 2, aces: vec![inherited_deny.clone()] };
        let next = add_traversal(&acl, &sandbox()).unwrap().unwrap();
        assert_eq!(next.aces[0].flags(), NO_INHERIT_ACE);
        assert_eq!(next.aces[1], inherited_deny);
        // An empty DACL (which denies everyone) gets the entry too.
        let next = add_traversal(&Acl { revision: 2, aces: vec![] }, &sandbox()).unwrap().unwrap();
        assert_eq!(next.aces.len(), 1);
    }

    #[test]
    fn the_acl_revision_never_goes_down() {
        let acl = Acl { revision: 4, aces: vec![] };
        assert_eq!(add_traversal(&acl, &sandbox()).unwrap().unwrap().revision, 4);
        let acl = Acl { revision: 0, aces: vec![] };
        assert_eq!(add_traversal(&acl, &sandbox()).unwrap().unwrap().revision, ACL_REVISION);
    }

    #[test]
    fn a_malformed_sid_is_refused() {
        assert!(add_traversal(&typical(), &[1, 2, 3]).is_err());
        assert!(add_traversal(&typical(), &[]).is_err());
    }

    #[test]
    fn revoking_removes_exactly_the_recorded_entry() {
        let theirs = ace(0, 0x03, READ_EXEC, &sandbox());
        let acl = Acl {
            revision: 2,
            aces: vec![
                ace(0, NO_INHERIT_ACE, TRAVERSE_MASK, &sandbox()),
                theirs.clone(),
                ace(0, NO_INHERIT_ACE, TRAVERSE_MASK, &users()),
                ace(0, INHERITED_ACE, FULL, &admins()),
            ],
        };
        let next = remove_exact(&acl, &sandbox(), TRAVERSE_MASK, NO_INHERIT_ACE).unwrap();
        assert_eq!(next.aces.len(), 3);
        assert!(next.aces.contains(&theirs), "another entry of the same account stays");
        assert!(next.aces.contains(&ace(0, NO_INHERIT_ACE, TRAVERSE_MASK, &users())));
        // Nothing to remove: no change.
        assert_eq!(remove_exact(&next, &sandbox(), TRAVERSE_MASK, NO_INHERIT_ACE), None);
        // A different mask or flags is not the recorded entry.
        assert_eq!(remove_exact(&acl, &sandbox(), FULL, NO_INHERIT_ACE), None);
        assert_eq!(remove_exact(&acl, &sandbox(), TRAVERSE_MASK, 0x03), None);
    }

    #[test]
    fn grant_then_revoke_restores_the_original_bytes() {
        let original = Acl {
            revision: 2,
            aces: vec![ace(1, 0, 0x2, &users()), ace(0, INHERITED_ACE | 3, FULL, &admins())],
        };
        let granted = add_traversal(&original, &sandbox()).unwrap().unwrap();
        let back = remove_exact(&granted, &sandbox(), TRAVERSE_MASK, NO_INHERIT_ACE).unwrap();
        assert_eq!(build_acl(&back).unwrap(), build_acl(&original).unwrap());
    }

    // ---- which directories ----

    fn paths(list: Vec<PathBuf>) -> Vec<String> {
        list.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn ancestors_start_at_the_profile_and_stop_before_the_target() {
        let found = ancestor_directories(
            Path::new(r"C:\Users\Me\AppData\Roaming\app\task-workspaces\abc\files"),
            Path::new(r"C:\Users\Me"),
        );
        assert_eq!(
            paths(found),
            [
                r"C:\Users\Me",
                r"C:\Users\Me\AppData",
                r"C:\Users\Me\AppData\Roaming",
                r"C:\Users\Me\AppData\Roaming\app",
                r"C:\Users\Me\AppData\Roaming\app\task-workspaces",
                r"C:\Users\Me\AppData\Roaming\app\task-workspaces\abc",
            ]
        );
    }

    #[test]
    fn nothing_outside_the_profile_is_touched() {
        let profile = Path::new(r"C:\Users\Me");
        for outside in [r"D:\proj\src", r"C:\proj", r"C:\Users\Other\work", r"C:\Users", r"C:\"] {
            assert!(
                ancestor_directories(Path::new(outside), profile).is_empty(),
                "{outside}"
            );
        }
        // A target that is the profile itself or a direct child has no ancestors inside it except
        // the profile.
        assert_eq!(paths(ancestor_directories(Path::new(r"C:\Users\Me\proj"), profile)), [r"C:\Users\Me"]);
        assert!(ancestor_directories(Path::new(r"C:\Users\Me"), profile).is_empty());
        // Relative, UNC and garbage give nothing.
        for bad in ["proj", r"\\server\share\x", ""] {
            assert!(ancestor_directories(Path::new(bad), profile).is_empty(), "{bad:?}");
        }
    }

    #[test]
    fn profile_containment_ignores_case_and_separators() {
        let found = ancestor_directories(
            Path::new(r"c:/users/me/AppData/Local/Temp/x"),
            Path::new(r"C:\Users\ME"),
        );
        assert_eq!(found.len(), 4, "{found:?}");
        assert!(winpath::same_path(&found[0], Path::new(r"C:\Users\Me")));
    }

    #[test]
    fn the_ancestors_of_several_roots_are_merged_once_outermost_first() {
        let profile = Path::new(r"C:\Users\Me");
        let found = ancestors_of_all(
            &[
                PathBuf::from(r"C:\Users\Me\AppData\Local\Temp\ws"),
                PathBuf::from(r"C:\users\me\.cargo\bin"),
                PathBuf::from(r"C:\Users\Me\AppData\Local\Programs\Python\bin"),
                PathBuf::from(r"D:\elsewhere\bin"),
            ],
            profile,
        );
        assert_eq!(
            paths(found),
            [
                r"C:\Users\Me",
                r"C:\Users\Me\AppData",
                r"C:\users\me\.cargo",
                r"C:\Users\Me\AppData\Local",
                r"C:\Users\Me\AppData\Local\Temp",
                r"C:\Users\Me\AppData\Local\Programs",
                r"C:\Users\Me\AppData\Local\Programs\Python",
            ]
        );
    }

    // ---- the record ----

    #[test]
    fn the_record_is_atomic_json_and_an_empty_record_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sandbox").join("ancestor-grants.json");
        assert_eq!(read_record(&file).unwrap().grants, vec![]);
        let record = GrantRecord {
            version: RECORD_VERSION,
            grants: vec![RecordedGrant {
                path: r"C:\Users\Me\AppData".into(),
                sid: to_hex(&sandbox()),
                mask: TRAVERSE_MASK,
                flags: NO_INHERIT_ACE,
            }],
        };
        write_record(&file, &record).unwrap();
        assert_eq!(read_record(&file).unwrap(), record);
        let names: Vec<_> = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["ancestor-grants.json"], "no temporary file is left");
        write_record(&file, &GrantRecord { version: RECORD_VERSION, grants: vec![] }).unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn a_corrupt_or_foreign_record_is_an_error_not_an_empty_one() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("r.json");
        std::fs::write(&file, "not json").unwrap();
        assert!(read_record(&file).unwrap_err().contains("not valid"));
        std::fs::write(&file, r#"{"version":99,"grants":[]}"#).unwrap();
        assert!(read_record(&file).unwrap_err().contains("version 99"));
    }

    #[test]
    fn hex_round_trips_and_rejects_garbage() {
        let bytes = sandbox();
        assert_eq!(from_hex(&to_hex(&bytes)).unwrap(), bytes);
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
        assert_eq!(from_hex("é"), None);
    }

    // ---- ensure / revoke on an in-memory model ----

    /// The DACLs of a set of directories, keyed by lower-cased path.
    #[derive(Default)]
    struct Model {
        dirs: RefCell<HashMap<String, Option<Acl>>>,
        writes: RefCell<Vec<String>>,
        fail_on: RefCell<Option<String>>,
        /// Directories whose access list Windows will not let this app change.
        deny_write: RefCell<Vec<String>>,
        /// Directories `modify` was called for (it needs WRITE_DAC; `read` does not).
        modified: RefCell<Vec<String>>,
    }

    impl Model {
        fn key(path: &Path) -> String {
            path.to_string_lossy().to_lowercase()
        }

        fn with(dirs: &[(&str, Option<Acl>)]) -> Self {
            let model = Model::default();
            for (path, acl) in dirs {
                model.dirs.borrow_mut().insert(Model::key(Path::new(path)), acl.clone());
            }
            model
        }

        fn acl(&self, path: &str) -> Option<Acl> {
            self.dirs.borrow()[&Model::key(Path::new(path))].clone()
        }
    }

    impl DirAcls for Model {
        fn read(&self, dir: &Path) -> std::result::Result<Option<Acl>, AclError> {
            self.dirs.borrow().get(&Model::key(dir)).cloned().ok_or(AclError::Missing)
        }

        fn modify(
            &self,
            dir: &Path,
            change: super::AclChange<'_>,
        ) -> std::result::Result<bool, AclError> {
            let key = Model::key(dir);
            self.modified.borrow_mut().push(key.clone());
            if self.deny_write.borrow().contains(&key) {
                return Err(AclError::Denied("access denied".into()));
            }
            let mut dirs = self.dirs.borrow_mut();
            let Some(current) = dirs.get(&key).cloned() else {
                return Err(AclError::Missing);
            };
            let Some(next) = change(current.as_ref()).map_err(AclError::Failed)? else {
                return Ok(false);
            };
            if self.fail_on.borrow().as_deref() == Some(key.as_str()) {
                return Err(AclError::Failed("access denied".into()));
            }
            self.writes.borrow_mut().push(key.clone());
            dirs.insert(key, Some(next));
            Ok(true)
        }
    }

    const PROFILE: &str = r"C:\Users\Me";
    const WORKSPACE: &str = r"C:\Users\Me\AppData\Local\Temp\ws";

    fn profile_model() -> Model {
        Model::with(&[
            (r"C:\Users\Me", Some(typical())),
            (r"C:\Users\Me\AppData", Some(typical())),
            (r"C:\Users\Me\AppData\Local", Some(typical())),
            (r"C:\Users\Me\AppData\Local\Temp", Some(typical())),
            (r"C:\Users\Me\.cargo", Some(typical())),
            (WORKSPACE, Some(typical())),
        ])
    }

    #[test]
    fn ensure_grants_every_ancestor_inside_the_profile_and_only_those() {
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        ensure_for(
            &model,
            base.path(),
            Path::new(PROFILE),
            &[PathBuf::from(WORKSPACE)],
            Some(&sandbox()),
        )
        .unwrap();
        for dir in [
            r"C:\Users\Me",
            r"C:\Users\Me\AppData",
            r"C:\Users\Me\AppData\Local",
            r"C:\Users\Me\AppData\Local\Temp",
        ] {
            let acl = model.acl(dir).unwrap();
            assert!(grants_traversal(&acl, &sandbox()), "{dir}");
            assert_eq!(acl.aces.len(), 3, "{dir}: one entry added, the rest untouched");
            assert_eq!(&acl.aces[1..], &typical().aces[..], "{dir}");
        }
        // The workspace itself (srt's) and unrelated directories are not touched.
        assert_eq!(model.acl(WORKSPACE), Some(typical()));
        assert_eq!(model.acl(r"C:\Users\Me\.cargo"), Some(typical()));
        assert_eq!(model.writes.borrow().len(), 4);
    }

    #[test]
    fn ensure_twice_writes_nothing_the_second_time() {
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        let run = || {
            ensure_for(&model, base.path(), Path::new(PROFILE), &[PathBuf::from(WORKSPACE)], Some(&sandbox()))
        };
        run().unwrap();
        let writes = model.writes.borrow().len();
        let record = std::fs::read(record_path(base.path())).unwrap();
        run().unwrap();
        assert_eq!(model.writes.borrow().len(), writes, "no DACL was written again");
        assert_eq!(std::fs::read(record_path(base.path())).unwrap(), record);
    }

    #[test]
    fn ensure_records_before_it_writes_and_records_only_what_it_added() {
        let base = tempfile::tempdir().unwrap();
        // The profile already admits the account (an inherited entry): not ours, not recorded.
        let already = Acl {
            revision: 2,
            aces: vec![ace(0, INHERITED_ACE | 3, FULL, &sandbox())],
        };
        let model = Model::with(&[
            (r"C:\Users\Me", Some(already.clone())),
            (r"C:\Users\Me\AppData", Some(typical())),
            (WORKSPACE.rsplit_once('\\').unwrap().0, Some(typical())),
        ]);
        // A write that fails halfway still leaves the entry recorded.
        *model.fail_on.borrow_mut() = Some(r"c:\users\me\appdata".into());
        let error = ensure_for(
            &model,
            base.path(),
            Path::new(PROFILE),
            &[PathBuf::from(r"C:\Users\Me\AppData\ws")],
            Some(&sandbox()),
        )
        .unwrap_err();
        assert_eq!(error.code, "SANDBOX_GRANT_FAILED");
        assert!(error.message.contains(r"C:\Users\Me\AppData"), "{}", error.message);
        let record = read_record(&record_path(base.path())).unwrap();
        assert_eq!(record.grants.len(), 1);
        assert_eq!(record.grants[0].path, r"C:\Users\Me\AppData");
        assert_eq!(model.acl(r"C:\Users\Me"), Some(already));
    }

    #[test]
    fn a_machine_without_the_account_fails_closed_and_touches_nothing() {
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        let error = ensure_for(&model, base.path(), Path::new(PROFILE), &[PathBuf::from(WORKSPACE)], None)
            .unwrap_err();
        assert_eq!(error.code, "SANDBOX_UNAVAILABLE");
        assert!(error.message.starts_with("[not_provisioned]"), "{}", error.message);
        assert!(model.writes.borrow().is_empty());
        assert!(!record_path(base.path()).exists());
    }

    #[test]
    fn a_target_outside_the_profile_needs_no_grant_and_no_record() {
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        ensure_for(&model, base.path(), Path::new(PROFILE), &[PathBuf::from(r"D:\proj\ws")], Some(&sandbox()))
            .unwrap();
        assert!(model.writes.borrow().is_empty());
        assert!(!record_path(base.path()).exists());
    }

    #[test]
    fn revoke_restores_every_directory_and_removes_the_record() {
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        let before: Vec<_> = [r"C:\Users\Me", r"C:\Users\Me\AppData", r"C:\Users\Me\AppData\Local\Temp"]
            .iter()
            .map(|d| (d.to_string(), model.acl(d)))
            .collect();
        ensure_for(&model, base.path(), Path::new(PROFILE), &[PathBuf::from(WORKSPACE)], Some(&sandbox()))
            .unwrap();
        let report = revoke_with(&model, &record_path(base.path()));
        assert_eq!(report, RevokeReport { removed: 4, failed: vec![] });
        for (dir, acl) in before {
            assert_eq!(model.acl(&dir), acl, "{dir}");
        }
        assert!(!record_path(base.path()).exists());
        // Idempotent: nothing recorded, nothing to do.
        assert_eq!(revoke_with(&model, &record_path(base.path())), RevokeReport::default());
    }

    #[test]
    fn revoke_leaves_other_entries_of_the_account_alone() {
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        ensure_for(&model, base.path(), Path::new(PROFILE), &[PathBuf::from(WORKSPACE)], Some(&sandbox()))
            .unwrap();
        // Someone adds an entry for the same account afterwards.
        let extra = ace(0, 0x03, READ_EXEC, &sandbox());
        {
            let mut dirs = model.dirs.borrow_mut();
            let acl = dirs.get_mut(&Model::key(Path::new(r"C:\Users\Me\AppData"))).unwrap().as_mut().unwrap();
            acl.aces.push(extra.clone());
        }
        revoke_with(&model, &record_path(base.path()));
        let acl = model.acl(r"C:\Users\Me\AppData").unwrap();
        assert!(acl.aces.contains(&extra));
        assert_eq!(acl.aces.len(), typical().aces.len() + 1);
        assert_eq!(remove_exact(&acl, &sandbox(), TRAVERSE_MASK, NO_INHERIT_ACE), None, "ours is gone");
    }

    #[test]
    fn a_directory_that_is_gone_counts_as_revoked_and_a_failure_stays_recorded() {
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        ensure_for(&model, base.path(), Path::new(PROFILE), &[PathBuf::from(WORKSPACE)], Some(&sandbox()))
            .unwrap();
        model.dirs.borrow_mut().remove(&Model::key(Path::new(r"C:\Users\Me\AppData\Local\Temp")));
        *model.fail_on.borrow_mut() = Some(r"c:\users\me\appdata".into());
        let report = revoke_with(&model, &record_path(base.path()));
        assert_eq!(report.removed, 2);
        assert_eq!(report.failed.len(), 1, "{report:?}");
        assert!(report.failed[0].contains(r"C:\Users\Me\AppData:"), "{}", report.failed[0]);
        let left = read_record(&record_path(base.path())).unwrap();
        assert_eq!(left.grants.len(), 1);
        assert_eq!(left.grants[0].path, r"C:\Users\Me\AppData");
        // After the cause is gone, a second revoke finishes the job.
        *model.fail_on.borrow_mut() = None;
        let report = revoke_with(&model, &record_path(base.path()));
        assert_eq!(report, RevokeReport { removed: 1, failed: vec![] });
        assert!(!record_path(base.path()).exists());
    }

    #[test]
    fn revoke_uses_the_recorded_sid_not_a_lookup() {
        // The account was deleted before revocation: the entry is removed by its SID bytes.
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        ensure_for(&model, base.path(), Path::new(PROFILE), &[PathBuf::from(WORKSPACE)], Some(&sandbox()))
            .unwrap();
        let report = revoke_with(&model, &record_path(base.path()));
        assert!(report.failed.is_empty());
        let acl = model.acl(r"C:\Users\Me").unwrap();
        assert!(acl.aces.iter().all(|a| a.plain().is_none_or(|(_, trustee)| trustee != sandbox().as_slice())));
    }
    // ---- availability: directories this app may not change, and placeholders ----

    #[test]
    fn the_groups_the_account_belongs_to_can_admit_it() {
        let users_read_exec = Acl { revision: 2, aces: vec![ace(0, INHERITED_ACE | 3, READ_EXEC, &users())] };
        assert!(effective_via_groups(&users_read_exec, &sandbox()));
        // Everyone and Authenticated Users count too; the SID bytes are the well-known ones.
        for group in [vec![1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], vec![1, 1, 0, 0, 0, 0, 0, 5, 11, 0, 0, 0]] {
            let acl = Acl { revision: 2, aces: vec![ace(0, 0, READ_EXEC, &group)] };
            assert!(effective_via_groups(&acl, &sandbox()));
        }
        // Several entries together cover the mask.
        let acl = Acl {
            revision: 2,
            aces: vec![
                ace(0, 0, FILE_TRAVERSE | FILE_READ_ATTRIBUTES, &users()),
                ace(0, 0, READ_CONTROL | SYNCHRONIZE, &sandbox()),
            ],
        };
        assert!(effective_via_groups(&acl, &sandbox()));
    }

    #[test]
    fn entries_that_do_not_admit_the_account() {
        // Administrators only, an inherit-only entry, a partial mask, a deny of the same bits.
        assert!(!effective_via_groups(&typical(), &sandbox()));
        let acl = Acl { revision: 2, aces: vec![ace(0, 0x03 | INHERIT_ONLY_ACE, READ_EXEC, &users())] };
        assert!(!effective_via_groups(&acl, &sandbox()));
        let acl = Acl { revision: 2, aces: vec![ace(0, 0, FILE_TRAVERSE, &users())] };
        assert!(!effective_via_groups(&acl, &sandbox()));
        let acl = Acl {
            revision: 2,
            aces: vec![ace(1, 0, FILE_TRAVERSE, &users()), ace(0, 0, READ_EXEC, &users())],
        };
        assert!(!effective_via_groups(&acl, &sandbox()), "a deny of traverse wins");
        // A deny that touches other bits only does not matter.
        let acl = Acl {
            revision: 2,
            aces: vec![ace(1, 0, 0x2, &users()), ace(0, 0, READ_EXEC, &users())],
        };
        assert!(effective_via_groups(&acl, &sandbox()));
    }

    #[test]
    fn only_links_and_junctions_redirect_cloud_placeholders_do_not() {
        const DIRECTORY: u32 = 0x10;
        const REPARSE: u32 = 0x400;
        // IO_REPARSE_TAG_SYMLINK, IO_REPARSE_TAG_MOUNT_POINT (junctions, volume mounts).
        assert!(redirects_elsewhere(DIRECTORY | REPARSE, 0xA000_000C));
        assert!(redirects_elsewhere(DIRECTORY | REPARSE, 0xA000_0003));
        // OneDrive / cloud files placeholders (IO_REPARSE_TAG_CLOUD, _CLOUD_1..F, _CLOUD_ROOT),
        // dedup, WSL and app execution aliases are ordinary folders as far as paths go.
        for tag in [0x9000_001A, 0x9000_101A, 0x9000_F01A, 0x8000_0013, 0x8000_001B, 0x8000_0017] {
            assert!(!redirects_elsewhere(DIRECTORY | REPARSE, tag), "{tag:#x}");
        }
        // Without the reparse attribute the tag is meaningless.
        assert!(!redirects_elsewhere(DIRECTORY, 0xA000_000C));
    }

    #[test]
    fn the_first_pass_never_asks_for_write_access_to_a_directory_that_needs_nothing() {
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        // The profile already admits the account (Users, inherited), and Windows would refuse a
        // change there anyway: it must never be opened for writing.
        model.dirs.borrow_mut().insert(
            Model::key(Path::new(r"C:\Users\Me")),
            Some(Acl { revision: 2, aces: vec![ace(0, INHERITED_ACE | 3, READ_EXEC, &users())] }),
        );
        model.deny_write.borrow_mut().push(Model::key(Path::new(r"C:\Users\Me")));
        ensure_for(&model, base.path(), Path::new(PROFILE), &[PathBuf::from(WORKSPACE)], Some(&sandbox()))
            .unwrap();
        let modified = model.modified.borrow().clone();
        assert!(!modified.contains(&Model::key(Path::new(r"C:\Users\Me"))), "{modified:?}");
        assert_eq!(modified.len(), 3, "only the three directories that needed the entry: {modified:?}");
        let record = read_record(&record_path(base.path())).unwrap();
        assert!(record.grants.iter().all(|g| g.path != r"C:\Users\Me"), "{record:?}");
    }

    #[test]
    fn a_directory_that_refuses_the_write_is_fine_when_the_account_is_admitted_anyway() {
        // Needs the entry by our own test (no entry for the SID), is not admitted by group entries
        // in the first pass (a deny of an unrelated bit does not matter, but an explicit deny of
        // traverse does), so it is attempted; the write is refused; and a re-read says admitted.
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        // The first pass reads "not admitted"; make the later read say admitted by flipping the
        // list when the write is attempted.
        model.deny_write.borrow_mut().push(Model::key(Path::new(r"C:\Users\Me\AppData")));
        struct Flip<'a>(&'a Model);
        impl DirAcls for Flip<'_> {
            fn read(&self, dir: &Path) -> std::result::Result<Option<Acl>, AclError> {
                self.0.read(dir)
            }
            fn modify(&self, dir: &Path, change: super::AclChange<'_>) -> std::result::Result<bool, AclError> {
                let outcome = self.0.modify(dir, change);
                if matches!(outcome, Err(AclError::Denied(_))) {
                    self.0.dirs.borrow_mut().insert(
                        Model::key(dir),
                        Some(Acl { revision: 2, aces: vec![ace(0, 0, READ_EXEC, &users())] }),
                    );
                }
                outcome
            }
        }
        let changed = ensure_for(
            &Flip(&model),
            base.path(),
            Path::new(PROFILE),
            &[PathBuf::from(WORKSPACE)],
            Some(&sandbox()),
        );
        assert!(changed.is_ok(), "{changed:?}");
    }

    #[test]
    fn a_directory_that_refuses_the_write_and_does_not_admit_the_account_fails_closed_with_advice() {
        let base = tempfile::tempdir().unwrap();
        let model = profile_model();
        model.deny_write.borrow_mut().push(Model::key(Path::new(r"C:\Users\Me\AppData")));
        let error = ensure_for(&model, base.path(), Path::new(PROFILE), &[PathBuf::from(WORKSPACE)], Some(&sandbox()))
            .unwrap_err();
        assert_eq!(error.code, "SANDBOX_GRANT_FAILED");
        assert!(error.message.contains(r"C:\Users\Me\AppData"), "{}", error.message);
        assert!(error.message.contains("Give sourceweft-sandbox"), "{}", error.message);
        assert!(error.message.contains("choose a working folder elsewhere"), "{}", error.message);
    }

}

// Real DACLs. These use a well-known group (BUILTIN\Guests) as the trustee, so they need neither
// the sandbox account nor administrator rights, and touch only a directory they create.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use super::win::WindowsDirAcls;

    /// S-1-5-32-546, BUILTIN\Guests.
    fn guests() -> Vec<u8> {
        let mut bytes = vec![1, 2, 0, 0, 0, 0, 0, 5];
        bytes.extend_from_slice(&32u32.to_le_bytes());
        bytes.extend_from_slice(&546u32.to_le_bytes());
        bytes
    }

    fn dacl_of(dir: &Path) -> Option<Acl> {
        WindowsDirAcls.read(dir).unwrap()
    }

    #[test]
    fn the_real_grant_is_idempotent_exact_and_revocable() {
        let base = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let record = record_path(base.path());
        let before = dacl_of(dir.path()).expect("a DACL");

        let changed = ensure_with(&WindowsDirAcls, &record, &guests(), &[dir.path().to_path_buf()]).unwrap();
        assert_eq!(changed, [dir.path().to_path_buf()]);
        let after = dacl_of(dir.path()).unwrap();
        assert!(grants_traversal(&after, &guests()));
        // Every other entry is still there, unchanged and in order.
        let others: Vec<_> = after
            .aces
            .iter()
            .filter(|ace| ace.plain().is_none_or(|(_, trustee)| trustee != guests().as_slice()))
            .cloned()
            .collect();
        let before_others: Vec<_> = before
            .aces
            .iter()
            .filter(|ace| ace.plain().is_none_or(|(_, trustee)| trustee != guests().as_slice()))
            .cloned()
            .collect();
        assert_eq!(others, before_others);

        // The second call changes nothing.
        let again = ensure_with(&WindowsDirAcls, &record, &guests(), &[dir.path().to_path_buf()]).unwrap();
        assert!(again.is_empty());
        assert_eq!(dacl_of(dir.path()).unwrap(), after);

        let report = revoke_with(&WindowsDirAcls, &record);
        assert_eq!(report, RevokeReport { removed: 1, failed: vec![] });
        assert_eq!(dacl_of(dir.path()).unwrap(), before);
        assert!(!record.exists());
    }

    #[test]
    fn a_junction_is_refused_and_the_target_is_not_changed() {
        let base = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let holder = tempfile::tempdir().unwrap();
        let link = holder.path().join("link");
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "New-Item -ItemType Junction -Path $env:SW_LINK -Target $env:SW_TARGET -ErrorAction Stop | Out-Null",
            ])
            .env("SW_LINK", &link)
            .env("SW_TARGET", outside.path())
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        let before = dacl_of(outside.path());
        let error = ensure_with(&WindowsDirAcls, &record_path(base.path()), &guests(), &[link]).unwrap_err();
        assert!(error.contains("link or junction"), "{error}");
        assert_eq!(dacl_of(outside.path()), before);
    }

    #[test]
    fn a_missing_directory_is_reported() {
        let base = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("gone");
        let error = ensure_with(&WindowsDirAcls, &record_path(base.path()), &guests(), &[gone]).unwrap_err();
        assert!(error.contains("does not exist"), "{error}");
    }

    #[test]
    fn the_sandbox_account_lookup_distinguishes_absent_from_present() {
        // On a machine without the sandbox installed the account is absent; with it installed it
        // is a user SID. Either way the lookup must not fail for another reason.
        match win::sandbox_account_sid() {
            Ok(sid) => assert!(valid_sid(&sid)),
            Err(win::SidLookup::NotFound) => {}
            Err(win::SidLookup::Failed(reason)) => panic!("lookup failed: {reason}"),
        }
    }
}
