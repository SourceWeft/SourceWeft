#![cfg(target_os = "linux")]
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_REQUEST: usize = 1024 * 1024;
static WANT_FREEZE: AtomicBool = AtomicBool::new(false);
static WANT_RESUME: AtomicBool = AtomicBool::new(false);
extern "C" fn lifecycle_signal(signal: i32) {
    if signal == libc::SIGUSR1 {
        WANT_FREEZE.store(true, Ordering::SeqCst);
    }
    if signal == libc::SIGUSR2 {
        WANT_RESUME.store(true, Ordering::SeqCst);
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    boot_id: String,
    supervisor_nonce: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Gate {
    identity: Identity,
    open: bool,
    drain_id: Option<String>,
    freeze_id: Option<String>,
    recovered_from: Option<Identity>,
    recovered_journal_digest: Option<String>,
    #[serde(default)]
    recovery_ancestry: Vec<Identity>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Launch {
    execution_id: String,
    command: String,
    cwd: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Identity,
    Open {
        expected_nonce: String,
        drain_id: Option<String>,
    },
    Start {
        expected_nonce: String,
        launch: Launch,
    },
    Status {
        expected_nonce: String,
        execution_id: String,
    },
    Cancel {
        expected_nonce: String,
        execution_id: String,
    },
    Freeze {
        expected_nonce: String,
        freeze_id: String,
    },
    Resume {
        expected_nonce: String,
        freeze_id: String,
    },
    Drain {
        expected_nonce: String,
        drain_id: String,
    },
}

#[derive(Serialize, Deserialize)]
struct Completion {
    exit_code: i32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NamespaceJournal {
    boot_id: String,
    init_pid: i32,
    init_start_time: String,
    namespace: PathBuf,
}

struct Workload {
    child: Child,
    init_fd: OwnedFd,
    directory: PathBuf,
    stopped: bool,
}

struct Supervisor {
    gate: Gate,
    state_dir: PathBuf,
    workspace: PathBuf,
    workload_uid: u32,
    control_uid: u32,
    workloads: HashMap<String, Workload>,
    _lease: File,
}

fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temp = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temp)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    File::open(path.parent().context("missing parent")?)?.sync_all()?;
    Ok(())
}

fn private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir(path)?;
    }
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && metadata.uid() == 0 && metadata.permissions().mode() & 0o077 == 0,
        "supervisor state directory must be root-owned, non-symlink, mode 0700"
    );
    Ok(())
}

fn pidfd(pid: i32) -> Result<OwnedFd> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) as i32 };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn signal_pidfd(fd: &OwnedFd, signal: i32) -> Result<()> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error.into());
        }
    }
    Ok(())
}

fn exited(fd: &OwnedFd, timeout: Duration) -> Result<bool> {
    let mut descriptor = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let result = unsafe {
        libc::poll(
            &mut descriptor,
            1,
            timeout.as_millis().min(i32::MAX as u128) as i32,
        )
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    ensure!(
        descriptor.revents & (libc::POLLERR | libc::POLLNVAL) == 0,
        "invalid namespace pidfd"
    );
    Ok(descriptor.revents & (libc::POLLIN | libc::POLLHUP) != 0)
}

impl Workload {
    fn await_receipt(&self, name: &str, freeze_id: &str) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if exited(&self.init_fd, Duration::ZERO)? {
                return Ok(());
            }
            let path = self.directory.join(name);
            if path.exists() {
                let receipt: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
                if receipt["freeze_id"] == freeze_id {
                    ensure!(
                        receipt["ok"] == true,
                        "namespace did not acknowledge a complete writer freeze/resume"
                    );
                    return Ok(());
                }
            }
            ensure!(
                Instant::now() < deadline,
                "namespace freeze/resume acknowledgement timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn stop(&mut self) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        signal_pidfd(&self.init_fd, libc::SIGKILL)?;
        // PID namespace init exits only after the kernel tears down its namespace's
        // descendants. A signal-send success is not a stop acknowledgement.
        ensure!(
            exited(&self.init_fd, Duration::from_secs(30))?,
            "namespace termination is not yet confirmed"
        );
        self.child.wait()?;
        self.stopped = true;
        Ok(())
    }
}

fn process_start_time(pid: i32) -> Result<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let tail = stat.rsplit_once(')').context("invalid process stat")?.1;
    Ok(tail
        .split_whitespace()
        .nth(19)
        .context("missing process start time")?
        .into())
}

