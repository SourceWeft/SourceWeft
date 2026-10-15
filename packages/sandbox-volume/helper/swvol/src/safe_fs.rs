//! Descriptor-relative restore operations. No user path is reopened via an
//! absolute name, and no intermediate or final symlink is followed.
use anyhow::{bail, Context, Result};
use std::ffi::{CString, OsStr};
use std::fs::{self, File};
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};

pub struct Directory(File);
// Stock Cloudflare images create these placeholders before bootstrap. Names alone
// do not grant permission to overwrite: every accepted entry must be a real empty directory.
const IMAGE_DIRECTORIES: &[&str] = &["input", "output", "work"];
fn name(value: &OsStr) -> Result<CString> { Ok(CString::new(value.as_bytes())?) }
fn fd_file(fd: i32) -> std::io::Result<File> { if fd < 0 { Err(std::io::Error::last_os_error()) } else { Ok(unsafe { File::from_raw_fd(fd) }) } }
impl Directory {
    pub fn open_root(path: &Path) -> Result<Self> {
        if !path.is_absolute() { bail!("restore root must be an absolute path"); }
        let mut dir = Self(File::open("/")?);
        for part in path.components() {
            match part {
                Component::RootDir => {},
                Component::Normal(part) => dir = dir.child(part, true)?,
                _ => bail!("restore root must not contain parent traversal"),
            }
        }
        Ok(dir)
    }
    fn child(&self, part: &OsStr, create: bool) -> Result<Self> {
        let part = name(part)?;
        if create {
            let result = unsafe { libc::mkdirat(self.0.as_raw_fd(), part.as_ptr(), 0o700) };
            if result != 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists { return Err(std::io::Error::last_os_error().into()); }
        }
        let fd = unsafe { libc::openat(self.0.as_raw_fd(), part.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        Ok(Self(fd_file(fd).context("restore parent is not an accessible real directory")?))
    }
    pub fn new_directory(&self, leaf: &str) -> Result<Self> {
        let name = CString::new(leaf)?;
        if leaf.contains('/') || unsafe { libc::mkdirat(self.0.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(std::io::Error::last_os_error()).context("cannot exclusively create restore staging directory");
        }
        self.child(OsStr::new(leaf), false)
    }
    pub fn move_entry_to(&self, source: &str, target: &Directory, destination: &str) -> Result<()> {
        if [source, destination].iter().any(|name| name.is_empty() || name.contains('/') || *name == "." || *name == "..") { bail!("invalid metadata rename leaf"); }
        let source = CString::new(source)?; let destination = CString::new(destination)?;
        if unsafe { libc::syscall(libc::SYS_renameat2, self.0.as_raw_fd(), source.as_ptr(), target.0.as_raw_fd(), destination.as_ptr(), libc::RENAME_NOREPLACE) } != 0 {
            return Err(std::io::Error::last_os_error()).context("metadata rename refused replacement");
        }
        target.0.sync_all()?; self.0.sync_all()?; Ok(())
    }
    pub fn directory(&self, relative: &str, create: bool) -> Result<Self> {
        let mut dir = Self(self.0.try_clone()?);
        for part in Path::new(relative).components() {
            match part { Component::Normal(part) => dir = dir.child(part, create)?, _ => bail!("invalid descriptor-relative path") }
        }
        Ok(dir)
    }
    fn parent(&self, relative: &str) -> Result<(Self, CString)> {
        let (parent, leaf) = relative.rsplit_once('/').unwrap_or(("", relative));
        if leaf.is_empty() || leaf == "." || leaf == ".." { bail!("invalid restore leaf"); }
        Ok((self.directory(parent, false)?, CString::new(leaf)?))
    }
    pub fn create_file(&self, relative: &str) -> Result<File> {
        let (dir, leaf) = self.parent(relative)?;
        let fd = unsafe { libc::openat(dir.0.as_raw_fd(), leaf.as_ptr(), libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
        Ok(fd_file(fd).context("restore refuses to replace an existing entry")?)
    }
    #[cfg(test)]
    pub fn open_created_file(&self, relative: &str, identity: (u64, u64)) -> Result<File> {
        let (dir, leaf) = self.parent(relative)?;
        let fd = unsafe { libc::openat(dir.0.as_raw_fd(), leaf.as_ptr(), libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        let file = fd_file(fd)?;
        let md = file.metadata()?;
        if !md.is_file() || md.nlink() != 1 || (md.dev(), md.ino()) != identity { bail!("restore file identity changed during capture"); }
        Ok(file)
    }
    pub fn lock_file(&self) -> Result<File> {
        let leaf = CString::new("lock")?;
        let fd = unsafe { libc::openat(self.0.as_raw_fd(), leaf.as_ptr(), libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
        let file = fd_file(fd)?;
        let md = file.metadata()?;
        if !md.is_file() || md.nlink() != 1 { bail!("invalid restore lock file"); }
        Ok(file)
    }
    pub fn symlink(&self, relative: &str, target: &str) -> Result<()> {
        let (dir, leaf) = self.parent(relative)?;
        let target = CString::new(target)?;
        if unsafe { libc::symlinkat(target.as_ptr(), dir.0.as_raw_fd(), leaf.as_ptr()) } != 0 { return Err(std::io::Error::last_os_error().into()); }
        Ok(())
    }
    pub fn set_symlink_mtime(&self, relative: &str, nanoseconds: i64) -> Result<()> {
        let (dir, leaf) = self.parent(relative)?;
        let times = [
            libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT as _ },
            libc::timespec { tv_sec: nanoseconds.div_euclid(1_000_000_000) as _, tv_nsec: nanoseconds.rem_euclid(1_000_000_000) as _ },
        ];
        if unsafe { libc::utimensat(dir.0.as_raw_fd(), leaf.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
            return Err(std::io::Error::last_os_error()).context("cannot restore symlink timestamp without following its target");
        }
        Ok(())
    }
    pub fn metadata(&self, relative: &str) -> Result<fs::Metadata> {
        let (dir, leaf) = self.parent(relative)?;
        let fd = unsafe { libc::openat(dir.0.as_raw_fd(), leaf.as_ptr(), libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        Ok(fd_file(fd)?.metadata()?)
    }
    pub fn chmod(&self, relative: &str, mode: u32) -> Result<()> {
        let directory = self.directory(relative, false)?;
        if unsafe { libc::fchmod(directory.0.as_raw_fd(), mode) } != 0 { return Err(std::io::Error::last_os_error().into()); }
        Ok(())
    }
    pub fn names(&self) -> Result<Vec<String>> {
        fs::read_dir(format!("/proc/self/fd/{}", self.0.as_raw_fd()))?.map(|entry| {
            entry?.file_name().into_string().map_err(|_| anyhow::anyhow!("non-UTF-8 entry in restore target"))
        }).collect()
    }
    fn empty_image_directory(&self, leaf: &str) -> Result<Self> {
        if !IMAGE_DIRECTORIES.contains(&leaf) { bail!("RESTORE_TARGET_NOT_EMPTY: refusing to overwrite existing workspace content"); }
        let directory = self.child(OsStr::new(leaf), false)
            .with_context(|| format!("RESTORE_TARGET_NOT_EMPTY: platform entry {leaf} is not a real accessible directory"))?;
        if !directory.names()?.is_empty() { bail!("RESTORE_TARGET_NOT_EMPTY: platform directory {leaf} contains existing content"); }
        Ok(directory)
    }
    fn remove_verified_image_directory(&self, leaf: &str, verified: &Self) -> Result<()> {
        if !IMAGE_DIRECTORIES.contains(&leaf) { bail!("refusing to remove an unknown platform directory"); }
        let expected = verified.0.metadata()?;
        let current = self.metadata(leaf)?;
        if !current.is_dir() || (current.dev(), current.ino()) != (expected.dev(), expected.ino()) {
            bail!("restore publish conflict: platform directory changed after validation");
        }
        let name = CString::new(leaf)?;
        // AT_REMOVEDIR atomically refuses nonempty directories, files and links.
        // Restore still requires a quiescent target; this is not an inode-CAS unlink.
        if unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            return Err(std::io::Error::last_os_error()).context("restore publish conflict: platform directory could not be removed as an empty directory");
        }
        Ok(())
    }
    pub fn require_empty_content(&self) -> Result<()> {
        for leaf in self.names()? {
            if leaf.starts_with(super::META_DIR) { continue; }
            self.empty_image_directory(&leaf)?;
        }
        Ok(())
    }
    pub fn remove(&self, relative: &str, directory: bool) -> Result<()> {
        let (dir, leaf) = self.parent(relative)?;
        if unsafe { libc::unlinkat(dir.0.as_raw_fd(), leaf.as_ptr(), if directory { libc::AT_REMOVEDIR } else { 0 }) } != 0 {
            let error = std::io::Error::last_os_error(); if error.kind() != std::io::ErrorKind::NotFound { return Err(error.into()); }
        }
        Ok(())
    }
    pub fn publish_into(&self, destination: &Self) -> Result<()> {
        for leaf in self.names()? {
            let name = CString::new(leaf.as_str())?;
            let publish = || unsafe { libc::syscall(libc::SYS_renameat2, self.0.as_raw_fd(), name.as_ptr(), destination.0.as_raw_fd(), name.as_ptr(), libc::RENAME_NOREPLACE) };
            if publish() != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::AlreadyExists || !IMAGE_DIRECTORIES.contains(&leaf.as_str()) {
                    return Err(error).context("restore publish conflict; staged and published data retained, attachment is not ready");
                }
                let verified = destination.empty_image_directory(&leaf)?;
                destination.remove_verified_image_directory(&leaf, &verified)?;
                // A new file, link or directory appearing after unlink is never replaced.
                if publish() != 0 {
                    return Err(std::io::Error::last_os_error()).context("restore publish conflict after platform placeholder removal; staged data retained");
                }
            }
        }
        destination.0.sync_all()?;
        Ok(())
    }
    pub fn atomic_write(&self, leaf: &str, bytes: &[u8]) -> Result<()> {
        let temporary = format!("{leaf}.restore-{}-{}", std::process::id(), super::now_ms());
        let mut file = self.create_file(&temporary)?;
        file.write_all(bytes)?; file.sync_all()?;
        let from = CString::new(temporary)?; let to = CString::new(leaf)?;
        if unsafe { libc::renameat(self.0.as_raw_fd(), from.as_ptr(), self.0.as_raw_fd(), to.as_ptr()) } != 0 { return Err(std::io::Error::last_os_error().into()); }
        self.0.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self { let path = std::env::temp_dir().join(format!("swvol-safe-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))); fs::create_dir_all(path.join("root")).unwrap(); fs::create_dir_all(path.join("outside")).unwrap(); fs::write(path.join("outside/sentinel"), "do not overwrite").unwrap(); Self(path) }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn replacing_parent_with_symlink_cannot_redirect_a_write() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        root.directory("parent", true).unwrap();
        fs::rename(f.0.join("root/parent"), f.0.join("old-parent")).unwrap();
        std::os::unix::fs::symlink(f.0.join("outside"), f.0.join("root/parent")).unwrap();
        assert!(root.create_file("parent/sentinel").is_err());
        assert_eq!(fs::read_to_string(f.0.join("outside/sentinel")).unwrap(), "do not overwrite");
    }
    #[test]
    fn replacing_a_created_file_with_hardlink_cannot_redirect_later_chunk_writes() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        let file = root.create_file("data").unwrap(); let md = file.metadata().unwrap(); drop(file);
        fs::remove_file(f.0.join("root/data")).unwrap(); fs::hard_link(f.0.join("outside/sentinel"), f.0.join("root/data")).unwrap();
        assert!(root.open_created_file("data", (md.dev(), md.ino())).is_err());
        assert_eq!(fs::read_to_string(f.0.join("outside/sentinel")).unwrap(), "do not overwrite");
    }
    #[test]
    fn publication_never_replaces_an_entry_created_after_the_empty_check() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        let staging = Directory::open_root(&f.0.join("stage")).unwrap(); staging.create_file("data").unwrap().write_all(b"restored").unwrap();
        root.require_empty_content().unwrap(); fs::write(f.0.join("root/data"), "user change").unwrap();
        assert!(staging.publish_into(&root).is_err());
        assert_eq!(fs::read_to_string(f.0.join("root/data")).unwrap(), "user change");
        assert_eq!(fs::read_to_string(f.0.join("stage/data")).unwrap(), "restored");
    }
    #[test]
    fn root_and_metadata_symlinks_are_never_followed() {
        let f = Fixture::new(); std::os::unix::fs::symlink(f.0.join("outside"), f.0.join("alias")).unwrap();
        assert!(Directory::open_root(&f.0.join("alias")).is_err());
        let root = Directory::open_root(&f.0.join("root")).unwrap();
        std::os::unix::fs::symlink(f.0.join("outside"), f.0.join("root/.sourceweft")).unwrap();
        assert!(root.directory(".sourceweft", true).is_err());
    }
    #[test]
    fn symlink_target_string_is_preserved_without_dereferencing_it() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        root.symlink("link", "../../outside/sentinel").unwrap();
        assert_eq!(fs::read_link(f.0.join("root/link")).unwrap(), Path::new("../../outside/sentinel"));
        assert_eq!(fs::read_to_string(f.0.join("outside/sentinel")).unwrap(), "do not overwrite");
    }
    #[test]
    fn platform_directory_populated_after_validation_is_never_removed() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        root.directory("input", true).unwrap();
        let verified = root.empty_image_directory("input").unwrap();
        fs::write(f.0.join("root/input/new-user-file"), "preserve").unwrap();
        assert!(root.remove_verified_image_directory("input", &verified).is_err());
        assert_eq!(fs::read_to_string(f.0.join("root/input/new-user-file")).unwrap(), "preserve");
    }
    #[test]
    fn platform_directory_replaced_by_symlink_after_validation_is_preserved() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        root.directory("input", true).unwrap();
        let verified = root.empty_image_directory("input").unwrap();
        fs::rename(f.0.join("root/input"), f.0.join("original-input")).unwrap();
        std::os::unix::fs::symlink(f.0.join("outside"), f.0.join("root/input")).unwrap();
        assert!(root.remove_verified_image_directory("input", &verified).is_err());
        assert!(fs::symlink_metadata(f.0.join("root/input")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(f.0.join("outside/sentinel")).unwrap(), "do not overwrite");
    }
    #[test]
    fn new_platform_name_conflict_after_empty_directory_removal_is_preserved() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        let staging = Directory::open_root(&f.0.join("stage")).unwrap();
        staging.directory("input", true).unwrap(); staging.create_file("input/restored").unwrap();
        root.directory("input", true).unwrap();
        let verified = root.empty_image_directory("input").unwrap();
        root.remove_verified_image_directory("input", &verified).unwrap();
        fs::write(f.0.join("root/input"), "concurrent user change").unwrap();
        assert!(staging.publish_into(&root).is_err());
        assert_eq!(fs::read_to_string(f.0.join("root/input")).unwrap(), "concurrent user change");
        assert!(f.0.join("stage/input/restored").is_file());
    }

    #[test]
    fn symlink_timestamp_is_restored_without_touching_target_timestamp() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        let before = fs::metadata(f.0.join("outside/sentinel")).unwrap();
        root.symlink("link", "../outside/sentinel").unwrap();
        let timestamp = 1_600_000_000_123_456_789i64;
        root.set_symlink_mtime("link", timestamp).unwrap();
        let link = root.metadata("link").unwrap();
        assert_eq!(link.mtime() * 1_000_000_000 + link.mtime_nsec(), timestamp);
        let after = fs::metadata(f.0.join("outside/sentinel")).unwrap();
        assert_eq!((before.mtime(), before.mtime_nsec()), (after.mtime(), after.mtime_nsec()));
        assert_eq!(fs::read_to_string(f.0.join("outside/sentinel")).unwrap(), "do not overwrite");
    }

    #[test]
    fn stable_restore_cache_is_bounded_and_keeps_nofollow_and_file_identity_checks() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        let cache = RestoreDirectoryCache::new(&root, 4).unwrap();
        for index in 0..20 { cache.directory(&format!("d{index}"), true).unwrap(); cache.create_file(&format!("d{index}/data")).unwrap(); }
        assert!(cache.entries.lock().unwrap().1.len() <= cache.limit); assert!(cache.limit <= 4);
        let file = cache.create_file("d19/pinned").unwrap(); let md = file.metadata().unwrap(); drop(file);
        fs::remove_file(f.0.join("root/d19/pinned")).unwrap(); fs::hard_link(f.0.join("outside/sentinel"), f.0.join("root/d19/pinned")).unwrap();
        assert!(cache.open_created_file("d19/pinned", (md.dev(), md.ino())).is_err());
        root.symlink("redirect", "../outside").unwrap();
        assert!(cache.create_file("redirect/sentinel").is_err());
        assert_eq!(fs::read_to_string(f.0.join("outside/sentinel")).unwrap(), "do not overwrite");
    }
    #[test]
    fn probe_linux_symlink_target_byte_limit() {
        let f = Fixture::new(); let root = Directory::open_root(&f.0.join("root")).unwrap();
        let accepted = root.symlink("target-4095", &"a".repeat(4095));
        let rejected = root.symlink("target-4096", &"a".repeat(4096));
        let error = rejected.as_ref().err().and_then(|e| e.downcast_ref::<std::io::Error>()).and_then(|e| e.raw_os_error());
        eprintln!("SYMLINK_LIMIT_PROBE target4095_ok={} target4096_ok={} target4096_errno={error:?}", accepted.is_ok(), rejected.is_ok());
        assert!(accepted.is_ok()); assert_eq!(error, Some(libc::ENAMETOOLONG));
        assert_eq!(fs::read_link(f.0.join("root/target-4095")).unwrap().as_os_str().as_bytes().len(), 4095);
        assert!(!f.0.join("root/target-4096").symlink_metadata().is_ok());
    }

}

/// A bounded capability cache used only while restore exclusively owns its
/// staging/published tree and workload admission is closed. Mutable-target
/// validation and exclusive publication continue to use uncached Directory APIs.
pub struct RestoreDirectoryCache<'a> {
    root: &'a Directory,
    limit: usize,
    entries: std::sync::Mutex<(u64, std::collections::HashMap<String, (Directory, u64)>)>,
}
impl<'a> RestoreDirectoryCache<'a> {
    pub fn new(root: &'a Directory, requested: usize) -> Result<Self> {
        let mut rlimit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlimit) } != 0 { return Err(std::io::Error::last_os_error().into()); }
        let limit = requested.min((rlimit.rlim_cur as usize).saturating_sub(64) / 2);
        Ok(Self { root, limit, entries: std::sync::Mutex::new((0, std::collections::HashMap::new())) })
    }
    pub fn clear(&self) { self.entries.lock().unwrap().1.clear(); }
    pub fn directory(&self, relative: &str, create: bool) -> Result<Directory> {
        // An exact hit already passed component validation and was opened with
        // O_NOFOLLOW in this restore-owned tree. Do not reopen or replace it.
        {
            let mut state = self.entries.lock().unwrap(); state.0 += 1; let tick = state.0;
            if let Some((directory, used)) = state.1.get_mut(relative) {
                *used = tick; return Ok(Directory(directory.0.try_clone()?));
            }
        }
        let components: Vec<_> = Path::new(relative).components().map(|part| match part { Component::Normal(part) => Ok(part), _ => Err(anyhow::anyhow!("invalid cached restore path")) }).collect::<Result<_>>()?;
        let (mut directory, consumed) = {
            let mut state = self.entries.lock().unwrap(); state.0 += 1; let tick = state.0;
            let mut prefix = relative;
            let mut found = None;
            while !prefix.is_empty() {
                if let Some((directory, used)) = state.1.get_mut(prefix) {
                    *used = tick; found = Some((Directory(directory.0.try_clone()?), prefix.split('/').count())); break;
                }
                prefix = prefix.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("");
            }
            match found { Some(found) => found, None => (Directory(self.root.0.try_clone()?), 0) }
        };
        for part in &components[consumed..] { directory = directory.child(part, create)?; }
        if self.limit > 0 && !relative.is_empty() {
            let mut state = self.entries.lock().unwrap(); state.0 += 1; let tick = state.0;
            if !state.1.contains_key(relative) && state.1.len() >= self.limit {
                let victim = state.1.iter().min_by_key(|(_, (_, used))| *used).map(|(path, _)| path.clone()).unwrap(); state.1.remove(&victim);
            }
            state.1.insert(relative.into(), (Directory(directory.0.try_clone()?), tick));
        }
        Ok(directory)
    }
    fn parent(&self, relative: &str) -> Result<(Directory, CString)> {
        let (parent, leaf) = relative.rsplit_once('/').unwrap_or(("", relative));
        if leaf.is_empty() || leaf == "." || leaf == ".." { bail!("invalid restore leaf"); }
        Ok((self.directory(parent, false)?, CString::new(leaf)?))
    }
    pub fn create_file(&self, relative: &str) -> Result<File> {
        let (parent, leaf) = self.parent(relative)?;
        let fd = unsafe { libc::openat(parent.0.as_raw_fd(), leaf.as_ptr(), libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
        Ok(fd_file(fd).context("restore refuses to replace an existing entry")?)
    }
    pub fn open_created_file(&self, relative: &str, identity: (u64, u64)) -> Result<File> {
        let (parent, leaf) = self.parent(relative)?;
        let fd = unsafe { libc::openat(parent.0.as_raw_fd(), leaf.as_ptr(), libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        let file = fd_file(fd)?; let md = file.metadata()?;
        if !md.is_file() || md.nlink() != 1 || (md.dev(), md.ino()) != identity { bail!("restore file identity changed during capture"); }
        Ok(file)
    }
    pub fn metadata(&self, relative: &str) -> Result<fs::Metadata> {
        let (parent, leaf) = self.parent(relative)?;
        let fd = unsafe { libc::openat(parent.0.as_raw_fd(), leaf.as_ptr(), libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        Ok(fd_file(fd)?.metadata()?)
    }
    pub fn set_metadata(&self, relative: &str, mode: u32, mtime_ns: i64) -> Result<fs::Metadata> {
        let directory = self.directory(relative, false)?;
        if unsafe { libc::fchmod(directory.0.as_raw_fd(), mode) } != 0 { return Err(std::io::Error::last_os_error().into()); }
        let mtime = filetime::FileTime::from_unix_time(mtime_ns.div_euclid(1_000_000_000), mtime_ns.rem_euclid(1_000_000_000) as u32);
        filetime::set_file_handle_times(&directory.0, None, Some(mtime))?;
        Ok(directory.0.metadata()?)
    }
}
