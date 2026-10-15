//! Unprivileged on-demand loading with seccomp user notification.
//!
//! `run` installs a seccomp filter on itself (needs only no_new_privs), hands the notification fd
//! to the daemon over a unix socket, and execs the command. Every open / exec / truncate by the
//! command or its descendants is paused in the kernel until the daemon answers. The daemon looks at
//! the path; if it is a placeholder, it fills the file first; then it lets the syscall continue.
use crate::hydrate::{self, Outcome};
use crate::store::Store;
use anyhow::{bail, Result};
use std::ffi::CString;
use std::io::{Read, Write};
use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

const SECCOMP_SET_MODE_FILTER: libc::c_ulong = 1;
const SECCOMP_FILTER_FLAG_NEW_LISTENER: libc::c_ulong = 1 << 3;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_RET_USER_NOTIF: u32 = 0x7fc0_0000;
const SECCOMP_IOCTL_NOTIF_RECV: libc::c_ulong = 0xc050_2100;
const SECCOMP_IOCTL_NOTIF_SEND: libc::c_ulong = 0xc018_2101;
const SECCOMP_IOCTL_NOTIF_ID_VALID: libc::c_ulong = 0x4008_2102;
const SECCOMP_IOCTL_NOTIF_SET_FLAGS: libc::c_ulong = 0x4008_2104;
const SECCOMP_USER_NOTIF_FLAG_CONTINUE: u32 = 1;
const SECCOMP_USER_NOTIF_FD_SYNC_WAKE_UP: u64 = 1;

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xC000_003E;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xC000_00B7;