fn recover_namespaces(state_dir: &Path, boot_id: &str) -> Result<String> {
    let mut pending = Vec::new();
    let mut hasher = blake3::Hasher::new();
    hasher.update(boot_id.as_bytes());
    let mut entries = fs::read_dir(state_dir)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if !entry.file_name().to_string_lossy().starts_with("exec-") {
            continue;
        }
        private_dir(&entry.path())?;
        let path = entry.path().join("namespace.json");
        if !path.exists() {
            continue;
        }
        let journal: NamespaceJournal = serde_json::from_slice(&fs::read(path)?)?;
        hasher.update(entry.file_name().as_encoded_bytes());
        hasher.update(&serde_json::to_vec(&journal)?);
        if journal.boot_id != boot_id {
            continue;
        }
        let start = match process_start_time(journal.init_pid) {
            Ok(value) => value,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
            {
                continue
            }
            Err(error) => return Err(error),
        };
        if start != journal.init_start_time {
            continue;
        }
        if fs::read_link(format!("/proc/{}/ns/pid", journal.init_pid))? != journal.namespace {
            continue;
        }
        let fd = pidfd(journal.init_pid)?;
        if process_start_time(journal.init_pid)? != journal.init_start_time {
            continue;
        }
        signal_pidfd(&fd, libc::SIGKILL)?;
        pending.push(fd);
    }
    for fd in pending {
        ensure!(
            exited(&fd, Duration::from_secs(30))?,
            "previous namespace has not stopped; preserve closed admission"
        );
    }
    Ok(hasher.finalize().to_hex().to_string())
}

impl Supervisor {
    fn new(
        state_dir: PathBuf,
        workspace: PathBuf,
        workload_uid: u32,
        control_uid: u32,
    ) -> Result<Self> {
        ensure!(
            unsafe { libc::geteuid() } == 0,
            "supervisor daemon requires root"
        );
        ensure!(
            workload_uid != 0 && workload_uid != control_uid,
            "workload identity must be separate from root/control identity"
        );
        private_dir(&state_dir)?;
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(state_dir.join("supervisor.lock"))?;
        ensure!(
            unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "another supervisor owns this state directory"
        );
        let identity = Identity {
            boot_id: fs::read_to_string("/proc/sys/kernel/random/boot_id")?
                .trim()
                .into(),
            supervisor_nonce: fs::read_to_string("/proc/sys/kernel/random/uuid")?
                .trim()
                .into(),
        };
        let previous_gate = state_dir.join("gate.json");
        let (recovered_from, recovery_ancestry) = if previous_gate.exists() {
            let previous: Gate = serde_json::from_slice(&fs::read(&previous_gate)?)?;
            let owner = previous
                .recovered_from
                .clone()
                .unwrap_or_else(|| previous.identity.clone());
            let mut ancestry = previous.recovery_ancestry;
            if ancestry.is_empty() {
                ancestry.push(owner.clone());
            }
            if ancestry
                .last()
                .is_none_or(|item| item.supervisor_nonce != previous.identity.supervisor_nonce)
            {
                ancestry.push(previous.identity);
            }
            ensure!(
                ancestry.len() <= 1024,
                "recovery ancestry exceeds safety bound; retain closed admission"
            );
            (Some(owner), ancestry)
        } else {
            (None, Vec::new())
        };
        let recovered_journal_digest = Some(recover_namespaces(&state_dir, &identity.boot_id)?);
        // Every restart begins closed. Neither daemon startup nor credential presence
        // authorizes restoring admission to a volume with unconfirmed dirty files.
        let gate = Gate {
            identity,
            open: false,
            drain_id: None,
            freeze_id: None,
            recovered_from,
            recovered_journal_digest,
            recovery_ancestry,
        };
        atomic_json(&state_dir.join("gate.json"), &gate)?;
        Ok(Self {
            gate,
            state_dir,
            workspace: workspace.canonicalize()?,
            workload_uid,
            control_uid,
            workloads: HashMap::new(),
            _lease: lease,
        })
    }

