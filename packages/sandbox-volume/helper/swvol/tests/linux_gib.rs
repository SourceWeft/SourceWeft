//! Explicit disk-backed GiB acceptance. Never runs in the default light suite.
//! Fixed pinned Linux image; sha256sum is an independent content oracle.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::os::unix::fs::{FileExt, MetadataExt, PermissionsExt};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const SEED: u64 = 0x2280_0300_5eed_8a71;
#[derive(Default)]
struct Counters {
    uploaded: AtomicU64,
    downloaded: AtomicU64,
    accepted: AtomicU64,
    ranges: AtomicU64,
    range_records: Mutex<BTreeMap<String, (u64, u64)>>,
    control: Mutex<Vec<u64>>,
    host_renewals: Mutex<Vec<u64>>,
    issued: Mutex<HashSet<String>>,
}
struct DiskStore {
    root: PathBuf,
    url: String,
    counters: Arc<Counters>,
    stop: Arc<AtomicBool>,
    server: Option<thread::JoinHandle<()>>,
}
fn grant(url: &str, next: u64, c: &Counters) -> Value {
    let packs: BTreeMap<_, _> = (next..next + 64)
        .map(|n| {
            let path = format!("/att/a/p/{n:06}");
            c.issued.lock().unwrap().insert(path.clone());
            (n.to_string(), format!("{url}{path}"))
        })
        .collect();
    let manifests: BTreeMap<_, _> = (1..=64)
        .map(|n| {
            let path = format!("/att/a/m/1/{n}");
            c.issued.lock().unwrap().insert(path.clone());
            (n.to_string(), format!("{url}{path}"))
        })
        .collect();
    json!({"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/1/","packs":packs,"manifests":manifests,"manifest_reads":manifests})
}
fn head(root: &Path) -> u64 {
    fs::read_dir(root.join("att/a/m/1"))
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u64>().ok())
        .max()
        .unwrap_or(0)
}
fn response(s: &mut TcpStream, status: u16, body: &[u8]) -> io::Result<()> {
    write!(
        s,
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    s.write_all(body)
}
fn serve(mut stream: TcpStream, root: &Path, url: &str, c: &Counters) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    stream.set_write_timeout(Some(Duration::from_secs(120)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first = String::new();
    if reader.read_line(&mut first)? == 0 {
        return Ok(());
    }
    let fields: Vec<_> = first.split_whitespace().collect();
    if fields.len() != 3 {
        return Err(io::Error::other("invalid fixture HTTP request"));
    }
    let (method, path) = (fields[0], fields[1]);
    let mut length = 0u64;
    let mut range = None;
    let mut auth = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            match k.to_ascii_lowercase().as_str() {
                "content-length" => length = v.trim().parse().unwrap(),
                "range" => range = Some(v.trim().to_owned()),
                "authorization" => auth = v.trim().to_owned(),
                _ => {}
            }
        }
    }
    if method == "POST" && path == "/v1/sandbox-volumes/a/control" {
        assert!(
            auth == format!("Bearer svctl_{}", "x".repeat(43)),
            "fixture scoped credential mismatch"
        );
        assert!(length < 1024 * 1024);
        let mut bytes = Vec::new();
        reader.take(length).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != length {
            return Ok(());
        }
        let request: Value = serde_json::from_slice(&bytes).unwrap();
        let next = request["nextPack"].as_u64().unwrap();
        c.control.lock().unwrap().push(next);
        let h = head(root);
        return response(&mut stream,200,&serde_json::to_vec(&json!({"head":h,"confirmedSeq":h.min(request["seq"].as_u64().unwrap()),"epoch":1,"hasMore":false,"slots":grant(url,next,c),"slotsExpiresAt":"2030-01-01T00:00:00Z","controlExpiresAt":"2030-01-01T00:00:00Z","locators":{"chunks":{},"packs":{}}})).unwrap());
    }
    assert!(path.starts_with("/att/a/") && path.split('/').all(|p| p != ".." && p != "."));
    let object = root.join(path.trim_start_matches('/'));
    if method == "PUT" {
        if !c.issued.lock().unwrap().contains(path) {
            return response(&mut stream, 403, b"unissued object slot");
        }
        fs::create_dir_all(object.parent().unwrap())?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let tmp = object.with_extension(format!("upload-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        let actual = io::copy(&mut reader.take(length), &mut file)?;
        c.uploaded.fetch_add(actual, Ordering::Relaxed);
        if actual != length {
            return Err(io::Error::other("short fixture PUT"));
        }
        file.sync_all()?;
        drop(file);
        let status = match fs::hard_link(&tmp, &object) {
            Ok(()) => {
                c.accepted.fetch_add(actual, Ordering::Relaxed);
                201
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => 412,
            Err(e) => return Err(e),
        };
        fs::remove_file(tmp)?;
        return response(&mut stream, status, &[]);
    }
    if method != "GET" {
        return response(&mut stream, 405, &[]);
    }
    let mut file = match File::open(&object) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return response(&mut stream, 404, &[]),
        Err(e) => return Err(e),
    };
    let size = file.metadata()?.len();
    let (status, from, count, extra) = if let Some(range) = range {
        let (a, b) = range
            .strip_prefix("bytes=")
            .unwrap()
            .split_once('-')
            .unwrap();
        let a: u64 = a.parse().unwrap();
        let b: u64 = b.parse().unwrap();
        assert!(a <= b && b < size);
        c.ranges.fetch_add(1, Ordering::Relaxed);
        let mut records = c.range_records.lock().unwrap();
        let entry = records
            .entry(format!("{path}@{a}+{}", b - a + 1))
            .or_default();
        entry.0 += 1;
        entry.1 += b - a + 1;
        drop(records);
        (
            206,
            a,
            b - a + 1,
            format!("Content-Range: bytes {a}-{b}/{size}\r\n"),
        )
    } else {
        (200, 0, size, String::new())
    };
    write!(
        stream,
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {count}\r\n{extra}Connection: close\r\n\r\n"
    )?;
    file.seek(SeekFrom::Start(from))?;
    let actual = io::copy(&mut file.take(count), &mut stream)?;
    c.downloaded.fetch_add(actual, Ordering::Relaxed);
    assert_eq!(actual, count);
    Ok(())
}
impl DiskStore {
    fn new(root: PathBuf) -> Self {
        fs::create_dir_all(&root).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let counters = Arc::new(Counters::default());
        let stop = Arc::new(AtomicBool::new(false));
        let (r, u, c, s) = (root.clone(), url.clone(), counters.clone(), stop.clone());
        let server = thread::spawn(move || {
            let mut last_progress = Instant::now();
            let mut workers: Vec<thread::JoinHandle<()>> = Vec::new();
            while !s.load(Ordering::Relaxed) {
                if last_progress.elapsed() >= Duration::from_secs(15) {
                    eprintln!("GIB_HTTP uploaded_bytes={} downloaded_bytes={} accepted_bytes={} control_requests={}",c.uploaded.load(Ordering::Relaxed),c.downloaded.load(Ordering::Relaxed),c.accepted.load(Ordering::Relaxed),c.control.lock().unwrap().len());
                    last_progress = Instant::now();
                }
                let mut i = 0;
                while i < workers.len() {
                    if workers[i].is_finished() {
                        workers.swap_remove(i).join().unwrap();
                    } else {
                        i += 1;
                    }
                }
                if workers.len() >= 16 {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let (r, u, c) = (r.clone(), u.clone(), c.clone());
                        workers.push(thread::spawn(move || {
                            if let Err(e) = serve(stream, &r, &u, &c) {
                                assert!(
                                    matches!(
                                        e.kind(),
                                        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                                    ),
                                    "disk fixture HTTP failed: {e}"
                                );
                            }
                        }));
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("HTTP accept: {e}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            root,
            url,
            counters,
            stop,
            server: Some(server),
        }
    }
    fn plan(&self) -> Value {
        let mut entries = BTreeMap::<String, Value>::new();
        let mut chunks = BTreeMap::new();
        let mut seqs: Vec<_> = fs::read_dir(self.root.join("att/a/m/1"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .parse::<u64>()
                    .is_ok()
            })
            .collect();
        seqs.sort_by_key(|p| {
            p.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        });
        let mut seq = 0;
        for path in seqs {
            let bytes = fs::read(path).unwrap();
            let manifest = swvol_core::decode_manifest(&bytes, 32 * 1024 * 1024).unwrap();
            assert_eq!(manifest.seq, seq + 1);
            seq = manifest.seq;
            for deletion in manifest.deletes {
                entries.retain(|p, _| p != &deletion && !p.starts_with(&(deletion.clone() + "/")));
            }
            for e in manifest.upserts {
                entries.insert(e.p.clone(), serde_json::to_value(e).unwrap());
            }
            chunks.extend(manifest.chunks);
        }
        let packs: BTreeMap<_, _> = chunks
            .values()
            .map(|loc| (loc.0.clone(), format!("{}/{}", self.url, loc.0)))
            .collect();
        json!({"volume":"v","attachment":"b","seq":seq,"entries":entries.into_values().collect::<Vec<_>>(),"chunks":chunks,"packs":packs})
    }
}
impl Drop for DiskStore {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.server.take().unwrap().join().unwrap();
    }
}
#[derive(Default, Serialize, Clone)]
struct Peaks {
    rss_sum_kib: u64,
    process_hwm_kib: BTreeMap<String, u64>,
    cache_bytes: u64,
}
struct Monitor {
    stop: Arc<AtomicBool>,
    pids: Arc<Mutex<Vec<(String, u32)>>>,
    peaks: Arc<Mutex<Peaks>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Monitor {
    fn new(cache: PathBuf) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let pids = Arc::new(Mutex::new(vec![("fixture".to_owned(), std::process::id())]));
        let peaks = Arc::new(Mutex::new(Peaks::default()));
        let (s, p, stats) = (stop.clone(), pids.clone(), peaks.clone());
        let worker = thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                let mut total = 0;
                let mut stats = stats.lock().unwrap();
                let mut visited = HashSet::new();
                let mut queue = p.lock().unwrap().clone();
                while let Some((name, pid)) = queue.pop() {
                    if !visited.insert(pid) {
                        continue;
                    }
                    if let Ok(text) = fs::read_to_string(format!("/proc/{pid}/status")) {
                        for line in text.lines() {
                            if line.starts_with("VmRSS:") {
                                total += line
                                    .split_whitespace()
                                    .nth(1)
                                    .unwrap()
                                    .parse::<u64>()
                                    .unwrap();
                            }
                            if line.starts_with("VmHWM:") {
                                let n = line
                                    .split_whitespace()
                                    .nth(1)
                                    .unwrap()
                                    .parse::<u64>()
                                    .unwrap();
                                let old = stats.process_hwm_kib.entry(name.clone()).or_default();
                                *old = (*old).max(n);
                            }
                        }
                    }
                    if let Ok(children) =
                        fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
                    {
                        for child in children
                            .split_whitespace()
                            .filter_map(|v| v.parse::<u32>().ok())
                        {
                            queue.push((format!("{name}/child"), child));
                        }
                    }
                }
                stats.rss_sum_kib = stats.rss_sum_kib.max(total);
                let size = fs::read_dir(&cache)
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.ok()?.metadata().ok())
                    .filter(|m| m.is_file())
                    .map(|m| m.len())
                    .sum();
                stats.cache_bytes = stats.cache_bytes.max(size);
                drop(stats);
                thread::sleep(Duration::from_millis(50));
            }
        });
        Self {
            stop,
            pids,
            peaks,
            worker: Some(worker),
        }
    }
    fn add(&self, name: &str, pid: u32) {
        self.pids.lock().unwrap().push((name.into(), pid));
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn private_json(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e3779b97f4a7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}
fn random_write(file: &mut File, bytes: u64, seed: u64) {
    let mut state = seed;
    let mut block = vec![0u8; MIB as usize];
    let mut remaining = bytes;
    while remaining > 0 {
        let count = remaining.min(MIB) as usize;
        for chunk in block[..count].chunks_mut(8) {
            let n = splitmix(&mut state).to_le_bytes();
            chunk.copy_from_slice(&n[..chunk.len()]);
        }
        file.write_all(&block[..count]).unwrap();
        remaining -= count as u64;
        if bytes >= GIB && (bytes - remaining) % (512 * MIB) == 0 {
            eprintln!("GIB_WRITE bytes={} total={bytes}", bytes - remaining);
        }
    }
    file.sync_all().unwrap();
}
fn set_time(path: &Path, ns: i64, link: bool) {
    let t = filetime::FileTime::from_unix_time(
        ns.div_euclid(1_000_000_000),
        ns.rem_euclid(1_000_000_000) as u32,
    );
    if link {
        filetime::set_symlink_file_times(path, t, t).unwrap();
    } else {
        filetime::set_file_mtime(path, t).unwrap();
    }
}
fn collect(root: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut pending = vec![root.to_owned()];
    while let Some(dir) = pending.pop() {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if fs::symlink_metadata(&p).unwrap().is_dir() {
                pending.push(p.clone());
            }
            result.push(p);
        }
    }
    result.sort();
    result
}
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
struct Oracle {
    kind: char,
    mode: u32,
    seconds: i64,
    nanos: i64,
    size: u64,
    sha256: Option<String>,
    link: Option<String>,
}
fn oracle(root: &Path) -> BTreeMap<String, Oracle> {
    let paths = collect(root);
    let files: Vec<_> = paths
        .iter()
        .filter(|p| fs::symlink_metadata(p).unwrap().is_file())
        .collect();
    let mut hashes = BTreeMap::new();
    for batch in files.chunks(128) {
        let out = Command::new("sha256sum").args(batch).output().unwrap();
        assert!(out.status.success());
        for line in String::from_utf8(out.stdout).unwrap().lines() {
            let (h, p) = line.split_once("  ").unwrap();
            hashes.insert(PathBuf::from(p), h.to_owned());
        }
    }
    assert_eq!(
        hashes.len(),
        files.len(),
        "independent SHA256 oracle omitted a file"
    );
    paths
        .into_iter()
        .map(|p| {
            let md = fs::symlink_metadata(&p).unwrap();
            let kind = if md.is_dir() {
                'd'
            } else if md.is_file() {
                'f'
            } else {
                'l'
            };
            let name = p.strip_prefix(root).unwrap().to_str().unwrap().to_owned();
            let entry = Oracle {
                kind,
                mode: md.mode() & 0o7777,
                seconds: md.mtime(),
                nanos: md.mtime_nsec(),
                size: if kind == 'f' { md.len() } else { 0 },
                sha256: hashes.remove(&p),
                link: if kind == 'l' {
                    Some(fs::read_link(&p).unwrap().to_str().unwrap().to_owned())
                } else {
                    None
                },
            };
            (name, entry)
        })
        .collect()
}
fn allocated(root: &Path) -> (u64, u64) {
    collect(root)
        .into_iter()
        .filter_map(|p| {
            let m = fs::symlink_metadata(p).unwrap();
            m.is_file().then_some((m.len(), m.blocks() * 512))
        })
        .fold((0, 0), |(a, b), (x, y)| (a + x, b + y))
}
struct Run {
    base: PathBuf,
    source: PathBuf,
    state: PathBuf,
    monitor: Monitor,
    daemon: Option<Child>,
    mount: Option<Child>,
    deadline: Instant,
    command: u32,
}
impl Run {
    fn command(&mut self, name: &str, args: &[&str], root: &Path, state: Option<&Path>) -> Value {
        let (status, value) = self.attempt(name, args, root, state);
        assert!(status.success(), "{name} failed {status}: {value}");
        value
    }
    fn attempt(
        &mut self,
        name: &str,
        args: &[&str],
        root: &Path,
        state: Option<&Path>,
    ) -> (std::process::ExitStatus, Value) {
        self.command += 1;
        let output = self
            .base
            .join(format!("command-{}-{name}.json", self.command));
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_swvol"));
        cmd.args(args).arg("--root").arg(root);
        if let Some(state) = state {
            cmd.arg("--state-dir").arg(state);
        }
        let mut child = cmd
            .stdout(File::create(&output).unwrap())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        self.monitor.add(name, child.id());
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                let bytes = fs::read(&output).unwrap();
                if !status.success() {
                    eprintln!("GIB_PROCESS_FAILURE phase={name} status={status} memory_events={:?} memory_peak={:?}", fs::read_to_string("/sys/fs/cgroup/memory.events"), fs::read_to_string("/sys/fs/cgroup/memory.peak"));
                }
                return (status, serde_json::from_slice(&bytes).unwrap());
            }
            if Instant::now() >= self.deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("declared GiB timeout exceeded in {name}");
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
    fn flush(&mut self) -> Value {
        let (root, state) = (self.source.clone(), self.state.clone());
        self.command("flush", &["flush", "--full"], &root, Some(&state))
    }
    fn start(&mut self) {
        assert!(self.daemon.is_none());
        let child = Command::new(env!("CARGO_BIN_EXE_swvol"))
            .args(["daemon", "--control-allow-http", "--root"])
            .arg(&self.source)
            .arg("--state-dir")
            .arg(&self.state)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        self.monitor.add("daemon", child.id());
        let pid = child.id();
        self.daemon = Some(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(self.daemon.as_mut().unwrap().try_wait().unwrap().is_none());
            if fs::read_to_string(self.state.join("daemon.pid"))
                .ok()
                .and_then(|s| s.parse::<u32>().ok())
                == Some(pid)
            {
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn kill(&mut self) {
        if let Some(mut child) = self.daemon.take() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }
    fn confirmed(&mut self, seq: u64) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let value = fs::read(self.state.join("control-status.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            if value
                .as_ref()
                .and_then(|v| v["confirmedSeq"].as_u64())
                .unwrap_or(0)
                >= seq
            {
                break;
            }
            assert!(self.daemon.as_mut().unwrap().try_wait().unwrap().is_none());
            assert!(
                Instant::now() < deadline,
                "64-slot control fixture never confirmed seq {seq}"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }
}
impl Drop for Run {
    fn drop(&mut self) {
        self.kill();
        if self.mount.is_some() {
            let _ = Command::new("umount").arg(self.base.join("lower")).status();
            if let Some(mut child) = self.mount.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
fn flush_mode(run: &mut Run, store: &DiskStore, host_retry: bool) -> Value {
    if !host_retry {
        return run.flush();
    }
    let mut check_new_pack = None;
    for attempt in 0..=32 {
        let (root, state) = (run.source.clone(), run.state.clone());
        let (status, report) = run.attempt("host-flush", &["flush", "--full"], &root, Some(&state));
        if let Some(next) = check_new_pack {
            let original = store.root.join("att/a/p/000000");
            let candidate = store.root.join(format!("att/a/p/{next:06}"));
            if candidate.exists() {
                let out = Command::new("sha256sum")
                    .args([&original, &candidate])
                    .output()
                    .unwrap();
                assert!(out.status.success());
                let text = String::from_utf8(out.stdout).unwrap();
                let hashes: Vec<_> = text
                    .lines()
                    .map(|line| line.split_whitespace().next().unwrap())
                    .collect();
                assert_ne!(hashes[0], hashes[1], "a renewed window reuploaded the same first pack instead of preserving unconfirmed capture progress; report={report}");
            }
        }
        if status.success() {
            return report;
        }
        assert_eq!(
            status.code(),
            Some(76),
            "unexpected capture failure: {report}"
        );
        assert!(attempt < 32, "fixed host-retry window budget exhausted");
        assert_eq!(
            head(&store.root),
            report
                .get("capture_progress")
                .and_then(|p| p["base_seq"].as_u64())
                .unwrap_or(head(&store.root)),
            "unconfirmed capture must not advance remote head"
        );
        let next: u64 = fs::read_to_string(state.join("pack.next"))
            .unwrap_or_else(|_| "0".into())
            .trim()
            .parse()
            .unwrap();
        eprintln!(
            "GIB_HOST_RENEW attempt={attempt} next_pack={next} uploaded_bytes={} report={report}",
            store.counters.uploaded.load(Ordering::Relaxed)
        );
        // Force process recovery at every boundary, proving progress is durable.
        run.kill();
        let lock = OpenOptions::new()
            .write(true)
            .create(true)
            .open(state.join("slots.lock"))
            .unwrap();
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        let temporary = state.join("slots.fixture.json");
        private_json(&temporary, &grant(&store.url, next, &store.counters));
        fs::rename(temporary, state.join("slots.json")).unwrap();
        File::open(&state).unwrap().sync_all().unwrap();
        drop(lock);
        store.counters.host_renewals.lock().unwrap().push(next);
        check_new_pack = Some(next);
        run.start();
    }
    unreachable!()
}
fn confirm_mode(run: &mut Run, store: &DiskStore, host_retry: bool, seq: u64) {
    if host_retry {
        assert_eq!(head(&store.root), seq);
        assert_eq!(store.plan()["seq"].as_u64(), Some(seq));
        assert!(store.counters.control.lock().unwrap().is_empty());
    } else {
        run.confirmed(seq);
    }
}

#[test]
#[ignore = "explicit real disk GiB test: SWVOL_GIB_CASE=ordinary2g|single8g, /gib disk, 2CPU/1GiB/pids512, pinned builder, real FUSE"]
fn gib_disk_roundtrip_crash_increment_and_small_cache() {
    let case = std::env::var("SWVOL_GIB_CASE").expect("select exact GiB matrix row");
    let (total, timeout) = match case.as_str() {
        "ordinary2g" => (2 * GIB, 1200),
        "single8g" => (8 * GIB, 3600),
        _ => panic!("unsupported GiB case"),
    };
    let host_retry = std::env::var("SWVOL_GIB_CONTROL_MODE").as_deref() == Ok("host-retry");
    let started = Instant::now();
    let base = PathBuf::from(format!(
        "/gib/{case}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    fs::create_dir(&base).unwrap();
    let (source, state, restored, restore_state, cache) = (
        base.join("source"),
        base.join("state"),
        base.join("restored"),
        base.join("restore-state"),
        base.join("cache"),
    );
    for p in [
        &source,
        &state,
        &restored,
        &restore_state,
        &cache,
        &base.join("lower"),
    ] {
        fs::create_dir(p).unwrap();
    }
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&restore_state, fs::Permissions::from_mode(0o700)).unwrap();
    let monitor = Monitor::new(cache.clone());
    let store = DiskStore::new(base.join("objects"));
    let mut run = Run {
        base: base.clone(),
        source: source.clone(),
        state: state.clone(),
        monitor,
        daemon: None,
        mount: None,
        deadline: started + Duration::from_secs(timeout),
        command: 0,
    };
    eprintln!("GIB_START case={case} seed={SEED:#x} logical_bytes={total} cpus=2 memory_mib=1024 pids=512 timeout_seconds={timeout} base={} strategy=disk_streaming_http_64_slots_sha256sum",base.display());
    let empty = base.join("empty.json");
    private_json(
        &empty,
        &json!({"volume":"v","attachment":"a","seq":0,"entries":[],"chunks":{},"packs":{}}),
    );
    run.command(
        "init",
        &["restore", "--plan", empty.to_str().unwrap()],
        &source,
        Some(&state),
    );
    private_json(
        &state.join("slots.json"),
        &grant(&store.url, 0, &store.counters),
    );
    if !host_retry {
        private_json(
            &state.join("control.json"),
            &json!({"url":format!("{}/v1/sandbox-volumes/a/control",store.url),"token":format!("svctl_{}","x".repeat(43)),"attachment":"a","bootId":fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim()}),
        );
    }
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for d in 0..64 {
        let p = source.join(format!("d{d:02}"));
        fs::create_dir(&p).unwrap();
        dirs.push(p);
    }
    if case == "ordinary2g" {
        for i in 0..1024 {
            let p = dirs[i % 64].join(format!("file-{i:04}.bin"));
            random_write(&mut File::create(&p).unwrap(), 2 * MIB, SEED ^ (i as u64));
            fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
            set_time(&p, 1_600_000_000_123_456_789 + i as i64, false);
            files.push(p);
        }
    } else {
        let p = dirs[0].join("large.bin");
        random_write(&mut File::create(&p).unwrap(), total, SEED);
        fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
        set_time(&p, 1_600_000_000_123_456_789, false);
        files.push(p);
    }
    for (i, d) in dirs.iter().enumerate() {
        let link = d.join("link");
        std::os::unix::fs::symlink(
            format!(
                "../{}",
                files[i % files.len()]
                    .strip_prefix(&source)
                    .unwrap()
                    .display()
            ),
            &link,
        )
        .unwrap();
        set_time(&link, 1_600_000_010_987_654_321 + i as i64, true);
        set_time(d, 1_600_000_020_555_555_555 + i as i64, false);
    }
    let (initial_logical, initial_allocated) = allocated(&source);
    assert_eq!(initial_logical, total);
    assert!(
        initial_allocated >= total,
        "sparse or insufficiently allocated source is forbidden"
    );
    let baseline = oracle(&source);
    fs::write(
        base.join("oracle-initial.json"),
        serde_json::to_vec(&baseline).unwrap(),
    )
    .unwrap();
    eprintln!(
        "GIB_PHASE generated_and_sha256_ms={} allocated_bytes={initial_allocated}",
        started.elapsed().as_millis()
    );
    run.start();
    let first = flush_mode(&mut run, &store, host_retry);
    let seq = first["seq"].as_u64().unwrap();
    assert!(seq >= 1);
    confirm_mode(&mut run, &store, host_retry, seq);
    let initial_upload = store.counters.uploaded.load(Ordering::Relaxed);
    let initial_stored = allocated(&store.root).0;
    assert!(
        initial_stored >= total * 98 / 100,
        "test data unexpectedly compressed/deduplicated: {initial_stored}/{total}"
    );
    assert!(
        (if host_retry {
            &store.counters.host_renewals
        } else {
            &store.counters.control
        })
        .lock()
        .unwrap()
        .iter()
        .any(|n| *n >= 64),
        "must cross a real 64-slot grant boundary"
    );
    eprintln!("GIB_PHASE confirmed_ms={} seq={seq} uploaded_bytes={initial_upload} stored_bytes={initial_stored}",started.elapsed().as_millis());
    run.kill();
    let manifest_head = head(&store.root);
    run.start();
    let recovered = flush_mode(&mut run, &store, host_retry);
    assert_eq!(recovered["seq"].as_u64(), Some(seq));
    assert_eq!(head(&store.root), manifest_head);
    assert_eq!(
        store.counters.uploaded.load(Ordering::Relaxed),
        initial_upload
    );
    run.kill();
    eprintln!(
        "GIB_PHASE confirmed_sigkill_recovery_ms={} command_replay=false",
        started.elapsed().as_millis()
    );
    if case == "ordinary2g" {
        for (i, p) in files.iter().take(16).enumerate() {
            let mut f = OpenOptions::new().write(true).open(p).unwrap();
            f.seek(SeekFrom::Start(512 * 1024)).unwrap();
            random_write(&mut f, 256 * 1024, SEED ^ 0xa55a ^ (i as u64));
            set_time(p, 1_700_000_000_123_456_789 + i as i64, false);
        }
        for p in files.iter().skip(16).take(8) {
            fs::rename(p, p.with_extension("renamed")).unwrap();
        }
        for p in files.iter().skip(24).take(8) {
            fs::remove_file(p).unwrap();
        }
    } else {
        let mut f = OpenOptions::new().write(true).open(&files[0]).unwrap();
        for i in 0..8 {
            f.seek(SeekFrom::Start(i * GIB + 256 * MIB)).unwrap();
            random_write(&mut f, 2 * MIB, SEED ^ 0xdecaf ^ (i as u64));
        }
        set_time(&files[0], 1_700_000_000_123_456_789, false);
    }
    let added = dirs[0].join("added.bin");
    random_write(&mut File::create(&added).unwrap(), MIB, SEED ^ 0xadd);
    fs::set_permissions(&added, fs::Permissions::from_mode(0o600)).unwrap();
    set_time(&added, 1_700_000_001_456_789_123, false);
    for (i, d) in dirs.iter().enumerate() {
        fs::set_permissions(
            d,
            fs::Permissions::from_mode(if i % 2 == 0 { 0o750 } else { 0o700 }),
        )
        .unwrap();
        set_time(d, 1_700_000_010_987_654_321 + i as i64, false);
    }
    let expected = oracle(&source);
    fs::write(
        base.join("oracle-final.json"),
        serde_json::to_vec(&expected).unwrap(),
    )
    .unwrap();
    run.start();
    let incremental = flush_mode(&mut run, &store, host_retry);
    let seq2 = incremental["seq"].as_u64().unwrap();
    assert!(seq2 > seq);
    confirm_mode(&mut run, &store, host_retry, seq2);
    run.kill();
    let incremental_upload = store.counters.uploaded.load(Ordering::Relaxed) - initial_upload;
    assert!(
        incremental_upload < 128 * MIB,
        "incremental update reuploaded too much: {incremental_upload}"
    );
    eprintln!(
        "GIB_PHASE incremental_confirmed_ms={} uploaded_bytes={incremental_upload}",
        started.elapsed().as_millis()
    );
    let plan = base.join("restore-plan.json");
    private_json(&plan, &store.plan());
    let restore = run.command(
        "restore",
        &["restore", "--plan", plan.to_str().unwrap()],
        &restored,
        Some(&restore_state),
    );
    let restored_oracle = oracle(&restored);
    assert_eq!(
        restored_oracle, expected,
        "independent SHA256/type/mode/nanosecond/target oracle differs"
    );
    let restore_download = store.counters.downloaded.load(Ordering::Relaxed);
    let (restored_logical, restored_allocated) = allocated(&restored);
    assert!(restored_allocated >= restored_logical);
    eprintln!("GIB_PHASE restored_verified_ms={} downloaded_bytes={restore_download} allocated_bytes={restored_allocated}",started.elapsed().as_millis());
    if case == "single8g" {
        let binary = std::env::var("SWVOL_LAZY_BIN")
            .expect("fresh verified swlazy binary required for 8GiB FUSE");
        run.mount = Some(
            Command::new(binary)
                .arg("mount-volume")
                .arg(&plan)
                .arg(&cache)
                .arg(base.join("lower"))
                .args(["--cap-mb", "8"])
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        run.monitor.add("fuse", run.mount.as_ref().unwrap().id());
        let ready = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(run.mount.as_mut().unwrap().try_wait().unwrap().is_none());
            if fs::read_to_string("/proc/self/mountinfo")
                .unwrap()
                .contains(&format!(" {} ", base.join("lower").display()))
            {
                break;
            }
            assert!(Instant::now() < ready);
            thread::sleep(Duration::from_millis(10));
        }
        thread::scope(|scope| {
            for worker in 0..8 {
                let original = files[0].clone();
                let mounted = base.join("lower/d00/large.bin");
                scope.spawn(move || {
                    let source = File::open(original).unwrap();
                    let lower = File::open(mounted).unwrap();
                    let mut seed = SEED ^ (worker as u64);
                    for _ in 0..16 {
                        let offset = (splitmix(&mut seed) % (8 * GIB - MIB)) / 4096 * 4096;
                        let mut wanted = vec![0; MIB as usize];
                        let mut actual = vec![0; MIB as usize];
                        source.read_exact_at(&mut wanted, offset).unwrap();
                        lower.read_exact_at(&mut actual, offset).unwrap();
                        assert_eq!(actual, wanted, "FUSE range mismatch at {offset}");
                    }
                });
            }
        });
        assert!(store.counters.ranges.load(Ordering::Relaxed) > 0);
        assert!(
            run.monitor.peaks.lock().unwrap().cache_bytes <= 8 * MIB,
            "disk cache exceeded 8MiB"
        );
    }
    // Unmount before physical disk accounting: FUSE's synthetic blocks are not allocated disk.
    if let Some(mut child) = run.mount.take() {
        assert!(Command::new("umount")
            .arg(base.join("lower"))
            .status()
            .unwrap()
            .success());
        let _ = child.kill();
        child.wait().unwrap();
    }
    let report = json!({"case":case,"seed":format!("{SEED:#x}"),"cpuLimit":2,"memoryLimitBytes":GIB,"pidsLimit":512,"timeoutSeconds":timeout,"elapsedMs":started.elapsed().as_millis(),"initialLogicalBytes":total,"initialAllocatedBytes":initial_allocated,"initialUploadedBytes":initial_upload,"initialStoredBytes":initial_stored,"incrementalUploadedBytes":incremental_upload,"totalUploadedBytes":store.counters.uploaded.load(Ordering::Relaxed),"restoreDownloadedBytes":restore_download,"totalDownloadedBytes":store.counters.downloaded.load(Ordering::Relaxed),"restoredLogicalBytes":restored_logical,"restoredAllocatedBytes":restored_allocated,"objectDisk":allocated(&store.root),"baseDisk":allocated(&base),"controlMode":if host_retry {"host-retry"} else {"independent-poll"},"hostRenewals":*store.counters.host_renewals.lock().unwrap(),"controlNextPackRequests":*store.counters.control.lock().unwrap(),"grantWindow":64,"rangeRequests":store.counters.ranges.load(Ordering::Relaxed),"peaks":run.monitor.peaks.lock().unwrap().clone(),"monitorSampleMs":50,"cgroupMemoryEvents":fs::read_to_string("/sys/fs/cgroup/memory.events").ok(),"cgroupMemoryPeak":fs::read_to_string("/sys/fs/cgroup/memory.peak").ok().map(|s|s.trim().to_owned()),"restoreReport":restore,"oracle":"system sha256sum plus independent filesystem type/mode/mtime/link inventory","productionFreezeUsed":false});
    fs::write(
        base.join("report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    eprintln!("GIB_RESULT {report}");
    assert!(
        Instant::now() < run.deadline,
        "declared GiB timeout exceeded"
    );
}

/// Read-stage replay only: the completed 8GiB roundtrip remains a separate result.
#[test]
#[ignore = "read-only replay of retained single8g data; explicit /gib baseline and /profile output mounts, same 2CPU/1GiB/8readers/8MiB cache"]
fn gib_read_replay_profile() {
    use std::os::fd::AsRawFd;
    let baseline =
        PathBuf::from(std::env::var("SWVOL_GIB_REPLAY_BASE").expect("retained 8GiB base required"));
    let source = baseline.join("source");
    let expected: BTreeMap<String, Oracle> =
        serde_json::from_slice(&fs::read(baseline.join("oracle-final.json")).unwrap()).unwrap();
    let verify_start = Instant::now();
    assert_eq!(
        oracle(&source),
        expected,
        "retained independent oracle changed"
    );
    let large = source.join("d00/large.bin");
    assert_eq!(fs::metadata(&large).unwrap().len(), 8 * GIB);
    eprintln!(
        "GIB_REPLAY_ORACLE_OK full_source_sha256=true elapsed_ms={} baseline={}",
        verify_start.elapsed().as_millis(),
        baseline.display()
    );
    let store = DiskStore::new(baseline.join("objects"));
    let plan = store.plan();
    let original: Value =
        serde_json::from_slice(&fs::read(baseline.join("restore-plan.json")).unwrap()).unwrap();
    for key in ["volume", "attachment", "seq", "entries", "chunks"] {
        assert_eq!(plan[key], original[key], "fixed plan field changed: {key}");
    }
    let binary = std::env::var("SWVOL_LAZY_BIN").expect("profile binary required");
    let group = PathBuf::from(format!(
        "/profile/read-replay-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    fs::create_dir(&group).unwrap();
    let mut results = Vec::new();
    for trial in 1..=3 {
        // Drop only this fixture's clean file pages. Never use global drop_caches.
        for path in collect(&source).into_iter().chain(collect(&store.root)) {
            if fs::symlink_metadata(&path).unwrap().is_file() {
                let file = File::open(path).unwrap();
                assert_eq!(
                    unsafe {
                        libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED)
                    },
                    0
                );
            }
        }
        let base = group.join(format!("trial-{trial}"));
        fs::create_dir(&base).unwrap();
        let cache = base.join("cache");
        let lower = base.join("lower");
        fs::create_dir(&cache).unwrap();
        fs::create_dir(&lower).unwrap();
        let plan_path = base.join("plan.json");
        private_json(&plan_path, &plan);
        let trace = base.join("fuse-reads.log");
        let monitor = Monitor::new(cache.clone());
        let mut run = Run {
            base: base.clone(),
            source: source.clone(),
            state: base.join("unused-state"),
            monitor,
            daemon: None,
            mount: None,
            deadline: Instant::now() + Duration::from_secs(180),
            command: 0,
        };
        store.counters.range_records.lock().unwrap().clear();
        let download_before = store.counters.downloaded.load(Ordering::Relaxed);
        run.mount = Some(
            Command::new(&binary)
                .arg("mount-volume")
                .arg(&plan_path)
                .arg(&cache)
                .arg(&lower)
                .args(["--cap-mb", "8"])
                .env("SWVOL_FUSE_TRACE_READS", "1")
                .stdout(Stdio::null())
                .stderr(File::create(&trace).unwrap())
                .spawn()
                .unwrap(),
        );
        run.monitor.add("fuse", run.mount.as_ref().unwrap().id());
        let ready = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(run.mount.as_mut().unwrap().try_wait().unwrap().is_none());
            if fs::read_to_string("/proc/self/mountinfo")
                .unwrap()
                .contains(&format!(" {} ", lower.display()))
            {
                break;
            }
            assert!(Instant::now() < ready);
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            fs::read_dir(&cache)
                .unwrap()
                .filter(|e| e.as_ref().unwrap().file_name() != ".lock")
                .count(),
            0
        );
        let durations = Mutex::new(Vec::new());
        let read_start = Instant::now();
        thread::scope(|scope| {
            for worker in 0..8 {
                let large = large.clone();
                let mounted = lower.join("d00/large.bin");
                let durations = &durations;
                scope.spawn(move || {
                    let source = File::open(large).unwrap();
                    let file = File::open(mounted).unwrap();
                    let mut seed = SEED ^ worker;
                    for _ in 0..16 {
                        let offset = (splitmix(&mut seed) % (8 * GIB - MIB)) / 4096 * 4096;
                        let mut expected = vec![0; MIB as usize];
                        let mut actual = vec![0; MIB as usize];
                        source.read_exact_at(&mut expected, offset).unwrap();
                        let t = Instant::now();
                        file.read_exact_at(&mut actual, offset).unwrap();
                        durations
                            .lock()
                            .unwrap()
                            .push(t.elapsed().as_micros() as u64);
                        assert_eq!(actual, expected, "read replay mismatch at {offset}");
                    }
                });
            }
        });
        let read_ms = read_start.elapsed().as_millis();
        assert!(Command::new("umount")
            .arg(&lower)
            .status()
            .unwrap()
            .success());
        let mut child = run.mount.take().unwrap();
        let _ = child.kill();
        child.wait().unwrap();
        let records = store.counters.range_records.lock().unwrap().clone();
        let expected_download: u64 = records.values().map(|(_, bytes)| *bytes).sum();
        let accounting_deadline = Instant::now() + Duration::from_secs(1);
        while store.counters.downloaded.load(Ordering::Relaxed) - download_before
            != expected_download
        {
            assert!(
                Instant::now() < accounting_deadline,
                "HTTP bytes accounting did not settle"
            );
            thread::sleep(Duration::from_millis(1));
        }
        let mut lengths = BTreeMap::<u64, u64>::new();
        for line in fs::read_to_string(&trace)
            .unwrap()
            .lines()
            .filter(|line| line.starts_with("SWVOL_FUSE_READ "))
        {
            let size: u64 = line.split("bytes=").nth(1).unwrap().parse().unwrap();
            *lengths.entry(size).or_default() += 1;
        }
        assert!(!lengths.is_empty(), "opt-in READ profiling was not active");
        let mut latency = durations.into_inner().unwrap();
        latency.sort();
        assert_eq!(latency.len(), 128);
        let peaks = run.monitor.peaks.lock().unwrap().clone();
        assert!(peaks.cache_bytes <= 8 * MIB);
        let report = json!({"qualification":"read-stage-only","trial":trial,"seed":format!("{SEED:#x}"),"verifiedReadBytes":128*MIB,"readMs":read_ms,"preadMicros":{"p50":latency[63],"p95":latency[121],"max":latency[127]},"rangeRequests":records.values().map(|(n,_)|*n).sum::<u64>(),"rangeDownloadedBytes":expected_download,"uniqueRanges":records.len(),"uniqueCompressedBytes":records.values().map(|(n,bytes)|bytes/n).sum::<u64>(),"maxFetchesOfOneRange":records.values().map(|(n,_)|*n).max(),"fuseReadLengthHistogram":lengths,"diskCacheLimitBytes":8*MIB,"peaks":peaks,"memoryEvents":fs::read_to_string("/sys/fs/cgroup/memory.events").unwrap(),"baseline":baseline,"trace":trace});
        fs::write(
            base.join("range-counts.json"),
            serde_json::to_vec_pretty(&records).unwrap(),
        )
        .unwrap();
        fs::write(
            base.join("report.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        eprintln!("GIB_READ_PROFILE {report}");
        results.push(report);
    }
    fs::write(
        group.join("summary.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
    eprintln!("GIB_READ_PROFILE_DONE output={}", group.display());
}
