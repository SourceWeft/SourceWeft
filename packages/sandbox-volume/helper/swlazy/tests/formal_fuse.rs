//! Explicit Linux-only mount acceptance. Run with --ignored in a FUSE-capable container.
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use serde_json::json;
type Objects = Arc<Mutex<BTreeMap<String, Vec<u8>>>>;
struct Storage { url: String, objects: Objects, stop: Arc<AtomicBool>, worker: Option<std::thread::JoinHandle<()>> }
impl Storage {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let objects = Arc::new(Mutex::new(BTreeMap::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (data, stopped) = (objects.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &data),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => panic!("HTTP fixture failed: {error}"),
                }
            }
        });
        Self { url, objects, stop, worker: Some(worker) }
    }
    fn grant(&self, root: &PathBuf, enabled: bool) {
        let packs: BTreeMap<_, _> = (0..64).filter(|_| enabled).map(|n| (n.to_string(), format!("{}/att/a/p/{n:06}", self.url))).collect();
        let manifests: BTreeMap<_, _> = (1..65).filter(|_| enabled).map(|n| (n.to_string(), format!("{}/att/a/m/1/{n}", self.url))).collect();
        let bytes = serde_json::to_vec(&json!({"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/1/","packs":packs,"manifests":manifests})).unwrap();
        let tmp = root.join(".sourceweft/slots.new");
        fs::write(&tmp, bytes).unwrap();
        fs::rename(tmp, root.join(".sourceweft/slots.json")).unwrap();
    }

}
impl Drop for Storage { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); self.worker.take().unwrap().join().unwrap(); } }
fn serve(mut stream: TcpStream, objects: &Objects) {
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new(); reader.read_line(&mut first).unwrap();
    let mut fields = first.split_whitespace();
    let method = fields.next().unwrap(); let path = fields.next().unwrap().to_owned();
    let mut length = 0;
    let mut range = None;
    loop {
        let mut line = String::new(); reader.read_line(&mut line).unwrap();
        if line == "\r\n" { break; }
        if let Some((key, value)) = line.split_once(':') { if key.eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap(); }
            if key.eq_ignore_ascii_case("range") { range = Some(value.trim().to_owned()); } }
    }
    let mut body = vec![0; length]; reader.read_exact(&mut body).unwrap();
    let mut map = objects.lock().unwrap();
    let mut range_header = String::new();
    let (status, reply) = if method == "PUT" {
        if map.contains_key(&path) { (412, Vec::new()) }
        else { map.insert(path, body); (201, Vec::new()) }
    } else { match map.get(&path) { Some(data) => {
        if let Some(range) = range {
            let (from, to) = range.strip_prefix("bytes=").unwrap().split_once('-').unwrap();
            let from: usize = from.parse().unwrap(); let to: usize = to.parse().unwrap();
            range_header = format!("Content-Range: bytes {from}-{to}/{}\r\n", data.len());
            (206, data[from..=to].to_vec())
        } else { (200, data.clone()) }
    }, None => (404, Vec::new()) } };
    write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\n{range_header}Connection: close\r\n\r\n", reply.len()).unwrap();
    stream.write_all(&reply).unwrap();
}

