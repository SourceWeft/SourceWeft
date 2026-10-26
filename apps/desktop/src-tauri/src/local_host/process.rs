//! Shared spawn/timeout/cancel/group-kill/bounded-output loop for running a command behind a
//! sandbox wrapper. macOS builds a `sandbox-exec` argv around this; a future Linux sidecar
//! runner reuses it unchanged, so this module must compile on every unix target even though
//! it currently has only one caller.
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

/// Spawns `argv` in its own process group with the environment cleared then set to exactly
/// `env`, bounds stdout/stderr to `max_chars` bytes each, and SIGKILLs the whole group on
/// cancellation, on timeout, and once more after the process exits, so no background
/// descendant can outlive this call or keep the output pipes open.
#[allow(dead_code)]
pub(crate) fn run_wrapped(
    argv: &[String],
    env: &[(String, String)],
    cwd: &Path,
    timeout_ms: u64,
    max_chars: usize,
    cancel: Arc<AtomicBool>,
) -> Result<RunOutput> {
    use std::os::unix::process::CommandExt;
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| HostError::new("INVALID_CALL", "Empty command"))?;
    let mut command = Command::new(program);
    command.args(args).current_dir(cwd).env_clear();
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()?;
    let group = child.id() as i32;
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
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            };
            break child.wait()?;
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    // No background descendants may outlive this execution or keep output pipes open.
    unsafe {
        libc::kill(-group, libc::SIGKILL);
    }
    let (stdout, out_truncated) = out
        .join()
        .map_err(|_| HostError::new("PIPE_FAILED", "stdout failed"))?;
    let (stderr, err_truncated) = err
        .join()
        .map_err(|_| HostError::new("PIPE_FAILED", "stderr failed"))?;
    Ok(RunOutput {
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(if cancelled { 124 } else { 1 }),
        truncated: out_truncated || err_truncated,
        cancelled,
    })
}

#[cfg(test)]
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
