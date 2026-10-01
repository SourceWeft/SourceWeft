//! Block store: the logical content stream of a volume, fetched on demand in 4 MiB blocks with
//! ranged GETs, cached in one sparse local file, evicted least-recently-used under a byte cap.
use anyhow::{anyhow, bail, Result};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::os::unix::fs::FileExt;
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const BLOCK: u64 = 4 << 20;

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
/// A fetch that made no progress is retried (resuming at the byte it reached) until this much time has passed.
fn build_agent() -> ureq::Agent {
    let rt: u64 = env_u64("SWLAZY_READ_TIMEOUT", 5);
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(rt))
        .max_idle_connections_per_host(8)
        .build()
}

/// One ranged GET never asks for more than this: a throttled connection is abandoned cheaply and
/// progress is kept in small steps.
const MAX_REQUEST: u64 = 8 << 20;

fn budget() -> Duration {
    Duration::from_secs(env_u64("SWLAZY_FETCH_BUDGET", 90))
}
fn permanent(e: &anyhow::Error) -> bool {
    e.to_string().starts_with("permanent")
}

#[derive(Default)]
pub struct Stats {
    pub gets: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pub stalls: AtomicU64,
    pub net_us: AtomicU64,
    pub evicted: AtomicU64,
}

struct St {
    present: HashMap<u64, u64>,
    fetching: HashSet<u64>,
    failed: HashMap<u64, String>,
    tick: u64,
    last_block: u64,
}

pub struct Store {
    packs: Vec<String>,
    pack_size: u64,
    pub total: u64,
    agent: Mutex<ureq::Agent>,
    cache: File,
    cap_blocks: usize,
    st: Mutex<St>,
    cv: Condvar,
    fault_file: PathBuf,
    pub readahead: u64,
    pub stats: Stats,
}

