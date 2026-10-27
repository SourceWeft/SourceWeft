//! Shared spawn/timeout/cancel/tree-kill/bounded-output loop for running a command behind a
//! sandbox wrapper. `srt_exec.rs` runs the argv the sandbox sidecar returns through this loop on
//! macOS, Linux and Windows; the module compiles on every unix target and on Windows.
use super::{HostError, Result};
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

/// Outcome of running a wrapped command to completion, cancellation, or timeout.
#[allow(dead_code)]
pub(crate) struct RunOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
    pub truncated: bool,
    pub cancelled: bool,
}

fn bounded_read(mut stream: impl Read, max: usize) -> (Vec<u8>, bool) {
    let mut stored = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = max.saturating_sub(stored.len());
                stored.extend_from_slice(&buffer[..n.min(room)]);
                truncated |= n > room;
            }
        }
    }
    (stored, truncated)
}

/// Kills everything this execution started, so nothing outlives the call or keeps the output
/// pipes open. Unix: SIGKILL to the process group the child leads. Windows: terminates the Job
/// Object the child was assigned to at spawn (the whole descendant tree), with `exit_code`.
struct TreeKiller {
    #[cfg(unix)]
    group: i32,
    #[cfg(windows)]
    job: windows_job::Job,
}

impl TreeKiller {
    #[cfg(unix)]
    fn attach(child: &std::process::Child) -> Result<Self> {
        Ok(Self {
            group: child.id() as i32,
        })
    }

    #[cfg(windows)]
    fn attach(child: &std::process::Child) -> Result<Self> {
        Ok(Self {
            job: windows_job::Job::containing(child)?,
        })
    }

    #[cfg(unix)]
    fn kill(&self, _exit_code: u32) {
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        };
    }

    #[cfg(windows)]
    fn kill(&self, exit_code: u32) {
        self.job.terminate(exit_code);
    }
}

/// The exit code reported for an execution that was cancelled or timed out.
const CANCELLED_EXIT_CODE: i32 = 124;

