//! swvol — SourceWeft sandbox volume helper (prototype).
//!
//! Runs inside the sandbox as the unprivileged sandbox user. It never holds a
//! long-lived secret: every object it writes goes to a pre-signed "slot" the
//! host issued for this attachment, and every object it reads comes from a
//! pre-signed URL in the restore plan. Everything it emits is untrusted input
//! to the host, which validates manifests before applying them.
//!
//! Commands:
//!   restore  --root R --plan FILE|URL     materialize a volume, write local state
//!   daemon   --root R                     inotify watcher + debounced/periodic sync + flush socket
//!   flush    --root R [--full]            sync barrier: via the daemon socket, or directly
//!   treehash --root R                     deterministic digest of the tree (verification)

mod safe_fs;
mod control_client;
mod capture;

use anyhow::{anyhow, bail, Context, Result};
use swvol_core::{ChunkRef, ChunkLoc, WireEntry, Manifest, RestorePlan as Plan};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{FileExt as UnixFileExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const META_DIR: &str = ".sourceweft";
static STATE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
static CONTROL_ALLOW_HTTP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Subtrees with very many directories: watched only at their top, rescanned as a whole.
const HEAVY_DIRS: &[&str] = &["node_modules", ".venv", "__pycache__", ".git"];
const CDC_MIN: u32 = 256 * 1024;
const CDC_AVG: u32 = 1024 * 1024;
const CDC_MAX: u32 = 4 * 1024 * 1024;
const PACK_TARGET: usize = 16 * 1024 * 1024;
const ZSTD_LEVEL: i32 = 3;
/// New chunk data up to this size rides inside the manifest object itself:
/// one PUT commits a small change instead of two.
const INLINE_MAX: usize = 4 * 1024 * 1024;
const MANIFEST_MAGIC: &[u8; 8] = b"SWVOLM1\n";
const MANIFEST_HEADER: usize = 16; // magic + u64 inline length
const UPLOAD_THREADS: usize = 3;
const QUIET_MS: u64 = 1500; // debounce: sync once writes have been quiet this long
const MAX_DELAY_MS: u64 = 10_000; // ...but never hold dirty state longer than this
const FULL_SCAN_INTERVAL: Duration = Duration::from_secs(300); // inotify is a hint; the scan is the truth

const EXIT_INSTANCE_CHANGED: i32 = 75; // not attached / container replaced: host must re-attach
const EXIT_NEED_SLOTS: i32 = 76; // ran out of pre-signed slots: host must refresh
const EXIT_NO_SPACE: i32 = 78; // retry after local storage is available
const EXIT_PACK_UNREADABLE: i32 = 77; // a pack would not download: host must repair it and re-plan
const READ_STALL_SECS: u64 = 3; // a download slower than MIN_BYTES_PER_WINDOW per window is cut off and resumed
const MIN_BYTES_PER_WINDOW: usize = 2 * 1024 * 1024; // the sandbox link does ~47 MB/s: under 0.7 MB/s is a stall

#[derive(Debug)]
enum NeedSlots { Capture(String), ManifestRead(String) }
impl std::fmt::Display for NeedSlots {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "NEED_SLOTS: {}", match self { Self::Capture(message) | Self::ManifestRead(message) => message }) }
}
impl std::error::Error for NeedSlots {}

fn error_exit_code(error: &anyhow::Error) -> i32 {
    if error.downcast_ref::<NeedSlots>().is_some() { return EXIT_NEED_SLOTS; }
    if error.chain().any(|cause| cause.downcast_ref::<std::io::Error>().map(|e| e.raw_os_error() == Some(28)).unwrap_or(false)) {
        return EXIT_NO_SPACE;
    }
    1
}

fn error_report(root: &Path, error: &anyhow::Error, rebase: Option<u64>) -> serde_json::Value {
    let mut result = serde_json::json!({"ok":false,"error":format!("{error:#}"),"exit_code":error_exit_code(error)});
    // A missing read proof is an authorization renewal, not capture progress.
    // The host may already have advanced head past these unconfirmed receipts.
    if matches!(error.downcast_ref::<NeedSlots>(), Some(NeedSlots::Capture(_))) {
        match capture::progress(root, rebase) {
            Ok(Some(progress)) if progress.has_uploads() => { result["capture_progress"] = serde_json::to_value(progress).expect("capture progress serialization"); },
            Ok(Some(_)) => {},
            Ok(None) => {},
            Err(checkpoint_error) => { result["error"] = format!("{error:#}; durable capture progress unavailable: {checkpoint_error:#}").into(); result["exit_code"] = error_exit_code(&checkpoint_error).into(); },
        }
    }
    result
}

// ---------- on-disk / wire types ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Entry {
    kind: char, // 'f' file, 'd' dir, 'l' symlink
    mode: u32,
    mtime_ns: i64,
    size: u64,
    link: Option<String>,
    chunks: Vec<ChunkRef>,
    // local-only change-detection fields (never sent to the host)
    ino: u64,
    ctime_ns: i64,
}

#[derive(Serialize, Deserialize, Default)]
struct State {
    volume: String,
    attachment: String,
    boot_id: String,
    seq: u64,
    next_pack: u32,
    entries: BTreeMap<String, Entry>,
    have: HashMap<String, ChunkLoc>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Slots {
    volume: String,
    attachment: String,
    pack_prefix: String,
    /// Manifests of one epoch live under one prefix; a rebase starts a new epoch.
    manifest_prefix: String,
    packs: HashMap<String, String>,
    manifests: HashMap<String, String>,
    #[serde(default)]
    manifest_reads: HashMap<String, String>,
}

// ---------- small helpers ----------

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn boot_id() -> String {
    fs::read_to_string("/proc/sys/kernel/random/boot_id").map(|s| s.trim().to_string()).unwrap_or_default()
}

fn meta_dir(root: &Path) -> PathBuf {
    STATE_DIR.get().cloned().unwrap_or_else(|| root.join(META_DIR))
}

/// Shared agents: connections to the bucket are kept alive across syncs.
/// Downloads use a short read timeout so that a stalled transfer is noticed.
fn build_agent(read_secs: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(read_secs))
        .timeout_write(Duration::from_secs(120))
        .max_idle_connections_per_host(8)
        .build()
}

fn agent() -> ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| build_agent(120)).clone()
}

fn get_agent() -> ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| build_agent(READ_STALL_SECS)).clone()
}

/// Upload to a pre-signed slot. Slots are write-once (the host signs `If-None-Match: *`):
/// an object that exists can never be replaced from inside the sandbox.
/// Returns Ok(false) when the slot was already written.
fn http_put(agent: &ureq::Agent, url: &str, body: &[u8]) -> Result<bool> {
    let mut last = None;
    for attempt in 0..4 {
        match agent.put(url).set("Content-Type", "application/octet-stream").set("If-None-Match", "*").send_bytes(body) {
            Ok(r) if r.status() / 100 == 2 => return Ok(true),
            Ok(r) => last = Some(anyhow!("PUT status {}", r.status())),
            Err(ureq::Error::Status(412, _)) => return Ok(false),
            Err(ureq::Error::Status(code, _)) if code / 100 == 4 && code != 408 && code != 429 => {
                bail!("PUT rejected with status {code}")
            }
            Err(e) => last = Some(anyhow!("PUT failed: {e}")),
        }
        std::thread::sleep(Duration::from_millis(300 << attempt));
    }
    Err(last.unwrap_or_else(|| anyhow!("PUT failed")))
}

/// A pre-existing immutable key proves nothing about this journal's bytes.
/// GET uses a separately signed read URL; PUT signatures cannot authenticate GET.
fn publish_manifest(slots: &Slots, seq: u64, body: &[u8]) -> Result<()> {
    let key = seq.to_string();
    if let Some(put) = slots.manifests.get(&key) {
        if http_put(&agent(), put, body)? { return Ok(()); }
    }
    // The host may already have applied this sequence and issue only its GET
    // proof, while all new PUT slots start at head + 1.

    let read = slots.manifest_reads.get(&key).ok_or_else(|| NeedSlots::ManifestRead(format!("no manifest read slot {seq} to verify existing bytes")))?;
    let response = agent().get(read).call().map_err(|error| match error {
        ureq::Error::Status(code, _) => anyhow!("MANIFEST_VERIFY_HTTP: read returned {code}; pending preserved"),
        _ => anyhow!("MANIFEST_VERIFY_TRANSPORT: read unavailable; pending preserved"),
    })?;
    if response.status() != 200 { bail!("MANIFEST_VERIFY_HTTP: expected complete object response; pending preserved"); }
    if let Some(length) = response.header("Content-Length") {
        let length: u64 = length.parse().context("MANIFEST_VERIFY_LENGTH: invalid content length")?;
        if length != body.len() as u64 { bail!("MANIFEST_SLOT_TAKEN: seq {seq} contains different manifest bytes"); }
    }
    let limit = body.len().checked_add(1).context("manifest verification byte budget overflow")?;
    let mut existing = Vec::new();
    response.into_reader().take(limit as u64).read_to_end(&mut existing)
        .map_err(|_| anyhow!("MANIFEST_VERIFY_READ: truncated or interrupted object; pending preserved"))?;
    if existing != body { bail!("MANIFEST_SLOT_TAKEN: seq {seq} contains different manifest bytes"); }
    Ok(())
}

