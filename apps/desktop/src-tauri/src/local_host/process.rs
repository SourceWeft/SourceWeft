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
        let trigger = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            trigger.store(true, Ordering::SeqCst);
        });
        let temp = tempfile::tempdir().unwrap();
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "sleep 30 & sleep 30".to_string(),
        ];
        let result = run_wrapped(&argv, &[], temp.path(), 10_000, 1000, cancel).unwrap();
        assert!(result.cancelled, "expected cancellation to be reported");
        assert_eq!(result.exit_code, 124);

        // Give the process table a moment to settle, then make sure neither `sleep 30`
        // (the `sh` child nor its own backgrounded sibling) survived the group kill.
        std::thread::sleep(Duration::from_millis(200));
        let ps = Command::new("ps")
            .args(["-eo", "command"])
            .output()
            .unwrap();
        let listing = String::from_utf8_lossy(&ps.stdout);
        assert!(
            !listing.contains("sleep 30"),
            "leftover sleep process(es) after cancel: {listing}"
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
