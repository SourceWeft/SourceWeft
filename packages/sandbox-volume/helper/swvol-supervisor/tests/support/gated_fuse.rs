//! Test-only real FUSE ASYNC_DIO boundary. Workload writes remain pending until
//! the controller releases actual backing writes and their kernel FUSE replies.
//! No completion is synthesized; the original native-AIO workload checks every
//! io_getevents result. This server never belongs to the frozen workload leaf.
use fuser::{
    BackgroundSession, FileAttr, FileType, Filesystem, KernelConfig, MountOption, ReplyAttr,
    ReplyData, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyWrite, Request, TimeOrNow,
};
use std::{
    ffi::{CString, OsStr},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{FileExt, MetadataExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
pub const SIZE: u64 = 256 * 1024 * 1024;
struct Pending {
    offset: u64,
    bytes: usize,
    path: PathBuf,
    reply: ReplyWrite,
}
struct Shared {
    root: PathBuf,
    backing: File,
    queue: Mutex<Vec<Pending>>,
    received: AtomicU64,
    requests: AtomicU64,
    min_write: AtomicU64,
    max_write: AtomicU64,
    written: AtomicU64,
    ready: AtomicBool,
    release: AtomicBool,
    stop: AtomicBool,
    complete: AtomicBool,
    failure: Mutex<Option<String>>,
}
impl Shared {
    fn fail(&self, error: impl ToString) {
        let mut failure = self.failure.lock().unwrap();
        if failure.is_none() {
            *failure = Some(error.to_string());
        }
    }
}
struct Files {
    shared: Arc<Shared>,
    size: u64,
    reserved: u64,
}
fn attr(ino: u64, size: u64) -> FileAttr {
    FileAttr {
        ino,
        size: if ino == 1 { 0 } else { size },
        blocks: (size + 511) / 512,
        atime: UNIX_EPOCH,
        mtime: UNIX_EPOCH,
        ctime: UNIX_EPOCH,
        crtime: UNIX_EPOCH,
        kind: if ino == 1 {
            FileType::Directory
        } else {
            FileType::RegularFile
        },
        perm: if ino == 1 { 0o755 } else { 0o600 },
        nlink: 1,
        uid: 65534,
        gid: 65534,
        rdev: 0,
        blksize: 4096,
        flags: 0,
    }
}
impl Filesystem for Files {
    fn init(&mut self, _: &Request<'_>, config: &mut KernelConfig) -> Result<(), i32> {
        // Unlike fuser's default flags, this explicit capability is required.
        config
            .add_capabilities(fuser::consts::FUSE_ASYNC_DIO)
            .map_err(|bits| {
                self.shared
                    .fail(format!("kernel lacks FUSE_ASYNC_DIO: {bits}"));
                libc::ENOTSUP
            })?;
        config
            .set_max_write(1024 * 1024)
            .map_err(|_| libc::EINVAL)?;
        config.set_max_background(512).map_err(|_| libc::EINVAL)?;
        self.shared.ready.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn lookup(&mut self, _: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        if parent == 1 && name == OsStr::new("data") {
            reply.entry(&Duration::ZERO, &attr(2, self.size), 0)
        } else {
            reply.error(libc::ENOENT)
        }
    }
    fn getattr(&mut self, _: &Request<'_>, ino: u64, _: Option<u64>, reply: ReplyAttr) {
        if ino == 1 || ino == 2 {
            reply.attr(&Duration::ZERO, &attr(ino, self.size))
        } else {
            reply.error(libc::ENOENT)
        }
    }
    fn setattr(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        _: Option<u32>,
        _: Option<u32>,
        _: Option<u32>,
        size: Option<u64>,
        _: Option<TimeOrNow>,
        _: Option<TimeOrNow>,
        _: Option<SystemTime>,
        _: Option<u64>,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
        _: Option<u32>,
        reply: ReplyAttr,
    ) {
        if ino != 2 {
            reply.error(libc::ENOENT);
            return;
        }
        if let Some(n) = size {
            if self.reserved != 0 || n > SIZE {
                reply.error(libc::EINVAL);
                return;
            }
            if let Err(e) = self.shared.backing.set_len(n) {
                self.shared.fail(e);
                reply.error(libc::EIO);
                return;
            }
            self.size = n;
        }
        reply.attr(&Duration::ZERO, &attr(ino, self.size))
    }
    fn open(&mut self, _: &Request<'_>, ino: u64, _: i32, reply: ReplyOpen) {
        if ino == 2 {
            reply.opened(2, fuser::consts::FOPEN_DIRECT_IO)
        } else {
            reply.error(libc::ENOENT)
        }
    }
    fn fallocate(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        _: u64,
        offset: i64,
        length: i64,
        mode: i32,
        reply: ReplyEmpty,
    ) {
        if ino != 2 || offset != 0 || length != SIZE as i64 || mode != 0 || self.reserved != 0 {
            reply.error(libc::EINVAL);
            return;
        }
        let error =
            unsafe { libc::posix_fallocate(self.shared.backing.as_raw_fd(), 0, SIZE as i64) };
        if error != 0 {
            self.shared
                .fail(format!("real backing allocation errno {error}"));
            reply.error(error);
            return;
        }
        if let Err(e) = self.shared.backing.sync_data() {
            self.shared.fail(e);
            reply.error(libc::EIO);
            return;
        }
        self.size = SIZE;
        reply.ok()
    }
    fn write(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        _: u64,
        offset: i64,
        data: &[u8],
        _: u32,
        _: i32,
        _: Option<u64>,
        reply: ReplyWrite,
    ) {
        if self.shared.stop.load(Ordering::SeqCst) {
            reply.error(libc::EINTR);
            return;
        }
        if ino != 2
            || offset < 0
            || offset as u64 + data.len() as u64 > SIZE
            || self.reserved + data.len() as u64 > SIZE
        {
            self.shared.fail("unexpected write range");
            reply.error(libc::EINVAL);
            return;
        }
        self.reserved += data.len() as u64;
        let path = self.shared.root.join(format!("spool-{offset}"));
        let stored = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            file.write_all(data)?;
            file.sync_data()
        })(); // Preparation must not leave spool writeback throttling the observation window.
        if let Err(e) = stored {
            self.shared.fail(e);
            reply.error(libc::EIO);
            return;
        }
        self.shared.queue.lock().unwrap().push(Pending {
            offset: offset as u64,
            bytes: data.len(),
            path,
            reply,
        });
        self.shared.requests.fetch_add(1, Ordering::SeqCst);
        self.shared
            .min_write
            .fetch_min(data.len() as u64, Ordering::SeqCst);
        self.shared
            .max_write
            .fetch_max(data.len() as u64, Ordering::SeqCst);
        self.shared
            .received
            .fetch_add(data.len() as u64, Ordering::SeqCst);
    }
    fn read(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        _: u64,
        offset: i64,
        size: u32,
        _: i32,
        _: Option<u64>,
        reply: ReplyData,
    ) {
        if ino != 2 || offset < 0 {
            reply.error(libc::EINVAL);
            return;
        }
        let mut bytes = vec![0; size as usize];
        match self.shared.backing.read_at(&mut bytes, offset as u64) {
            Ok(n) => reply.data(&bytes[..n]),
            Err(e) => {
                self.shared.fail(e);
                reply.error(libc::EIO)
            }
        }
    }
    fn flush(&mut self, _: &Request<'_>, _: u64, _: u64, _: u64, reply: ReplyEmpty) {
        reply.ok()
    }
    fn fsync(&mut self, _: &Request<'_>, _: u64, _: u64, _: bool, reply: ReplyEmpty) {
        match self.shared.backing.sync_all() {
            Ok(()) => reply.ok(),
            Err(e) => {
                self.shared.fail(e);
                reply.error(libc::EIO)
            }
        }
    }
}
// A private mount namespace view; only the verified connection's pre-opened
// abort fd is writable. Dropping the view never edits another connection.
struct ControlMount {
    path: PathBuf,
    active: bool,
}
impl ControlMount {
    fn close(&mut self) -> std::io::Result<()> {
        if self.active {
            detach(&self.path)?;
            self.active = false;
        }
        Ok(())
    }
}
impl Drop for ControlMount {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("owned FUSE control view did not unmount: {error}");
        }
    }
}
fn detach(path: &Path) -> std::io::Result<()> {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    if unsafe { libc::umount2(path.as_ptr(), libc::MNT_DETACH) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[derive(Debug, PartialEq, Eq)]
struct MountIdentity {
    canonical: PathBuf,
    mount_id: String,
    device: u64,
}
impl MountIdentity {
    fn read(path: &Path) -> std::io::Result<Self> {
        let canonical = path.canonicalize()?;
        let device = fs::metadata(&canonical)?.dev();
        let mounts = fs::read_to_string("/proc/self/mountinfo")?;
        let expected_device = format!("{}:{}", libc::major(device), libc::minor(device));
        for line in mounts.lines() {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.get(4).copied() != canonical.to_str() {
                continue;
            }
            let sep = fields
                .iter()
                .position(|f| *f == "-")
                .ok_or_else(|| std::io::Error::other("invalid mount identity"))?;
            if fields.get(2) != Some(&expected_device.as_str())
                || fields.get(sep + 1) != Some(&"fuse")
                || fields.get(sep + 2) != Some(&"swvol-owned-aio-gate")
            {
                return Err(std::io::Error::other(
                    "mount is not the owned FUSE filesystem",
                ));
            }
            return Ok(Self {
                canonical,
                mount_id: fields[0].into(),
                device,
            });
        }
        Err(std::io::Error::other(
            "owned FUSE mount is no longer present; do not guess a connection",
        ))
    }
}
pub struct GatedFuse {
    shared: Arc<Shared>,
    session: Option<BackgroundSession>,
    worker: Option<JoinHandle<()>>,
    backing: PathBuf,
    mountpoint: PathBuf,
    identity: MountIdentity,
    abort: Option<File>,
    control_mount: Option<ControlMount>,
}
impl GatedFuse {
    pub fn mount(mount: &Path, private: &Path) -> Self {
        fs::create_dir(mount).unwrap();
        fs::create_dir(private).unwrap();
        fs::set_permissions(private, fs::Permissions::from_mode(0o700)).unwrap();
        let backing = private.join("backing");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&backing)
            .unwrap();
        let shared = Arc::new(Shared {
            root: private.into(),
            backing: file,
            queue: Mutex::new(vec![]),
            received: AtomicU64::new(0),
            requests: AtomicU64::new(0),
            min_write: AtomicU64::new(u64::MAX),
            max_write: AtomicU64::new(0),
            written: AtomicU64::new(0),
            ready: AtomicBool::new(false),
            release: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            complete: AtomicBool::new(false),
            failure: Mutex::new(None),
        });
        let session = fuser::spawn_mount2(
            Files {
                shared: shared.clone(),
                size: 0,
                reserved: 0,
            },
            mount,
            &[
                MountOption::FSName("swvol-owned-aio-gate".into()),
                MountOption::AllowOther,
                MountOption::DefaultPermissions,
            ],
        )
        .expect("real test FUSE mount must be available");
        let control_path = private.join("fusectl");
        fs::create_dir(&control_path).unwrap();
        let control_c = CString::new(control_path.as_os_str().as_bytes()).unwrap();
        assert_eq!(
            unsafe {
                libc::mount(
                    c"fusectl".as_ptr(),
                    control_c.as_ptr(),
                    c"fusectl".as_ptr(),
                    0,
                    std::ptr::null(),
                )
            },
            0,
            "owned FUSE control view must be mountable: {}",
            std::io::Error::last_os_error()
        );
        let control_mount = ControlMount {
            path: control_path,
            active: true,
        };
        let identity = MountIdentity::read(mount).expect(
            "capture exact owned mount ID/path/fsname/device before opening its abort capability",
        );
        let device = identity.device;
        assert_eq!(
            libc::major(device),
            0,
            "FUSE mount must have its own anonymous device"
        );
        let connection = libc::minor(device).to_string();
        let abort = OpenOptions::new()
            .write(true)
            .open(control_mount.path.join(&connection).join("abort"))
            .expect("open only this mount's kernel FUSE connection abort capability");
        let worker_shared = shared.clone();
        let worker = std::thread::spawn(move || {
            let s = worker_shared;
            while !s.release.load(Ordering::SeqCst) && !s.stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
            while !s.stop.load(Ordering::SeqCst) {
                let pending = std::mem::take(&mut *s.queue.lock().unwrap());
                for item in pending {
                    if s.stop.load(Ordering::SeqCst) {
                        item.reply.error(libc::EINTR);
                        continue;
                    }
                    let written = (|| -> std::io::Result<()> {
                        let mut bytes = vec![];
                        File::open(&item.path)?.read_to_end(&mut bytes)?;
                        if bytes.len() != item.bytes {
                            return Err(std::io::Error::other("spool length changed"));
                        }
                        s.backing.write_all_at(&bytes, item.offset)
                    })();
                    match written {
                        Ok(()) => {
                            s.written.fetch_add(item.bytes as u64, Ordering::SeqCst);
                            item.reply.written(item.bytes as u32);
                            if let Err(e) = fs::remove_file(item.path) {
                                s.fail(e)
                            }
                        }
                        Err(e) => {
                            s.fail(e);
                            item.reply.error(libc::EIO)
                        }
                    }
                }
                if s.written.load(Ordering::SeqCst) == SIZE {
                    match s.backing.sync_all() {
                        Ok(()) => s.complete.store(true, Ordering::SeqCst),
                        Err(e) => s.fail(e),
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            // Dropping un-replied requests sends EIO on a failed test's cleanup.
            s.queue.lock().unwrap().clear();
        });
        Self {
            shared,
            session: Some(session),
            worker: Some(worker),
            backing,
            mountpoint: identity.canonical.clone(),
            identity,
            abort: Some(abort),
            control_mount: Some(control_mount),
        }
    }
    pub fn assert_healthy(&self) {
        let failure = self.shared.failure.lock().unwrap();
        assert!(failure.is_none(), "real FUSE gate failure: {failure:?}");
    }
    pub fn ready(&self) -> bool {
        self.assert_healthy();
        self.shared.ready.load(Ordering::SeqCst)
    }
    pub fn received(&self) -> u64 {
        self.assert_healthy();
        self.shared.received.load(Ordering::SeqCst)
    }
    pub fn stats(&self) -> (u64, u64, u64) {
        (
            self.shared.requests.load(Ordering::SeqCst),
            self.shared.min_write.load(Ordering::SeqCst),
            self.shared.max_write.load(Ordering::SeqCst),
        )
    }
    pub fn release(&self) {
        self.assert_healthy();
        assert!(
            !self.shared.release.swap(true, Ordering::SeqCst),
            "test release must be exactly once"
        );
    }
    pub fn complete(&self) -> bool {
        self.assert_healthy();
        self.shared.complete.load(Ordering::SeqCst)
    }
    pub fn backing(&self) -> &Path {
        &self.backing
    }
}
fn bounded_join<T>(thread: JoinHandle<T>) -> Result<T, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !thread.is_finished() {
        if Instant::now() >= deadline {
            return Err(
                "owned test worker did not exit within cleanup budget; retain fixture evidence"
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    thread
        .join()
        .map_err(|_| "owned test worker panicked".into())
}
impl GatedFuse {
    fn shutdown(&mut self) -> Result<(), String> {
        self.shared.stop.store(true, Ordering::SeqCst);
        let mut errors = vec![];
        if let Some(worker) = self.worker.take() {
            if let Err(error) = bounded_join(worker) {
                errors.push(error);
            }
        }
        if self.session.is_some() {
            let current = MountIdentity::read(&self.mountpoint);
            if current.as_ref().ok() != Some(&self.identity) {
                // Do not let fuser's path-based Drop unmount an unrelated
                // replacement. Preserve evidence and fail the test instead.
                if let Some(session) = self.session.take() {
                    std::mem::forget(session);
                }
                self.abort.take();
                self.control_mount.take();
                let error=format!("owned mount identity changed; no connection aborted or mount detached: {current:?}");
                let _ = fs::write(
                    self.shared
                        .root
                        .parent()
                        .unwrap()
                        .join(".gated-cleanup-unconfirmed"),
                    &error,
                );
                return Err(error);
            }
        }
        if let Some(mut abort) = self.abort.take() {
            if let Err(e) = abort.write_all(b"1") {
                errors.push(format!("owned FUSE abort failed: {e}"));
            }
        }
        if self.session.is_some() {
            if let Err(e) = detach(&self.mountpoint) {
                errors.push(format!("owned FUSE detach failed: {e}"));
            }
        }
        if let Some(session) = self.session.take() {
            let joiner = std::thread::Builder::new()
                .name("owned-fuse-cleanup".into())
                .spawn(move || {
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| session.join()))
                });
            match joiner {
                Ok(joiner) => match bounded_join(joiner) {
                    Ok(Ok(())) => {}
                    _ => errors.push(
                        "FUSE dispatch did not exit cleanly within cleanup budget".to_owned(),
                    ),
                },
                Err(error) => {
                    errors.push(format!("cannot start bounded owned-FUSE cleanup: {error}"))
                }
            }
        }
        if let Some(mut control) = self.control_mount.take() {
            if let Err(error) = control.close() {
                errors.push(format!("owned FUSE control view did not unmount: {error}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            let _ = fs::write(
                self.shared
                    .root
                    .parent()
                    .unwrap()
                    .join(".gated-cleanup-unconfirmed"),
                errors.join("; "),
            );
            Err(errors.join("; "))
        }
    }
    pub fn close(mut self) -> Result<(), String> {
        self.shutdown()
    }
}
impl Drop for GatedFuse {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            eprintln!("owned gated FUSE cleanup failed: {error}");
        }
    }
}
