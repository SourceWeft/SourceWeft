//! Immutable, hash-addressed disk chunks. Readers pin bytes before releasing the
//! cache lock; eviction can never remove the data being served to a FUSE reply.
use anyhow::{bail, Context, Result};
use std::collections::{HashMap, HashSet, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use serde::Deserialize;
use swvol_core::{ChunkLoc, ChunkRef, RestorePlan};

struct Cache {
    chunks: HashMap<String, (usize, u64)>,
    fetching: HashSet<String>,
    bytes: usize,
    tick: u64,
}
#[derive(Deserialize)]
pub struct ReadLocatorUpdate {
    pub volume: String,
    pub attachment: String,
    pub generation: u64,
    #[serde(rename = "mountId")] pub mount_id: String,
    pub chunks: HashMap<String, ChunkLoc>,
    pub packs: HashMap<String, String>,
}
struct ReadLocators { generation: u64, chunks: HashMap<String, ChunkLoc>, packs: HashMap<String, String>, pack_refs: HashMap<String, usize> }
fn validate_locator_update(volume: &str, attachment: &str, expected: &HashMap<String, u32>, update: &ReadLocatorUpdate) -> Result<()> {
    if update.volume != volume || update.attachment != attachment || update.chunks.len() > 256 { bail!("read locator update identity or chunk set mismatch"); }
    if update.chunks.is_empty() && !expected.is_empty() { bail!("empty locator patch for a nonempty lower"); }
    let referenced: HashSet<_> = update.chunks.values().map(|loc| &loc.0).collect();
    if update.packs.len() != referenced.len() || update.packs.keys().any(|key| !referenced.contains(key)) { bail!("locator patch includes unrelated pack URLs"); }
    for (id, loc) in &update.chunks {
        let raw = expected.get(id).context("read locator patch introduces a new chunk")?;
        swvol_core::validate_location(loc)?;
        if loc.3 != *raw || !update.packs.contains_key(&loc.0) { bail!("read locator update changes chunk identity or omits a URL"); }
        let url = &update.packs[&loc.0];
        if !url.starts_with("http://") && !url.starts_with("https://") { bail!("read locator update URL scheme is unsupported"); }
    }
    Ok(())
}
pub struct VolumeStore {
    volume: String,
    attachment: String,
    expected: HashMap<String, u32>,
    locators: RwLock<ReadLocators>,
    workers: crate::workers::Workers,
    cache: Mutex<Cache>,
    wake: Condvar,
    cap: usize,
    directory: PathBuf,
    _lock: File,
    control: Mutex<Option<(PathBuf, String)>>,
    priorities: Mutex<BTreeSet<String>>,
}
impl VolumeStore {
    pub fn new(plan: &RestorePlan, directory: &Path, cap: usize) -> Result<Arc<Self>> {
        plan.validate()?;
        if cap < swvol_core::MAX_CHUNK_BYTES as usize { bail!("chunk cache must hold at least one maximum-size chunk"); }
        fs::create_dir_all(directory)?;
        if fs::symlink_metadata(directory)?.file_type().is_symlink() { bail!("chunk cache directory must not be a symlink"); }
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new().read(true).write(true).create(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(directory.join(".lock"))?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error()).context("chunk cache is already owned by another mount");
        }
        let mut cache = Cache { chunks: HashMap::new(), fetching: HashSet::new(), bytes: 0, tick: 0 };
        for item in fs::read_dir(directory)? {
            let item = item?;
            let name = item.file_name().into_string().map_err(|_| anyhow::anyhow!("invalid cache entry name"))?;
            if name == ".lock" { continue; }
            if name.ends_with(".pending") { fs::remove_file(item.path())?; continue; }
            if name.len() != 64 || !name.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { bail!("unexpected chunk cache entry"); }
            let metadata = item.metadata()?;
            if !item.file_type()?.is_file() || metadata.len() > swvol_core::MAX_CHUNK_BYTES as u64 { bail!("invalid cache chunk file"); }
            cache.tick += 1;
            cache.bytes += metadata.len() as usize;
            cache.chunks.insert(name, (metadata.len() as usize, cache.tick));
        }
        let expected: HashMap<String, u32> = plan.entries.iter().flat_map(|entry| entry.c.iter().map(|chunk| (chunk.0.clone(), chunk.1))).collect();
        let chunks: HashMap<_, _> = expected.keys().map(|id| (id.clone(), plan.chunks[id].clone())).collect();
        let mut pack_refs = HashMap::new();
        for loc in chunks.values() { *pack_refs.entry(loc.0.clone()).or_insert(0) += 1; }
        let packs = pack_refs.keys().map(|key| (key.clone(), plan.packs[key].clone())).collect();
        let store = Self { volume: plan.volume.clone(), attachment: plan.attachment.clone(), expected,
            locators: RwLock::new(ReadLocators { generation: 0, chunks, packs, pack_refs }), workers: crate::workers::Workers::new()?,
            cache: Mutex::new(cache), wake: Condvar::new(), cap, directory: directory.to_owned(), _lock: lock, control: Mutex::new(None), priorities: Mutex::new(BTreeSet::new()) };
        store.evict(&mut store.cache.lock().unwrap(), 0)?;
        Ok(Arc::new(store))
    }
    /// The sync daemon owns authentication; dispatch consumes bounded patches
    /// in a mount-specific durable queue, without replacing its fixed tree.
    pub fn start_control_view(self: &Arc<Self>, directory: &Path) -> Result<()> {
        swvol_core::control::validate_directory(directory)?;
        let mount_id = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos());
        *self.control.lock().unwrap() = Some((directory.to_owned(), mount_id.clone()));
        let mut ids: Vec<_> = self.expected.keys().cloned().collect(); ids.sort();
        swvol_core::control::atomic_json(directory, "read-locators-status.json", &serde_json::json!({"ok":false,"mountId":mount_id,"reason":"awaiting locator patches"}))?;
        swvol_core::control::atomic_json(directory, "locator-requests.json", &serde_json::json!({"volume":self.volume,"attachment":self.attachment,"mountId":mount_id,"chunks":ids}))?;
        let directory = directory.to_owned(); let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            let queue = directory.join("locator-updates").join(&mount_id);
            loop {
                let Some(store) = weak.upgrade() else { break; };
                let outcome = (|| -> Result<()> {
                    let entries = match fs::read_dir(&queue) { Ok(entries) => entries, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()), Err(error) => return Err(error.into()) };
                    let mut names = Vec::new();
                    for entry in entries {
                        let name = entry?.file_name().into_string().map_err(|_| anyhow::anyhow!("invalid locator queue filename"))?;
                        if name.starts_with('.') { continue; }
                        if name.len() != 25 || !name.ends_with(".json") || !name[..20].bytes().all(|b| b.is_ascii_digit()) { bail!("invalid locator queue filename"); }
                        names.push(name);
                    }
                    names.sort();
                    for name in names.into_iter().take(16) {
                        let update: ReadLocatorUpdate = swvol_core::control::read_private(&queue, &name, 8 * 1024 * 1024)?;
                        let generation = update.generation; let updated = update.chunks.len();
                        store.apply_read_locator_patch(update)?;
                        swvol_core::control::atomic_json(&directory, "read-locators-status.json", &serde_json::json!({"ok":true,"mountId":mount_id,"generation":generation,"updatedChunks":updated,"scope":"subset"}))?;
                        fs::remove_file(queue.join(name))?;
                    }
                    Ok(())
                })();
                if let Err(error) = outcome {
                    eprintln!("swvol: read locator patch rejected: {error}");
                    let _ = swvol_core::control::atomic_json(&directory, "read-locators-status.json", &serde_json::json!({"ok":false,"mountId":mount_id,"error":error.to_string()}));
                }
                drop(store); std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        Ok(())
    }
    fn publish_priorities(&self) -> Result<()> {
        let control = self.control.lock().unwrap();
        if let Some((directory, mount_id)) = control.as_ref() {
            let priorities = self.priorities.lock().unwrap();
            if priorities.is_empty() {
                match fs::remove_file(directory.join("locator-priority.json")) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(error) => return Err(error.into()) }
            } else {
                swvol_core::control::atomic_json(directory, "locator-priority.json", &serde_json::json!({"mountId":mount_id,"chunks":priorities.iter().collect::<Vec<_>>()}))?;
            }
        }
        Ok(())
    }
    pub fn apply_read_locator_patch(&self, update: ReadLocatorUpdate) -> Result<()> {
        validate_locator_update(&self.volume, &self.attachment, &self.expected, &update)?;
        if self.control.lock().unwrap().as_ref().map(|(_, id)| id.as_str()) != Some(update.mount_id.as_str()) { bail!("locator patch belongs to another mount"); }
        let mut current = self.locators.write().unwrap();
        if update.generation < current.generation { bail!("stale read locator generation"); }
        if update.generation == current.generation {
            if update.chunks.iter().all(|(id, loc)| current.chunks.get(id) == Some(loc)) && update.packs.iter().all(|(key, url)| current.packs.get(key) == Some(url)) { return Ok(()); }
            bail!("read locator generation reused with different locations");
        }
        let ids: Vec<_> = update.chunks.keys().cloned().collect();
        current.generation = update.generation;
        for (id, loc) in update.chunks {
            let old = current.chunks.insert(id, loc.clone()).expect("validated fixed chunk");
            if old.0 != loc.0 {
                let count = current.pack_refs.get_mut(&old.0).expect("known old pack reference"); *count -= 1;
                if *count == 0 { current.pack_refs.remove(&old.0); current.packs.remove(&old.0); }
                *current.pack_refs.entry(loc.0.clone()).or_insert(0) += 1;
            }
        }
        current.packs.extend(update.packs);
        drop(current);
        { let mut priorities = self.priorities.lock().unwrap(); for id in ids { priorities.remove(&id); } }
        self.publish_priorities()?;
        Ok(())
    }
    fn fetch_with_refresh(&self, id: &str, mut loc: ChunkLoc, mut url: String) -> Result<Vec<u8>> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        for _ in 0..3 {
            match self.workers.chunk(id, &loc, &url, deadline) {
                Ok(bytes) => return Ok(bytes),
                Err(error) => {
                    let text = error.to_string();
                    let expired = text.contains("HTTP 401") || text.contains("HTTP 403") || text.contains("HTTP 404");
                    if !expired || self.control.lock().unwrap().is_none() { return Err(error); }
                    { let mut priorities = self.priorities.lock().unwrap(); if priorities.len() >= 256 && !priorities.contains(id) { bail!("locator priority budget exhausted"); } priorities.insert(id.to_owned()); }
                    self.publish_priorities()?;
                    loop {
                        if std::time::Instant::now() >= deadline { bail!("signed read locator refresh budget expired"); }
                        let current = self.locators.read().unwrap();
                        let candidate = current.chunks.get(id).context("fixed chunk locator disappeared")?;
                        let candidate_url = current.packs.get(&candidate.0).context("fixed chunk URL disappeared")?;
                        if candidate != &loc || candidate_url != &url { loc = candidate.clone(); url = candidate_url.clone(); break; }
                        drop(current); std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                }
            }
        }
        bail!("signed read locator failed after bounded refreshes")
    }
    fn evict(&self, cache: &mut Cache, incoming: usize) -> Result<()> {
        while cache.bytes + incoming > self.cap {
            let victim = cache.chunks.iter().min_by_key(|(_, (_, used))| *used).map(|(id, _)| id.clone()).context("cache cannot fit verified chunk")?;
            fs::remove_file(self.directory.join(&victim)).context("chunk eviction failed")?;
            cache.bytes -= cache.chunks.remove(&victim).unwrap().0;
        }
        Ok(())
    }
    fn chunk(&self, id: &str) -> Result<Vec<u8>> {
        let (loc, url) = {
            let locations = self.locators.read().unwrap();
            let loc = locations.chunks.get(id).context("chunk location missing")?;
            (loc.clone(), locations.packs.get(&loc.0).context("chunk URL missing")?.clone())
        };
        let mut cache = self.cache.lock().unwrap();
        loop {
            cache.tick += 1;
            let tick = cache.tick;
            if let Some((size, used)) = cache.chunks.get_mut(id) {
                *used = tick;
                // Lock pins this disk object until its verified bytes are owned by
                // the request. Buffers are bounded by MAX_CHUNK_BYTES and 4 workers.
                let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(self.directory.join(id))?;
                let mut data = Vec::with_capacity(*size);
                (&mut file).take(swvol_core::MAX_CHUNK_BYTES as u64 + 1).read_to_end(&mut data)?;
                if data.len() != loc.3 as usize || swvol_core::raw_chunk_hash(&data) != id { bail!("cached chunk integrity mismatch"); }
                return Ok(data);
            }
            if cache.fetching.insert(id.to_owned()) { break; }
            cache = self.wake.wait(cache).unwrap();
        }
        drop(cache);
        let result = self.fetch_with_refresh(id, loc.clone(), url);
        let mut cache = self.cache.lock().unwrap();
        let result = result.and_then(|data| {
            self.evict(&mut cache, data.len())?;
            let tmp = self.directory.join(format!("{id}.pending"));
            let publish = (|| -> Result<()> {
                let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
                file.write_all(&data)?; file.sync_all()?;
                fs::rename(&tmp, self.directory.join(id))?;
                File::open(&self.directory)?.sync_all()?;
                Ok(())
            })();
            if let Err(error) = publish { let _ = fs::remove_file(&tmp); return Err(error).context("cannot publish verified cache chunk"); }
            cache.bytes += data.len(); cache.tick += 1;
            let tick = cache.tick;
            cache.chunks.insert(id.to_owned(), (data.len(), tick));
            Ok(data)
        });
        cache.fetching.remove(id);
        drop(cache);
        self.wake.notify_all();
        result
    }
    pub fn read(&self, chunks: &[ChunkRef], offset: u64, out: &mut [u8]) -> Result<()> {
        let end = offset.checked_add(out.len() as u64).context("file read overflow")?;
        let mut position = 0u64;
        let mut filled = 0;
        for ChunkRef(id, raw) in chunks {
            let next = position + *raw as u64;
            if next > offset && position < end {
                let data = self.chunk(id)?;
                if data.len() != *raw as usize { bail!("file chunk length mismatch"); }
                let from = offset.saturating_sub(position) as usize;
                let to = ((end - position).min(*raw as u64)) as usize;
                let count = to - from;
                out[filled..filled + count].copy_from_slice(&data[from..to]);
                filled += count;
            }
            position = next;
            if position >= end { break; }
        }
        if filled != out.len() { bail!("file read exceeds declared chunks"); }
        Ok(())
    }
}

#[cfg(test)]
mod locator_tests {
    use super::*;
    #[test]
    fn locator_refresh_may_move_bytes_but_cannot_change_tree_chunk_identity() {
        let id = "a".repeat(64);
        let expected = [(id.clone(), 10)].into_iter().collect();
        let mut update = ReadLocatorUpdate { volume: "v".into(), attachment: "a".into(), generation: 1, mount_id: "test".into(),
            chunks: [(id.clone(), ChunkLoc("repaired-pack".into(), 20, 15, 10))].into_iter().collect(),
            packs: [("repaired-pack".into(), "https://storage.example/new-signed-url".into())].into_iter().collect() };
        assert!(validate_locator_update("v", "a", &expected, &update).is_ok());
        update.chunks.get_mut(&id).unwrap().3 = 11;
        assert!(validate_locator_update("v", "a", &expected, &update).is_err());
        update.chunks.get_mut(&id).unwrap().3 = 10; update.attachment = "other".into();
        assert!(validate_locator_update("v", "a", &expected, &update).is_err());
        update.attachment = "a".into(); update.chunks.insert("b".repeat(64), ChunkLoc("repaired-pack".into(), 20, 15, 10));
        assert!(validate_locator_update("v", "a", &expected, &update).is_err());
    }
}
