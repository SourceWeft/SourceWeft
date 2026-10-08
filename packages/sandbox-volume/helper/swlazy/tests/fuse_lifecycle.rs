//! P0 counterexample experiment, not a claim of transparent daemon recovery.
//! The supervisor retains the original /dev/fuse FD across SIGKILL and starts a
//! new fuser 0.15.1 Session::from_fd on that same connection.
use fuser::{FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData, ReplyEntry, ReplyOpen, Request, Session, SessionACL};
use std::ffi::OsStr;
use std::fs;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::os::unix::process::CommandExt;
use std::time::{Duration, Instant, UNIX_EPOCH};

struct Probe { marker: Option<PathBuf> }
fn attr(ino: u64) -> FileAttr {
    FileAttr { ino, size: if ino == 1 { 0 } else { 4 }, blocks: 1, atime: UNIX_EPOCH, mtime: UNIX_EPOCH, ctime: UNIX_EPOCH, crtime: UNIX_EPOCH,
        kind: if ino == 1 { FileType::Directory } else { FileType::RegularFile }, perm: if ino == 1 { 0o755 } else { 0o444 },
        nlink: 1, uid: unsafe { libc::getuid() }, gid: unsafe { libc::getgid() }, rdev: 0, blksize: 4096, flags: 0 }
}
impl Filesystem for Probe {
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        if parent == 1 && name == "data" { reply.entry(&Duration::ZERO, &attr(2), 0); } else { reply.error(libc::ENOENT); }
    }
    fn getattr(&mut self, _req: &Request<'_>, ino: u64, _fh: Option<u64>, reply: ReplyAttr) { reply.attr(&Duration::ZERO, &attr(ino)); }
    fn open(&mut self, _req: &Request<'_>, _ino: u64, _flags: i32, reply: ReplyOpen) { reply.opened(0, fuser::consts::FOPEN_DIRECT_IO); }
    fn read(&mut self, _req: &Request<'_>, _ino: u64, _fh: u64, _offset: i64, _size: u32, _flags: i32, _lock: Option<u64>, reply: ReplyData) {
        if let Some(marker) = &self.marker {
            // This proves the request has left the kernel queue and is in user
            // space, before the process is killed without replying.
            fs::write(marker, b"read-dequeued-no-reply").unwrap();
            loop { std::thread::sleep(Duration::from_secs(1)); }
        }
        reply.data(b"safe");
    }
}
#[test]
#[ignore = "internal child process of retained_fd counterexample"]
fn child_serve_inherited_fd() {
    let fd: i32 = std::env::var("SWVOL_PROBE_FD").unwrap().parse().unwrap();
    let marker = std::env::var_os("SWVOL_PROBE_MARKER").map(PathBuf::from);
    let mut session = Session::from_fd(Probe { marker }, unsafe { OwnedFd::from_raw_fd(fd) }, SessionACL::Owner);
    session.run().unwrap();
}
fn spawn_server(fd: i32, marker: Option<&PathBuf>) -> Child {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "child_serve_inherited_fd", "--ignored", "--nocapture"]).env("SWVOL_PROBE_FD", fd.to_string());
    if let Some(marker) = marker { command.env("SWVOL_PROBE_MARKER", marker); } else { command.env_remove("SWVOL_PROBE_MARKER"); }
    // Only the server child inherits the retained connection. Reader processes
    // keep CLOEXEC and must never own the very connection they are waiting on.
    unsafe { command.pre_exec(move || {
        if libc::fcntl(fd, libc::F_SETFD, 0) < 0 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }); }
    command.stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap()
}
fn abort_own_probe(base: &PathBuf) {
    let expected_mount = base.join("mount").to_string_lossy().into_owned();
    let info = fs::read_to_string("/proc/self/mountinfo").unwrap();
    let connection = info.lines().find_map(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.get(4) == Some(&expected_mount.as_str()) && line.contains(" - fuse swvol-p0-probe ") {
            fields[2].strip_prefix("0:").and_then(|value| value.parse::<u32>().ok())
        } else { None }
    });
    if let Some(connection) = connection {
        let control = base.join("control"); fs::create_dir_all(&control).unwrap();
        assert!(Command::new("mount").args(["-t", "fusectl", "none"]).arg(&control).status().unwrap().success());
        fs::write(control.join(connection.to_string()).join("abort"), b"1").unwrap();
        assert!(Command::new("umount").arg(&control).status().unwrap().success());
        eprintln!("P0 cleanup aborted only verified probe connection {connection} at {expected_mount}");
    }
}
struct Cleanup { path: PathBuf, children: Vec<Child> }
impl Drop for Cleanup {
    fn drop(&mut self) {
        // Kill blocked readers and workers; then disconnect the original mount.
        for child in &mut self.children { let _ = child.kill(); }
        abort_own_probe(&self.path);
        for child in &mut self.children { let _ = child.wait(); }
        let mount = self.path.join("mount");
        if fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!(" {} ", mount.display())) {
            let _ = Command::new("umount").arg("-l").arg(&mount).status();
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}
#[test]
#[ignore = "requires real FUSE and mount privileges; expected finding is transparent_recovery=false"]
fn retained_fd_does_not_recover_a_dequeued_read_after_daemon_sigkill() {
    let base = PathBuf::from(format!("/test/swvol-lifecycle-{}", std::process::id()));
    fs::create_dir_all(base.join("mount")).unwrap();
    let mut cleanup = Cleanup { path: base.clone(), children: vec![] };
    let mut supervisor = Session::new(Probe { marker: None }, base.join("mount"), &[MountOption::RO, MountOption::FSName("swvol-p0-probe".into())]).unwrap();
    let retained = supervisor.as_fd().try_clone_to_owned().unwrap();
    let fd = retained.as_raw_fd();
    assert_ne!(unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
    assert_ne!(unsafe { libc::fcntl(supervisor.as_fd().as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
    let marker = base.join("dequeued");
    cleanup.children.push(spawn_server(fd, Some(&marker)));
    cleanup.children.push(Command::new("cat").arg(base.join("mount/data")).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() { assert!(Instant::now() < deadline, "server never dequeued a real read"); std::thread::sleep(Duration::from_millis(10)); }
    assert!(cleanup.children[1].try_wait().unwrap().is_none());
    cleanup.children[0].kill().unwrap(); cleanup.children[0].wait().unwrap();
    cleanup.children.push(spawn_server(fd, None));
    std::thread::sleep(Duration::from_secs(2));
    let original_read_finished = cleanup.children[1].try_wait().unwrap().is_some();
    assert!(!original_read_finished, "counterexample changed: inspect and update lifecycle contract");
    cleanup.children.push(Command::new("cat").arg(base.join("mount/data")).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(3);
    let fresh = loop {
        if let Some(status) = cleanup.children[3].try_wait().unwrap() { break status; }
        assert!(Instant::now() < deadline, "restarted session did not answer a fresh request"); std::thread::sleep(Duration::from_millis(10));
    };
    assert!(!fresh.success(), "from_fd unexpectedly recovered initialized protocol state");
    println!("P0_FUSE_RESULT {{\"retained_fd\":true,\"killed_after_read_dequeue\":true,\"original_read_completed_after_restart\":false,\"fresh_read_succeeded\":false,\"transparent_recovery\":false}}");
    // Stop users before releasing retained connection; no automatic remount or retry.
    for child in &mut cleanup.children { let _ = child.kill(); }
    // A killed reader may remain in kernel I/O until the last retained FD is
    // closed. Release the connection before waiting for reader termination.
    abort_own_probe(&base);
    supervisor.unmount();
    drop(supervisor);
    drop(retained);
    for child in &mut cleanup.children { let _ = child.wait(); }
}