    fn expected(&self, nonce: &str) -> Result<()> {
        ensure!(
            nonce == self.gate.identity.supervisor_nonce,
            "stale supervisor identity"
        );
        Ok(())
    }

    fn persist_gate(&self) -> Result<()> {
        atomic_json(&self.state_dir.join("gate.json"), &self.gate)
    }

    fn start(&mut self, launch: Launch) -> Result<serde_json::Value> {
        ensure!(
            self.gate.open,
            "workload admission is closed for recovery/drain"
        );
        ensure!(token(&launch.execution_id), "invalid execution id");
        ensure!(
            !self.workloads.contains_key(&launch.execution_id),
            "execution id already exists; commands are never replayed"
        );
        ensure!(!launch.command.is_empty(), "empty command");
        let cwd = PathBuf::from(&launch.cwd).canonicalize()?;
        ensure!(
            cwd.starts_with(&self.workspace),
            "command cwd escapes the workspace"
        );
        let directory = self.state_dir.join(format!("exec-{}", launch.execution_id));
        fs::create_dir(&directory)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        atomic_json(&directory.join("launch.json"), &launch)?;
        let log = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(directory.join("init.log"))?;
        let executable = std::env::current_exe()?;
        let parent = unsafe { libc::getpid() };
        let mut command = Command::new("/usr/bin/unshare");
        command
            .args(["--pid", "--fork", "--mount-proc", "--kill-child=KILL"])
            .arg(executable)
            .arg("init-child")
            .arg(&directory)
            .arg(self.workload_uid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    libc::_exit(125);
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let own_namespace = fs::read_link("/proc/self/ns/pid")?;
        let init_result = (|| -> Result<(OwnedFd, NamespaceJournal)> {
            loop {
                ensure!(
                    child.try_wait()?.is_none(),
                    "namespace launcher exited before readiness"
                );
                let children_path = format!("/proc/{0}/task/{0}/children", child.id());
                let children = fs::read_to_string(children_path).unwrap_or_default();
                let pids: Vec<i32> = children
                    .split_whitespace()
                    .map(str::parse)
                    .collect::<std::result::Result<_, _>>()?;
                if pids.len() == 1 {
                    let pid = pids[0];
                    if directory.join("ready.json").exists() {
                        ensure!(
                            fs::read_link(format!("/proc/{pid}/ns/pid"))? != own_namespace,
                            "child lacks isolated PID namespace"
                        );
                        // Only the root-owned unshare launcher's direct child is accepted.
                        // The init is waiting for our root-owned go receipt and has not started untrusted work.
                        let fd = pidfd(pid)?;
                        let journal = NamespaceJournal {
                            boot_id: self.gate.identity.boot_id.clone(),
                            init_pid: pid,
                            init_start_time: process_start_time(pid)?,
                            namespace: fs::read_link(format!("/proc/{pid}/ns/pid"))?,
                        };
                        return Ok((fd, journal));
                    }
                }
                ensure!(Instant::now() < deadline, "namespace readiness timeout");
                std::thread::sleep(Duration::from_millis(10));
            }
        })();
        let (init_fd, journal) = match init_result {
            Ok(value) => value,
            Err(error) => {
                child.kill()?;
                child.wait()?;
                return Err(error);
            }
        };
        let authorize = atomic_json(&directory.join("namespace.json"), &journal).and_then(|_| {
            atomic_json(
                &directory.join("go.json"),
                &serde_json::json!({"start":true}),
            )
        });
        if let Err(error) = authorize {
            signal_pidfd(&init_fd, libc::SIGKILL)?;
            ensure!(
                exited(&init_fd, Duration::from_secs(30))?,
                "failed start still has a namespace"
            );
            child.wait()?;
            return Err(error);
        }
        self.workloads.insert(
            launch.execution_id.clone(),
            Workload {
                child,
                init_fd,
                directory,
                stopped: false,
            },
        );
        Ok(serde_json::json!({"execution_id": launch.execution_id, "started": true}))
    }

    fn handle(&mut self, request: Request) -> Result<serde_json::Value> {
        match request {
            Request::Identity => Ok(serde_json::to_value(&self.gate)?),
            Request::Open {
                expected_nonce,
                drain_id,
            } => {
                self.expected(&expected_nonce)?;
                ensure!(self.gate.drain_id == drain_id, "drain fence does not match");
                ensure!(
                    self.gate.recovered_from.is_none() || drain_id.is_some(),
                    "restarted supervisor requires a confirmed recovery drain before admission"
                );
                ensure!(
                    self.gate.freeze_id.is_none(),
                    "frozen background writers must be resumed explicitly"
                );
                ensure!(
                    self.workloads.values().all(|work| work.stopped
                        || exited(&work.init_fd, Duration::ZERO).unwrap_or(false)),
                    "existing workloads prevent reopening"
                );
                let mut opened = self.gate.clone();
                opened.open = true;
                opened.drain_id = None;
                opened.recovered_from = None;
                opened.recovered_journal_digest = None;
                opened.recovery_ancestry.clear();
                atomic_json(&self.state_dir.join("gate.json"), &opened)?;
                self.gate = opened;
                Ok(serde_json::json!({"open":true}))
            }
            Request::Start {
                expected_nonce,
                launch,
            } => {
                self.expected(&expected_nonce)?;
                self.start(launch)
            }
            Request::Status {
                expected_nonce,
                execution_id,
            } => {
                self.expected(&expected_nonce)?;
                let work = self
                    .workloads
                    .get(&execution_id)
                    .context("unknown execution id")?;
                let completion = work.directory.join("completion.json");
                let completed = if completion.exists() {
                    Some(serde_json::from_slice::<Completion>(&fs::read(
                        completion,
                    )?)?)
                } else {
                    None
                };
                let bounded_output = |name: &str| -> Result<String> {
                    let path = work.directory.join(name);
                    if !path.exists() {
                        return Ok(String::new());
                    }
                    let mut bytes = Vec::new();
                    File::open(path)?
                        .take(8 * 1024 * 1024)
                        .read_to_end(&mut bytes)?;
                    Ok(String::from_utf8_lossy(&bytes).into_owned())
                };
                let stdout = bounded_output("stdout")?;
                let stderr = bounded_output("stderr")?;
                Ok(
                    serde_json::json!({"completion":completed,"namespace_exited":exited(&work.init_fd,Duration::ZERO)?,"stdout":stdout,"stderr":stderr}),
                )
            }
            Request::Cancel {
                expected_nonce,
                execution_id,
            } => {
                self.expected(&expected_nonce)?;
                self.workloads
                    .get_mut(&execution_id)
                    .context("unknown execution id")?
                    .stop()?;
                Ok(
                    serde_json::json!({"execution_id":execution_id,"stopped":true,"boundary":"pid-namespace"}),
                )
            }
            Request::Freeze {
                expected_nonce,
                freeze_id,
            } => {
                self.expected(&expected_nonce)?;
                ensure!(token(&freeze_id), "invalid freeze id");
                ensure!(self.gate.drain_id.is_none(), "volume is draining");
                ensure!(
                    self.gate
                        .freeze_id
                        .as_ref()
                        .is_none_or(|id| id == &freeze_id),
                    "another barrier owns the freeze"
                );
                self.gate.open = false;
                self.gate.freeze_id = Some(freeze_id.clone());
                self.persist_gate()?;
                for work in self.workloads.values() {
                    if !exited(&work.init_fd, Duration::ZERO)? {
                        let _ = fs::remove_file(work.directory.join("frozen.json"));
                        atomic_json(
                            &work.directory.join("freeze-request.json"),
                            &serde_json::json!({"freeze_id":freeze_id}),
                        )?;
                        signal_pidfd(&work.init_fd, libc::SIGUSR1)?;
                    }
                }
                for work in self.workloads.values() {
                    work.await_receipt("frozen.json", &freeze_id)?;
                }
                Ok(
                    serde_json::json!({"freeze_id":freeze_id,"supervisor_nonce":self.gate.identity.supervisor_nonce,"all_writers_stopped":true}),
                )
            }
            Request::Resume {
                expected_nonce,
                freeze_id,
            } => {
                self.expected(&expected_nonce)?;
                ensure!(
                    self.gate.freeze_id.as_ref() == Some(&freeze_id),
                    "freeze fence does not match"
                );
                ensure!(self.gate.drain_id.is_none(), "volume is draining");
                for work in self.workloads.values() {
                    if !exited(&work.init_fd, Duration::ZERO)? {
                        let _ = fs::remove_file(work.directory.join("resumed.json"));
                        atomic_json(
                            &work.directory.join("resume-request.json"),
                            &serde_json::json!({"freeze_id":freeze_id}),
                        )?;
                        signal_pidfd(&work.init_fd, libc::SIGUSR2)?;
                    }
                }
                for work in self.workloads.values() {
                    work.await_receipt("resumed.json", &freeze_id)?;
                }
                let mut opened = self.gate.clone();
                opened.open = true;
                opened.freeze_id = None;
                atomic_json(&self.state_dir.join("gate.json"), &opened)?;
                self.gate = opened;
                Ok(serde_json::json!({"freeze_id":freeze_id,"resumed":true}))
            }
            Request::Drain {
                expected_nonce,
                drain_id,
            } => {
                self.expected(&expected_nonce)?;
                ensure!(token(&drain_id), "invalid drain id");
                ensure!(
                    self.gate.drain_id.as_ref().is_none_or(|id| id == &drain_id),
                    "another drain owns the gate"
                );
                self.gate.open = false;
                self.gate.drain_id = Some(drain_id.clone());
                self.gate.freeze_id = None;
                self.persist_gate()?;
                for work in self.workloads.values() {
                    signal_pidfd(&work.init_fd, libc::SIGKILL)?;
                }
                for work in self.workloads.values_mut() {
                    work.stop()?;
                }
                Ok(
                    serde_json::json!({"drain_id":drain_id,"identity":self.gate.identity,"launch_gate_closed":true,"all_namespaces_exited":true,"recovered_from":self.gate.recovered_from,"journal_digest":self.gate.recovered_journal_digest,"recovery_ancestry":self.gate.recovery_ancestry}),
                )
            }
        }
    }
}

fn all_workload_threads_stopped() -> Result<bool> {
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "1" || name.parse::<u32>().is_err() {
            continue;
        }
        let tasks = match fs::read_dir(entry.path().join("task")) {
            Ok(tasks) => tasks,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for task in tasks {
            let status = match fs::read_to_string(task?.path().join("status")) {
                Ok(status) => status,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            let state = status
                .lines()
                .find_map(|line| line.strip_prefix("State:"))
                .and_then(|line| line.trim().chars().next());
            if !matches!(state, Some('T' | 't' | 'Z' | 'X')) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn apply_lifecycle_signals(directory: &Path) -> Result<()> {
    if WANT_FREEZE.swap(false, Ordering::SeqCst) {
        let request: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("freeze-request.json"))?)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut stopped = false;
        while Instant::now() < deadline {
            let rc = unsafe { libc::kill(-1, libc::SIGSTOP) };
            if rc < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                return Err(std::io::Error::last_os_error().into());
            }
            if all_workload_threads_stopped()? {
                stopped = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        atomic_json(
            &directory.join("frozen.json"),
            &serde_json::json!({"freeze_id":request["freeze_id"],"ok":stopped}),
        )?;
    }
    if WANT_RESUME.swap(false, Ordering::SeqCst) {
        let request: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("resume-request.json"))?)?;
        let frozen: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("frozen.json"))?)?;
        ensure!(
            request["freeze_id"] == frozen["freeze_id"],
            "resume does not match the writer freeze"
        );
        let rc = unsafe { libc::kill(-1, libc::SIGCONT) };
        if rc < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            return Err(std::io::Error::last_os_error().into());
        }
        atomic_json(
            &directory.join("resumed.json"),
            &serde_json::json!({"freeze_id":request["freeze_id"],"ok":true}),
        )?;
    }
    Ok(())
}