/// Download with stall detection and range-resume. A transfer that stops making
/// progress is cut off after READ_STALL_SECS and resumed from the last byte; if it
/// keeps stalling, the caller gets an error instead of a hang.
fn http_get(url: &str) -> Result<Vec<u8>> {
    let ag = get_agent();
    let mut buf: Vec<u8> = Vec::new();
    let mut total: Option<usize> = None;
    let (mut attempts, mut stalls) = (0u32, 0u32);
    loop {
        attempts += 1;
        let before = buf.len();
        let mut req = ag.get(url);
        if !buf.is_empty() {
            req = req.set("Range", &format!("bytes={}-", buf.len()));
        }
        match req.call() {
            Ok(r) => {
                if r.status() == 206 {
                    if let Some(t) = r.header("Content-Range").and_then(|h| h.rsplit('/').next()).and_then(|t| t.parse().ok()) {
                        total = Some(t);
                    }
                } else {
                    buf.clear(); // full response: the server ignored or was not given a range
                    total = r.header("Content-Length").and_then(|h| h.parse().ok());
                }
                let mut rd = r.into_reader();
                let mut tmp = vec![0u8; 256 * 1024];
                let (mut win_start, mut win_bytes) = (Instant::now(), 0usize);
                loop {
                    match rd.read(&mut tmp) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&tmp[..n]);
                            win_bytes += n;
                        }
                        Err(_) => break, // stalled or reset: resume below
                    }
                    // A trickle is a stall too: under MIN_BYTES_PER_WINDOW in a full window, cut it off.
                    if win_start.elapsed() >= Duration::from_secs(READ_STALL_SECS) {
                        if win_bytes < MIN_BYTES_PER_WINDOW {
                            break;
                        }
                        win_start = Instant::now();
                        win_bytes = 0;
                    }
                }
                if total.map(|t| buf.len() >= t).unwrap_or(true) {
                    return Ok(buf);
                }
            }
            Err(ureq::Error::Status(code, _)) if code / 100 == 4 && code != 408 && code != 429 => {
                bail!("GET rejected with status {code}")
            }
            Err(_) => {}
        }
        if buf.len().saturating_sub(before) < 4 * 1024 * 1024 {
            stalls += 1;
        } else {
            stalls = 0;
        }
        // Two slow attempts in a row: stop waiting and let the host repair the object.
        if stalls >= 2 || attempts >= 12 {
            bail!("STALLED after {} of {} bytes", buf.len(), total.map(|t| t.to_string()).unwrap_or_else(|| "?".into()));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Some(dir) = path.parent() {
        File::open(dir)?.sync_all()?;
    }
    Ok(())
}

fn fault(point: &str) {
    if std::env::var("SWVOL_FAULT").map(|v| v == point).unwrap_or(false) {
        eprintln!("swvol: injected fault at {point}");
        std::process::exit(137);
    }
}

// ---------- state ----------

fn state_path(root: &Path) -> PathBuf {
    meta_dir(root).join("state.bin")
}

