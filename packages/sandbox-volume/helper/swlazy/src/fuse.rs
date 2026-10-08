//! Read-only lazy filesystem: metadata from the plan (in memory), content fetched on first read
//! through the block store. Meant to be the lower layer of an overlay whose upper layer is local disk.
use crate::plan::Plan;
use crate::store::Store;
use fuser::{FileAttr, FileType, Filesystem, KernelConfig, MountOption, ReplyAttr, ReplyData, ReplyDirectory, ReplyDirectoryPlus, ReplyEntry, ReplyOpen, ReplyStatfs, Request};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TTL: Duration = Duration::from_secs(86400);

struct Node {
    parent: u64,
    kind: FileType,
    perm: u16,
    mtime: SystemTime,
    size: u64,
    off: u64,
    link: Vec<u8>,
    children: Vec<(Vec<u8>, u64)>,
    chunks: Arc<Vec<swvol_core::ChunkRef>>,
}

pub struct LazyFs {
    nodes: Vec<Node>,
    names: HashMap<(u64, Vec<u8>), u64>,
    store: Option<Arc<Store>>,
    uid: u32,
    gid: u32,
    total: u64,
    /// The kernel accepts "no open handler": after one ENOSYS it stops asking us on every open.
    no_open: bool,
    no_opendir: bool,
    volume_jobs: Option<std::sync::mpsc::SyncSender<VolumeRead>>,
}
struct VolumeRead {
    chunks: Arc<Vec<swvol_core::ChunkRef>>,
    offset: u64,
    size: usize,
    reply: ReplyData,
}

fn ts(ns: i64) -> SystemTime {
    if ns >= 0 { UNIX_EPOCH + Duration::from_nanos(ns as u64) } else { UNIX_EPOCH }
}

impl LazyFs {
    pub fn new(plan: &Plan, store: Option<Arc<Store>>) -> LazyFs {
        let mut fs = LazyFs {
            nodes: Vec::with_capacity(plan.entries.len() + 2),
            names: HashMap::with_capacity(plan.entries.len()),
            store,
            // The daemon may run as a dedicated system user; the files it presents belong to the workspace user.
            uid: std::env::var("SWLAZY_UID").ok().and_then(|v| v.parse().ok()).unwrap_or_else(|| unsafe { libc::getuid() }),
            gid: std::env::var("SWLAZY_GID").ok().and_then(|v| v.parse().ok()).unwrap_or_else(|| unsafe { libc::getgid() }),
            total: plan.total,
            no_open: false,
            no_opendir: false,
            volume_jobs: None,
        };
        let dir = |parent| Node { parent, kind: FileType::Directory, perm: 0o755, mtime: UNIX_EPOCH, size: 0, off: 0, link: vec![], children: vec![], chunks: Arc::new(vec![]) };
        fs.nodes.push(dir(0)); // ino 0 unused
        fs.nodes.push(dir(1)); // root
        for e in &plan.entries {
            let mut parent = 1u64;
            let parts: Vec<&str> = e.p.split('/').collect();
            for (i, part) in parts.iter().enumerate() {
                let key = (parent, part.as_bytes().to_vec());
                let last = i + 1 == parts.len();
                let ino = match fs.names.get(&key) {
                    Some(x) => *x,
                    None => {
                        let ino = fs.nodes.len() as u64;
                        fs.nodes.push(dir(parent));
                        fs.nodes[parent as usize].children.push((key.1.clone(), ino));
                        fs.names.insert(key, ino);
                        ino
                    }
                };
                if last {
                    let n = &mut fs.nodes[ino as usize];
                    n.perm = (e.m & 0o7777) as u16;
                    n.mtime = ts(e.t);
                    match e.k.as_str() {
                        "d" => {}
                        "l" => {
                            n.kind = FileType::Symlink;
                            n.link = e.l.clone().unwrap_or_default().into_bytes();
                            n.size = n.link.len() as u64;
                        }
                        _ => {
                            n.kind = FileType::RegularFile;
                            n.size = e.s;
                            n.off = e.o;
                        }
                    }
                }
                parent = ino;
            }
        }
        fs
    }

    fn attr(&self, ino: u64) -> FileAttr {
        let n = &self.nodes[ino as usize];
        FileAttr {
            ino,
            size: n.size,
            blocks: (n.size + 511) / 512,
            atime: n.mtime,
            mtime: n.mtime,
            ctime: n.mtime,
            crtime: n.mtime,
            kind: n.kind,
            perm: n.perm,
            nlink: if n.kind == FileType::Directory { 2 } else { 1 },
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: 4096,
            flags: 0,
        }
    }

