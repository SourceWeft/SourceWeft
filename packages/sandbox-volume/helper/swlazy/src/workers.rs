//! Restartable content workers. The FUSE dispatch process retains every request
//! and reply; only idempotent immutable-chunk reads cross this IPC boundary.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use swvol_core::{ChunkLoc, Fetcher, MAX_CHUNK_BYTES};

const WORKERS: usize = 4;
const MAX_FRAME: usize = 64 * 1024;
const MAX_ATTEMPTS: usize = 3;
#[derive(Serialize, Deserialize)]
struct Request { version: u32, id: u64, hash: String, location: ChunkLoc, url: String }
#[derive(Serialize, Deserialize)]
struct Response { version: u32, id: u64, bytes: usize, error: Option<String> }
#[derive(Serialize, Deserialize)]
struct Hello { version: u32, pid: u32 }
fn write_frame<T: Serialize>(stream: &mut UnixStream, value: &T) -> Result<()> {
    let json = serde_json::to_vec(value)?;
    if json.len() > MAX_FRAME { bail!("worker control frame exceeds budget"); }
    stream.write_all(&(json.len() as u32).to_be_bytes())?; stream.write_all(&json)?;
    Ok(())
}
fn read_frame<T: for<'de> Deserialize<'de>>(stream: &mut UnixStream) -> Result<T> {
    let mut length = [0u8; 4]; stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME { bail!("invalid worker control frame length"); }
    let mut bytes = vec![0u8; length]; stream.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes).context("invalid worker control frame")?)
}
fn read_exact_until(stream: &mut UnixStream, bytes: &mut [u8], deadline: Instant) -> Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let remaining = deadline.checked_duration_since(Instant::now()).context("content worker read budget expired")?;
        stream.set_read_timeout(Some(remaining))?;
        let count = stream.read(&mut bytes[offset..])?;
        if count == 0 { return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into()); }
        offset += count;
    }
    Ok(())
}
fn read_response_until(stream: &mut UnixStream, deadline: Instant) -> Result<Response> {
    let mut length = [0u8; 4]; read_exact_until(stream, &mut length, deadline)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME { bail!("invalid worker response frame length"); }
    let mut bytes = vec![0; length]; read_exact_until(stream, &mut bytes, deadline)?;
    Ok(serde_json::from_slice(&bytes).context("invalid worker response frame")?)
}
struct Worker { child: Child, stream: UnixStream }
impl Drop for Worker {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
impl Worker {
    fn spawn(handshake_budget: Duration) -> Result<Self> {
        let (stream, socket) = UnixStream::pair()?;
        let fd = socket.as_raw_fd();
        let parent = std::process::id() as libc::pid_t;
        let mut command = Command::new(std::env::current_exe()?);
        // Attachment bootstrap/control credentials stay in the dispatch process.
        // Workers receive only the presigned read URL for their current request.
        command.env_clear();
        for key in ["LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
        #[cfg(debug_assertions)]
        if let Some(value) = std::env::var_os("SWVOL_WORKER_TEST_FAULT_DIR") { command.env("SWVOL_WORKER_TEST_FAULT_DIR", value); }
        command.args(["chunk-worker", "--fd", &fd.to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
        unsafe { command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 { return Err(std::io::Error::last_os_error()); }
            if libc::getppid() != parent { return Err(std::io::Error::other("dispatch exited during worker launch")); }
            Ok(())
        }); }
        let child = command.spawn().context("cannot launch content worker")?;
        drop(socket);
        let mut worker = Self { child, stream };
        worker.stream.set_read_timeout(Some(handshake_budget))?;
        let hello: Hello = read_frame(&mut worker.stream)?;
        if hello.version != 1 || hello.pid != worker.child.id() { bail!("content worker handshake mismatch"); }
        Ok(worker)
    }
    fn exchange(&mut self, request: &Request, deadline: Instant) -> Result<std::result::Result<Vec<u8>, String>> {
        let remaining = deadline.checked_duration_since(Instant::now()).context("content worker request budget expired")?;
        self.stream.set_write_timeout(Some(remaining))?;
        write_frame(&mut self.stream, request)?;
        let response = read_response_until(&mut self.stream, deadline)?;
        if response.version != 1 || response.id != request.id || response.bytes > MAX_CHUNK_BYTES as usize { bail!("content worker response identity or length mismatch"); }
        if let Some(error) = response.error {
            if response.bytes != 0 { bail!("content worker returned bytes with an error"); }
            return Ok(Err(error));
        }
        if response.bytes != request.location.3 as usize { bail!("content worker raw length mismatch"); }
        let mut bytes = vec![0; response.bytes]; read_exact_until(&mut self.stream, &mut bytes, deadline)?;
        // The dispatch process never trusts a worker's claim of validation.
        if swvol_core::raw_chunk_hash(&bytes) != request.hash { bail!("content worker raw hash mismatch"); }
        Ok(Ok(bytes))
    }
}
pub struct Workers {
    slots: Vec<Mutex<Option<Worker>>>,
    next: AtomicUsize,
    ids: AtomicU64,
}
impl Workers {
    pub fn new() -> Result<Self> {
        let mut slots = Vec::new();
        for _ in 0..WORKERS { slots.push(Mutex::new(Some(Worker::spawn(Duration::from_secs(5))?))); }
        Ok(Self { slots, next: AtomicUsize::new(0), ids: AtomicU64::new(1) })
    }
    pub fn chunk(&self, hash: &str, location: &ChunkLoc, url: &str, deadline: Instant) -> Result<Vec<u8>> {
        let start = self.next.fetch_add(1, Ordering::Relaxed) % self.slots.len();
        let mut worker = loop {
            let mut available = None;
            for offset in 0..self.slots.len() {
                match self.slots[(start + offset) % self.slots.len()].try_lock() {
                    Ok(slot) => { available = Some(slot); break; },
                    Err(std::sync::TryLockError::Poisoned(_)) => bail!("content worker slot lock poisoned"),
                    Err(std::sync::TryLockError::WouldBlock) => {},
                }
            }
            if let Some(slot) = available { break slot; }
            if Instant::now() >= deadline { bail!("content worker queue budget expired"); }
            std::thread::sleep(Duration::from_millis(2));
        };
        let request = Request { version: 1, id: self.ids.fetch_add(1, Ordering::Relaxed), hash: hash.into(), location: location.clone(), url: url.into() };
        // Bound control payloads before classifying communication failures as retryable.
        if serde_json::to_vec(&request)?.len() > MAX_FRAME { bail!("chunk request exceeds worker IPC budget"); }
        for attempt in 0..MAX_ATTEMPTS {
            let remaining = deadline.checked_duration_since(Instant::now()).context("content worker retry budget expired")?;
            if worker.is_none() { *worker = Some(Worker::spawn(remaining.min(Duration::from_secs(5)))?); }
            match worker.as_mut().unwrap().exchange(&request, deadline) {
                Ok(Ok(bytes)) => return Ok(bytes),
                // Remote HTTP/integrity failures are returned as errors. Restart
                // only repairs a crashed/broken worker, never changes the source.
                Ok(Err(error)) => bail!("content read failed: {error}"),
                Err(_) => {
                    worker.take(); // terminate/reap before replacing this slot
                    eprintln!("swvol: content worker interrupted; retrying immutable read (attempt {})", attempt + 1);
                }
            }
        }
        bail!("content worker failed after bounded restarts")
    }
}

#[cfg(debug_assertions)]
fn fault_boundary(point: &str) {
    let Some(directory) = std::env::var_os("SWVOL_WORKER_TEST_FAULT_DIR") else { return; };
    let directory = std::path::PathBuf::from(directory);
    let armed = directory.join(format!("arm-{point}"));
    if std::fs::rename(&armed, directory.join(format!("claimed-{point}"))).is_ok() {
        std::fs::write(directory.join(format!("observed-{point}")), std::process::id().to_string()).unwrap();
        loop { std::thread::sleep(Duration::from_millis(50)); }
    }
}
#[cfg(not(debug_assertions))]
fn fault_boundary(_point: &str) {}

pub fn serve(fd: i32) -> Result<()> {
    if fd < 3 { bail!("content worker requires an inherited private socket"); }
    let mut stream = unsafe { UnixStream::from_raw_fd(fd) };
    write_frame(&mut stream, &Hello { version: 1, pid: std::process::id() })?;
    let fetcher = Fetcher::default();
    loop {
        let request: Request = match read_frame(&mut stream) {
            Ok(request) => request,
            Err(error) if error.downcast_ref::<std::io::Error>().map(|e| e.kind() == std::io::ErrorKind::UnexpectedEof).unwrap_or(false) => return Ok(()),
            Err(error) => return Err(error),
        };
        if request.version != 1 { bail!("unsupported worker IPC version"); }
        fault_boundary("before-fetch");
        let result = (|| {
            let compressed = fetcher.compressed(&request.location, &request.url)?;
            fault_boundary("after-download");
            let data = swvol_core::decode_chunk(&request.hash, &request.location, &compressed)?;
            fault_boundary("after-decode");
            Ok::<_, anyhow::Error>(data)
        })();
        match result {
            Ok(data) => {
                write_frame(&mut stream, &Response { version: 1, id: request.id, bytes: data.len(), error: None })?;
                let half = data.len() / 2;
                stream.write_all(&data[..half])?;
                fault_boundary("mid-response");
                stream.write_all(&data[half..])?;
            }
            Err(error) => {
                // These messages contain operation/status context, never signed URLs.
                let error: String = format!("{error:#}").chars().take(2048).collect();
                write_frame(&mut stream, &Response { version: 1, id: request.id, bytes: 0, error: Some(error) })?;
            }
        }
    }
}