fn load_state(root: &Path) -> Result<Option<State>> {
    match fs::read(state_path(root)) {
        Ok(b) => Ok(Some(bincode::deserialize(&b).context("state is corrupt")?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn save_state(root: &Path, st: &State) -> Result<()> {
    #[cfg(test)]
    if FAIL_STATE_SAVE.with(|fault| fault.get()) { return Err(std::io::Error::from_raw_os_error(28).into()); }
    atomic_write(&state_path(root), &bincode::serialize(st)?)?;
    control_client::record_commit(st.seq);
    Ok(())
}

/// The guard against "an empty replacement container syncs the volume to empty":
/// without a state written by `restore` in THIS boot of THIS container, nothing syncs.
fn load_attached_state(root: &Path) -> Result<State> {
    let st = match load_state(root)? {
        Some(s) => s,
        None => {
            eprintln!("swvol: NOT_ATTACHED: no local state; this container was never restored");
            std::process::exit(EXIT_INSTANCE_CHANGED);
        }
    };
    if st.boot_id != boot_id() {
        eprintln!("swvol: INSTANCE_CHANGED: state belongs to another boot");
        std::process::exit(EXIT_INSTANCE_CHANGED);
    }
    Ok(st)
}

fn load_slots(root: &Path) -> Result<Slots> {
    let b = fs::read(meta_dir(root).join("slots.json")).context("slots.json missing")?;
    Ok(serde_json::from_slice(&b)?)
}

// ---------- scanning ----------

struct Cand {
    rel: String,
    abs: PathBuf,
    md: fs::Metadata,
}

fn rel_of(root: &Path, p: &Path) -> Option<String> {
    let r = p.strip_prefix(root).ok()?;
    let s = r.to_str()?; // non-UTF-8 names are skipped (reported by caller)
    Some(s.to_string())
}

/// Everything named `.sourceweft*` at the root is platform-owned: the meta dir,
/// the sandbox stamp, and the flush sentinels.
fn excluded_at_root(name: &std::ffi::OsStr) -> bool {
    name.to_str().map(|s| s.starts_with(META_DIR)).unwrap_or(false)
}

const SENTINEL_PREFIX: &str = ".sourceweft-sync-";

/// Collect candidates under `start`. `recursive=false` lists direct children only.
fn walk(root: &Path, start: &Path, recursive: bool, out: &mut Vec<Cand>, skipped: &mut Vec<String>) -> Result<()> {
    let mut stack = vec![start.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = fs::read_dir(&dir).with_context(|| format!("cannot read volume directory: {}", dir.display()))?;
        for entry in rd {
            let ent = entry.context("cannot enumerate a volume directory entry")?;
            let name = ent.file_name();
            if dir == root && excluded_at_root(&name) { continue; }
            let abs = ent.path();
            let md = fs::symlink_metadata(&abs).with_context(|| format!("cannot stat volume entry: {}", abs.display()))?;
            let ft = md.file_type();
            if !(ft.is_file() || ft.is_dir() || ft.is_symlink()) {
                bail!("unsupported volume entry type: {}", abs.display());
            }
            let rel = match rel_of(root, &abs) {
                Some(r) => r,
                None => {
                    skipped.push(abs.to_string_lossy().to_string());
                    bail!("non-UTF-8 volume paths are unsupported; refusing an incomplete snapshot");
                }
            };
            if ft.is_dir() && recursive { stack.push(abs.clone()); }
            out.push(Cand { rel, abs, md });
        }
    }
    Ok(())
}

fn timestamp_ns(seconds: i64, nanoseconds: i64) -> Result<i64> {
    if !(0..1_000_000_000).contains(&nanoseconds) { bail!("invalid filesystem timestamp nanoseconds"); }
    // i64::MIN uses seconds=-9223372037 and positive subsecond nanoseconds;
    // checking the seconds multiplication in i64 would reject a valid boundary.
    (seconds as i128 * 1_000_000_000 + nanoseconds as i128)
        .try_into().map_err(|_| anyhow!("timestamp outside signed-i64 nanosecond range"))
}

fn unchanged(e: &Entry, md: &fs::Metadata) -> Result<bool> {
    let ft = md.file_type();
    let mtime = timestamp_ns(md.mtime(), md.mtime_nsec())?;
    let ctime = timestamp_ns(md.ctime(), md.ctime_nsec())?;
    Ok(match e.kind {
        'd' => ft.is_dir() && e.mode == (md.mode() & 0o7777) && e.mtime_ns == mtime,
        'f' => ft.is_file() && e.size == md.len() && e.mtime_ns == mtime
            && e.ctime_ns == ctime && e.ino == md.ino() && e.mode == (md.mode() & 0o7777),
        'l' => ft.is_symlink() && e.ino == md.ino() && e.ctime_ns == ctime,
        _ => false,
    })
}

// ---------- pack writer (chunks -> compressed packs -> pre-signed slots) ----------

struct PackWriter {
    slots: Slots,
    root: PathBuf,
    next_pack: u32,
    counter: PathBuf,
    buf: Vec<u8>,
    cur_key: Option<String>,
    new_locs: BTreeMap<String, ChunkLoc>,
    packs: Vec<(String, u64)>,
    tx: Option<mpsc::SyncSender<(String, Vec<u8>, Option<capture::Receipt>)>>,
    capture: Option<Arc<capture::Writer>>,
    referenced: HashSet<String>,
    uploaders: Vec<std::thread::JoinHandle<Result<()>>>,
    uploaded_bytes: u64,
}

impl PackWriter {
    fn new(slots: &Slots, root: &Path) -> Self {
        PackWriter { slots: slots.clone(), root: root.to_owned(), next_pack: 0, counter: meta_dir(root).join("pack.next"), buf: Vec::new(), cur_key: None, new_locs: BTreeMap::new(), packs: Vec::new(), tx: None, capture: None, referenced: HashSet::new(), uploaders: Vec::new(), uploaded_bytes: 0 }
    }

    fn resume(slots: &Slots, root: &Path, state: &State) -> Result<Self> {
        let (capture, loaded) = capture::open(root, state, slots)?;
        let mut writer = Self::new(slots, root);
        writer.next_pack = loaded.packs.iter().filter_map(|(key, _)| key.rsplit('/').next()?.parse::<u32>().ok()).max().unwrap_or(state.next_pack);
        writer.new_locs = loaded.locs; writer.packs = loaded.packs; writer.capture = Some(capture);
        Ok(writer)
    }
    fn join_uploads(&mut self) -> Result<()> {
        self.tx.take();
        let mut first = None;
        for worker in self.uploaders.drain(..) {
            let result = worker.join().map_err(|_| anyhow!("uploader panicked")).and_then(|result| result);
            if let Err(error) = result { if first.is_none() { first = Some(error); } }
        }
        match first { Some(error) => Err(error), None => Ok(()) }
    }

    /// Reserve the next pack slot. The reservation is durable BEFORE the slot is used,
    /// so a crash can never lead to the same write-once slot being chosen twice.
    fn reserve(&mut self) -> Result<u32> {
        let n: u32 = match fs::read_to_string(&self.counter) {
            Ok(value) => value.trim().parse().context("pack counter is corrupt")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.into()),
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let fresh = load_slots(&self.root)?;
            if fresh.volume != self.slots.volume || fresh.attachment != self.slots.attachment || fresh.pack_prefix != self.slots.pack_prefix || fresh.manifest_prefix != self.slots.manifest_prefix { bail!("pack grant changed during capture"); }
            self.slots = fresh;
            if self.slots.packs.contains_key(&n.to_string()) { break; }
            if !control_client::active() || Instant::now() >= deadline {
                // Surface failed PUT/receipt fsync before reporting reusable progress.
                self.join_uploads()?;
                return Err(NeedSlots::Capture(format!("no pack slot {n}")).into());
            }
            control_client::WAKE.store(true, std::sync::atomic::Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(100));
        }
        let next = n.checked_add(1).context("pack counter exhausted")?;
        atomic_write(&self.counter, next.to_string().as_bytes())?;
        Ok(n)
    }

    fn ensure_uploaders(&mut self) {
        if self.tx.is_some() {
            return;
        }
        // Chunking and compression continue while earlier packs are on the wire.
        let (tx, rx) = mpsc::sync_channel::<(String, Vec<u8>, Option<capture::Receipt>)>(1);
        let rx = Arc::new(Mutex::new(rx));
        for _ in 0..UPLOAD_THREADS {
            let rx = rx.clone();
            let capture = self.capture.clone();
            self.uploaders.push(std::thread::spawn(move || -> Result<()> {
                let ag = agent();
                loop {
                    let job = rx.lock().unwrap().recv();
                    match job {
                        Ok((url, body, receipt)) => {
                            if !http_put(&ag, &url, &body)? {
                                bail!("PACK_SLOT_TAKEN: a pack slot was already written");
                            }
                            fault("after_pack_put");
                            if let (Some(capture), Some(receipt)) = (&capture, receipt) {
                                capture.save(receipt)?;
                                fault("after_capture_receipt");
                            }
                        }
                        Err(_) => return Ok(()),
                    }
                }
            }));
        }
        self.tx = Some(tx);
    }

    fn add(&mut self, id: &str, data: &[u8]) -> Result<()> {
        if self.cur_key.is_none() {
            self.next_pack = self.reserve()?;
            self.cur_key = Some(format!("{}{:06}", self.slots.pack_prefix, self.next_pack));
        }
        let comp = zstd::bulk::compress(data, ZSTD_LEVEL)?;
        let loc = ChunkLoc(self.cur_key.clone().unwrap(), self.buf.len() as u64, comp.len() as u32, data.len() as u32);
        self.buf.extend_from_slice(&comp);
        self.new_locs.insert(id.to_string(), loc);
        if self.buf.len() >= PACK_TARGET {
            self.roll()?;
        }
        Ok(())
    }

    fn roll(&mut self) -> Result<()> {
        if let Some(key) = self.cur_key.take() {
            let body = std::mem::take(&mut self.buf);
            let url = self.slots.packs.get(&self.next_pack.to_string()).cloned().ok_or_else(|| anyhow!("slot vanished"))?;
            let receipt = self.capture.as_ref().map(|capture| capture.receipt(key.clone(), body.len() as u64,
                self.new_locs.iter().filter(|(_, loc)| loc.0 == key).map(|(id, loc)| (id.clone(), loc.clone())).collect()));
            self.packs.push((key, body.len() as u64));
            self.uploaded_bytes += body.len() as u64;
            self.ensure_uploaders();
            if self.tx.as_ref().unwrap().send((url, body, receipt)).is_err() {
                self.join_uploads()?;
                bail!("uploader stopped");
            }
        }
        Ok(())
    }

    /// Finish all uploads. If the only new data is small and no pack was sent,
    /// return it as the inline section of the manifest object `manifest_key`.
    fn finish(&mut self, manifest_key: &str) -> Result<Vec<u8>> {
        let mut inline = Vec::new();
        if self.packs.is_empty() && self.buf.len() <= INLINE_MAX {
            if let Some(key) = self.cur_key.take() {
                inline = std::mem::take(&mut self.buf);
                for loc in self.new_locs.values_mut() {
                    if loc.0 == key {
                        loc.0 = manifest_key.to_string();
                        loc.1 += MANIFEST_HEADER as u64;
                    }
                }
                // the reserved pack slot is simply never used
            }
        } else {
            self.roll()?;
        }
        self.join_uploads()?;
        Ok(inline)
    }
}

#[cfg(test)]
thread_local! { static FAIL_CHUNK_READ: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

impl Drop for PackWriter {
    fn drop(&mut self) {
        self.tx.take();
        for worker in self.uploaders.drain(..) { let _ = worker.join(); }
    }
}

/// Read a file as content-defined chunks. Returns (refs, stable): `stable=false`
/// means it changed while being read and must be captured again next time.
fn chunk_file(abs: &Path, md: &fs::Metadata, have: &HashMap<String, ChunkLoc>, pw: &mut PackWriter) -> Result<(Vec<ChunkRef>, bool, u64)> {
    #[cfg(test)]
    if FAIL_CHUNK_READ.with(|fault| fault.get()) { bail!("injected file read failure"); }
    let mut refs = Vec::new();
    let mut push = |data: &[u8], pw: &mut PackWriter| -> Result<()> {
        let id = blake3::hash(data).to_hex().to_string();
        pw.referenced.insert(id.clone());
        if !have.contains_key(&id) && !pw.new_locs.contains_key(&id) {
            pw.add(&id, data)?;
        }
        refs.push(ChunkRef(id, data.len() as u32));
        Ok(())
    };
    let mut f = File::open(abs)?;
    if md.len() <= CDC_MIN as u64 {
        let mut buf = Vec::with_capacity(md.len() as usize);
        f.read_to_end(&mut buf)?;
        if !buf.is_empty() {
            push(&buf, pw)?;
        }
    } else {
        for chunk in fastcdc::v2020::StreamCDC::new(f, CDC_MIN, CDC_AVG, CDC_MAX) {
            let chunk = chunk.map_err(|e| anyhow!("chunking failed: {e}"))?;
            push(&chunk.data, pw)?;
        }
    }
    // The size recorded for a file is what was actually read, never the earlier stat:
    // a file that is still being written must not produce an entry whose chunks disagree with its size.
    let read: u64 = refs.iter().map(|r| r.1 as u64).sum();
    let after = fs::symlink_metadata(abs)?;
    let stable = read == md.len() && after.is_file() && after.len() == md.len()
        && after.ino() == md.ino() && after.dev() == md.dev() && after.mode() == md.mode()
        && after.mtime() == md.mtime() && after.mtime_nsec() == md.mtime_nsec()
        && after.ctime() == md.ctime() && after.ctime_nsec() == md.ctime_nsec();
    Ok((refs, stable, read))
}

// ---------- sync ----------

enum Scope {
    Full,
    Partial { dirs: HashSet<PathBuf>, subtrees: HashSet<PathBuf> },
}

#[derive(Serialize, Default)]
struct SyncReport {
    ok: bool,
    committed: bool,
    seq: u64,
    trigger: String,
    scope: String,
    scanned: usize,
    upserts: usize,
    deletes: usize,
    bytes_read: u64,
    bytes_uploaded: u64,
    packs: usize,
    unstable: usize,
    ms: u64,
}

fn delete_prefix(entries: &BTreeMap<String, Entry>, rel: &str, deletes: &mut BTreeSet<String>) {
    if entries.contains_key(rel) {
        deletes.insert(rel.to_string());
    }
    let prefix = format!("{rel}/");
    for (k, _) in entries.range(prefix.clone()..) {
        if !k.starts_with(&prefix) {
            break;
        }
        deletes.insert(k.clone());
    }
}

fn sync_once(root: &Path, st: &mut State, scope: Scope, trigger: &str, rebase: Option<u64>) -> Result<SyncReport> {
    let t0 = Instant::now();
    let slots = load_slots(root)?;
    if slots.attachment != st.attachment || slots.volume != st.volume {
        bail!("slots belong to a different attachment");
    }
    // Finish a commit that was interrupted between "manifest uploaded" and "state saved".
    if rebase.is_some() {
        // The host explicitly rejected the old chain and issued a new epoch.
        // Keep every old byte for recovery; never replay it into a new slot.
        quarantine_pending(root)?;
        capture::prepare_rebase(root, st, &slots, rebase.unwrap())?;
    } else {
        recover_pending(root, st, &slots)?;
    }
    // A resumed capture must re-evaluate the whole current namespace, even
    // when the triggering watch event covered only one directory.
    let scope = if capture::has_pending(root)? { Scope::Full } else { scope };
    let old_seq = st.seq;
    let mut removed_locs = HashMap::new();
    let mut changed_ctimes = Vec::new();
    let scope = if let Some(head) = rebase {
        // The host refused part of our chain and is at `head`. Restart from there with a
        // self-contained snapshot. Chunk data that lived inside manifests the host never
        // applied is about to be overwritten, so forget it and re-read the files that used it.
        let mprefix = format!("att/{}/m/", st.attachment);
        let dropped: HashSet<String> = st
            .have
            .iter()
            .filter(|(_, loc)| loc.0.starts_with(&mprefix) && loc.0.rsplit('/').next().and_then(|n| n.parse::<u64>().ok()).map(|n| n > head).unwrap_or(false))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &dropped {
            if let Some(loc) = st.have.remove(id) { removed_locs.insert(id.clone(), loc); }
        }
        for (path, e) in &mut st.entries {
            if e.chunks.iter().any(|c| dropped.contains(&c.0)) {
                changed_ctimes.push((path.clone(), e.ctime_ns));
                e.ctime_ns = -1;
            }
        }
        st.seq = head;
        Scope::Full
    } else {
        scope
    };

    let result = sync_scoped(root, st, scope, trigger, rebase, &slots, t0);
    if result.is_err() && rebase.is_some() {
        st.seq = old_seq;
        st.have.extend(removed_locs);
        for (path, ctime) in changed_ctimes { if let Some(entry) = st.entries.get_mut(&path) { entry.ctime_ns = ctime; } }
    }
    result
}

fn sync_scoped(root: &Path, st: &mut State, scope: Scope, trigger: &str, rebase: Option<u64>, slots: &Slots, t0: Instant) -> Result<SyncReport> {
    let mut cands = Vec::new();
    let mut skipped = Vec::new();
    let mut deletes: BTreeSet<String> = BTreeSet::new();
    let scope_name;
    match &scope {
        Scope::Full => {
            scope_name = "full".to_string();
            walk(root, root, true, &mut cands, &mut skipped)?;
            let seen: HashSet<&str> = cands.iter().map(|c| c.rel.as_str()).collect();
            for k in st.entries.keys() {
                if !seen.contains(k.as_str()) {
                    deletes.insert(k.clone());
                }
            }
        }
        Scope::Partial { dirs, subtrees } => {
            scope_name = format!("partial({}d,{}t)", dirs.len(), subtrees.len());
            for t in subtrees {
                let rel = match rel_of(root, t) {
                    Some(r) => r,
                    None => continue,
                };
                match fs::symlink_metadata(t) {
                    Ok(md) if md.is_dir() => {
                        let before = cands.len();
                        if !rel.is_empty() {
                            cands.push(Cand { rel: rel.clone(), abs: t.clone(), md });
                        }
                        walk(root, t, true, &mut cands, &mut skipped)?;
                        let seen: HashSet<&str> = cands[before..].iter().map(|c| c.rel.as_str()).collect();
                        let prefix = if rel.is_empty() { String::new() } else { format!("{rel}/") };
                        for (k, _) in st.entries.range(prefix.clone()..) {
                            if !k.starts_with(&prefix) {
                                break;
                            }
                            if !seen.contains(k.as_str()) {
                                deletes.insert(k.clone());
                            }
                        }
                    }
                    Ok(_) => delete_prefix(&st.entries, &rel, &mut deletes),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => delete_prefix(&st.entries, &rel, &mut deletes),
                    Err(error) => return Err(error).with_context(|| format!("cannot stat volume path: {}", rel)),
                }
            }
            for d in dirs {
                if subtrees.iter().any(|t| d.starts_with(t)) {
                    continue;
                }
                let rel = match rel_of(root, d) {
                    Some(r) => r,
                    None => continue,
                };
                match fs::symlink_metadata(d) {
                    Ok(md) if md.is_dir() => {
                        let before = cands.len();
                        walk(root, d, false, &mut cands, &mut skipped)?;
                        let seen: HashSet<&str> = cands[before..].iter().map(|c| c.rel.as_str()).collect();
                        let prefix = if rel.is_empty() { String::new() } else { format!("{rel}/") };
                        let mut gone = Vec::new();
                        for (k, _) in st.entries.range(prefix.clone()..) {
                            if !k.starts_with(&prefix) {
                                break;
                            }
                            if k[prefix.len()..].contains('/') {
                                continue; // deeper than a direct child
                            }
                            if !seen.contains(k.as_str()) {
                                gone.push(k.clone());
                            }
                        }
                        for g in gone {
                            delete_prefix(&st.entries, &g, &mut deletes);
                        }
                    }
                    Ok(_) => delete_prefix(&st.entries, &rel, &mut deletes),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => delete_prefix(&st.entries, &rel, &mut deletes),
                    Err(error) => return Err(error).with_context(|| format!("cannot stat volume path: {}", rel)),
                }
            }
        }
    }

    // Watch scopes can overlap (for example a new parent and its heavy subtree).
    cands.sort_by(|a, b| a.rel.cmp(&b.rel));
    cands.dedup_by(|a, b| a.rel == b.rel);
    let mut pw = PackWriter::resume(slots, root, st)?;
    let mut upserts: Vec<(String, Entry)> = Vec::new();
    let unstable = Vec::new();
    let mut bytes_read = 0u64;
    let scanned = cands.len();
    for c in &cands {
        if let Some(e) = st.entries.get(&c.rel) {
            if unchanged(e, &c.md).with_context(|| format!("cannot persist timestamps: {}", c.rel))? {
                continue;
            }
        }
        let ft = c.md.file_type();
        let mut e = Entry {
            kind: 'd',
            mode: c.md.mode() & 0o7777,
            mtime_ns: timestamp_ns(c.md.mtime(), c.md.mtime_nsec()).with_context(|| format!("cannot persist mtime: {}", c.rel))?,
            size: 0,
            link: None,
            chunks: vec![],
            ino: c.md.ino(),
            ctime_ns: timestamp_ns(c.md.ctime(), c.md.ctime_nsec()).with_context(|| format!("cannot persist ctime: {}", c.rel))?,
        };
        if ft.is_symlink() {
            e.kind = 'l';
            match fs::read_link(&c.abs).ok().and_then(|t| t.to_str().map(|s| s.to_string())) {
                Some(t) => e.link = Some(t),
                None => bail!("cannot persist unreadable or non-UTF-8 symlink target: {}", c.rel),
            }
        } else if ft.is_file() {
            e.kind = 'f';
            e.size = c.md.len();
            match chunk_file(&c.abs, &c.md, &st.have, &mut pw) {
                Ok((refs, stable, read)) => {
                    bytes_read += read;
                    e.size = read;
                    e.chunks = refs;
                    if !stable {
                        // Keep the pre-read stat so the next scan sees a difference and re-captures.
                        bail!("UNSTABLE_FILE: changed while capturing {}", c.rel);
                    }
                }
                Err(error) => return Err(error).with_context(|| format!("cannot persist file read: {}", c.rel)),
            }
        }
        upserts.push((c.rel.clone(), e));
    }
    // A path that changed type from directory to file/symlink drops its old children.
    for (rel, e) in &upserts {
        if e.kind != 'd' {
            if let Some(old) = st.entries.get(rel) {
                if old.kind == 'd' {
                    let prefix = format!("{rel}/");
                    for (k, _) in st.entries.range(prefix.clone()..) {
                        if !k.starts_with(&prefix) {
                            break;
                        }
                        deletes.insert(k.clone());
                    }
                }
            }
        }
    }
    let upsert_paths: HashSet<&str> = upserts.iter().map(|(p, _)| p.as_str()).collect();
    deletes.retain(|d| !upsert_paths.contains(d.as_str()));

    let mut rep = SyncReport { ok: true, trigger: trigger.to_string(), scope: scope_name, scanned, seq: st.seq, ..Default::default() };
    if upserts.is_empty() && deletes.is_empty() && rebase.is_none() {
        rep.ms = t0.elapsed().as_millis() as u64;
        return Ok(rep);
    }

    let seq = st.seq + 1;
    let manifest_key = format!("{}{}", slots.manifest_prefix, seq);
    let inline = pw.finish(&manifest_key)?; // every referenced pack is in the bucket before the manifest exists
    let fresh_slots = load_slots(root)?;
    if fresh_slots.attachment != slots.attachment || fresh_slots.manifest_prefix != slots.manifest_prefix { bail!("manifest grant changed during capture"); }
    if !fresh_slots.manifests.contains_key(&seq.to_string()) && !fresh_slots.manifest_reads.contains_key(&seq.to_string()) { return Err(NeedSlots::Capture(format!("no manifest slot {seq}")).into()); }
    // Unreferenced staged chunks (for example a file removed during a pause)
    // must not enter State.have without being registered by this manifest.
    let new_locs: BTreeMap<_, _> = pw.new_locs.iter().filter(|(id, _)| pw.referenced.contains(*id)).map(|(id, loc)| (id.clone(), loc.clone())).collect();
    let used_packs: HashSet<_> = new_locs.values().map(|loc| loc.0.as_str()).collect();
    let packs: Vec<_> = pw.packs.iter().filter(|(key, _)| used_packs.contains(key.as_str())).cloned().collect();
    let wire = |p: &String, e: &Entry| WireEntry { p: p.clone(), k: e.kind, m: e.mode, t: e.mtime_ns, s: e.size, l: e.link.clone(), c: e.chunks.clone() };
    let (m_upserts, m_deletes, m_chunks) = if rebase.is_some() {
        // Snapshot: every entry as it will be after this sync, with the location of every chunk it uses.
        let changed: HashMap<&String, &Entry> = upserts.iter().map(|(p, e)| (p, e)).collect();
        let mut all: Vec<WireEntry> = st.entries.iter().filter(|(p, _)| !deletes.contains(*p) && !changed.contains_key(p)).map(|(p, e)| wire(p, e)).collect();
        all.extend(upserts.iter().map(|(p, e)| wire(p, e)));
        let mut locs = new_locs.clone();
        for w in &all {
            for c in &w.c {
                if !locs.contains_key(&c.0) {
                    if let Some(l) = st.have.get(&c.0) {
                        locs.insert(c.0.clone(), l.clone());
                    }
                }
            }
        }
        (all, Vec::new(), locs)
    } else {
        (upserts.iter().map(|(p, e)| wire(p, e)).collect(), deletes.iter().cloned().collect(), new_locs.clone())
    };
    let mut manifest = Manifest {
        v: 1,
        volume: st.volume.clone(),
        attachment: st.attachment.clone(),
        boot_id: st.boot_id.clone(),
        seq,
        base: st.seq,
        full: rebase.is_some(),
        trigger: trigger.to_string(),
        upserts: m_upserts,
        deletes: m_deletes,
        chunks: m_chunks,
        packs,
        unstable: unstable.clone(),
        skipped,
        ts_ms: now_ms(),
    };
    if std::env::var("SWVOL_FAULT").map(|v| v == "corrupt_size").unwrap_or(false) {
        if let Some(f) = manifest.upserts.iter_mut().find(|e| e.k == 'f') {
            f.s += 1; // test hook: a manifest the host must refuse
        }
    }
    // Object layout: magic | u64 inline length | inline chunk data | zstd(JSON).
    let mut body = Vec::with_capacity(MANIFEST_HEADER + inline.len() + 4096);
    body.extend_from_slice(MANIFEST_MAGIC);
    body.extend_from_slice(&(inline.len() as u64).to_le_bytes());
    body.extend_from_slice(&inline);
    body.extend_from_slice(&zstd::bulk::compress(&serde_json::to_vec(&manifest)?, ZSTD_LEVEL)?);
    // Two-phase local commit: the exact manifest bytes are durable locally before they
    // are uploaded, so a crash after the upload replays the SAME manifest for this seq.
    let pending = meta_dir(root).join("pending.manifest");
    let apply = PendingApply { seq, rebase: rebase.is_some(), next_pack: pw.next_pack, upserts, deletes: deletes.into_iter().collect(), new_locs, unstable };
    let journal = PendingJournal { manifest_key: manifest_key.clone(), body: body.clone(), apply };
    atomic_write(&pending, &encode_pending(&journal)?)?;
    fault("before_manifest_put");
    publish_manifest(&fresh_slots, seq, &body)?;
    fault("after_manifest_put");
    commit_pending(root, st, journal.apply)?;
    // A durable commit does not become uncommitted if journal housekeeping fails.
    // Recovery recognizes this seq as already applied and retries cleanup.
    if let Err(error) = fs::remove_file(&pending) { eprintln!("swvol: committed journal cleanup pending: {error}"); }

    rep.committed = true;
    rep.seq = seq;
    rep.upserts = manifest.upserts.len();
    rep.deletes = manifest.deletes.len();
    rep.bytes_read = bytes_read;
    rep.bytes_uploaded = pw.uploaded_bytes + body.len() as u64;
    rep.packs = pw.packs.len();
    rep.unstable = manifest.unstable.len();
    rep.ms = t0.elapsed().as_millis() as u64;
    let _ = OpenOptions::new().create(true).append(true).open(meta_dir(root).join("sync.log")).and_then(|mut f| {
        writeln!(f, "{}", serde_json::json!({"seq": seq, "trigger": trigger, "ts_ms": now_ms(), "upserts": rep.upserts, "deletes": rep.deletes, "uploaded": rep.bytes_uploaded, "ms": rep.ms}))
    });
    Ok(rep)
}

#[derive(Serialize, Deserialize)]
struct PendingApply {
    seq: u64,
    rebase: bool,
    next_pack: u32,
    upserts: Vec<(String, Entry)>,
    deletes: Vec<String>,
    new_locs: BTreeMap<String, ChunkLoc>,
    unstable: Vec<String>,
}

/// Publish the new local index only if its durable write succeeds. The undo log
/// owns only affected entries/chunks, rather than cloning the whole volume index.
fn commit_pending(root: &Path, st: &mut State, p: PendingApply) -> Result<()> {
    let old_seq = st.seq;
    let old_pack = st.next_pack;
    let mut entries = BTreeMap::<String, Option<Entry>>::new();
    let mut chunks = HashMap::<String, Option<ChunkLoc>>::new();
    let unstable: HashSet<String> = p.unstable.into_iter().collect();
    for path in p.deletes {
        let old = st.entries.remove(&path);
        entries.entry(path).or_insert(old);
    }
    for (path, mut entry) in p.upserts {
        if unstable.contains(&path) { entry.ctime_ns = -1; }
        let old = st.entries.insert(path.clone(), entry);
        entries.entry(path).or_insert(old);
    }
    for (id, loc) in p.new_locs {
        let old = st.have.insert(id.clone(), loc);
        chunks.insert(id, old);
    }
    if p.rebase {
        // Replay must apply the same cache invalidation as the original rebase.
        // Numeric sequence checks cannot identify old-epoch inline locations
        // after the accepted new epoch advances beyond their sequence numbers.
        let referenced: HashSet<&str> = st.entries.values().flat_map(|entry| entry.chunks.iter().map(|chunk| chunk.0.as_str())).collect();
        st.have.retain(|id, loc| {
            if referenced.contains(id.as_str()) { return true; }
            chunks.entry(id.clone()).or_insert_with(|| Some(loc.clone()));
            false
        });
    }
    st.seq = p.seq;
    st.next_pack = p.next_pack;
    if let Err(error) = save_state(root, st) {
        for (path, old) in entries {
            match old { Some(entry) => { st.entries.insert(path, entry); }, None => { st.entries.remove(&path); } }
        }
        for (id, old) in chunks {
            match old { Some(loc) => { st.have.insert(id, loc); }, None => { st.have.remove(&id); } }
        }
        st.seq = old_seq;
        st.next_pack = old_pack;
        return Err(error);
    }
    if let Err(error) = capture::committed(root, old_seq) { eprintln!("swvol: committed capture cleanup pending: {error:#}"); }
    Ok(())
}

const PENDING_MAGIC: &[u8] = b"SWVPEND2\n";
#[derive(Serialize, Deserialize)]
struct PendingJournal {
    manifest_key: String,
    body: Vec<u8>,
    apply: PendingApply,
}
fn encode_pending(journal: &PendingJournal) -> Result<Vec<u8>> {
    let mut bytes = PENDING_MAGIC.to_vec();
    bytes.extend(bincode::serialize(journal)?);
    Ok(bytes)
}
fn decode_pending(bytes: &[u8]) -> Result<PendingJournal> {
    let payload = bytes.strip_prefix(PENDING_MAGIC).context("unsupported or corrupt pending journal; preserve it and request explicit rebase recovery")?;
    bincode::deserialize(payload).context("pending journal is corrupt; preserving it for recovery")
}
fn quarantine_pending(root: &Path) -> Result<()> {
    let pending = meta_dir(root).join("pending.manifest");
    match fs::symlink_metadata(&pending) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_file() => bail!("pending journal is not a regular file"),
        Ok(_) => {},
    }
    let directory = meta_dir(root).join("recovery");
    fs::create_dir_all(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    for attempt in 0..100 {
        let archive = directory.join(format!("pending-{}-{}-{attempt}.bin", now_ms(), std::process::id()));
        match fs::hard_link(&pending, &archive) {
            Ok(()) => {
                File::open(&directory)?.sync_all()?;
                fs::remove_file(&pending)?;
                File::open(meta_dir(root))?.sync_all()?;
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).context("cannot preserve rejected pending journal"),
        }
    }
    bail!("cannot reserve pending recovery archive")
}
fn recover_pending(root: &Path, st: &mut State, slots: &Slots) -> Result<()> {
    let pending = meta_dir(root).join("pending.manifest");
    let bytes = match fs::read(&pending) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("cannot read pending manifest"),
    };
    let journal = decode_pending(&bytes)?;
    let PendingJournal { manifest_key, body, apply } = journal;
    if manifest_key != format!("{}{}", slots.manifest_prefix, apply.seq) {
        bail!("PENDING_EPOCH_MISMATCH: old bytes retained; explicit rebase recovery required");
    }
    if apply.seq == st.seq + 1 || apply.rebase {
        // Both fresh conflicts and lost-ACK recovery require byte equality,
        // never merely the existence of an immutable object at this sequence.
        publish_manifest(slots, apply.seq, &body)?;
        commit_pending(root, st, apply)?;
    } else if apply.seq != st.seq {
        bail!("pending manifest sequence disagrees with local state; preserving it for recovery");
    }
    fs::remove_file(&pending)?;
    Ok(())
}

// ---------- restore ----------

fn cmd_restore(root: &Path, plan_src: &str, index_only: bool) -> Result<()> {
    let t0 = Instant::now();
    let raw = if plan_src.starts_with("http://") || plan_src.starts_with("https://") { http_get(plan_src)? } else { fs::read(plan_src)? };
    let raw = if raw.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) { zstd::stream::decode_all(&raw[..])? } else { raw };
    let plan: Plan = serde_json::from_slice(&raw).context("plan is not valid JSON")?;
    plan.validate()?;
    let root_dir = safe_fs::Directory::open_root(root)?;
    if !index_only { root_dir.require_empty_content()?; }
    let metadata = match STATE_DIR.get() { Some(directory) => safe_fs::Directory::open_root(directory)?, None => root_dir.directory(META_DIR, true)? };
    metadata.chmod("", 0o700)?;
    let lock = metadata.lock_file()?;
    lock.try_lock_exclusive().map_err(|_| anyhow!("another swvol (restore or daemon) is running in this workspace"))?;
    if capture::has_pending(root)? { bail!("CAPTURE_RESTORE_CONFLICT: preserve or explicitly rebase unconfirmed upload receipts before restoring"); }
    if metadata.names()?.iter().any(|name| name == "pending.manifest") {
        bail!("PENDING_RESTORE_CONFLICT: preserve or explicitly recover pending journal before restoring");
    }
    // A scope header alone contains no uploaded data. Incomplete receipt writes
    // were included in has_pending(), so only an empty journal can be cleared here.
    capture::archive(root, "empty-restore", true)?;
    // Existing user content and pending commits are checked before touching identity.
    metadata.remove("identity", false)?;
    metadata.remove("state.bin", false)?;

    if index_only {
        // Shadow mode: nothing is written to the tree. The local index is seeded from the plan with
        // unknown inode/ctime, so the daemon's first full scan reconciles the volume with whatever
        // the sandbox actually holds (present files are re-read, absent ones are deleted).
        let mut st = State { volume: plan.volume.clone(), attachment: plan.attachment.clone(), boot_id: boot_id(), seq: plan.seq, next_pack: 0, ..Default::default() };
        for e in &plan.entries {
            st.entries.insert(e.p.clone(), Entry { kind: e.k, mode: e.m, mtime_ns: e.t, size: e.s, link: e.l.clone(), chunks: e.c.clone(), ino: 0, ctime_ns: 0 });
        }
        st.have = plan.chunks.clone();
        metadata.atomic_write("state.bin", &bincode::serialize(&st)?)?;
        metadata.atomic_write("identity", format!("{}\n{}\n", st.attachment, st.boot_id).as_bytes())?;
        println!("{}", serde_json::json!({"ok": true, "shadow": true, "seq": plan.seq, "entries": plan.entries.len(), "boot_id": st.boot_id, "ms": t0.elapsed().as_millis() as u64}));
        return Ok(());
    }

    // Build only in a newly created protected directory. Failed downloads leave
    // an inspectable staging tree and never replace existing workspace files.
    let staging_name = format!("restore-{}-{}", now_ms(), std::process::id());
    if metadata.names()?.contains(&staging_name) { bail!("restore staging name collision"); }
    let staging = metadata.new_directory(&staging_name)?;
    let staged_directories = safe_fs::RestoreDirectoryCache::new(&staging, 128)?;
    let mut dirs: Vec<&WireEntry> = plan.entries.iter().filter(|e| e.k == 'd').collect();
    dirs.sort_by(|a, b| a.p.cmp(&b.p));
    for d in &dirs {
        staged_directories.directory(&d.p, true)?;
    }
    // Data workers need leaf parents, not every ancestor from mkdir traversal.
    staged_directories.clear();
    // chunk id -> [(file index, offset)]
    let files: Vec<&WireEntry> = plan.entries.iter().filter(|e| e.k == 'f').collect();
    let mut targets: HashMap<&str, Vec<(usize, u64)>> = HashMap::new();
    let mut total = 0u64;
    // Files made of exactly one chunk (the vast majority in dependency trees) are written in a
    // single write-open: create, write, set mode and mtime, close. A final
    // descriptor-relative stat after publication records rename's actual ctime.
    let single: Vec<bool> = files.iter().map(|f| f.c.len() == 1).collect();
    let mut identities = vec![(0u64, 0u64); files.len()];
    for (i, f) in files.iter().enumerate() {
        if !single[i] {
            let fh = staged_directories.create_file(&f.p)?;
            fh.set_len(f.s)?;
            let md = fh.metadata()?;
            identities[i] = (md.dev(), md.ino());
        }
        let mut off = 0u64;
        for ChunkRef(id, len) in &f.c {
            targets.entry(id.as_str()).or_default().push((i, off));
            off += *len as u64;
        }
        if off != f.s {
            bail!("plan entry {} has inconsistent size", f.p);
        }
        total += f.s;
    }
    // pack -> chunks needed from it
    let mut by_pack: HashMap<&str, Vec<(&str, &ChunkLoc)>> = HashMap::new();
    for id in targets.keys() {
        let loc = plan.chunks.get(*id).ok_or_else(|| anyhow!("plan is missing chunk {id}"))?;
        by_pack.entry(loc.0.as_str()).or_default().push((id, loc));
    }
    let work: Vec<(&str, Vec<(&str, &ChunkLoc)>)> = by_pack.into_iter().collect();
    let next = Mutex::new(0usize);
    let downloaded = Mutex::new(0u64);
    let err: Mutex<Option<anyhow::Error>> = Mutex::new(None);
    let unreadable: Mutex<Vec<String>> = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..4 {
            s.spawn(|| {
                loop {
                    let i = {
                        let mut n = next.lock().unwrap();
                        let i = *n;
                        *n += 1;
                        i
                    };
                    if i >= work.len() || err.lock().unwrap().is_some() {
                        break;
                    }
                    let (pack, chunks) = &work[i];
                    let res = (|| -> Result<()> {
                        let url = plan.packs.get(*pack).ok_or_else(|| anyhow!("plan has no URL for pack {pack}"))?;
                        let body = match http_get(url) {
                            Ok(b) => b,
                            Err(e) if e.to_string().starts_with("STALLED") => {
                                // Keep going with the other packs; the host repairs these and re-plans.
                                unreadable.lock().unwrap().push(pack.to_string());
                                return Ok(());
                            }
                            Err(e) => return Err(e),
                        };
                        *downloaded.lock().unwrap() += body.len() as u64;
                        for (id, loc) in chunks {
                            let end = loc.1 as usize + loc.2 as usize;
                            if end > body.len() {
                                bail!("pack {pack} is shorter than the plan says");
                            }
                            let data = swvol_core::decode_chunk(id, loc, &body[loc.1 as usize..end])?;
                            for (fi, off) in &targets[*id] {
                                let f = files[*fi];
                                if single[*fi] {
                                    let fh = staged_directories.create_file(&f.p)?;
                                    (&fh).write_all(&data)?;
                                    fh.set_permissions(fs::Permissions::from_mode(f.m))?;
                                    filetime::set_file_handle_times(&fh, None, Some(filetime::FileTime::from_unix_time(f.t.div_euclid(1_000_000_000), f.t.rem_euclid(1_000_000_000) as u32)))?;
                                } else {
                                    let fh = staged_directories.open_created_file(&f.p, identities[*fi])?;
                                    fh.write_all_at(&data, *off)?;
                                }
                            }
                        }
                        Ok(())
                    })();
                    if let Err(e) = res {
                        *err.lock().unwrap() = Some(e);
                        break;
                    }
                }
            });
        }
    });
    if let Some(e) = err.into_inner().unwrap() {
        return Err(e);
    }
    let unreadable = unreadable.into_inner().unwrap();
    if !unreadable.is_empty() {
        println!("{}", serde_json::json!({"ok": false, "unreadable": unreadable, "ms": t0.elapsed().as_millis() as u64}));
        std::process::exit(EXIT_PACK_UNREADABLE);
    }
    for l in plan.entries.iter().filter(|e| e.k == 'l') {
        staging.symlink(&l.p, l.l.as_deref().unwrap_or(""))?;
        staging.set_symlink_mtime(&l.p, l.t)?;
    }
    for (i, f) in files.iter().enumerate() {
        if single[i] {
            continue;
        }
        let fh = staged_directories.open_created_file(&f.p, identities[i])?;
        fh.set_permissions(fs::Permissions::from_mode(f.m))?;
        filetime::set_file_handle_times(&fh, None, Some(filetime::FileTime::from_unix_time(f.t.div_euclid(1_000_000_000), f.t.rem_euclid(1_000_000_000) as u32)))?;
    }
    drop(staged_directories);
    root_dir.require_empty_content()?;
    staging.publish_into(&root_dir)?;
    metadata.remove(&staging_name, true)?;
    // Publication changes ctime on moved top-level entries. Index the published
    // tree, never pre-rename staging metadata, so a no-change barrier stays empty.
    let mut st = State { volume: plan.volume.clone(), attachment: plan.attachment.clone(), boot_id: boot_id(), seq: plan.seq, next_pack: 0, ..Default::default() };
    let published_directories = safe_fs::RestoreDirectoryCache::new(&root_dir, 128)?;
    let mut published_entries: Vec<_> = plan.entries.iter().collect();
    published_entries.sort_by(|a, b| a.p.cmp(&b.p));
    for e in published_entries {
        let md = published_directories.metadata(&e.p)?;
        let restored_mtime = timestamp_ns(md.mtime(), md.mtime_nsec())?;
        if e.k != 'd' && restored_mtime != e.t {
            bail!("filesystem cannot preserve requested mtime: {}", e.p);
        }
        if e.k != 'd' && (md.mode() & 0o7777) != e.m {
            bail!("filesystem cannot preserve requested mode: {}", e.p);
        }
        st.entries.insert(
            e.p.clone(),
            Entry {
                kind: e.k,
                mode: if e.k == 'd' { e.m } else { md.mode() & 0o7777 },
                mtime_ns: restored_mtime,
                size: if e.k == 'f' { md.len() } else { 0 },
                link: e.l.clone(),
                chunks: e.c.clone(),
                ino: md.ino(),
                ctime_ns: timestamp_ns(md.ctime(), md.ctime_nsec())?,
            },
        );
    }
    st.have = plan.chunks.clone();
    for d in dirs.iter().rev() {
        // Restore children before restricting parent modes or setting parent
        // timestamps. Read final identity from the same no-follow directory FD.
        let md = published_directories.set_metadata(&d.p, d.m, d.t)?;
        let restored_mtime = timestamp_ns(md.mtime(), md.mtime_nsec())?;
        if restored_mtime != d.t { bail!("filesystem cannot preserve requested mtime: {}", d.p); }
        if (md.mode() & 0o7777) != d.m { bail!("filesystem cannot preserve requested mode: {}", d.p); }
        let entry = st.entries.get_mut(&d.p).expect("indexed restored directory");
        entry.mode = md.mode() & 0o7777;
        entry.mtime_ns = restored_mtime;
        entry.ino = md.ino();
        entry.ctime_ns = timestamp_ns(md.ctime(), md.ctime_nsec())?;
    }
    metadata.atomic_write("state.bin", &bincode::serialize(&st)?)?;
    // Written last: its presence means "this boot of this container holds a complete restore".
    metadata.atomic_write("identity", format!("{}\n{}\n", st.attachment, st.boot_id).as_bytes())?;
    println!(
        "{}",
        serde_json::json!({"ok": true, "seq": plan.seq, "entries": plan.entries.len(), "files": files.len(), "bytes": total,
            "packs": work.len(), "downloaded": *downloaded.lock().unwrap(), "boot_id": st.boot_id, "ms": t0.elapsed().as_millis() as u64})
    );
    Ok(())
}

