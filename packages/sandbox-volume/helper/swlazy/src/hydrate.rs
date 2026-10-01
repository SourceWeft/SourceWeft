//! Placeholder files: a sparse file with the right size, mode and mtime, carrying an extended
//! attribute that says where its bytes live. Hydration fills it in place and drops the attribute.
use crate::plan::Plan;
use crate::store::Store;
use anyhow::{anyhow, bail, Result};
use std::ffi::{CStr, CString};
use std::fs::File;
use std::os::unix::fs::FileExt;
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::Path;
use std::sync::Arc;

pub const XATTR: &[u8] = b"user.swlazy\0";
/// Files at least this large are streamed straight into place instead of through the block cache.
pub const DIRECT_MIN: u64 = 8 << 20;

fn xname() -> *const libc::c_char {
    XATTR.as_ptr() as *const libc::c_char
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn times(mtime_ns: i64) -> [libc::timespec; 2] {
    [
        libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT },
        libc::timespec { tv_sec: (mtime_ns.div_euclid(1_000_000_000)) as libc::time_t, tv_nsec: mtime_ns.rem_euclid(1_000_000_000) as _ },
    ]
}

pub struct Made {
    pub dirs: u64,
    pub files: u64,
    pub links: u64,
    pub placeholders: u64,
    pub skipped: u64,
}

/// Create the whole tree as placeholders. Nothing is downloaded.
pub fn materialize(plan: &Plan, root: &Path) -> Result<Made> {
    let mut made = Made { dirs: 0, files: 0, links: 0, placeholders: 0, skipped: 0 };
    let mut dirs: Vec<(CString, i64, u32)> = Vec::new();
    let mut known: std::collections::HashSet<String> = std::collections::HashSet::new();
    std::fs::create_dir_all(root)?;
    for e in &plan.entries {
        let full = root.join(&e.p);
        let c = CString::new(full.to_string_lossy().as_bytes())?;
        if let Some(parent) = Path::new(&e.p).parent() {
            let ps = parent.to_string_lossy().to_string();
            if !ps.is_empty() && !known.contains(&ps) {
                std::fs::create_dir_all(root.join(parent))?;
                known.insert(ps);
            }
        }
        match e.k.as_str() {
            "d" => {
                if unsafe { libc::mkdir(c.as_ptr(), 0o700 | (e.m & 0o7777) as libc::mode_t) } != 0 && errno() != libc::EEXIST {
                    bail!("mkdir {}: errno {}", e.p, errno());
                }
                known.insert(e.p.clone());
                dirs.push((c, e.t, e.m));
                made.dirs += 1;
            }
            "l" => {
                let target = CString::new(e.l.clone().unwrap_or_default())?;
                if unsafe { libc::symlink(target.as_ptr(), c.as_ptr()) } != 0 {
                    if errno() == libc::EEXIST {
                        made.skipped += 1;
                        continue;
                    }
                    bail!("symlink {}: errno {}", e.p, errno());
                }
                let ts = times(e.t);
                unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), ts.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
                made.links += 1;
            }
            _ => {
                let fd = unsafe { libc::open(c.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC, (e.m & 0o7777 | 0o200) as libc::c_uint) };
                if fd < 0 {
                    if errno() == libc::EEXIST {
                        made.skipped += 1;
                        continue;
                    }
                    bail!("create {}: errno {}", e.p, errno());
                }
                if e.s > 0 {
                    let v = format!("{}:{}", e.o, e.s);
                    unsafe {
                        if libc::ftruncate(fd, e.s as libc::off_t) != 0 {
                            bail!("ftruncate {}: errno {}", e.p, errno());
                        }
                        if libc::fsetxattr(fd, xname(), v.as_ptr() as *const libc::c_void, v.len(), 0) != 0 {
                            bail!("fsetxattr {}: errno {}", e.p, errno());
                        }
                    }
                    made.placeholders += 1;
                }
                let ts = times(e.t);
                unsafe {
                    // Setting an xattr needs write permission on the inode, so read-only modes go on last.
                    if e.m & 0o200 == 0 || e.m & 0o7000 != 0 {
                        libc::fchmod(fd, (e.m & 0o7777) as libc::mode_t);
                    }
                    libc::futimens(fd, ts.as_ptr());
                    libc::close(fd);
                }
                made.files += 1;
            }
        }
    }
    // Directory mtimes last, deepest first, so creating children does not disturb them.
    for (c, t, m) in dirs.iter().rev() {
        let ts = times(*t);
        unsafe {
            libc::chmod(c.as_ptr(), (*m & 0o7777) as libc::mode_t);
            libc::utimensat(libc::AT_FDCWD, c.as_ptr(), ts.as_ptr(), 0);
        }
    }
    Ok(made)
}