fn capture_output(reader: &mut impl Read, writer: &mut File, total: &mut usize) -> Result<()> {
    let mut buffer = [0u8; 8192];
    // Bound each pump iteration as well as retained bytes; a chatty background
    // process must not starve lifecycle signals or fill the protected state disk.
    for _ in 0..128 {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                let retained = count.min((8 * 1024 * 1024usize).saturating_sub(*total));
                if retained > 0 {
                    writer.write_all(&buffer[..retained])?;
                }
                *total = total.saturating_add(count);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn init_child(directory: &Path, uid: u32) -> Result<()> {
    ensure!(
        unsafe { libc::getpid() } == 1 && unsafe { libc::geteuid() } == 0,
        "init-child requires root PID namespace init"
    );
    ensure!(uid != 0, "workload must not run as root");
    unsafe {
        ensure!(
            libc::prctl(libc::PR_SET_DUMPABLE, 0) == 0,
            "cannot protect init process"
        );
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = lifecycle_signal as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        ensure!(
            libc::sigaction(libc::SIGUSR1, &action, std::ptr::null_mut()) == 0
                && libc::sigaction(libc::SIGUSR2, &action, std::ptr::null_mut()) == 0,
            "cannot install lifecycle handlers"
        );
    }
    atomic_json(
        &directory.join("ready.json"),
        &serde_json::json!({"ready":true}),
    )?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !directory.join("go.json").exists() {
        ensure!(
            Instant::now() < deadline,
            "controller did not authorize workload start"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let launch: Launch = serde_json::from_slice(&fs::read(directory.join("launch.json"))?)?;
    let output = |name: &str| -> Result<File> {
        Ok(OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(directory.join(name))?)
    };
    let mut child = Command::new("/usr/bin/setpriv")
        .args([
            "--reuid",
            &uid.to_string(),
            "--regid",
            &uid.to_string(),
            "--clear-groups",
            "--no-new-privs",
            "--bounding-set=-all",
            "--inh-caps=-all",
            "/bin/sh",
            "-lc",
            &launch.command,
        ])
        .current_dir(&launch.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().context("missing stdout pipe")?;
    let mut stderr = child.stderr.take().context("missing stderr pipe")?;
    for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        ensure!(
            flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == 0,
            "cannot configure bounded output capture"
        );
    }
    let mut stdout_file = output("stdout")?;
    let mut stderr_file = output("stderr")?;
    let mut stdout_size = 0;
    let mut stderr_size = 0;
    let mut completed = false;
    use std::os::unix::process::ExitStatusExt;
    loop {
        capture_output(&mut stdout, &mut stdout_file, &mut stdout_size)?;
        capture_output(&mut stderr, &mut stderr_file, &mut stderr_size)?;
        apply_lifecycle_signals(directory)?;
        if !completed {
            if let Some(status) = child.try_wait()? {
                // After main-command exit, drain bytes already in the pipes before
                // publishing its result; detached children may retain the pipes.
                capture_output(&mut stdout, &mut stdout_file, &mut stdout_size)?;
                capture_output(&mut stderr, &mut stderr_file, &mut stderr_size)?;
                stdout_file.sync_all()?;
                stderr_file.sync_all()?;
                atomic_json(
                    &directory.join("completion.json"),
                    &Completion {
                        exit_code: status.code().unwrap_or(128 + status.signal().unwrap_or(0)),
                    },
                )?;
                completed = true;
            }
        }
        if completed {
            // PID 1 adopts descendants; reap them without ending the namespace
            // while background services are still alive.
            let result = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ECHILD) {
                    break;
                }
                if error.raw_os_error() != Some(libc::EINTR) {
                    return Err(error.into());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn peer_uid(stream: &UnixStream) -> Result<u32> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    ensure!(
        unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut credentials as *mut _ as *mut _,
                &mut length,
            )
        } == 0,
        "cannot authenticate control peer"
    );
    Ok(credentials.uid)
}

fn serve(socket: &Path, supervisor: Supervisor) -> Result<()> {
    let parent = socket.parent().context("socket needs a parent directory")?;
    let metadata = fs::symlink_metadata(parent)?;
    ensure!(
        metadata.is_dir() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
        "socket parent must be protected and root-owned"
    );
    if let Ok(metadata) = fs::symlink_metadata(socket) {
        use std::os::unix::fs::FileTypeExt;
        ensure!(
            metadata.file_type().is_socket()
                && [0, supervisor.control_uid].contains(&metadata.uid()),
            "unexpected control socket owner/type"
        );
        match UnixStream::connect(socket) {
            Ok(_) => bail!("a live supervisor owns this control socket"),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                fs::remove_file(socket)?
            }
            Err(error) => return Err(error.into()),
        }
    }
    let listener = UnixListener::bind(socket)?;
    fs::set_permissions(socket, fs::Permissions::from_mode(0o600))?;
    let path = std::ffi::CString::new(socket.as_os_str().as_encoded_bytes())?;
    ensure!(
        unsafe { libc::chown(path.as_ptr(), supervisor.control_uid, u32::MAX) } == 0,
        "cannot assign control socket owner"
    );
    let supervisor = Arc::new(Mutex::new(supervisor));
    for connection in listener.incoming() {
        let Ok(mut stream) = connection else { continue };
        let handled = (|| -> Result<()> {
            stream.set_read_timeout(Some(Duration::from_secs(10)))?;
            stream.set_write_timeout(Some(Duration::from_secs(10)))?;
            let owner = supervisor
                .lock()
                .map_err(|_| anyhow::anyhow!("supervisor state poisoned"))?
                .control_uid;
            ensure!(
                [0, owner].contains(&peer_uid(&stream)?),
                "unauthorized control peer"
            );
            let mut line = Vec::new();
            BufReader::new(&stream)
                .take((MAX_REQUEST + 1) as u64)
                .read_until(b'\n', &mut line)?;
            let result = if line.len() > MAX_REQUEST {
                Err(anyhow::anyhow!("control request exceeds limit"))
            } else {
                serde_json::from_slice::<Request>(&line)
                    .map_err(Into::into)
                    .and_then(|request| {
                        supervisor
                            .lock()
                            .map_err(|_| anyhow::anyhow!("supervisor state poisoned"))?
                            .handle(request)
                    })
            };
            let response = match result {
                Ok(value) => serde_json::json!({"ok":true,"result":value}),
                Err(error) => serde_json::json!({"ok":false,"error":error.to_string()}),
            };
            writeln!(stream, "{}", serde_json::to_string(&response)?)?;
            Ok(())
        })();
        if handled.is_err() {
            eprintln!(
                "control client disconnected or sent an invalid request; supervisor retained"
            );
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    unsafe {
        libc::umask(0o077);
    }
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("version") => println!("swvol-supervisor {VERSION}"),
        Some("serve") if args.len()==7 => serve(Path::new(&args[2]), Supervisor::new(PathBuf::from(&args[3]), PathBuf::from(&args[4]), args[5].parse()?, args[6].parse()?)?)?,
        Some("init-child") if args.len()==4 => init_child(Path::new(&args[2]), args[3].parse()?)?,
        Some("request") if args.len()==3 => {
            let mut request = Vec::new();
            std::io::stdin().take(MAX_REQUEST as u64+1).read_to_end(&mut request)?;
            ensure!(request.len()<=MAX_REQUEST,"request exceeds limit");
            serde_json::from_slice::<Request>(&request)?;
            let mut stream=UnixStream::connect(&args[2])?;
            stream.set_read_timeout(Some(Duration::from_secs(45)))?;
            stream.write_all(&request)?; stream.write_all(b"\n")?;
            let mut response=String::new(); BufReader::new(stream).read_line(&mut response)?;
            ensure!(!response.is_empty(),"supervisor closed the control channel without a result");
            print!("{response}");
        }
        _ => bail!("usage: swvol-supervisor version | serve SOCKET STATE_DIR WORKSPACE WORKLOAD_UID CONTROL_UID | request SOCKET | init-child STATE_DIR UID"),
    }
    Ok(())
}
