//! Bounded retries shared by metadata, plugin checks and package transfers.
//! Never changes endpoints, proxy settings or certificate/signature verification.
use serde_json::{json, Value};
use std::{
    error::Error,
    future::Future,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::Instant;

pub const CHECK_BUDGET: Duration = Duration::from_secs(50);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const DOWNLOAD_BUDGET: Duration = Duration::from_secs(1200);
const LOG_LIMIT: u64 = 256 * 1024;

pub struct Journal {
    path: PathBuf,
    lock: Mutex<()>,
}
impl Journal {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }
    pub fn write(&self, value: Value) {
        if self.append(value).is_err() {
            eprintln!("desktop_update: local diagnostic log unavailable");
        }
    }
    fn append(&self, mut value: Value) -> std::io::Result<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| std::io::Error::other("log lock poisoned"))?;
        value["time"] = json!(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs());
        for path in [&self.path, &self.path.with_extension("log.1")] {
            match std::fs::symlink_metadata(path) {
                Ok(m) if !m.file_type().is_file() => {
                    return Err(std::io::Error::other("log must be a regular file"))
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        if std::fs::metadata(&self.path).is_ok_and(|m| m.len() >= LOG_LIMIT) {
            let previous = self.path.with_extension("log.1");
            if previous.exists() {
                std::fs::remove_file(&previous)?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
            }
            std::fs::rename(&self.path, previous)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            let mut file = options.open(&self.path)?;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            writeln!(file, "{value}")?;
        }
        #[cfg(not(unix))]
        {
            writeln!(options.open(&self.path)?, "{value}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct Failure {
    pub code: String,
    pub kind: &'static str,
    pub causes: Vec<&'static str>,
    pub status: Option<u16>,
    pub retryable: bool,
    pub retry_after: Option<Duration>,
}
impl Failure {
    pub fn terminal(code: impl Into<String>) -> Self {
        let raw = code.into();
        let code = raw.split(':').next().unwrap_or_default();
        let code = if !code.is_empty()
            && code.len() <= 80
            && code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            code.to_owned()
        } else {
            "UPDATE_FAILED".into()
        };
        Self {
            code,
            kind: "policy",
            causes: vec![],
            status: None,
            retryable: false,
            retry_after: None,
        }
    }
    pub fn http(status: u16, retry_after: Option<Duration>) -> Self {
        Self {
            code: if status == 404 {
                "UPDATE_CHANNEL_UNAVAILABLE".into()
            } else {
                format!("UPDATE_HTTP_{status}")
            },
            kind: "http",
            causes: vec![],
            status: Some(status),
            retryable: matches!(status, 408 | 429 | 500 | 502 | 503 | 504),
            retry_after,
        }
    }
    pub fn transport(error: &(dyn Error + 'static), timeout: bool) -> Self {
        // Project each cause onto a fixed vocabulary. Do not persist arbitrary error
        // text: proxy URLs, credentials and response content can occur at any depth.
        let mut causes = Vec::new();
        let mut current = Some(error);
        let mut transient = timeout;
        let mut certificate = false;
        for _ in 0..12 {
            let Some(e) = current else { break };
            let text = e.to_string().to_ascii_lowercase();
            let label = if text.contains("certificate")
                || text.contains("unknownissuer")
                || text.contains("invalid peer")
            {
                certificate = true;
                "certificate validation failed"
            } else if text.contains("tls handshake eof") {
                transient = true;
                "tls handshake eof"
            } else if let Some(io) = e.downcast_ref::<std::io::Error>() {
                match io.kind() {
                    std::io::ErrorKind::TimedOut => {
                        transient = true;
                        "operation timed out"
                    }
                    std::io::ErrorKind::ConnectionReset => {
                        transient = true;
                        "connection reset"
                    }
                    std::io::ErrorKind::ConnectionAborted => {
                        transient = true;
                        "connection aborted"
                    }
                    std::io::ErrorKind::ConnectionRefused => {
                        transient = true;
                        "connection refused"
                    }
                    std::io::ErrorKind::BrokenPipe => {
                        transient = true;
                        "broken pipe"
                    }
                    std::io::ErrorKind::UnexpectedEof => {
                        transient = true;
                        "unexpected end of stream"
                    }
                    _ => "unclassified I/O error (details omitted)",
                }
            } else if text.contains("connection closed before message completed")
                || text.contains("end of file before message length reached")
            {
                transient = true;
                "response body interrupted"
            } else if text.contains("dns error") {
                "DNS resolution failed"
            } else if text.contains("client error (connect)") {
                "client connect error"
            } else if text.contains("error sending request") {
                "request send failed"
            } else if text.contains("error decoding response body")
                || text.contains("error reading a body")
            {
                "response body read failed"
            } else {
                "unclassified cause (details omitted)"
            };
            causes.push(label);
            current = e.source();
        }
        Self {
            code: "UPDATE_NETWORK".into(),
            kind: if certificate {
                "certificate"
            } else if timeout {
                "timeout"
            } else {
                "transport"
            },
            causes,
            status: None,
            retryable: transient && !certificate,
            retry_after: None,
        }
    }
    pub fn reqwest(error: reqwest::Error) -> Self {
        Self::transport(&error, error.is_timeout())
    }
    pub fn plugin(error: tauri_plugin_updater::Error) -> Self {
        match error {
            tauri_plugin_updater::Error::Reqwest(e) => Self::transport(&e, e.is_timeout()),
            // The plugin discards headers/status for some failures. Do not infer a
            // retry from free-form strings or retry signature/installation errors.
            tauri_plugin_updater::Error::Minisign(_)
            | tauri_plugin_updater::Error::Base64(_)
            | tauri_plugin_updater::Error::SignatureUtf8(_) => {
                Self::terminal("UPDATE_SIGNATURE_INVALID")
            }
            _ => Self::terminal("UPDATE_PLUGIN_FAILED"),
        }
    }
    pub fn message(&self) -> String {
        if self.causes.is_empty() {
            self.code.clone()
        } else {
            format!(
                "{}: {} ({})",
                self.code,
                self.kind,
                self.causes.join(" -> ")
            )
        }
    }
    pub fn cancelled(&self) -> bool {
        self.code == "UPDATE_CANCELLED"
    }
}

pub struct Operation {
    pub id: String,
    pub deadline: Instant,
}
impl Operation {
    pub fn new(budget: Duration) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            deadline: Instant::now() + budget,
        }
    }
}
#[derive(Clone, Copy)]
pub struct Policy {
    pub attempts: u32,
    pub timeout: Duration,
    pub backoff: Duration,
}
impl Policy {
    pub const METADATA: Self = Self {
        attempts: 3,
        timeout: REQUEST_TIMEOUT,
        backoff: Duration::from_secs(1),
    };
    pub const DOWNLOAD: Self = Self {
        attempts: 2,
        timeout: DOWNLOAD_BUDGET,
        backoff: Duration::from_secs(1),
    };
}
async fn cancelled(cancel: Option<&AtomicBool>) {
    loop {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
pub async fn run<T, F, Fut>(
    journal: &Journal,
    operation: &Operation,
    phase: &'static str,
    policy: Policy,
    cancel: Option<&AtomicBool>,
    mut request: F,
) -> Result<T, Failure>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T, Failure>>,
{
    for attempt in 1..=policy.attempts {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(Failure::terminal("UPDATE_CANCELLED"));
        }
        if Instant::now() >= operation.deadline {
            return Err(Failure::terminal("UPDATE_BUDGET_EXHAUSTED"));
        }
        let start = Instant::now();
        journal.write(json!({"event":"update_request", "operationId":operation.id,"phase":phase,"attempt":attempt,"outcome":"started"}));
        let result = tokio::select! {
            biased;
            _ = cancelled(cancel) => Err(Failure::terminal("UPDATE_CANCELLED")),
            r = tokio::time::timeout_at(operation.deadline.min(start + policy.timeout), request(attempt)) => r.unwrap_or_else(|_| {
                let mut e = Failure::terminal("UPDATE_NETWORK"); e.kind = "timeout"; e.retryable = true; e.causes = vec!["operation timed out"]; Err(e)
            }),
        };
        let error = match result {
            Ok(value) => {
                journal.write(json!({"event":"update_request","operationId":operation.id,"phase":phase,"attempt":attempt,"outcome":"succeeded","recovered":attempt>1,"elapsedMs":start.elapsed().as_millis()}));
                return Ok(value);
            }
            Err(error) => error,
        };
        let jitter = Duration::from_millis(u64::from(uuid::Uuid::new_v4().as_bytes()[0]));
        let delay = (policy.backoff * attempt + jitter).max(error.retry_after.unwrap_or_default());
        let retry = error.retryable
            && attempt < policy.attempts
            && Instant::now()
                .checked_add(delay)
                .is_some_and(|next| next < operation.deadline);
        journal.write(json!({"event":"update_request","operationId":operation.id,"phase":phase,"attempt":attempt,"outcome":"failed","elapsedMs":start.elapsed().as_millis(),"errorCode":error.code,"kind":error.kind,"causes":error.causes,"httpStatus":error.status,"retry":retry,"delayMs":if retry {Some(delay.as_millis())} else {None}}));
        if !retry {
            return Err(error);
        }
        tokio::select! {
            biased;
            _ = cancelled(cancel) => {
                journal.write(json!({"event":"update_request","operationId":operation.id,"phase":phase,"attempt":attempt,"outcome":"cancelled"}));
                return Err(Failure::terminal("UPDATE_CANCELLED"));
            },
            _ = tokio::time::sleep(delay) => {}
        }
    }
    Err(Failure::terminal("UPDATE_BUDGET_EXHAUSTED"))
}

/// Read the entire manifest inside the attempt so interrupted bodies are retried
/// from the beginning and never parsed as partial metadata.
pub async fn manifest(client: &reqwest::Client, endpoint: &str) -> Result<Value, Failure> {
    let mut response = client
        .get(endpoint)
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(Failure::reqwest)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(Failure::http(
            response.status().as_u16(),
            retry_after(
                response
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok()),
            ),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(Failure::reqwest)? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(Failure::terminal("UPDATE_MANIFEST_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure::terminal("INVALID_UPDATE_MANIFEST"))
}

// Both delta-seconds and HTTP-date Retry-After values follow HTTP semantics.
pub fn retry_after(value: Option<&str>) -> Option<Duration> {
    let value = value?.trim();
    value
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
        .or_else(|| {
            httpdate::parse_http_date(value)
                .ok()
                .map(|date| date.duration_since(SystemTime::now()).unwrap_or_default())
        })
}

#[cfg(test)]
mod tests;