    fn valid(&self, ino: u64) -> bool {
        ino >= 1 && (ino as usize) < self.nodes.len()
    }
}

impl Filesystem for LazyFs {
    fn init(&mut self, _req: &Request<'_>, config: &mut KernelConfig) -> Result<(), libc::c_int> {
        let _ = config.set_max_readahead(1 << 20);
        let _ = config.add_capabilities(fuser::consts::FUSE_DO_READDIRPLUS);
        let _ = config.add_capabilities(fuser::consts::FUSE_READDIRPLUS_AUTO);
        let _ = config.add_capabilities(fuser::consts::FUSE_PARALLEL_DIROPS);
        let _ = config.add_capabilities(fuser::consts::FUSE_CACHE_SYMLINKS);
        if std::env::var("SWLAZY_FUSE_OPEN").is_err() {
            self.no_open = config.add_capabilities(fuser::consts::FUSE_NO_OPEN_SUPPORT).is_ok();
            self.no_opendir = config.add_capabilities(fuser::consts::FUSE_NO_OPENDIR_SUPPORT).is_ok();
        }
        eprintln!("fuse init: no_open={} no_opendir={}", self.no_open, self.no_opendir);
        Ok(())
    }

    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        match self.names.get(&(parent, name.as_bytes().to_vec())) {
            Some(ino) => reply.entry(&TTL, &self.attr(*ino), 0),
            None => reply.error(libc::ENOENT),
        }
    }

    fn getattr(&mut self, _req: &Request<'_>, ino: u64, _fh: Option<u64>, reply: ReplyAttr) {
        if self.valid(ino) { reply.attr(&TTL, &self.attr(ino)) } else { reply.error(libc::ENOENT) }
    }

    fn readlink(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyData) {
        if self.valid(ino) { reply.data(&self.nodes[ino as usize].link) } else { reply.error(libc::ENOENT) }
    }

    fn open(&mut self, _req: &Request<'_>, ino: u64, flags: i32, reply: ReplyOpen) {
        if !self.valid(ino) {
            return reply.error(libc::ENOENT);
        }
        if flags & libc::O_ACCMODE != libc::O_RDONLY {
            return reply.error(libc::EROFS);
        }
        if self.no_open {
            // Kernel default for handler-less opens is "keep the page cache": exactly what we want.
            return reply.error(libc::ENOSYS);
        }
        // Content never changes under a given mount: let the kernel keep its page cache across opens.
        reply.opened(0, fuser::consts::FOPEN_KEEP_CACHE);
    }

    fn read(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, size: u32, _flags: i32, _lock: Option<u64>, reply: ReplyData) {
        if !self.valid(ino) {
            return reply.error(libc::ENOENT);
        }
        let n = &self.nodes[ino as usize];
        let off = offset.max(0) as u64;
        if off >= n.size {
            return reply.data(&[]);
        }
        let len = (size as u64).min(n.size - off) as usize;
        if let Some(jobs) = &self.volume_jobs {
            if len > 8 * 1024 * 1024 { return reply.error(libc::EINVAL); }
            let job = VolumeRead { chunks: n.chunks.clone(), offset: off, size: len, reply };
            if let Err(error) = jobs.try_send(job) {
                match error {
                    std::sync::mpsc::TrySendError::Full(job) => job.reply.error(libc::EAGAIN),
                    std::sync::mpsc::TrySendError::Disconnected(job) => job.reply.error(libc::EIO),
                }
            }
            return;
        }
        let Some(store) = self.store.clone() else { return reply.error(libc::EIO) };
        let pos = n.off + off;
        let mut buf = vec![0u8; len];
        if store.try_read_cached(pos, &mut buf) {
            return reply.data(&buf);
        }
        // Needs the network: answer from another thread so the request loop keeps serving.
        std::thread::spawn(move || match store.read_at(pos, &mut buf) {
            Ok(()) => reply.data(&buf),
            Err(e) => {
                eprintln!("read failed: {}", e);
                reply.error(libc::EIO)
            }
        });
    }

    fn opendir(&mut self, _req: &Request<'_>, _ino: u64, _flags: i32, reply: ReplyOpen) {
        if self.no_opendir {
            return reply.error(libc::ENOSYS);
        }
        reply.opened(0, fuser::consts::FOPEN_KEEP_CACHE | fuser::consts::FOPEN_CACHE_DIR);
    }

    fn readdir(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, mut reply: ReplyDirectory) {
        if !self.valid(ino) {
            return reply.error(libc::ENOENT);
        }
        let n = &self.nodes[ino as usize];
        let mut i = offset;
        loop {
            let full = match i {
                0 => reply.add(ino, 1, FileType::Directory, "."),
                1 => reply.add(n.parent.max(1), 2, FileType::Directory, ".."),
                _ => match n.children.get((i - 2) as usize) {
                    Some((name, c)) => reply.add(*c, i + 1, self.nodes[*c as usize].kind, OsStr::from_bytes(name)),
                    None => break,
                },
            };
            if full {
                break;
            }
            i += 1;
        }
        reply.ok();
    }

    fn readdirplus(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64, mut reply: ReplyDirectoryPlus) {
        if !self.valid(ino) {
            return reply.error(libc::ENOENT);
        }
        let n = &self.nodes[ino as usize];
        let mut i = offset;
        loop {
            let full = match i {
                0 => reply.add(ino, 1, ".", &TTL, &self.attr(ino), 0),
                1 => reply.add(n.parent.max(1), 2, "..", &TTL, &self.attr(n.parent.max(1)), 0),
                _ => match n.children.get((i - 2) as usize) {
                    Some((name, c)) => reply.add(*c, i + 1, OsStr::from_bytes(name), &TTL, &self.attr(*c), 0),
                    None => break,
                },
            };
            if full {
                break;
            }
            i += 1;
        }
        reply.ok();
    }

    fn statfs(&mut self, _req: &Request<'_>, _ino: u64, reply: ReplyStatfs) {
        reply.statfs(self.total / 4096 + 1, 0, 0, self.nodes.len() as u64, 0, 4096, 255, 4096);
    }
}

