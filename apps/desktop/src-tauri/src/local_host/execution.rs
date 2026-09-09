use super::{HostError, LocalHost, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Executions {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
impl Executions {
    pub fn cancel(&self, id: &str) -> bool {
        if let Ok(active) = self.active.lock() {
            if let Some(cancel) = active.get(id) {
                cancel.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }
    pub fn cancel_all(&self) {
        if let Ok(active) = self.active.lock() {
            for cancel in active.values() {
                cancel.store(true, Ordering::SeqCst);
            }
        }
    }
}

impl LocalHost {
    pub fn initialize_invocation_journal(&self) -> Result<()> {
        self.db.lock().map_err(|_| HostError::new("HOST_UNAVAILABLE", "Database lock failed"))?.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_invocations(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
             UPDATE local_invocations SET state='unknown' WHERE state='running';")?;
        Ok(())
    }

    pub fn dispatch(
        &self,
        calls: &Executions,
        id: &str,
        owner: &str,
        thread: &str,
        action: &str,
        payload: Value,
    ) -> Result<Value> {
        let fingerprint = serde_json::to_string(&(owner, thread, action, &payload))
            .map_err(|e| HostError::new("INVALID_CALL", e.to_string()))?;
        {
            let db = self
                .db
                .lock()
                .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Database lock failed"))?;
            let saved: Option<(String, String, Option<String>)> = db
                .query_row(
                    "SELECT payload,state,result FROM local_invocations WHERE id=?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            if let Some((old, state, result)) = saved {
                if old != fingerprint {
                    return Err(HostError::new(
                        "INVOCATION_CONFLICT",
                        "Invocation parameters changed",
                    ));
                }
                if state == "done" {
                    return serde_json::from_str(&result.unwrap_or_default())
                        .map_err(|e| HostError::new("INVALID_JOURNAL", e.to_string()));
                }
                return Err(HostError::new(
                    "OUTCOME_UNKNOWN",
                    "This call was already started. It will not be executed twice.",
                ));
            }
            db.execute(
                "INSERT INTO local_invocations(id,payload,state) VALUES(?1,?2,'running')",
                params![id, fingerprint],
            )?;
        }
        let outcome = self.perform(calls, id, owner, thread, action, &payload);
        if let Ok(value) = &outcome {
            let serialized = serde_json::to_string(value)
                .map_err(|e| HostError::new("INVALID_RESULT", e.to_string()))?;
            self.db
                .lock()
                .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Database lock failed"))?
                .execute(
                    "UPDATE local_invocations SET state='done',result=?2 WHERE id=?1",
                    params![id, serialized],
                )?;
        }
        outcome
    }

    fn perform(
        &self,
        calls: &Executions,
        id: &str,
        owner: &str,
        thread: &str,
        action: &str,
        payload: &Value,
    ) -> Result<Value> {
        if action == "workspace.ensure" {
            return serde_json::to_value(self.ensure_workspace(owner, thread)?)
                .map_err(|e| HostError::new("INVALID_RESULT", e.to_string()));
        }
        if action == "command.cancel" {
            let target = text(payload, "executionId")?;
            calls.cancel(target);
            return Ok(json!({"confirmed":false}));
        }
        let workspace = self.get_workspace(owner, thread, text(payload, "workspaceId")?)?;
        if action == "command.execute" {
            let command = text(payload, "command")?;
            if command.len() > 64 * 1024 {
                return Err(HostError::new("COMMAND_TOO_LARGE", "Command is too large"));
            }
            let cwd = checked_path(
                &workspace.path,
                payload.get("cwd").and_then(Value::as_str).unwrap_or("."),
                true,
            )?;
            let timeout = payload
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(30000)
                .clamp(1, 120000);
            let max_output = payload
                .get("maxOutputChars")
                .and_then(Value::as_u64)
                .unwrap_or(20000)
                .clamp(1, 100000) as usize;
            let cancel = Arc::new(AtomicBool::new(false));
            calls
                .active
                .lock()
                .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Execution lock failed"))?
                .insert(id.into(), cancel.clone());
            let result =
                execute_command(&workspace.path, &cwd, command, timeout, max_output, cancel);
            if let Ok(mut active) = calls.active.lock() {
                active.remove(id);
            }
            return result;
        }
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let relative = text(payload, "path")?;
        match action {
            "file.read" => {
                // Current Agent file tools request text; bounded descriptor reads retain
                // traversal/link protection. Binary transfer is an explicit later capability.
                let content = self.read_text(owner, thread, &workspace.id, relative)?;
                Ok(json!({"content":STANDARD.encode(content.as_bytes())}))
            }
            "file.write" => {
                let bytes = STANDARD
                    .decode(text(payload, "content")?)
                    .map_err(|e| HostError::new("INVALID_CONTENT", e.to_string()))?;
                if bytes.len() > 1024 * 1024 {
                    return Err(HostError::new("FILE_TOO_LARGE", "File exceeds 1 MiB"));
                }
                let path = checked_path(&workspace.path, relative, false)?;
                // Workspace mutation is serialized by the device dispatcher. Refuse
                // replacing files in this first delivery; generated outputs use new names.
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                Ok(json!({"bytes":bytes.len()}))
            }
            "file.mkdir" => {
                let path = checked_path(&workspace.path, relative, false)?;
                if !path.exists() {
                    std::fs::create_dir(&path)?;
                }
                if !path.is_dir() {
                    return Err(HostError::new("NOT_A_DIRECTORY", "Path is not a directory"));
                }
                Ok(json!({"created":true}))
            }
            "file.list" => {
                let path = checked_path(&workspace.path, relative, true)?;
                let mut files = Vec::new();
                for entry in std::fs::read_dir(path)?.take(500) {
                    let entry = entry?;
                    let meta = entry.path().symlink_metadata()?;
                    if meta.file_type().is_symlink() {
                        continue;
                    }
                    files.push(json!({"path":entry.path().strip_prefix(&workspace.path).map_err(|_|HostError::new("PATH_DENIED","Outside workspace"))?.to_string_lossy(),"is_dir":meta.is_dir(),"size":meta.len()}));
                }
                Ok(json!({"files":files}))
            }
            _ => Err(HostError::new(
                "UNSUPPORTED_ACTION",
                "The local action is not implemented",
            )),
        }
    }
}

fn text<'a>(payload: &'a Value, key: &str) -> Result<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::new("INVALID_CALL", format!("Missing {key}")))
}

fn checked_path(root: &Path, relative: &str, must_exist: bool) -> Result<std::path::PathBuf> {
    use std::path::Component;
    let mut result = root.to_owned();
    for component in Path::new(relative).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => {
                result.push(part);
                if let Ok(meta) = result.symlink_metadata() {
                    if meta.file_type().is_symlink() {
                        return Err(HostError::new(
                            "PATH_DENIED",
                            "Symbolic links are not allowed",
                        ));
                    }
                }
            }
            _ => {
                return Err(HostError::new(
                    "PATH_DENIED",
                    "Expected a workspace-relative path",
                ))
            }
        }
    }
    if must_exist && !result.exists() {
        return Err(HostError::new("PATH_MISSING", "Path does not exist"));
    }
    Ok(result)
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

fn execute_command(
    root: &Path,
    cwd: &Path,
    script: &str,
    timeout: u64,
    max: usize,
    cancel: Arc<AtomicBool>,
) -> Result<Value> {
    use std::os::unix::process::CommandExt;
    let proxy = super::proxy::PublicProxy::start()?;
    let policy = super::sandbox::command_profile(root, proxy.port)?;
    let proxy_url = format!("http://127.0.0.1:{}", proxy.port);
    let mut child = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &policy, "/bin/sh", "-c", script])
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", root)
        .env("TMPDIR", root)
        .env("HTTP_PROXY", &proxy_url)
        .env("HTTPS_PROXY", &proxy_url)
        .env("http_proxy", &proxy_url)
        .env("https_proxy", &proxy_url)
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
    let out = std::thread::spawn(move || bounded_read(stdout, max));
    let err = std::thread::spawn(move || bounded_read(stderr, max));
    let start = Instant::now();
    let mut cancelled = false;
    let status = loop {
        if cancel.load(Ordering::SeqCst) || start.elapsed() > Duration::from_millis(timeout) {
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
    let (out, ot) = out
        .join()
        .map_err(|_| HostError::new("PIPE_FAILED", "stdout failed"))?;
    let (err, et) = err
        .join()
        .map_err(|_| HostError::new("PIPE_FAILED", "stderr failed"))?;
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    );
    Ok(
        json!({"output":output.chars().take(max).collect::<String>(),"exitCode":status.code().unwrap_or(if cancelled{124}else{1}),"truncated":ot||et||output.chars().count()>max,"cancelled":cancelled}),
    )
}