#[repr(C)]
#[derive(Clone, Copy)]
struct SeccompData {
    nr: i32,
    arch: u32,
    ip: u64,
    args: [u64; 6],
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Notif {
    id: u64,
    pid: u32,
    flags: u32,
    data: SeccompData,
}
#[repr(C)]
struct NotifResp {
    id: u64,
    val: i64,
    error: i32,
    flags: u32,
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

// ---------------------------------------------------------------- filter

enum T {
    Allow,
    Notif,
    Block(usize),
    Next,
}
struct Ins {
    code: u16,
    k: u32,
    jt: T,
    jf: T,
}

/// Syscalls that always notify, and syscalls that notify depending on their flags argument.
fn syscalls() -> (Vec<i64>, Vec<(i64, u32)>) {
    let mut plain = vec![libc::SYS_openat2, libc::SYS_execve, libc::SYS_execveat, libc::SYS_truncate];
    let mut flagged = vec![(libc::SYS_openat, 2u32)];
    #[cfg(target_arch = "x86_64")]
    {
        plain.push(libc::SYS_creat);
        flagged.push((libc::SYS_open, 1));
    }
    let _ = &mut plain;
    let _ = &mut flagged;
    (plain, flagged)
}

fn build_filter(filter_flags: bool) -> Vec<libc::sock_filter> {
    const LD: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
    const JEQ: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
    const JSET: u16 = 0x45; // BPF_JMP | BPF_JSET | BPF_K
    const AND: u16 = 0x54; // BPF_ALU | BPF_AND | BPF_K
    const RET: u16 = 0x06;
    let (mut plain, mut flagged) = syscalls();
    if !filter_flags {
        plain.extend(flagged.iter().map(|x| x.0));
        flagged.clear();
    }
    let mut p: Vec<Ins> = Vec::new();
    p.push(Ins { code: LD, k: 4, jt: T::Next, jf: T::Next });
    p.push(Ins { code: JEQ, k: AUDIT_ARCH, jt: T::Next, jf: T::Allow });
    p.push(Ins { code: LD, k: 0, jt: T::Next, jf: T::Next });
    for nr in &plain {
        p.push(Ins { code: JEQ, k: *nr as u32, jt: T::Notif, jf: T::Next });
    }
    for (i, (nr, _)) in flagged.iter().enumerate() {
        p.push(Ins { code: JEQ, k: *nr as u32, jt: T::Block(i), jf: T::Next });
    }
    p.push(Ins { code: RET, k: SECCOMP_RET_ALLOW, jt: T::Next, jf: T::Next });
    let mut block_at = Vec::new();
    let skip = (libc::O_DIRECTORY | libc::O_PATH) as u32;
    let excl = (libc::O_CREAT | libc::O_EXCL) as u32;
    for (_, arg) in &flagged {
        block_at.push(p.len());
        // Opening a directory, an O_PATH handle, or a file that must not exist yet can never need content.
        p.push(Ins { code: LD, k: 16 + 8 * arg, jt: T::Next, jf: T::Next });
        p.push(Ins { code: JSET, k: skip, jt: T::Allow, jf: T::Next });
        p.push(Ins { code: AND, k: excl, jt: T::Next, jf: T::Next });
        p.push(Ins { code: JEQ, k: excl, jt: T::Allow, jf: T::Notif });
    }
    let allow_at = p.len();
    p.push(Ins { code: RET, k: SECCOMP_RET_ALLOW, jt: T::Next, jf: T::Next });
    let notif_at = p.len();
    p.push(Ins { code: RET, k: SECCOMP_RET_USER_NOTIF, jt: T::Next, jf: T::Next });
    let resolve = |t: &T, at: usize| -> u8 {
        let target = match t {
            T::Next => return 0,
            T::Allow => allow_at,
            T::Notif => notif_at,
            T::Block(i) => block_at[*i],
        };
        (target - at - 1) as u8
    };
    p.iter().enumerate().map(|(i, x)| libc::sock_filter { code: x.code, jt: resolve(&x.jt, i), jf: resolve(&x.jf, i), k: x.k }).collect()
}

// ---------------------------------------------------------------- run wrapper

fn send_fd(sock: &UnixStream, tag: u8, fd: RawFd) -> Result<()> {
    let mut cbuf = [0u8; 64];
    let mut iov = libc::iovec { iov_base: &tag as *const u8 as *mut libc::c_void, iov_len: 1 };
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cbuf.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = unsafe { libc::CMSG_SPACE(4) } as _;
    unsafe {
        let c = libc::CMSG_FIRSTHDR(&msg);
        (*c).cmsg_level = libc::SOL_SOCKET;
        (*c).cmsg_type = libc::SCM_RIGHTS;
        (*c).cmsg_len = libc::CMSG_LEN(4) as _;
        std::ptr::copy_nonoverlapping(&fd as *const RawFd as *const u8, libc::CMSG_DATA(c), 4);
        if libc::sendmsg(sock.as_raw_fd(), &msg, 0) < 0 {
            bail!("sendmsg: errno {}", errno());
        }
    }
    Ok(())
}

fn recv_fd(sock: &UnixStream) -> Result<(u8, Option<RawFd>)> {
    let mut tag = 0u8;
    let mut cbuf = [0u8; 64];
    let mut iov = libc::iovec { iov_base: &mut tag as *mut u8 as *mut libc::c_void, iov_len: 1 };
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cbuf.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = cbuf.len() as _;
    let n = unsafe { libc::recvmsg(sock.as_raw_fd(), &mut msg, libc::MSG_CMSG_CLOEXEC) };
    if n <= 0 {
        bail!("recvmsg: {}", n);
    }
    let mut fd = None;
    unsafe {
        let c = libc::CMSG_FIRSTHDR(&msg);
        if !c.is_null() && (*c).cmsg_level == libc::SOL_SOCKET && (*c).cmsg_type == libc::SCM_RIGHTS {
            let mut v: RawFd = -1;
            std::ptr::copy_nonoverlapping(libc::CMSG_DATA(c), &mut v as *mut RawFd as *mut u8, 4);
            fd = Some(v);
        }
    }
    Ok((tag, fd))
}

/// Install the filter on this process, register with the daemon, exec the command.
pub fn run(sock_path: &str, argv: &[String]) -> Result<()> {
    if argv.is_empty() {
        bail!("no command");
    }
    let filter_flags = std::env::var("SWLAZY_NO_FLAG_FILTER").is_err();
    let prog = build_filter(filter_flags);
    let fprog = libc::sock_fprog { len: prog.len() as u16, filter: prog.as_ptr() as *mut libc::sock_filter };
    // Connect first: connecting after the filter is on would need an unfiltered path anyway.
    let sock = UnixStream::connect(sock_path).map_err(|e| anyhow::anyhow!("daemon not reachable at {}: {}", sock_path, e))?;
    let cargs: Vec<CString> = argv.iter().map(|a| CString::new(a.as_str()).unwrap()).collect();
    let mut ptrs: Vec<*const libc::c_char> = cargs.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            bail!("no_new_privs: errno {}", errno());
        }
        let fd = libc::syscall(libc::SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &fprog as *const libc::sock_fprog);
        if fd < 0 {
            bail!("seccomp(NEW_LISTENER): errno {}", errno());
        }
        send_fd(&sock, b'L', fd as RawFd)?;
        let mut ack = [0u8; 1];
        (&sock).read_exact(&mut ack)?;
        libc::close(fd as RawFd);
        drop(sock);
        libc::execvp(ptrs[0], ptrs.as_ptr());
        bail!("exec {}: errno {}", argv[0], errno());
    }
}