// ---------- daemon: inotify + triggers ----------

#[derive(Default)]
struct Dirty {
    dirs: HashSet<PathBuf>,
    subtrees: HashSet<PathBuf>,
    need_full: bool,
    first: Option<Instant>,
    last: Option<Instant>,
    events: u64,
    /// Highest flush sentinel the watcher has seen. inotify delivers events in
    /// order, so once sentinel N is seen every earlier event has been recorded.
    sentinel: u64,
    /// Subtrees whose contents cannot be observed recursively by inotify.
    must_scan: HashSet<PathBuf>,
}

fn is_heavy(name: &std::ffi::OsStr) -> bool {
    HEAVY_DIRS.iter().any(|h| name == *h)
}

fn add_watches(watches: &mut inotify::Watches, map: &mut HashMap<inotify::WatchDescriptor, (PathBuf, bool)>, root: &Path, start: &Path, overflow: &mut bool, must_scan: &mut HashSet<PathBuf>) {
    use inotify::WatchMask as M;
    let mask = M::CREATE | M::MODIFY | M::CLOSE_WRITE | M::DELETE | M::MOVED_FROM | M::MOVED_TO | M::ATTRIB | M::DELETE_SELF | M::DONT_FOLLOW;
    let mut stack = vec![start.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let heavy = dir.file_name().map(is_heavy).unwrap_or(false);
        match watches.add(&dir, mask) {
            Ok(wd) => {
                map.insert(wd, (dir.clone(), heavy));
            }
            Err(_) => {
                *overflow = true;
                must_scan.insert(dir.clone());
                continue;
            }
        }
        if heavy {
            must_scan.insert(dir.clone());
            continue; // nested writes do not emit events at this directory
        }
        match fs::read_dir(&dir) {
            Ok(rd) => for ent in rd {
                match ent {
                    Ok(ent) => {
                        if dir == root && excluded_at_root(&ent.file_name()) { continue; }
                        match ent.file_type() {
                            Ok(kind) if kind.is_dir() => stack.push(ent.path()),
                            Ok(_) => {},
                            Err(_) => { must_scan.insert(dir.clone()); }
                        }
                    }
                    Err(_) => { must_scan.insert(dir.clone()); }
                }
            },
            Err(_) => { must_scan.insert(dir.clone()); }
        }
    }
}