struct Mounts { base: PathBuf, child: Option<Child>, overlay: bool }
impl Drop for Mounts {
    fn drop(&mut self) {
        if self.overlay { let _ = Command::new("umount").arg(self.base.join("workspace")).status(); }
        let _ = Command::new("umount").arg(self.base.join("lower")).status();
        if let Some(mut child) = self.child.take() { let _ = child.kill(); let _ = child.wait(); }
        let _ = fs::remove_dir_all(&self.base);
    }
}
fn random_bytes(seed: u32, size: usize) -> Vec<u8> {
    let mut seed = seed;
    (0..size).map(|_| { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed as u8 }).collect()
}
fn swvol(root: &Path, args: &[&str]) {
    let binary = std::env::var("SWVOL_SYNC_BIN").expect("SWVOL_SYNC_BIN must name the freshly built sync helper");
    let output = Command::new(binary).args(args).arg("--root").arg(root).output().unwrap();
    assert!(output.status.success(), "sync helper failed: {}", String::from_utf8_lossy(&output.stdout));
}
#[test]
#[ignore = "requires real /dev/fuse and mount privileges; run explicit Linux acceptance command"]
fn formal_sync_objects_mount_lazily_and_overlay_keeps_lower_immutable() {
    assert!(Path::new("/dev/fuse").exists(), "real FUSE device is required");
    let base = PathBuf::from(format!("/test/swvol-fuse-{}", std::process::id()));
    let mut mounts = Mounts { base: base.clone(), child: None, overlay: false };
    for dir in ["source", "cache", "lower", "upper", "work", "workspace"] { fs::create_dir_all(base.join(dir)).unwrap(); }
    let source = base.join("source"); let storage = Storage::new();
    let empty = base.join("empty.json");
    fs::write(&empty, serde_json::to_vec(&json!({"volume":"v","attachment":"a","seq":0,"entries":[],"chunks":{},"packs":{}})).unwrap()).unwrap();
    swvol(&source, &["restore", "--plan", empty.to_str().unwrap()]); storage.grant(&source, true);
    fs::create_dir(source.join("nested")).unwrap();
    let a = random_bytes(41, 6 * 1024 * 1024); let b = random_bytes(97, 6 * 1024 * 1024); let bad = random_bytes(199, 6 * 1024 * 1024);
    fs::write(source.join("nested/a.bin"), &a).unwrap(); fs::write(source.join("b.bin"), &b).unwrap(); fs::write(source.join("bad.bin"), &bad).unwrap();
    std::os::unix::fs::symlink("nested/a.bin", source.join("link")).unwrap();
    swvol(&source, &["flush"]);
    let objects = storage.objects.lock().unwrap();
    let manifest_bytes = objects.get("/att/a/m/1/1").expect("sync emitted a formal manifest");
    let manifest = swvol_core::decode_manifest(manifest_bytes, 1024 * 1024).unwrap();
    let urls = objects.keys().map(|key| (key.trim_start_matches('/').to_owned(), format!("{}{key}", storage.url))).collect();
    drop(objects);
    let plan = swvol_core::RestorePlan { volume: "v".into(), attachment: "a".into(), seq: manifest.seq, entries: manifest.upserts, chunks: manifest.chunks.into_iter().collect(), packs: urls };
    plan.validate().unwrap();
    let plan_path = base.join("plan.json"); fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    mounts.child = Some(Command::new(env!("CARGO_BIN_EXE_swlazy")).arg("mount-volume").arg(&plan_path).arg(base.join("cache")).arg(base.join("lower")).args(["--cap-mb", "4"]).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(mounts.child.as_mut().unwrap().try_wait().unwrap().is_none(), "FUSE process exited before mount");
        if fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!(" {} ", base.join("lower").display())) { break; }
        assert!(Instant::now() < deadline, "FUSE mount did not become ready"); std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read_dir(base.join("cache")).unwrap().filter(|item| item.as_ref().unwrap().file_name() != ".lock").count(), 0, "mount must not download file data");
    assert_eq!(fs::read_link(base.join("lower/link")).unwrap(), PathBuf::from("nested/a.bin"));
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| assert_eq!(fs::read(base.join("lower/nested/a.bin")).unwrap(), a));
            scope.spawn(|| assert_eq!(fs::read(base.join("lower/b.bin")).unwrap(), b));
        }
    });
    let cache_bytes: u64 = fs::read_dir(base.join("cache")).unwrap().map(|entry| entry.unwrap().metadata().unwrap().len()).sum();
    assert!(cache_bytes <= 4 * 1024 * 1024, "disk cache exceeded its budget: {cache_bytes}");
    let mount = Command::new("mount").args(["-t", "overlay", "overlay", "-o"]).arg(format!("lowerdir={},upperdir={},workdir={}", base.join("lower").display(), base.join("upper").display(), base.join("work").display())).arg(base.join("workspace")).output().unwrap();
    assert!(mount.status.success(), "overlay mount failed: {}", String::from_utf8_lossy(&mount.stderr)); mounts.overlay = true;
    fs::write(base.join("workspace/nested/a.bin"), "upper write").unwrap(); fs::remove_file(base.join("workspace/b.bin")).unwrap();
    assert_eq!(fs::read_to_string(base.join("workspace/nested/a.bin")).unwrap(), "upper write");
    assert_eq!(fs::read(base.join("lower/nested/a.bin")).unwrap(), a);
    assert_eq!(fs::read(base.join("lower/b.bin")).unwrap(), b);
    // Corrupt an unread immutable object chunk. The FUSE reply must fail, never return corrupt bytes.
    let bad_ref = &plan.entries.iter().find(|entry| entry.p == "bad.bin").unwrap().c[0];
    let loc = &plan.chunks[&bad_ref.0];
    storage.objects.lock().unwrap().get_mut(&format!("/{}", loc.0)).unwrap()[loc.1 as usize] ^= 0xff;
    assert!(fs::read(base.join("lower/bad.bin")).is_err(), "corrupt compressed chunk must cause EIO");
}
