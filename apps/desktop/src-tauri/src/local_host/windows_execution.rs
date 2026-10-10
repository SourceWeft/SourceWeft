//! niubash one-shot execution. A Job Object contains the entire process tree;
//! this is process lifetime control, not a filesystem or network sandbox.
use super::{HostError, Result};
use serde_json::{json, Value};
use std::{
    io::Read,
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::*,
        Threading::{
            OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
        },
    },
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub fn resolve_niubash() -> Result<PathBuf> {
    if let Some(configured) = std::env::var_os("SOURCEWEFT_NIUBASH_PATH") {
        let path = PathBuf::from(configured);
        if !path.is_absolute() || !path.is_file() {
            return Err(HostError::new(
                "NIUBASH_UNAVAILABLE",
                "SOURCEWEFT_NIUBASH_PATH must identify an absolute niu.exe path.",
            ));
        }
        return Ok(path.canonicalize()?);
    }
    // Packaged Windows builds (including debug installers) use resources next
    // to the executable. Tauri dev and cargo tests use the prepared source copy.
    let directory = std::env::current_exe()?
        .parent()
        .ok_or_else(|| HostError::new("NIUBASH_UNAVAILABLE", "Missing application directory."))?
        .to_path_buf();
    let path = directory.join("resources/niubash/niu.exe");
    #[cfg(debug_assertions)]
    let path = if path.is_file() {
        path
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/niubash/niu.exe")
    };
    if !path.is_file() {
        return Err(HostError::new(
            "NIUBASH_UNAVAILABLE",
            "Bundled niubash is missing. Repair or reinstall SourceWeft.",
        ));
    }
    Ok(path.canonicalize()?)
}

pub fn require_trusted_execution() -> Result<()> {
    match std::env::var("SOURCEWEFT_WINDOWS_TRUSTED_LOCAL_EXECUTION") {
        Err(std::env::VarError::NotPresent) => {}
        Ok(value) if value == "true" => {}
        Ok(value) if value == "false" => {
            return Err(HostError::new(
                "WINDOWS_LOCAL_EXECUTION_DISABLED",
                "Windows local execution is disabled by the desktop environment.",
            ))
        }
        _ => {
            return Err(HostError::new(
                "INVALID_LOCAL_EXECUTION_CONFIG",
                "SOURCEWEFT_WINDOWS_TRUSTED_LOCAL_EXECUTION must be true or false.",
            ))
        }
    }
    resolve_niubash()?;
    Ok(())
}

fn create_job() -> Result<Handle> {
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    let job = Handle(job);
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(HostError::new(
            "PROCESS_CONTROL_UNAVAILABLE",
            std::io::Error::last_os_error().to_string(),
        ));
    }
    Ok(job)
}

fn resume_process(pid: u32) -> Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().into());
    }
    let snapshot = Handle(snapshot);
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    let mut found = unsafe { Thread32First(snapshot.0, &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let thread = Handle(thread);
            if unsafe { ResumeThread(thread.0) } == u32::MAX {
                return Err(std::io::Error::last_os_error().into());
            }
            return Ok(());
        }
        found = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }
    Err(HostError::new(
        "PROCESS_CONTROL_UNAVAILABLE",
        "Could not resume the niubash process.",
    ))
}

fn bounded_read(mut pipe: impl Read, max: usize) -> (Vec<u8>, bool) {
    let mut output = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 8192];
    while let Ok(count) = pipe.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let keep = count.min(max.saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    (output, truncated)
}

pub(crate) fn execute(
    root: &Path,
    cwd: &Path,
    script: &str,
    timeout: u64,
    max: usize,
    cancel: Arc<AtomicBool>,
) -> Result<Value> {
    require_trusted_execution()?;
    if cancel.load(Ordering::SeqCst) {
        return Err(HostError::new(
            "CALL_CANCELLED",
            "Invocation was cancelled before execution.",
        ));
    }
    let niu = resolve_niubash()?;
    let relative = cwd
        .strip_prefix(root)
        .map_err(|_| HostError::new("PATH_DENIED", "Working directory is outside the task."))?;
    let _directory = super::windows_files::pin_directory(root, relative)?;
    let job = create_job()?;
    let mut command = Command::new(&niu);
    command
        .args(["-c", script])
        .current_dir(cwd)
        .env_clear()
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("TEMP", root)
        .env("TMP", root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    // Preserve installed native tools and Windows loader settings, not deployment
    // secrets or NIU_ENV/BASH_ENV startup hooks.
    for name in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "PATHEXT",
        "LOCALAPPDATA",
        "APPDATA",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command
        .spawn()
        .map_err(|e| HostError::new("NIUBASH_UNAVAILABLE", e.to_string()))?;
    if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } == 0 {
        let error = std::io::Error::last_os_error();
        let _ = child.kill();
        let _ = child.wait();
        return Err(HostError::new(
            "PROCESS_CONTROL_UNAVAILABLE",
            error.to_string(),
        ));
    }
    if let Err(error) = resume_process(child.id()) {
        unsafe {
            TerminateJobObject(job.0, 1);
        }
        let _ = child.wait();
        return Err(error);
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| HostError::new("PIPE_FAILED", "Missing stdout."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| HostError::new("PIPE_FAILED", "Missing stderr."))?;
    let out = std::thread::spawn(move || bounded_read(stdout, max));
    let err = std::thread::spawn(move || bounded_read(stderr, max));
    let start = Instant::now();
    let mut cancelled = false;
    let status = loop {
        if cancel.load(Ordering::SeqCst) || start.elapsed() >= Duration::from_millis(timeout) {
            cancelled = true;
            if unsafe { TerminateJobObject(job.0, 124) } == 0 {
                return Err(HostError::new(
                    "PROCESS_CONTROL_UNAVAILABLE",
                    "Could not stop the execution job.",
                ));
            }
            break child.wait()?;
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // Kill background descendants before joining readers, even on normal exit.
    drop(job);
    let (out, ot) = out
        .join()
        .map_err(|_| HostError::new("PIPE_FAILED", "stdout reader failed."))?;
    let (err, et) = err
        .join()
        .map_err(|_| HostError::new("PIPE_FAILED", "stderr reader failed."))?;
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    );
    Ok(
        json!({"output":output.chars().take(max).collect::<String>(),"exitCode":status.code().unwrap_or(1),
        "truncated":ot||et||output.chars().count()>max,"cancelled":cancelled}),
    )
}