fn watcher_thread(root: PathBuf, dirty: Arc<Mutex<Dirty>>) -> Result<()> {
    use inotify::EventMask as E;
    let mut ino = inotify::Inotify::init()?;
    let mut watches = ino.watches();
    let mut map: HashMap<inotify::WatchDescriptor, (PathBuf, bool)> = HashMap::new();
    let mut overflow = false;
    let mut must_scan = HashSet::new();
    add_watches(&mut watches, &mut map, &root, &root, &mut overflow, &mut must_scan);
    {
        let mut d = dirty.lock().unwrap();
        d.need_full |= overflow;
        d.must_scan.extend(must_scan);
    }
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let events = ino.read_events_blocking(&mut buf)?;
        let mut new_dirs = Vec::new();
        {
            let mut d = dirty.lock().unwrap();
            for ev in events {
                if ev.mask.contains(E::Q_OVERFLOW) {
                    d.need_full = true;
                    // Lost CREATE events may also mean lost watch coverage.
                    d.must_scan.insert(root.clone());
                    d.first.get_or_insert_with(Instant::now);
                    d.last = Some(Instant::now());
                    continue;
                }
                if ev.mask.contains(E::IGNORED) {
                    map.remove(&ev.wd);
                    continue;
                }
                let (dir, heavy) = match map.get(&ev.wd) {
                    Some(v) => v.clone(),
                    None => continue,
                };
                if let Some(name) = ev.name {
                    if dir == root {
                        if let Some(n) = name.to_str().and_then(|s| s.strip_prefix(SENTINEL_PREFIX)).and_then(|n| n.parse::<u64>().ok()) {
                            d.sentinel = d.sentinel.max(n);
                            continue;
                        }
                        if excluded_at_root(name) {
                            continue;
                        }
                    }
                }
                d.events += 1;
                d.first.get_or_insert_with(Instant::now);
                d.last = Some(Instant::now());
                if heavy {
                    d.subtrees.insert(dir.clone());
                    continue;
                }
                if ev.mask.contains(E::ISDIR) && (ev.mask.contains(E::CREATE) || ev.mask.contains(E::MOVED_TO)) {
                    if let Some(name) = ev.name {
                        let p = dir.join(name);
                        d.subtrees.insert(p.clone()); // files may already exist inside: scan it, do not trust events
                        new_dirs.push(p);
                    }
                }
                d.dirs.insert(dir);
            }
        }
        for p in new_dirs {
            let mut of = false;
            let mut must_scan = HashSet::new();
            add_watches(&mut watches, &mut map, &root, &p, &mut of, &mut must_scan);
            let mut d = dirty.lock().unwrap();
            d.need_full |= of;
            d.must_scan.extend(must_scan);
        }
    }
}

