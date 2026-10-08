//! Immutable, hash-addressed disk chunks. Readers pin bytes before releasing the
//! cache lock; eviction can never remove the data being served to a FUSE reply.
use anyhow::{bail, Context, Result};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use swvol_core::{ChunkLoc, ChunkRef, Fetcher, RestorePlan};

struct Cache {
    chunks: HashMap<String, (usize, u64)>,
    fetching: HashSet<String>,
    bytes: usize,
    tick: u64,
}
pub struct VolumeStore {
    locators: HashMap<String, ChunkLoc>,
    urls: HashMap<String, String>,
    fetcher: Fetcher,
    cache: Mutex<Cache>,
    wake: Condvar,
    cap: usize,
    directory: PathBuf,
    _lock: File,
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
        let store = Self { locators: plan.chunks.clone(), urls: plan.packs.clone(), fetcher: Fetcher::default(),
            cache: Mutex::new(cache), wake: Condvar::new(), cap, directory: directory.to_owned(), _lock: lock };
        store.evict(&mut store.cache.lock().unwrap(), 0)?;
        Ok(Arc::new(store))
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
        let loc = self.locators.get(id).context("chunk location missing")?;
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
        let result = self.urls.get(&loc.0).context("chunk URL missing").and_then(|url| self.fetcher.chunk(id, loc, url));
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