/// Spawns `argv` in its own process group (Windows: its own console-less process group inside a
/// Job Object) with the environment cleared then set to exactly `env`, bounds stdout/stderr to
/// `max_chars` bytes each, and kills the whole tree on cancellation, on timeout, and once more
/// after the process exits, so no background descendant can outlive this call or keep the output
/// pipes open. A cancelled or timed-out execution reports exit code 124 on every platform; any
/// other exit code (including the Windows broker's 26, `session_ended`) is returned as-is.
#[allow(dead_code)]
pub(crate) fn run_wrapped(
    argv: &[String],
    env: &[(String, String)],
    cwd: &Path,
    timeout_ms: u64,
    max_chars: usize,
    cancel: Arc<AtomicBool>,
) -> Result<RunOutput> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| HostError::new("INVALID_CALL", "Empty command"))?;
    let mut command = Command::new(program);
    command.args(args).current_dir(cwd).env_clear();
    for (key, value) in env {
        command.env(key, value);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = command.spawn()?;
    let killer = match TreeKiller::attach(&child) {
        Ok(killer) => killer,
        Err(error) => {
            // Never run a command that cannot be killed as a tree.
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| HostError::new("PIPE_FAILED", "Missing stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| HostError::new("PIPE_FAILED", "Missing stderr"))?;
    let out = std::thread::spawn(move || bounded_read(stdout, max_chars));
    let err = std::thread::spawn(move || bounded_read(stderr, max_chars));
    let start = Instant::now();
    let mut cancelled = false;
    let status = loop {
        if cancel.load(Ordering::SeqCst) || start.elapsed() > Duration::from_millis(timeout_ms) {
            cancelled = true;
            killer.kill(CANCELLED_EXIT_CODE as u32);
            // Windows: the job covers the child, this is the explicit second path.
            #[cfg(windows)]
            let _ = child.kill();
            break child.wait()?;
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    // No background descendants may outlive this execution or keep output pipes open.
    killer.kill(0);
    let (stdout, out_truncated) = out
        .join()
        .map_err(|_| HostError::new("PIPE_FAILED", "stdout failed"))?;
    let (stderr, err_truncated) = err
        .join()
        .map_err(|_| HostError::new("PIPE_FAILED", "stderr failed"))?;
    Ok(RunOutput {
        stdout,
        stderr,
        exit_code: status
            .code()
            .unwrap_or(if cancelled { CANCELLED_EXIT_CODE } else { 1 }),
        truncated: out_truncated || err_truncated,
        cancelled,
    })
}

/// A Job Object that kills every process assigned to it (and their descendants) when
/// terminated or closed.
#[cfg(windows)]
mod windows_job {
    use super::{HostError, Result};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    pub(super) struct Job(HANDLE);

    impl Job {
        /// A new kill-on-close job that `child` has been assigned to. A grandchild started in
        /// the instant between the child's creation and this assignment would escape the job;
        /// the sandbox broker does not start one that early.
        pub(super) fn containing(child: &std::process::Child) -> Result<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(job_error("create"));
                }
                // Owned from here on: closing it on any failure below kills nothing yet.
                let job = Job(handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(job_error("configure"));
                }
                if AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0 {
                    return Err(job_error("assign the command to"));
                }
                Ok(job)
            }
        }

        pub(super) fn terminate(&self, exit_code: u32) {
            unsafe {
                TerminateJobObject(self.0, exit_code);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn job_error(action: &str) -> HostError {
        HostError::new(
            "PROCESS_JOB_FAILED",
            format!(
                "Could not {action} the job object that bounds the command: {}",
                std::io::Error::last_os_error()
            ),
        )
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn run_wrapped_kills_group_on_cancel() {
        let cancel = Arc::new(AtomicBool::new(false));
        let temp = tempfile::tempdir().unwrap();
        // The shell records its own pid (the process group run_wrapped created, since it is the
        // group leader) and its backgrounded child's, then becomes the foreground `sleep`. The
        // background child does not hold the output pipes, so run_wrapped returns as soon as the
        // leader dies and a background survivor would still be there to find. Cancel only once
        // both pids are recorded, however slowly the shell starts under load.
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "echo $$ > group.tmp && mv group.tmp group; sleep 30 </dev/null >/dev/null 2>&1 & \
             echo $! > background.tmp && mv background.tmp background; exec sleep 30"
                .to_string(),
        ];
        {
            let trigger = cancel.clone();
            let ready = temp.path().join("background");
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(20);
                while !ready.exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                std::thread::sleep(Duration::from_millis(100));
                trigger.store(true, Ordering::SeqCst);
            });
        }
        let result = run_wrapped(&argv, &[], temp.path(), 10_000, 1000, cancel).unwrap();
        assert!(result.cancelled, "expected cancellation to be reported");
        assert_eq!(result.exit_code, 124);

        let read_pid = |name: &str| -> i32 {
            std::fs::read_to_string(temp.path().join(name))
                .unwrap()
                .trim()
                .parse()
                .unwrap()
        };
        let group = read_pid("group");
        let background = read_pid("background");
        // Only this test's own process group is inspected (final review M6): a system-wide
        // `ps` text match flaked on unrelated `sleep 30` processes. A killed member that its
        // new parent has not reaped yet shows as a zombie (`Z`), which is dead, not alive.
        let alive_in_group = || -> Vec<String> {
            let ps = Command::new("ps")
                .args(["-A", "-o", "pid=,pgid=,stat="])
                .output()
                .unwrap();
            String::from_utf8_lossy(&ps.stdout)
                .lines()
                .filter(|line| {
                    let fields: Vec<&str> = line.split_whitespace().collect();
                    fields.len() == 3
                        && fields[1].parse::<i32>() == Ok(group)
                        && !fields[2].starts_with('Z')
                })
                .map(str::to_string)
                .collect()
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut survivors = alive_in_group();
        while !survivors.is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
            survivors = alive_in_group();
        }
        assert!(
            survivors.is_empty(),
            "process group {group} (background sleep {background}) survived the cancel: {survivors:?}"
        );
    }

    #[test]
    fn run_wrapped_truncates_at_max_chars() {
        let cancel = Arc::new(AtomicBool::new(false));
        let temp = tempfile::tempdir().unwrap();
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf '0123456789'".to_string(),
        ];
        let result = run_wrapped(&argv, &[], temp.path(), 5_000, 4, cancel).unwrap();
        assert!(!result.cancelled);
        assert_eq!(result.exit_code, 0);
        assert!(result.truncated);
        assert_eq!(result.stdout, b"0123");
        assert_eq!(result.stderr, b"");
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// `%SystemRoot%\System32` and an environment a console program needs to start.
    fn system32() -> String {
        format!("{}\\System32", std::env::var("SystemRoot").unwrap())
    }

    fn windows_env() -> Vec<(String, String)> {
        vec![
            ("SystemRoot".to_string(), std::env::var("SystemRoot").unwrap()),
            ("PATH".to_string(), system32()),
        ]
    }

    /// `cmd.exe /d /s /c <script>`, the form srt itself uses.
    fn cmd(script: &str) -> Vec<String> {
        vec![
            format!("{}\\cmd.exe", system32()),
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            script.to_string(),
        ]
    }

    fn run(script: &str, timeout_ms: u64, max_chars: usize, cancel: Arc<AtomicBool>) -> RunOutput {
        let temp = tempfile::tempdir().unwrap();
        run_wrapped(&cmd(script), &windows_env(), temp.path(), timeout_ms, max_chars, cancel)
            .unwrap()
    }

    #[test]
    fn run_wrapped_captures_output_and_exit_code() {
        let result = run("echo hello& exit 0", 20_000, 1000, Arc::new(AtomicBool::new(false)));
        assert!(!result.cancelled);
        assert_eq!(result.exit_code, 0);
        assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), "hello");
    }

    #[test]
    fn run_wrapped_returns_the_session_ended_exit_code_as_is() {
        let result = run("exit 26", 20_000, 1000, Arc::new(AtomicBool::new(false)));
        assert!(!result.cancelled);
        assert_eq!(result.exit_code, 26);
    }

    #[test]
    fn run_wrapped_truncates_at_max_chars() {
        let result = run("<nul set /p =0123456789", 20_000, 4, Arc::new(AtomicBool::new(false)));
        assert!(!result.cancelled);
        assert!(result.truncated);
        assert_eq!(result.stdout, b"0123");
    }

    #[test]
    fn run_wrapped_stops_a_cancelled_command() {
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            trigger.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let result = run("ping -n 60 127.0.0.1 >nul", 60_000, 1000, cancel);
        assert!(result.cancelled);
        assert_eq!(result.exit_code, 124);
        assert!(started.elapsed() < Duration::from_secs(20), "{:?}", started.elapsed());
    }

    #[test]
    fn run_wrapped_times_out_a_long_command() {
        let started = Instant::now();
        let result = run("ping -n 60 127.0.0.1 >nul", 500, 1000, Arc::new(AtomicBool::new(false)));
        assert!(result.cancelled);
        assert_eq!(result.exit_code, 124);
        assert!(started.elapsed() < Duration::from_secs(20), "{:?}", started.elapsed());
    }

    /// A background descendant that still holds the stderr pipe after the command exited must
    /// not block the readers until it ends on its own (60 s here).
    #[test]
    fn run_wrapped_does_not_wait_for_background_descendants() {
        let started = Instant::now();
        let result = run(
            "start /b ping -n 60 127.0.0.1 >nul & exit 0",
            120_000,
            1000,
            Arc::new(AtomicBool::new(false)),
        );
        assert!(!result.cancelled);
        assert_eq!(result.exit_code, 0);
        assert!(started.elapsed() < Duration::from_secs(20), "{:?}", started.elapsed());
    }
}