fn cmd_daemon(root: &Path) -> Result<()> {
    let lock = OpenOptions::new().create(true).write(true).open(meta_dir(root).join("lock"))?;
    lock.try_lock_exclusive().map_err(|_| anyhow!("another swvol holds the lock"))?;
    let mut st = load_attached_state(root)?;
    control_client::start(root, &st, CONTROL_ALLOW_HTTP.load(std::sync::atomic::Ordering::Relaxed))?;
    let dirty = Arc::new(Mutex::new(Dirty::default()));
    {
        let (r, d) = (root.to_path_buf(), dirty.clone());
        std::thread::spawn(move || {
            if let Err(e) = watcher_thread(r.clone(), d.clone()) {
                eprintln!("swvol: watcher stopped: {e}");
                let mut dirty = d.lock().unwrap();
                dirty.need_full = true;
                dirty.must_scan.insert(r);
            }
        });
    }
    let sock = meta_dir(root).join("sock");
    let _ = fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock)?;
    fs::set_permissions(&sock, fs::Permissions::from_mode(0o600))?;
    let (tx, rx) = mpsc::channel::<(String, UnixStream)>();
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let mut line = String::new();
            if BufReader::new(&conn).read_line(&mut line).is_ok() {
                let _ = tx.send((line.trim().to_string(), conn));
            }
        }
    });
    let _ = fs::write(meta_dir(root).join("daemon.pid"), std::process::id().to_string());
    let mut last_full = Instant::now();
    let mut last_coverage_scan = Instant::now();
    let mut backoff_until = Instant::now();
    // The first pass after start is a full scan: it covers anything written between restore and watch setup.
    let mut force_full = true;
    let mut gen = 0u64;
    loop {
        let req = rx.recv_timeout(Duration::from_millis(200)).ok();
        if st.boot_id != boot_id() {
            std::process::exit(EXIT_INSTANCE_CHANGED);
        }
        let rebase = req.as_ref().and_then(|(line, _)| line.split("rebase=").nth(1)).and_then(|n| n.trim().parse::<u64>().ok());
        let (trigger, want_full) = match &req {
            Some((_, _)) => (if rebase.is_some() { "rebase" } else { "flush" }, true),
            None => {
                let d = dirty.lock().unwrap();
                let quiet = d.last.map(|t| t.elapsed() >= Duration::from_millis(QUIET_MS)).unwrap_or(false);
                let overdue = d.first.map(|t| t.elapsed() >= Duration::from_millis(MAX_DELAY_MS)).unwrap_or(false);
                if Instant::now() < backoff_until {
                    continue;
                } else if d.first.is_some() && quiet {
                    ("debounce", false)
                } else if d.first.is_some() && overdue {
                    ("max-delay", false)
                } else if !d.must_scan.is_empty() && last_coverage_scan.elapsed() >= Duration::from_millis(MAX_DELAY_MS) {
                    ("coverage-scan", false)
                } else if force_full || last_full.elapsed() >= FULL_SCAN_INTERVAL {
                    ("periodic-full", true)
                } else {
                    continue;
                }
            }
        };
        let mut drained = true;
        if req.is_some() {
            // Barrier: make sure every event the finished command produced has been read.
            gen += 1;
            let sp = root.join(format!("{SENTINEL_PREFIX}{gen}"));
            let _ = File::create(&sp);
            let _ = fs::remove_file(&sp);
            let deadline = Instant::now() + Duration::from_secs(2);
            while dirty.lock().unwrap().sentinel < gen {
                if Instant::now() > deadline {
                    drained = false; // watcher is not keeping up or is gone: scan everything
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        let taken = {
            let mut d = dirty.lock().unwrap();
            let s = d.sentinel;
            let t = std::mem::take(&mut *d);
            d.sentinel = s;
            d.must_scan = t.must_scan.clone();
            t
        };
        let full = want_full || force_full || taken.need_full || !drained || trigger == "periodic-full";
        let mut subtrees = taken.subtrees.clone();
        subtrees.extend(taken.must_scan.iter().cloned());
        let scope = if full { Scope::Full } else { Scope::Partial { dirs: taken.dirs.clone(), subtrees } };
        let result = sync_once(root, &mut st, scope, trigger, rebase);
        let reply = match &result {
            Ok(rep) => {
                last_coverage_scan = Instant::now();
                if full {
                    last_full = Instant::now();
                    force_full = false;
                }
                let mut v = serde_json::to_value(rep)?;
                v["mode"] = "daemon".into();
                v["events"] = taken.events.into();
                v.to_string()
            }
            Err(e) => {
                // Nothing is lost: put the dirty set back and try again after a pause.
                let mut d = dirty.lock().unwrap();
                d.dirs.extend(taken.dirs);
                d.subtrees.extend(taken.subtrees);
                d.need_full |= taken.need_full || full;
                d.first.get_or_insert_with(Instant::now);
                d.last.get_or_insert_with(Instant::now);
                backoff_until = Instant::now() + Duration::from_secs(3);
                let mut report = error_report(root, e, rebase); report["mode"] = "daemon".into(); report.to_string()
            }
        };
        if let Some((_, mut conn)) = req {
            let _ = writeln!(conn, "{reply}");
        }
    }
}

fn cmd_flush(root: &Path, full: bool, rebase: Option<u64>) -> Result<i32> {
    // The daemon already owns a validated index; avoid decoding a second full
    // copy in every client. Direct mode loads and validates it once under lock.
    if cmd_check(root) != 0 { return Ok(EXIT_INSTANCE_CHANGED); }
    match fs::metadata(state_path(root)) {
        Ok(metadata) if metadata.is_file() => {},
        Ok(_) => bail!("state index is not a regular file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(EXIT_INSTANCE_CHANGED),
        Err(error) => return Err(error.into()),
    }
    if let Ok(mut conn) = UnixStream::connect(meta_dir(root).join("sock")) {
        conn.set_read_timeout(Some(Duration::from_secs(600)))?;
        match rebase {
            Some(n) => writeln!(conn, "FLUSH rebase={n}")?,
            None => writeln!(conn, "{}", if full { "FLUSH full" } else { "FLUSH" })?,
        }
        let mut line = String::new();
        BufReader::new(&conn).read_line(&mut line)?;
        if !line.trim().is_empty() {
            println!("{}", line.trim());
            let report: serde_json::Value = serde_json::from_str(&line).context("invalid daemon report")?;
            return Ok(if report.get("ok") == Some(&serde_json::Value::Bool(true)) { 0 }
                else { report.get("exit_code").and_then(|value| value.as_i64()).filter(|code| matches!(code, 1 | 76 | 78)).unwrap_or(1) as i32 });
        }
    }
    // No daemon: do the work here. Correctness never depends on the daemon being alive.
    let lock = OpenOptions::new().create(true).write(true).open(meta_dir(root).join("lock"))?;
    lock.lock_exclusive()?;
    let mut st = load_attached_state(root)?;
    let rep = sync_once(root, &mut st, Scope::Full, if rebase.is_some() { "rebase" } else { "flush" }, rebase)?;
    let mut v = serde_json::to_value(&rep)?;
    v["mode"] = "direct".into();
    println!("{v}");
    Ok(0)
}

/// Cheap pre-command check (no state load): is this still the container that was restored?
fn cmd_check(root: &Path) -> i32 {
    match fs::read_to_string(meta_dir(root).join("identity")) {
        Ok(s) if s.lines().nth(1) == Some(boot_id().as_str()) => 0,
        _ => EXIT_INSTANCE_CHANGED,
    }
}

// ---------- verification ----------

fn cmd_treehash(root: &Path) -> Result<()> {
    let mut cands = Vec::new();
    let mut skipped = Vec::new();
    walk(root, root, true, &mut cands, &mut skipped)?;
    cands.sort_by(|a, b| a.rel.cmp(&b.rel));
    let mut h = blake3::Hasher::new();
    h.update(b"SWVOL_TREEHASH_V2\0");
    let (mut files, mut bytes) = (0u64, 0u64);
    for c in &cands {
        let ft = c.md.file_type();
        timestamp_ns(c.md.mtime(), c.md.mtime_nsec()).with_context(|| format!("cannot hash unsupported mtime: {}", c.rel))?;
        let record = if ft.is_dir() {
            serde_json::json!(["d", c.md.mode() & 0o7777, c.md.mtime().to_string(), c.md.mtime_nsec(), c.rel])
        } else if ft.is_symlink() {
            let target = fs::read_link(&c.abs)?.into_os_string().into_string().map_err(|_| anyhow!("non-UTF-8 symlink targets are unsupported; refusing an incomplete tree hash"))?;
            serde_json::json!(["l", c.md.mode() & 0o7777, c.md.mtime().to_string(), c.md.mtime_nsec(), c.rel, target])
        } else {
            let mut fh = blake3::Hasher::new();
            let mut f = File::open(&c.abs)?;
            let mut buf = vec![0u8; 1 << 20];
            loop {
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                fh.update(&buf[..n]);
            }
            files += 1;
            bytes += c.md.len();
            serde_json::json!(["f", c.md.mode() & 0o7777, c.md.len(), c.md.mtime().to_string(), c.md.mtime_nsec(), fh.finalize().to_hex().to_string(), c.rel])
        };
        let bytes = serde_json::to_vec(&record)?;
        h.update(&(bytes.len() as u64).to_le_bytes());
        h.update(&bytes);
    }
    println!("{}", serde_json::json!({"treehash_version": 2, "algorithm": "blake3-framed-json-v2", "treehash": h.finalize().to_hex().to_string(), "entries": cands.len(), "files": files, "bytes": bytes}));
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let root = PathBuf::from(get("--root").unwrap_or_else(|| "/workspace".into()));
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");
    if let Some(directory) = get("--state-dir") {
        let directory = PathBuf::from(directory);
        if !directory.is_absolute() || directory.starts_with(&root) {
            eprintln!("swvol: protected state directory must be absolute and outside workspace"); std::process::exit(1);
        }
        let _ = STATE_DIR.set(directory);
    }
    CONTROL_ALLOW_HTTP.store(args.iter().any(|arg| arg == "--control-allow-http"), std::sync::atomic::Ordering::Relaxed);
    let res: Result<i32> = match cmd {
        "restore" => get("--plan").ok_or_else(|| anyhow!("--plan required")).and_then(|p| cmd_restore(&root, &p, args.iter().any(|a| a == "--index-only"))).map(|_| 0),
        "daemon" => cmd_daemon(&root).map(|_| 0),
        "flush" => cmd_flush(&root, args.iter().any(|a| a == "--full"), get("--rebase").and_then(|n| n.parse().ok())),
        "treehash" => cmd_treehash(&root).map(|_| 0),
        "check" => Ok(cmd_check(&root)),
        "version" => {
            println!("swvol {}", env!("CARGO_PKG_VERSION"));
            Ok(0)
        }
        _ => Err(anyhow!("usage: swvol restore|daemon|flush|treehash|version [--root DIR] [--plan FILE|URL] [--full]")),
    };
    match res {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            let report = error_report(&root, &e, get("--rebase").and_then(|n| n.parse().ok()));
            println!("{report}");
            std::process::exit(report["exit_code"].as_i64().unwrap_or(1) as i32);
        }
    }
}

#[cfg(test)]
thread_local! { static FAIL_STATE_SAVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

#[cfg(test)]
mod durability_tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct Fixture { root: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("swvol-read-{}-{}-{}", std::process::id(), now_ms(), NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(meta_dir(&root)).unwrap();
            fs::write(meta_dir(&root).join("slots.json"), r#"{"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/1/","packs":{},"manifests":{}}"#).unwrap();
            Self { root }
        }
        fn sync(&self) -> Result<SyncReport> {
            sync_once(&self.root, &mut State { volume: "v".into(), attachment: "a".into(), boot_id: boot_id(), ..State::default() }, Scope::Full, "test", None)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }

    #[test]
    fn failed_file_read_does_not_report_an_unchanged_success() {
        let f = Fixture::new(); fs::write(f.root.join("data"), b"new data").unwrap();
        FAIL_CHUNK_READ.with(|fault| fault.set(true));
        let result = f.sync();
        FAIL_CHUNK_READ.with(|fault| fault.set(false));
        assert!(result.err().unwrap().to_string().contains("cannot persist file read"), "the injected read failure must reach file capture");
    }
    #[test]
    fn non_utf8_symlink_target_cannot_disappear_from_a_successful_flush() {
        let f = Fixture::new();
        symlink(OsString::from_vec(vec![0xff]), f.root.join("link")).unwrap();
        assert!(f.sync().is_err(), "unsupported link target must explicitly fail");
    }
}

#[cfg(test)]
mod reliability_tests;

#[cfg(test)]
mod timestamp_tests {
    use super::timestamp_ns;
    #[test]
    fn signed_nanosecond_bounds_use_wide_intermediates() {
        for ns in [i64::MIN, -1, 0, 1, i64::MAX] {
            assert_eq!(timestamp_ns(ns.div_euclid(1_000_000_000), ns.rem_euclid(1_000_000_000)).unwrap(), ns);
        }
        for ns in [i64::MIN as i128 - 1, i64::MAX as i128 + 1] {
            assert!(timestamp_ns(ns.div_euclid(1_000_000_000) as i64, ns.rem_euclid(1_000_000_000) as i64).is_err());
        }
        assert!(timestamp_ns(0, -1).is_err()); assert!(timestamp_ns(0, 1_000_000_000).is_err());
    }
}