impl Store {
    pub fn new(packs: Vec<String>, pack_size: u64, total: u64, cache_dir: &str, cap_bytes: u64) -> Result<Arc<Store>> {
        if pack_size % BLOCK != 0 {
            bail!("pack size must be a multiple of the block size");
        }
        std::fs::create_dir_all(cache_dir)?;
        let path = format!("{}/blocks", cache_dir);
        let cache = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&path)?;
        cache.set_len(total.max(1))?;
        // A body that stops flowing for this long is abandoned and resumed on a new connection.
        let agent = Mutex::new(build_agent());
        Ok(Arc::new(Store {
            packs,
            pack_size,
            total,
            agent,
            cache,
            cap_blocks: ((cap_bytes / BLOCK) as usize).max(4),
            st: Mutex::new(St { present: HashMap::new(), fetching: HashSet::new(), failed: HashMap::new(), tick: 0, last_block: u64::MAX - 1 }),
            cv: Condvar::new(),
            fault_file: PathBuf::from(format!("{}/fault", cache_dir)),
            readahead: std::env::var("SWLAZY_READAHEAD").ok().and_then(|v| v.parse().ok()).unwrap_or(8),
            stats: Stats::default(),
        }))
    }

    fn url_for(&self, pack: usize) -> String {
        // Fault injection for the stall / failure tests: a file that replaces every pack URL.
        if let Ok(s) = std::fs::read_to_string(&self.fault_file) {
            let s = s.trim();
            if !s.is_empty() {
                return s.to_string();
            }
        }
        self.packs[pack].clone()
    }

    /// One ranged GET inside one pack, streamed to `sink` in pieces. Returns bytes delivered.
    fn get_range(&self, pack: usize, off: u64, len: u64, sink: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<u64> {
        let url = self.url_for(pack);
        let t = Instant::now();
        self.stats.gets.fetch_add(1, Ordering::Relaxed);
        let mut done = 0u64;
        let mut buf = vec![0u8; 256 << 10];
        if let Some(p) = url.strip_prefix("file://") {
            let f = File::open(p)?;
            while done < len {
                let want = buf.len().min((len - done) as usize);
                let n = f.read_at(&mut buf[..want], off + done)?;
                if n == 0 {
                    bail!("short pack file");
                }
                sink(&buf[..n])?;
                done += n as u64;
            }
        } else {
            let len = len.min(MAX_REQUEST);
            let agent = self.agent.lock().unwrap().clone();
            let resp = agent
                .get(&url)
                .set("Range", &format!("bytes={}-{}", off, off + len - 1))
                .call()
                .map_err(|e| match e {
                    // An expired or refused URL will not get better by retrying.
                    ureq::Error::Status(code, _) if (400..500).contains(&code) && code != 408 && code != 429 => anyhow!("permanent: HTTP {}", code),
                    ureq::Error::Status(code, _) => anyhow!("HTTP {}", code),
                    other => anyhow!("GET failed: {}", short(&other.to_string())),
                })?;
            if resp.status() != 206 && !(resp.status() == 200 && off == 0) {
                bail!("unexpected status {}", resp.status());
            }
            let mut rd = resp.into_reader();
            // A body that keeps trickling (seen from Daytona: ~90 KB/s after ~100 MB on one
            // connection, while a fresh connection does 40-70 MB/s) never trips the read timeout,
            // so the delivered rate is also checked per window; a slow body is abandoned and the
            // caller resumes the range on a new connection.
            let (win, floor) = (Duration::from_secs(env_u64("SWLAZY_STALL_WINDOW", 3)), env_u64("SWLAZY_STALL_MIN_BYTES", 1 << 20));
            // Only time spent waiting on the socket counts towards the window: time spent in the
            // sink (writing the cache file) is not the network's fault.
            let (mut win_wait, mut win_bytes) = (Duration::ZERO, 0u64);
            while done < len {
                let want = buf.len().min((len - done) as usize);
                let t_read = Instant::now();
                let n = rd.read(&mut buf[..want]).map_err(|e| anyhow!("read failed after {} bytes: {}", done, e))?;
                win_wait += t_read.elapsed();
                if n == 0 {
                    bail!("body ended after {} of {} bytes", done, len);
                }
                sink(&buf[..n])?;
                done += n as u64;
                win_bytes += n as u64;
                if win_wait >= win {
                    if win_bytes < floor && done < len {
                        self.stats.stalls.fetch_add(1, Ordering::Relaxed);
                        // Throttling sticks to the TCP connection: drop the whole pool so no retry reuses it.
                        *self.agent.lock().unwrap() = build_agent();
                        bail!("stalled: {} bytes in {:?} of socket wait after {} of {} bytes", win_bytes, win_wait, done, len);
                    }
                    win_wait = Duration::ZERO;
                    win_bytes = 0;
                }
            }
        }
        self.stats.bytes.fetch_add(done, Ordering::Relaxed);
        self.stats.net_us.fetch_add(t.elapsed().as_micros() as u64, Ordering::Relaxed);
        Ok(done)
    }

    /// Fetch blocks b0..=b1 (all in one pack) into the cache, marking each present as it lands.
    /// A stalled or broken transfer is resumed from the byte it reached, until the time budget runs out.
    fn fetch_span(self: &Arc<Self>, b0: u64, b1: u64) {
        let end = ((b1 + 1) * BLOCK).min(self.total);
        let mut pos = b0 * BLOCK;
        let mut cur = b0;
        let mut last_err = String::new();
        let t0 = Instant::now();
        let mut attempt = 0u64;
        while pos < end {
            if attempt > 0 {
                if t0.elapsed() > budget() {
                    break;
                }
                std::thread::sleep(Duration::from_millis((250 * attempt).min(2000)));
            }
            attempt += 1;
            let pack = (pos / self.pack_size) as usize;
            let in_pack = pos - pack as u64 * self.pack_size;
            let me = self.clone();
            let r = self.get_range(pack, in_pack, end - pos, &mut |chunk: &[u8]| {
                me.cache.write_all_at(chunk, pos)?;
                pos += chunk.len() as u64;
                while cur <= b1 && pos >= ((cur + 1) * BLOCK).min(me.total) {
                    me.mark_present(cur);
                    cur += 1;
                }
                Ok(())
            });
            match r {
                Ok(_) => attempt = 0, // a capped request finished: the next piece is not a retry
                Err(e) => {
                    self.stats.errors.fetch_add(1, Ordering::Relaxed);
                    last_err = e.to_string();
                    if permanent(&e) {
                        break;
                    }
                }
            }
        }
        if cur <= b1 {
            let mut st = self.st.lock().unwrap();
            for b in cur..=b1 {
                st.fetching.remove(&b);
                st.failed.insert(b, last_err.clone());
            }
            drop(st);
            self.cv.notify_all();
        }
    }

    fn mark_present(&self, b: u64) {
        let mut st = self.st.lock().unwrap();
        st.fetching.remove(&b);
        st.failed.remove(&b);
        st.tick += 1;
        let t = st.tick;
        st.present.insert(b, t);
        // Eviction: least recently used blocks go first; their disk space is released with a hole punch.
        while st.present.len() > self.cap_blocks {
            let victim = st.present.iter().filter(|(k, _)| **k != b).min_by_key(|(_, v)| **v).map(|(k, _)| *k);
            match victim {
                Some(v) => {
                    st.present.remove(&v);
                    unsafe {
                        libc::fallocate(self.cache.as_raw_fd(), libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE, (v * BLOCK) as libc::off_t, BLOCK as libc::off_t);
                    }
                    self.stats.evicted.fetch_add(1, Ordering::Relaxed);
                }
                None => break,
            }
        }
        drop(st);
        self.cv.notify_all();
    }

    /// Make block `b` present, fetching up to `ahead` further missing blocks in the same request.
    fn ensure(self: &Arc<Self>, b: u64, ahead: u64) -> Result<()> {
        let mut st = self.st.lock().unwrap();
        let mut waited = false;
        loop {
            if st.present.contains_key(&b) {
                return Ok(());
            }
            if let Some(e) = st.failed.remove(&b) {
                // A failure left behind by an earlier reader is stale: this reader gets its own attempt.
                if waited {
                    return Err(anyhow!("block {} unavailable: {}", b, e));
                }
            }
            waited = true;
            if !st.fetching.contains(&b) {
                let last_in_pack = ((b * BLOCK / self.pack_size) + 1) * self.pack_size / BLOCK - 1;
                let last_block = (self.total.saturating_sub(1)) / BLOCK;
                let limit = (b + ahead).min(last_in_pack).min(last_block);
                let mut e = b;
                while e < limit && !st.present.contains_key(&(e + 1)) && !st.fetching.contains(&(e + 1)) {
                    e += 1;
                }
                for x in b..=e {
                    st.fetching.insert(x);
                }
                let me = self.clone();
                std::thread::spawn(move || me.fetch_span(b, e));
            }
            st = self.cv.wait(st).unwrap();
        }
    }

    /// Serve from the cache only. False when a needed block is not present.
    pub fn try_read_cached(&self, off: u64, buf: &mut [u8]) -> bool {
        if buf.is_empty() {
            return true;
        }
        let b0 = off / BLOCK;
        let b1 = (off + buf.len() as u64 - 1) / BLOCK;
        let mut st = self.st.lock().unwrap();
        for b in b0..=b1 {
            if !st.present.contains_key(&b) {
                return false;
            }
        }
        st.tick += 1;
        let t = st.tick;
        for b in b0..=b1 {
            st.present.insert(b, t);
        }
        // Read while holding the lock so a concurrent eviction cannot punch the block out from under us.
        self.cache.read_exact_at(buf, off).is_ok()
    }

    pub fn read_at(self: &Arc<Self>, off: u64, buf: &mut [u8]) -> Result<()> {
        if buf.is_empty() {
            return Ok(());
        }
        if off + buf.len() as u64 > self.total {
            bail!("read past the end of the volume stream");
        }
        let b0 = off / BLOCK;
        let b1 = (off + buf.len() as u64 - 1) / BLOCK;
        for _ in 0..50 {
            if self.try_read_cached(off, buf) {
                return Ok(());
            }
            for b in b0..=b1 {
                // A reader that moves to the block after the previous one is sequential: read ahead.
                let ahead = {
                    let mut st = self.st.lock().unwrap();
                    let seq = b == st.last_block + 1 || b == st.last_block;
                    st.last_block = b;
                    if seq { self.readahead.saturating_sub(1) } else { 0 }
                };
                self.ensure(b, ahead)?;
            }
        }
        bail!("cache thrash: block evicted before it could be read")
    }

    /// One segment (inside one pack) streamed into `out`, resumed on stalls until the budget runs out.
    fn fetch_segment(&self, off: u64, len: u64, out: &File, out_off: u64) -> Result<()> {
        let mut done = 0u64;
        let t0 = Instant::now();
        let mut attempt = 0u64;
        let mut last = String::new();
        while done < len {
            if attempt > 0 {
                if t0.elapsed() > budget() {
                    bail!("range unavailable after {} attempts in {:?}: {}", attempt, t0.elapsed(), last);
                }
                std::thread::sleep(Duration::from_millis((250 * attempt).min(2000)));
            }
            attempt += 1;
            let pos = off + done;
            let pack = (pos / self.pack_size) as usize;
            let mut w = out_off + done;
            let mut got = 0u64;
            let r = self.get_range(pack, pos - pack as u64 * self.pack_size, len - done, &mut |c: &[u8]| {
                out.write_all_at(c, w)?;
                w += c.len() as u64;
                got += c.len() as u64;
                Ok(())
            });
            done += got;
            match r {
                Ok(_) => attempt = 0,
                Err(e) => {
                    self.stats.errors.fetch_add(1, Ordering::Relaxed);
                    last = e.to_string();
                    if permanent(&e) {
                        bail!("{}", last);
                    }
                }
            }
        }
        Ok(())
    }

    /// Stream a large range straight into a file, bypassing the block cache. The range is cut at
    /// pack boundaries and the pieces are fetched on a few connections at once.
    pub fn fetch_to(self: &Arc<Self>, off: u64, len: u64, out: &File, out_off: u64) -> Result<()> {
        let mut segs = Vec::new();
        let mut done = 0u64;
        while done < len {
            let pos = off + done;
            let n = (self.pack_size - pos % self.pack_size).min(len - done);
            segs.push((pos, n, out_off + done));
            done += n;
        }
        let par = (env_u64("SWLAZY_PAR", 4) as usize).min(segs.len()).max(1);
        let segs = Arc::new(Mutex::new(segs.into_iter()));
        let mut hs = Vec::new();
        for _ in 0..par {
            let (me, segs, out) = (self.clone(), segs.clone(), out.try_clone()?);
            hs.push(std::thread::spawn(move || -> Result<()> {
                loop {
                    let next = segs.lock().unwrap().next();
                    match next {
                        Some((pos, n, w)) => me.fetch_segment(pos, n, &out, w)?,
                        None => return Ok(()),
                    }
                }
            }));
        }
        let mut res = Ok(());
        for h in hs {
            if let Err(e) = h.join().unwrap() {
                res = Err(e);
            }
        }
        res
    }

    /// Whole pack into memory (eager restore).
    pub fn fetch_pack(&self, pack: usize) -> Result<Vec<u8>> {
        let start = pack as u64 * self.pack_size;
        let len = self.pack_size.min(self.total - start);
        let mut last = String::new();
        let mut v = Vec::with_capacity(len as usize);
        let mut attempt = 0u32;
        while (v.len() as u64) < len {
            let off = v.len() as u64;
            match self.get_range(pack, off, len - off, &mut |c: &[u8]| {
                v.extend_from_slice(c);
                Ok(())
            }) {
                Ok(_) => attempt = 0,
                Err(e) => {
                    attempt += 1;
                    if attempt >= 6 {
                        bail!("pack {} unavailable: {}", pack, e);
                    }
                    last = e.to_string();
                    std::thread::sleep(Duration::from_millis(300 * attempt as u64));
                }
            }
        }
        let _ = last;
        Ok(v)
    }

    pub fn cached_blocks(&self) -> usize {
        self.st.lock().unwrap().present.len()
    }

    pub fn stats_line(&self) -> String {
        format!(
            "gets={} bytes={} errors={} stalls={} net_ms={} cached_blocks={} evicted={}",
            self.stats.gets.load(Ordering::Relaxed),
            self.stats.bytes.load(Ordering::Relaxed),
            self.stats.errors.load(Ordering::Relaxed),
            self.stats.stalls.load(Ordering::Relaxed),
            self.stats.net_us.load(Ordering::Relaxed) / 1000,
            self.cached_blocks(),
            self.stats.evicted.load(Ordering::Relaxed)
        )
    }
}

/// Never let a pre-signed URL reach a log line.
fn short(s: &str) -> String {
    let mut out = String::new();
    for w in s.split_whitespace() {
        if w.contains("X-Amz-") || w.starts_with("http") {
            out.push_str("<url> ");
        } else {
            out.push_str(w);
            out.push(' ');
        }
    }
    out.trim().chars().take(160).collect()
}