pub fn mount(plan: &Plan, store: Option<Arc<Store>>, mountpoint: &str, allow_other: bool) -> std::io::Result<()> {
    let fs = LazyFs::new(plan, store);
    let mut opts = vec![MountOption::RO, MountOption::FSName("swlazy".into()), MountOption::Subtype("swlazy".into()), MountOption::DefaultPermissions, MountOption::NoAtime];
    if allow_other {
        opts.push(MountOption::AllowOther);
    }
    let nodes = fs.nodes.len() - 1;
    let session = fuser::spawn_mount2(fs, mountpoint, &opts)?;
    eprintln!("mounted {} nodes at {}", nodes, mountpoint);
    // join() would unmount. Stay until somebody unmounts us (the request loop then ends by itself).
    while !session.guard.is_finished() {
        std::thread::sleep(Duration::from_millis(200));
    }
    std::mem::forget(session);
    Ok(())
}

/// Mount the production chunk format with bounded network workers. No active
/// tree or inode map is changed during this mount's lifetime.
pub fn mount_volume(plan: &swvol_core::RestorePlan, store: Arc<crate::volume::VolumeStore>, mountpoint: &str, allow_other: bool) -> std::io::Result<()> {
    let view = Plan {
        pack_size: 0, total: plan.entries.iter().map(|entry| entry.s).sum(), packs: vec![],
        entries: plan.entries.iter().map(|entry| crate::plan::Entry { p: entry.p.clone(), k: entry.k.to_string(), m: entry.m, t: entry.t, s: entry.s, o: 0, l: entry.l.clone() }).collect(),
    };
    let mut fs = LazyFs::new(&view, None);
    for entry in &plan.entries {
        let mut ino = 1;
        for component in entry.p.split('/') { ino = fs.names[&(ino, component.as_bytes().to_vec())]; }
        fs.nodes[ino as usize].chunks = Arc::new(entry.c.clone());
    }
    let (tx, rx) = std::sync::mpsc::sync_channel::<VolumeRead>(32);
    let rx = Arc::new(std::sync::Mutex::new(rx));
    for _ in 0..4 {
        let (rx, store) = (rx.clone(), store.clone());
        std::thread::spawn(move || loop {
            let job = rx.lock().unwrap().recv();
            let Ok(job) = job else { break; };
            let mut data = vec![0; job.size];
            match store.read(&job.chunks, job.offset, &mut data) {
                Ok(()) => job.reply.data(&data),
                Err(error) => { eprintln!("volume read failed: {error:#}"); job.reply.error(libc::EIO); }
            }
        });
    }
    fs.volume_jobs = Some(tx);
    let mut opts = vec![MountOption::RO, MountOption::FSName("swvol".into()), MountOption::Subtype("swvol".into()), MountOption::DefaultPermissions, MountOption::NoAtime];
    if allow_other { opts.push(MountOption::AllowOther); }
    fuser::mount2(fs, mountpoint, &opts)
}
