use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::os::unix::fs::OpenOptionsExt;
use swvol_core::control;
pub static WAKE: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static COMMITTED_SEQ: AtomicU64 = AtomicU64::new(0);
pub fn record_commit(seq: u64) { COMMITTED_SEQ.store(seq, Ordering::Release); }
pub fn active() -> bool { ACTIVE.load(Ordering::Relaxed) }
struct Identity { volume: String, attachment: String, boot_id: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocatorRequest { volume: String, attachment: String, mount_id: String, chunks: Vec<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Priorities { mount_id: String, chunks: Vec<String> }
#[derive(Default)]
struct PollState { stamp: Option<(u64, i64, i64)>, request: Option<LocatorRequest>, cursor: usize, generation: u64, wrapped: bool }
fn valid_id(id: &str) -> bool { id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) }
fn refresh_request(directory: &Path, state: &Identity, poll: &mut PollState) -> Result<()> {
    let md = match fs::symlink_metadata(directory.join("locator-requests.json")) {
        Ok(md) => md,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => { poll.request = None; poll.stamp = None; return Ok(()); },
        Err(error) => return Err(error.into()),
    };
    let stamp = (md.ino(), md.mtime(), md.mtime_nsec());
    if poll.stamp == Some(stamp) { return Ok(()); }
    let request: LocatorRequest = control::read_private(directory, "locator-requests.json", 64 * 1024 * 1024)?;
    if request.volume != state.volume || request.attachment != state.attachment || request.mount_id.is_empty() || request.mount_id.len() > 64
        || !request.mount_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || request.chunks.iter().any(|id| !valid_id(id)) || request.chunks.windows(2).any(|ids| ids[0] >= ids[1]) {
        bail!("invalid fixed lower locator request");
    }
    poll.request = Some(request); poll.cursor = 0; poll.stamp = Some(stamp);
    Ok(())
}
fn locator_batch(directory: &Path, poll: &mut PollState) -> Result<Vec<String>> {
    poll.wrapped = false;
    let Some(request) = &poll.request else { return Ok(vec![]); };
    let mut selected = BTreeSet::new();
    match fs::symlink_metadata(directory.join("locator-priority.json")) {
        Ok(_) => {
            let priorities: Priorities = control::read_private(directory, "locator-priority.json", 32 * 1024)?;
            if priorities.mount_id == request.mount_id {
                if priorities.chunks.len() > 256 { bail!("too many locator priorities"); }
                for id in priorities.chunks {
                    if request.chunks.binary_search(&id).is_err() { bail!("priority chunk is not in the fixed lower tree"); }
                    selected.insert(id);
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.into()),
    }
    let mut examined = 0;
    while selected.len() < 256 && examined < request.chunks.len() {
        selected.insert(request.chunks[poll.cursor].clone());
        poll.cursor = (poll.cursor + 1) % request.chunks.len();
        if poll.cursor == 0 { poll.wrapped = true; }
        examined += 1;
    }
    Ok(selected.into_iter().collect())
}
fn private_subdirectory(parent: &Path, name: &str) -> Result<PathBuf> {
    let path = parent.join(name);
    match fs::create_dir(&path) { Ok(()) => fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?, Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}, Err(error) => return Err(error.into()) }
    control::validate_directory(&path)?; Ok(path)
}
fn cycle(root: &Path, identity: &Identity, allow_http: bool, poll: &mut PollState) -> Result<bool> {
    let directory = meta_dir(root);
    let config = control::Config::load(&directory, allow_http)?;
    if identity.attachment != config.attachment || identity.boot_id != config.boot_id { bail!("control configuration does not match local attachment"); }
    let seq = COMMITTED_SEQ.load(Ordering::Acquire);
    let grant = load_slots(root)?;
    let epoch = grant.manifest_prefix.trim_end_matches('/').rsplit('/').next().context("manifest epoch missing")?.parse::<u64>()?;
    refresh_request(&directory, identity, poll)?;
    let batch = locator_batch(&directory, poll)?;
    let next_pack = match fs::read_to_string(directory.join("pack.next")) { Ok(text) => text.trim().parse::<u32>()?, Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0, Err(e) => return Err(e.into()) };
    let response = config.poll(&control::Request { boot_id: identity.boot_id.clone(), epoch, seq, next_pack, locator_chunk_ids: batch.clone() })?;
    let fresh: Slots = serde_json::from_value(response.slots.clone()).map_err(|_| anyhow!("control slot grant is malformed"))?;
    if fresh.volume != identity.volume || fresh.attachment != identity.attachment || fresh.pack_prefix != grant.pack_prefix || fresh.manifest_prefix != grant.manifest_prefix { bail!("control slot grant identity changed"); }
    if response.locators.chunks.len() != batch.len() || batch.iter().any(|id| !response.locators.chunks.contains_key(id)) { bail!("control omitted a requested lower chunk"); }
    {
        let lock = OpenOptions::new().write(true).create(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(directory.join("slots.lock"))?;
        lock.lock_exclusive()?;
        let current = load_slots(root)?;
        if current.attachment != identity.attachment || current.volume != identity.volume || current.manifest_prefix != grant.manifest_prefix || current.pack_prefix != grant.pack_prefix { bail!("control slot publish lost the current attachment epoch"); }
        control::atomic_json(&directory, "slots.json", &response.slots)?;
    }
    control::atomic_json(&directory, "control-status.json", &serde_json::json!({"ok":true,"head":response.head,"confirmedSeq":response.confirmed_seq,"epoch":response.epoch,"hasMore":response.has_more,"slotsExpiresAt":response.slots_expires_at,"controlExpiresAt":response.control_expires_at,"updatedAt":now_ms()}))?;
    if let Some(request) = &poll.request {
        let updates = private_subdirectory(&directory, "locator-updates")?;
        let queue = private_subdirectory(&updates, &request.mount_id)?;
        let (mut pending, mut bytes) = (0usize, 0u64);
        for entry in fs::read_dir(&queue)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().ends_with(".json") { pending += 1; bytes += entry.metadata()?.len(); }
        }
        poll.generation = (poll.generation + 1).max(now_ms());
        let patch = serde_json::json!({"volume":identity.volume,"attachment":identity.attachment,"mountId":request.mount_id,"generation":poll.generation,"chunks":response.locators.chunks,"packs":response.locators.packs});
        let incoming = serde_json::to_vec(&patch)?.len() as u64;
        if pending >= 256 || bytes + incoming > 16 * 1024 * 1024 { bail!("locator update queue is full; preserve pending patches and report degraded"); }
        control::atomic_json(&queue, &format!("{:020}.json", poll.generation), &patch)?;
    }
    Ok(response.has_more || (!poll.wrapped && poll.request.as_ref().map(|request| !request.chunks.is_empty()).unwrap_or(false)))
}
pub fn start(root: &Path, state: &State, allow_http: bool) -> Result<()> {
    if STATE_DIR.get().is_none() { return Ok(()); }
    let directory = meta_dir(root);
    match fs::symlink_metadata(directory.join("control.json")) { Ok(_) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()), Err(error) => return Err(error.into()) }
    let config = control::Config::load(&directory, allow_http)?;
    if config.attachment != state.attachment || config.boot_id != state.boot_id { bail!("control configuration does not match local attachment"); }
    record_commit(state.seq);
    let identity = Identity { volume: state.volume.clone(), attachment: state.attachment.clone(), boot_id: state.boot_id.clone() };
    ACTIVE.store(true, Ordering::Relaxed);
    let root = root.to_owned();
    std::thread::spawn(move || {
        let mut poll = PollState::default();
        loop {
            let started = Instant::now();
            let fast = match cycle(&root, &identity, allow_http, &mut poll) {
                Ok(fast) => fast,
                Err(error) => {
                    eprintln!("swvol: attachment control degraded: {error}");
                    let _ = control::atomic_json(&meta_dir(&root), "control-status.json", &serde_json::json!({"ok":false,"error":error.to_string(),"updatedAt":now_ms()}));
                    true
                }
            };
            // A bounded subset is published every ~1s, never one batch per 20s.
            // Even priority wakeups respect the endpoint's one-second rate limit.
            let normal = if fast { Duration::from_millis(1100) } else { Duration::from_secs(20) };
            loop {
                let elapsed = started.elapsed();
                if elapsed >= normal || (elapsed >= Duration::from_millis(1100) && WAKE.swap(false, Ordering::Relaxed)) { break; }
                if elapsed >= Duration::from_millis(1100) && meta_dir(&root).join("locator-priority.json").exists() {
                    // A priority file may also be empty; a cheap next poll is safe.
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    });
    Ok(())
}
