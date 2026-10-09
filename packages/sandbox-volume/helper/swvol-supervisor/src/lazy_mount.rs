//! Protected-bootstrap attestation plus independent kernel process liveness.
//! PID/executable/argv checks do not constitute a generic PID-to-FUSE-connection
//! ownership proof. The trusted bootstrap attests that relationship. No field is
//! accepted from workload stdout, a user-writable pidfile, or cached status JSON.
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::OwnedFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
const MAX_PLAN: u64 = 32 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub volume_id: String,
    pub attachment_id: String,
    pub boot_id: String,
    pub fixed_base_seq: u64,
    pub plan_sha256: String,
    pub plan_path: PathBuf,
    pub mount_path: PathBuf,
    pub mount_id: u64,
    pub device_major: u32,
    pub device_minor: u32,
    pub fs_name: String,
    pub fs_type: String,
    pub dispatcher_pid: i32,
    pub dispatcher_start_time: String,
    pub dispatcher_executable: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub registration: Registration,
    pub controller_nonce: String,
    pub state: String,
    pub reason: Option<String>,
    #[serde(default)]
    pub sealed_plan_path: Option<PathBuf>,
}
#[derive(Debug, PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    len: u64,
    mode: u32,
    uid: u32,
    ctime: i64,
    ctime_ns: i64,
}
fn file_identity(meta: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
        len: meta.len(),
        mode: meta.mode(),
        uid: meta.uid(),
        ctime: meta.ctime(),
        ctime_ns: meta.ctime_nsec(),
    }
}
fn normalized(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}
fn unescape_mount(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            ensure!(i + 3 < bytes.len(), "invalid kernel mount escape");
            let digits = &bytes[i + 1..i + 4];
            ensure!(
                digits.iter().all(|v| (b'0'..=b'7').contains(v)),
                "invalid kernel mount escape"
            );
            let n = u16::from(digits[0] - b'0') * 64
                + u16::from(digits[1] - b'0') * 8
                + u16::from(digits[2] - b'0');
            ensure!(n <= 255, "invalid kernel mount byte");
            out.push(n as u8);
            i += 4;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Ok(String::from_utf8(out)?)
}
fn verify_mount(r: &Registration) -> Result<()> {
    // Never stat/canonicalize the live FUSE path during liveness checks: a dead
    // dispatcher with a retained FD can leave filesystem syscalls blocked.
    let info = fs::read_to_string("/proc/self/mountinfo")?;
    for line in info.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        if Path::new(&unescape_mount(fields[4])?) != r.mount_path {
            continue;
        }
        let sep = fields
            .iter()
            .position(|v| *v == "-")
            .context("invalid mountinfo separator")?;
        ensure!(
            fields[0].parse::<u64>()? == r.mount_id,
            "lazy mount ID changed"
        );
        ensure!(
            fields[2] == format!("{}:{}", r.device_major, r.device_minor),
            "lazy mount device changed"
        );
        ensure!(
            fields[3] == "/" && fields[5].split(',').any(|v| v == "ro"),
            "fixed lazy lower must remain a whole read-only mount"
        );
        ensure!(
            fields.get(sep + 1) == Some(&r.fs_type.as_str())
                && fields.get(sep + 2) == Some(&r.fs_name.as_str()),
            "lazy mount filesystem identity changed"
        );
        return Ok(());
    }
    bail!("registered lazy mount is missing")
}
fn protected_parent(path: &Path) -> Result<()> {
    let parent = path.parent().context("path has no parent")?;
    ensure!(
        parent.canonicalize()? == parent,
        "protected path parent must be canonical"
    );
    let meta = fs::symlink_metadata(parent)?;
    ensure!(
        meta.is_dir() && meta.uid() == 0 && meta.mode() & 0o022 == 0,
        "path parent is not protected and root-owned"
    );
    for ancestor in parent.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        ensure!(
            metadata.is_dir()
                && metadata.uid() == 0
                && (metadata.mode() & 0o022 == 0 || metadata.mode() & libc::S_ISVTX != 0),
            "protected bootstrap path has a workload-writable ancestor"
        );
    }
    Ok(())
}
fn plan_file(r: &Registration) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&r.plan_path)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.uid() == 0 && meta.mode() & 0o222 == 0 && meta.len() <= MAX_PLAN,
        "fixed plan must be root-owned, read-only, regular and at most 32 MiB"
    );
    Ok(file)
}
fn verify_plan_bytes(r: &Registration, file: &mut File) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(MAX_PLAN + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_PLAN,
        "fixed plan exceeds byte budget"
    );
    let digest = format!("{:x}", Sha256::digest(&bytes));
    ensure!(
        digest == r.plan_sha256,
        "original fixed plan SHA256 changed"
    );
    let plan: serde_json::Value = serde_json::from_slice(&bytes)?;
    ensure!(
        plan.get("volume").and_then(|v| v.as_str()) == Some(&r.volume_id)
            && plan.get("attachment").and_then(|v| v.as_str()) == Some(&r.attachment_id)
            && plan.get("seq").and_then(|v| v.as_u64()) == Some(r.fixed_base_seq),
        "fixed plan actor/base does not match registration"
    );
    Ok(bytes)
}
fn verify_process(r: &Registration) -> Result<FileIdentity> {
    ensure!(
        super::process_start_time(r.dispatcher_pid)? == r.dispatcher_start_time,
        "dispatcher process identity changed"
    );
    let root = PathBuf::from(format!("/proc/{}", r.dispatcher_pid));
    ensure!(
        fs::read_link(root.join("ns/mnt"))? == fs::read_link("/proc/self/ns/mnt")?,
        "dispatcher is outside the attested mount namespace"
    );
    let status = fs::read_to_string(root.join("status"))?;
    let uids = status
        .lines()
        .find_map(|l| l.strip_prefix("Uid:"))
        .context("missing process UID")?;
    ensure!(
        uids.split_whitespace().all(|n| n == "0"),
        "lazy dispatcher must be the protected root process"
    );
    let executable = fs::read_link(root.join("exe"))?;
    ensure!(
        executable == r.dispatcher_executable,
        "dispatcher executable changed"
    );
    let meta = fs::metadata(root.join("exe"))?;
    ensure!(
        meta.is_file() && meta.uid() == 0 && meta.mode() & 0o022 == 0,
        "dispatcher executable must be root-owned and protected"
    );
    let command = fs::read(root.join("cmdline"))?;
    ensure!(command.len() <= 64 * 1024, "dispatcher argv too large");
    let argv: Vec<_> = command
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .collect();
    ensure!(
        argv.len() >= 5
            && argv[1] == b"mount-volume"
            && argv[2] == r.plan_path.as_os_str().as_encoded_bytes()
            && argv[4] == r.mount_path.as_os_str().as_encoded_bytes(),
        "dispatcher argv is not the attested original plan/mount launch"
    );
    let mut fuse = false;
    for fd in fs::read_dir(root.join("fd"))?.take(4097) {
        let fd = fd?;
        if fs::read_link(fd.path()).is_ok_and(|p| p == Path::new("/dev/fuse")) {
            fuse = true;
            break;
        }
    }
    ensure!(
        fuse,
        "attested dispatcher no longer holds a FUSE device descriptor"
    );
    Ok(file_identity(&meta))
}
impl Registration {
    pub fn validate_persisted_shape(&self, state_dir: &Path) -> Result<()> {
        ensure!(
            super::token(&self.volume_id)
                && super::token(&self.attachment_id)
                && super::valid_kernel_uuid(&self.boot_id),
            "invalid persisted lazy actor identity"
        );
        ensure!(
            self.fixed_base_seq <= 9_007_199_254_740_991 && super::digest_hex(&self.plan_sha256),
            "invalid persisted lazy base/digest"
        );
        for path in [
            &self.plan_path,
            &self.mount_path,
            &self.dispatcher_executable,
        ] {
            ensure!(
                normalized(path) && path.as_os_str().as_encoded_bytes().len() <= 4096,
                "invalid persisted lazy path"
            );
        }
        ensure!(
            self.plan_path.starts_with(state_dir),
            "persisted plan is outside private state"
        );
        ensure!(
            self.dispatcher_pid > 1
                && !self.dispatcher_start_time.is_empty()
                && self.dispatcher_start_time.len() <= 20
                && self
                    .dispatcher_start_time
                    .bytes()
                    .all(|b| b.is_ascii_digit()),
            "invalid persisted dispatcher identity"
        );
        ensure!(
            self.mount_id > 0
                && self.device_major == 0
                && self.device_minor > 0
                && self.fs_name == "swvol"
                && matches!(self.fs_type.as_str(), "fuse" | "fuse.swvol"),
            "invalid persisted mount identity"
        );
        protected_parent(&self.plan_path)?;
        protected_parent(&self.mount_path)?;
        Ok(())
    }
}
pub struct Guard {
    pub registration: Registration,
    pidfd: OwnedFd,
    plan_identity: FileIdentity,
    executable_identity: FileIdentity,
    pub sealed_plan_path: PathBuf,
    sealed_identity: FileIdentity,
    reason: Mutex<Option<String>>,
}
impl Guard {
    pub fn bind(r: Registration, state_dir: &Path, boot: &str) -> Result<Self> {
        r.validate_persisted_shape(state_dir)?;
        ensure!(
            super::token(&r.volume_id) && super::token(&r.attachment_id),
            "invalid volume/attachment identity"
        );
        ensure!(
            r.boot_id == boot && r.fixed_base_seq <= 9_007_199_254_740_991,
            "boot or fixed base is invalid"
        );
        ensure!(
            r.plan_sha256.len() == 64
                && r.plan_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "expected lowercase SHA256 required"
        );
        ensure!(
            normalized(&r.plan_path)
                && normalized(&r.mount_path)
                && normalized(&r.dispatcher_executable),
            "absolute normalized paths are required"
        );
        ensure!(
            r.plan_path.starts_with(state_dir),
            "fixed plan must remain in protected supervisor state"
        );
        ensure!(
            r.dispatcher_pid > 1
                && r.dispatcher_pid != std::process::id() as i32
                && r.dispatcher_start_time.bytes().all(|b| b.is_ascii_digit())
                && !r.dispatcher_start_time.is_empty(),
            "invalid dispatcher process"
        );
        ensure!(
            r.mount_id > 0
                && r.device_major == 0
                && r.device_minor > 0
                && r.fs_name == "swvol"
                && matches!(r.fs_type.as_str(), "fuse" | "fuse.swvol"),
            "unsupported formal lazy filesystem identity"
        );
        protected_parent(&r.plan_path)?;
        protected_parent(&r.mount_path)?;
        let before = verify_process(&r)?;
        let fd = super::pidfd(r.dispatcher_pid)?;
        let after = verify_process(&r)?;
        ensure!(
            before == after && !super::exited(&fd, Duration::ZERO)?,
            "dispatcher changed while acquiring pidfd"
        );
        verify_mount(&r)?;
        let mut plan = plan_file(&r)?;
        let plan_identity = file_identity(&plan.metadata()?);
        let bytes = verify_plan_bytes(&r, &mut plan)?;
        let sealed_plan_path = state_dir.join(format!("lazy-fixed-plan-{}.json", r.plan_sha256));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o400)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&sealed_plan_path)
        {
            Ok(mut sealed) => {
                sealed.write_all(&bytes)?;
                sealed.sync_all()?;
                File::open(state_dir)?.sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let mut sealed_registration = r.clone();
        sealed_registration.plan_path = sealed_plan_path.clone();
        let mut sealed = plan_file(&sealed_registration)?;
        verify_plan_bytes(&sealed_registration, &mut sealed)?;
        let sealed_identity = file_identity(&sealed.metadata()?);
        let guard = Self {
            registration: r,
            pidfd: fd,
            plan_identity,
            executable_identity: after,
            sealed_plan_path,
            sealed_identity,
            reason: Mutex::new(None),
        };
        guard.check(true)?;
        Ok(guard)
    }
    fn latch(&self, reason: &str) {
        let mut value = self.reason.lock().unwrap();
        if value.is_none() {
            *value = Some(reason.into());
        }
    }
    pub fn reason(&self) -> Option<String> {
        self.reason.lock().unwrap().clone()
    }
    pub fn poll_death(&self, timeout: Duration) {
        match super::exited(&self.pidfd, timeout) {
            Ok(true) => self.latch("dispatcher_exited"),
            Err(_) => self.latch("dispatcher_liveness_unverified"),
            Ok(false) => {}
        }
    }
    pub fn check(&self, full_hash: bool) -> Result<()> {
        self.poll_death(Duration::ZERO);
        if let Some(reason) = self.reason() {
            bail!("LAZY_MOUNT_FENCED: {reason}")
        }
        let checked = (|| -> Result<()> {
            protected_parent(&self.registration.plan_path)?;
            protected_parent(&self.registration.mount_path)?;
            verify_mount(&self.registration)?;
            ensure!(
                verify_process(&self.registration)? == self.executable_identity,
                "dispatcher executable identity changed"
            );
            let mut file = plan_file(&self.registration)?;
            ensure!(
                file_identity(&file.metadata()?) == self.plan_identity,
                "fixed plan was modified or replaced"
            );
            if full_hash {
                verify_plan_bytes(&self.registration, &mut file)?;
            }
            let mut sealed_registration = self.registration.clone();
            sealed_registration.plan_path = self.sealed_plan_path.clone();
            let mut sealed = plan_file(&sealed_registration)?;
            ensure!(
                file_identity(&sealed.metadata()?) == self.sealed_identity,
                "sealed original lower plan was modified or replaced"
            );
            if full_hash {
                verify_plan_bytes(&sealed_registration, &mut sealed)?;
            }
            ensure!(
                file_identity(&file.metadata()?) == self.plan_identity,
                "fixed plan changed during verification"
            );
            ensure!(
                !super::exited(&self.pidfd, Duration::ZERO)?,
                "dispatcher exited during verification"
            );
            Ok(())
        })();
        if checked.is_err() {
            self.latch("dispatcher_mount_or_fixed_plan_changed");
        }
        checked.context("LAZY_MOUNT_FENCED: protected bootstrap binding is no longer valid")
    }
}