/// Is `path` a placeholder? Returns (offset, size). One getxattr; this is the hot path.
pub fn placeholder(path: &CStr) -> Option<(u64, u64)> {
    let mut buf = [0u8; 64];
    let n = unsafe { libc::getxattr(path.as_ptr(), xname(), buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    if n <= 0 {
        return None;
    }
    parse(&buf[..n as usize])
}

fn parse(v: &[u8]) -> Option<(u64, u64)> {
    let s = std::str::from_utf8(v).ok()?;
    let (a, b) = s.split_once(':')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

#[derive(Debug)]
pub struct Filled {
    /// Path of the file in the daemon's own namespace (stable, unlike the /proc/<pid>/... form).
    pub path: CString,
    pub off: u64,
    pub size: u64,
    pub mtime_ns: i64,
}

#[derive(Debug)]
pub enum Outcome {
    NotPlaceholder,
    Hydrated(Filled),
    /// The caller is about to truncate the file: the marker is dropped and nothing is fetched.
    Discarded,
    Raced,
}

/// Fill a placeholder in place. `truncating` = the pending syscall throws the old content away.
pub fn hydrate(path: &CStr, store: &Arc<Store>, truncating: bool, make_room: &dyn Fn(u64) -> Result<()>) -> Result<Outcome> {
    if placeholder(path).is_none() {
        return Ok(Outcome::NotPlaceholder);
    }
    let mut restore_mode: Option<libc::mode_t> = None;
    let mut fd = unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOCTTY) };
    if fd < 0 && errno() == libc::EACCES {
        if truncating {
            // The caller's open will fail the same way; leave the placeholder alone.
            return Ok(Outcome::NotPlaceholder);
        }
        // Read-only file (0444 is common in node_modules and .git): lend ourselves the write bit.
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::stat(path.as_ptr(), &mut st) } != 0 {
            bail!("stat failed: errno {}", errno());
        }
        unsafe { libc::chmod(path.as_ptr(), st.st_mode | 0o200) };
        fd = unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOCTTY) };
        restore_mode = Some(st.st_mode & 0o7777);
    }
    if fd < 0 {
        bail!("cannot open placeholder for hydration: errno {}", errno());
    }
    let f = unsafe { File::from_raw_fd(fd) };
    // The write bit stays on until the marker is removed (xattr changes need it); restored on every exit path.
    struct Restore(libc::c_int, Option<libc::mode_t>);
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(m) = self.1 {
                unsafe { libc::fchmod(self.0, m) };
            }
        }
    }
    let _restore = Restore(fd, restore_mode);
    // One hydration per inode at a time, across threads and processes.
    unsafe { libc::flock(fd, libc::LOCK_EX) };
    let mut buf = [0u8; 64];
    let n = unsafe { libc::fgetxattr(fd, xname(), buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    if n <= 0 {
        return Ok(Outcome::Raced);
    }
    let (off, size) = parse(&buf[..n as usize]).ok_or_else(|| anyhow!("malformed placeholder attribute"))?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    unsafe { libc::fstat(fd, &mut st) };
    if truncating || st.st_size as u64 != size {
        // Content is (about to be) the user's own: just stop treating the file as a placeholder.
        unsafe { libc::fremovexattr(fd, xname()) };
        return Ok(Outcome::Discarded);
    }
    make_room(size)?;
    if size >= DIRECT_MIN {
        store.fetch_to(off, size, &f, 0)?;
    } else {
        let mut data = vec![0u8; size as usize];
        store.read_at(off, &mut data)?;
        f.write_all_at(&data, 0)?;
    }
    let ts = [
        libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT },
        libc::timespec { tv_sec: st.st_mtime, tv_nsec: st.st_mtime_nsec as _ },
    ];
    unsafe {
        libc::fremovexattr(f.as_raw_fd(), xname());
        libc::futimens(f.as_raw_fd(), ts.as_ptr());
    }
    let real = std::fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd())).ok().and_then(|p| CString::new(p.to_string_lossy().as_bytes()).ok()).unwrap_or_else(|| path.to_owned());
    Ok(Outcome::Hydrated(Filled { path: real, off, size, mtime_ns: st.st_mtime as i64 * 1_000_000_000 + st.st_mtime_nsec as i64 }))
}

/// Turn a hydrated, unmodified file back into a placeholder (cache eviction for the in-place design).
/// Uses a write lease: the kernel refuses it while any other process has the file open.
pub fn dehydrate(path: &CStr, off: u64, size: u64, mtime_ns: i64) -> Result<bool> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::stat(path.as_ptr(), &mut st) } != 0 {
        return Ok(false);
    }
    let lend = st.st_mode & 0o200 == 0;
    if lend {
        unsafe { libc::chmod(path.as_ptr(), st.st_mode | 0o200) };
    }
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NONBLOCK) };
    if fd < 0 {
        if lend {
            unsafe { libc::chmod(path.as_ptr(), st.st_mode & 0o7777) };
        }
        return Ok(false);
    }
    let f = unsafe { File::from_raw_fd(fd) };
    struct Restore(libc::c_int, Option<libc::mode_t>);
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(m) = self.1 {
                unsafe { libc::fchmod(self.0, m) };
            }
        }
    }
    let _restore = Restore(fd, if lend { Some(st.st_mode & 0o7777) } else { None });
    let cur_ns = st.st_mtime as i64 * 1_000_000_000 + st.st_mtime_nsec as i64;
    if st.st_size as u64 != size || cur_ns != mtime_ns {
        return Ok(false); // modified since restore: it is the only copy, never evict
    }
    if unsafe { libc::fcntl(fd, libc::F_SETLEASE, libc::F_WRLCK) } != 0 {
        return Ok(false); // somebody has it open
    }
    let v = format!("{}:{}", off, size);
    let ts = times(mtime_ns);
    unsafe {
        libc::fsetxattr(fd, xname(), v.as_ptr() as *const libc::c_void, v.len(), 0);
        libc::fallocate(fd, libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE, 0, size as libc::off_t);
        libc::futimens(fd, ts.as_ptr());
        libc::fcntl(fd, libc::F_SETLEASE, libc::F_UNLCK);
    }
    drop(f);
    Ok(true)
}