// ---------------------------------------------------------------- daemon

#[derive(Default)]
pub struct Counters {
    pub notifs: AtomicU64,
    pub skipped_prefix: AtomicU64,
    pub checked: AtomicU64,
    pub hydrated: AtomicU64,
    pub hydrated_bytes: AtomicU64,
    pub discarded: AtomicU64,
    pub failed: AtomicU64,
    pub handler_ns: AtomicU64,
    pub hydrate_ms: AtomicU64,
    pub listeners: AtomicU64,
    pub t_read_ns: AtomicU64,
    pub t_xattr_ns: AtomicU64,
    pub t_send_ns: AtomicU64,
}

pub struct Daemon {
    pub store: Arc<Store>,
    pub c: Counters,
    /// Directories the sandbox user cannot write: nothing under them can lead to a placeholder.
    pub skip: Vec<Vec<u8>>,
    /// Assume every caller shares our root directory and mount namespace: absolute paths are used as they are.
    pub trust_root: bool,
    /// Files this daemon filled, oldest first: the candidates for eviction when the disk runs low.
    pub filled: std::sync::Mutex<std::collections::VecDeque<hydrate::Filled>>,
    pub root: CString,
    /// Keep at least this many bytes free on the disk that holds the workspace.
    pub reserve: u64,
    pub evicted: AtomicU64,
    pub evicted_bytes: AtomicU64,
}

fn read_cstr(pid: u32, addr: u64) -> Option<Vec<u8>> {
    if addr == 0 {
        return None;
    }
    let mut buf = [0u8; 4096];
    let first = 4096 - (addr & 4095) as usize;
    let remote = [
        libc::iovec { iov_base: addr as *mut libc::c_void, iov_len: first },
        libc::iovec { iov_base: (addr + first as u64) as *mut libc::c_void, iov_len: 4096 - first },
    ];
    let local = libc::iovec { iov_base: buf.as_mut_ptr() as *mut libc::c_void, iov_len: 4096 };
    let n = unsafe { libc::process_vm_readv(pid as libc::pid_t, &local, 1, remote.as_ptr(), if first < 4096 { 2 } else { 1 }, 0) };
    if n <= 0 {
        return None;
    }
    let got = &buf[..n as usize];
    got.iter().position(|b| *b == 0).map(|p| got[..p].to_vec())
}

fn read_u64(pid: u32, addr: u64) -> Option<u64> {
    let mut v = 0u64;
    let remote = libc::iovec { iov_base: addr as *mut libc::c_void, iov_len: 8 };
    let local = libc::iovec { iov_base: &mut v as *mut u64 as *mut libc::c_void, iov_len: 8 };
    let n = unsafe { libc::process_vm_readv(pid as libc::pid_t, &local, 1, &remote, 1, 0) };
    if n == 8 { Some(v) } else { None }
}

fn respond(fd: RawFd, id: u64, error: i32) {
    let resp = NotifResp { id, val: 0, error: -error, flags: if error == 0 { SECCOMP_USER_NOTIF_FLAG_CONTINUE } else { 0 } };
    unsafe { libc::syscall(libc::SYS_ioctl, fd, SECCOMP_IOCTL_NOTIF_SEND, &resp as *const NotifResp) };
}

impl Daemon {
    fn free_bytes(&self) -> u64 {
        let mut v: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(self.root.as_ptr(), &mut v) } != 0 {
            return u64::MAX;
        }
        v.f_bavail as u64 * v.f_frsize as u64
    }

    /// Before filling `size` bytes: if the disk would drop under the reserve, turn the oldest filled
    /// files back into placeholders (only unmodified ones that nobody has open) until it fits.
    fn make_room(&self, size: u64) -> Result<()> {
        let mut q = self.filled.lock().unwrap();
        loop {
            if self.free_bytes() >= size.saturating_add(self.reserve) {
                return Ok(());
            }
            let Some(c) = q.pop_front() else {
                bail!("not enough disk: need {} bytes plus reserve, {} free, nothing left to evict", size, self.free_bytes());
            };
            if hydrate::dehydrate(&c.path, c.off, c.size, c.mtime_ns).unwrap_or(false) {
                self.evicted.fetch_add(1, Ordering::Relaxed);
                self.evicted_bytes.fetch_add(c.size, Ordering::Relaxed);
            }
        }
    }

    fn do_hydrate(&self, path: &CString, trunc: bool) -> Result<Outcome> {
        let r = hydrate::hydrate(path, &self.store, trunc, &|size| self.make_room(size))?;
        Ok(match r {
            Outcome::Hydrated(f) => {
                self.c.hydrated.fetch_add(1, Ordering::Relaxed);
                self.c.hydrated_bytes.fetch_add(f.size, Ordering::Relaxed);
                let keep = hydrate::Filled { path: f.path.clone(), off: f.off, size: f.size, mtime_ns: f.mtime_ns };
                self.filled.lock().unwrap().push_back(keep);
                Outcome::Hydrated(f)
            }
            other => other,
        })
    }

    /// Resolve the path the way the calling process sees it. None = cannot be a placeholder.
    fn resolve(&self, n: &Notif) -> Option<(CString, bool)> {
        let a = &n.data.args;
        let nr = n.data.nr as i64;
        let cwd = libc::AT_FDCWD as i64;
        let (dirfd, paddr, trunc): (i64, u64, bool) = if nr == libc::SYS_openat {
            (a[0] as i32 as i64, a[1], a[2] as i32 & libc::O_TRUNC != 0)
        } else if nr == libc::SYS_openat2 {
            let fl = read_u64(n.pid, a[2]).unwrap_or(0);
            if fl as i32 & (libc::O_DIRECTORY | libc::O_PATH) != 0 {
                return None;
            }
            (a[0] as i32 as i64, a[1], fl as i32 & libc::O_TRUNC != 0)
        } else if nr == libc::SYS_execve {
            (cwd, a[0], false)
        } else if nr == libc::SYS_execveat {
            (a[0] as i32 as i64, a[1], false)
        } else if nr == libc::SYS_truncate {
            (cwd, a[0], a[1] == 0)
        } else {
            #[cfg(target_arch = "x86_64")]
            {
                if nr == libc::SYS_open {
                    (cwd, a[0], a[1] as i32 & libc::O_TRUNC != 0)
                } else if nr == libc::SYS_creat {
                    (cwd, a[0], true)
                } else {
                    return None;
                }
            }
            #[cfg(not(target_arch = "x86_64"))]
            return None;
        };
        let path = read_cstr(n.pid, paddr)?;
        if path.is_empty() {
            return None;
        }
        let mut full: Vec<u8> = Vec::with_capacity(path.len() + 32);
        if path[0] == b'/' {
            if self.skip.iter().any(|p| path.starts_with(p)) {
                // The only way into a placeholder from here is through the caller's own fd table.
                if let Some(rest) = path.strip_prefix(b"/proc/self/fd/").or_else(|| path.strip_prefix(b"/dev/fd/")) {
                    full.extend_from_slice(format!("/proc/{}/fd/", n.pid).as_bytes());
                    full.extend_from_slice(rest);
                } else {
                    self.c.skipped_prefix.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
            } else if self.trust_root {
                full.extend_from_slice(&path);
            } else {
                full.extend_from_slice(format!("/proc/{}/root", n.pid).as_bytes());
                full.extend_from_slice(&path);
            }
        } else if dirfd == cwd {
            full.extend_from_slice(format!("/proc/{}/cwd/", n.pid).as_bytes());
            full.extend_from_slice(&path);
        } else {
            full.extend_from_slice(format!("/proc/{}/fd/{}/", n.pid, dirfd).as_bytes());
            full.extend_from_slice(&path);
        }
        Some((CString::new(full).ok()?, trunc))
    }

    fn handle(self: &Arc<Self>, lfd: RawFd, n: Notif) {
        let t = Instant::now();
        self.c.notifs.fetch_add(1, Ordering::Relaxed);
        let target = self.resolve(&n);
        let t1 = t.elapsed().as_nanos() as u64;
        self.c.t_read_ns.fetch_add(t1, Ordering::Relaxed);
        let Some((path, trunc)) = target else {
            respond(lfd, n.id, 0);
            let t2 = t.elapsed().as_nanos() as u64;
            self.c.t_send_ns.fetch_add(t2 - t1, Ordering::Relaxed);
            self.c.handler_ns.fetch_add(t2, Ordering::Relaxed);
            return;
        };
        self.c.checked.fetch_add(1, Ordering::Relaxed);
        let ph = hydrate::placeholder(&path);
        let t2 = t.elapsed().as_nanos() as u64;
        self.c.t_xattr_ns.fetch_add(t2 - t1, Ordering::Relaxed);
        if ph.is_none() {
            respond(lfd, n.id, 0);
            let t3 = t.elapsed().as_nanos() as u64;
            self.c.t_send_ns.fetch_add(t3 - t2, Ordering::Relaxed);
            self.c.handler_ns.fetch_add(t3, Ordering::Relaxed);
            return;
        }
        // The memory we read the path from could have belonged to a process that is already gone.
        let valid = unsafe { libc::syscall(libc::SYS_ioctl, lfd, SECCOMP_IOCTL_NOTIF_ID_VALID, &n.id as *const u64) } == 0;
        if !valid {
            return;
        }
        // Slow path off the dispatcher thread: other opens keep flowing while this one downloads.
        let me = self.clone();
        std::thread::spawn(move || {
            let t = Instant::now();
            match me.do_hydrate(&path, trunc) {
                Ok(Outcome::Discarded) => {
                    me.c.discarded.fetch_add(1, Ordering::Relaxed);
                    respond(lfd, n.id, 0);
                }
                Ok(_) => respond(lfd, n.id, 0),
                Err(e) => {
                    // Fail the syscall loudly rather than let the caller read a file of zeros.
                    me.c.failed.fetch_add(1, Ordering::Relaxed);
                    eprintln!("hydrate failed (pid {}): {}", n.pid, e);
                    respond(lfd, n.id, libc::EIO);
                }
            }
            me.c.hydrate_ms.fetch_add(t.elapsed().as_millis() as u64, Ordering::Relaxed);
        });
    }

    fn serve_listener(self: Arc<Self>, lfd: RawFd) {
        self.c.listeners.fetch_add(1, Ordering::Relaxed);
        if std::env::var("SWLAZY_NO_SYNC_WAKE").is_err() {
            let fl: u64 = SECCOMP_USER_NOTIF_FD_SYNC_WAKE_UP;
            unsafe { libc::syscall(libc::SYS_ioctl, lfd, SECCOMP_IOCTL_NOTIF_SET_FLAGS, fl) };
        }
        loop {
            let mut n: Notif = unsafe { std::mem::zeroed() };
            let r = unsafe { libc::syscall(libc::SYS_ioctl, lfd, SECCOMP_IOCTL_NOTIF_RECV, &mut n as *mut Notif) };
            if r != 0 {
                let e = errno();
                if e == libc::EINTR {
                    continue;
                }
                // ENOENT: the notification vanished, or no task uses the filter any more.
                let mut p = libc::pollfd { fd: lfd, events: libc::POLLIN, revents: 0 };
                unsafe { libc::poll(&mut p, 1, 0) };
                if p.revents & libc::POLLHUP != 0 || e != libc::ENOENT {
                    break;
                }
                continue;
            }
            self.handle(lfd, n);
        }
        // Hydrations still in flight for this listener answer into a closed fd at worst.
        std::thread::sleep(std::time::Duration::from_millis(50));
        unsafe { libc::close(lfd) };
        self.c.listeners.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn stats(&self) -> String {
        let c = &self.c;
        format!(
            "notifs={} skipped_prefix={} checked={} hydrated={} hydrated_bytes={} discarded={} failed={} handler_us={} read_us={} xattr_us={} send_us={} hydrate_ms={} listeners={} auto_evicted={} auto_evicted_bytes={} free_mb={} {}",
            c.notifs.load(Ordering::Relaxed),
            c.skipped_prefix.load(Ordering::Relaxed),
            c.checked.load(Ordering::Relaxed),
            c.hydrated.load(Ordering::Relaxed),
            c.hydrated_bytes.load(Ordering::Relaxed),
            c.discarded.load(Ordering::Relaxed),
            c.failed.load(Ordering::Relaxed),
            c.handler_ns.load(Ordering::Relaxed) / 1000,
            c.t_read_ns.load(Ordering::Relaxed) / 1000,
            c.t_xattr_ns.load(Ordering::Relaxed) / 1000,
            c.t_send_ns.load(Ordering::Relaxed) / 1000,
            c.hydrate_ms.load(Ordering::Relaxed),
            c.listeners.load(Ordering::Relaxed),
            self.evicted.load(Ordering::Relaxed),
            self.evicted_bytes.load(Ordering::Relaxed),
            self.free_bytes() >> 20,
            self.store.stats_line()
        )
    }

    pub fn serve(self: Arc<Self>, sock_path: &str) -> Result<()> {
        let _ = std::fs::remove_file(sock_path);
        let l = UnixListener::bind(sock_path)?;
        eprintln!("ready");
        for conn in l.incoming() {
            let Ok(mut conn) = conn else { continue };
            let me = self.clone();
            std::thread::spawn(move || {
                let Ok((tag, fd)) = recv_fd(&conn) else { return };
                match tag {
                    b'L' => {
                        let Some(fd) = fd else { return };
                        // Start serving before the ack: the client execs right after it.
                        let me2 = me.clone();
                        let h = std::thread::spawn(move || me2.serve_listener(fd));
                        let _ = conn.write_all(b"k");
                        drop(conn);
                        let _ = h.join();
                    }
                    b'H' => {
                        // Explicit hydrate request (used by the LD_PRELOAD shim): path, newline.
                        let mut p = Vec::new();
                        let mut b = [0u8; 1];
                        while conn.read_exact(&mut b).is_ok() && b[0] != b'\n' {
                            p.push(b[0]);
                        }
                        let ok = CString::new(p).ok().map(|c| me.do_hydrate(&c, false).is_ok()).unwrap_or(false);
                        let _ = conn.write_all(if ok { b"0" } else { b"E" });
                    }
                    b'S' => {
                        let _ = conn.write_all(me.stats().as_bytes());
                    }
                    _ => {}
                }
            });
        }
        Ok(())
    }
}

pub fn client_stats(sock_path: &str) -> Result<String> {
    let mut s = UnixStream::connect(sock_path)?;
    s.write_all(b"S")?;
    let mut out = String::new();
    s.read_to_string(&mut out)?;
    Ok(out)
}

#[allow(dead_code)]
pub fn owned(fd: RawFd) -> std::fs::File {
    unsafe { std::fs::File::from_raw_fd(fd) }
}
