mod eager;
mod fuse;
mod fuser_time;
mod hydrate;
mod notify;
mod plan;
mod store;
mod volume;
mod workers;

use anyhow::{bail, Result};
use std::ffi::CString;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}
fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}
fn sock_default() -> String {
    std::env::var("SWLAZY_SOCK").unwrap_or_else(|_| "/tmp/swlazy.sock".into())
}

fn open_store(plan: &plan::Plan, cache: &str, args: &[String]) -> Result<Arc<store::Store>> {
    let cap: u64 = opt(args, "--cap-mb").and_then(|v| v.parse().ok()).unwrap_or(512);
    store::Store::new(plan.packs.clone(), plan.pack_size, plan.total, cache, cap << 20)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");
    match cmd {
        "version" => println!("swlazy {}", env!("CARGO_PKG_VERSION")),
        "chunk-worker" => {
            let fd = opt(&args, "--fd").ok_or_else(|| anyhow::anyhow!("inherited worker socket required"))?.parse()?;
            workers::serve(fd)?;
        }
        // Explicit formal protocol; never auto-detect or fall back to experiment data.
        "mount-volume" => {
            if args.len() < 5 { bail!("usage: swlazy mount-volume <plan> <cache-dir> <mountpoint> [--cap-mb N]"); }
            let plan: swvol_core::RestorePlan = serde_json::from_slice(&std::fs::read(&args[2])?)?;
            plan.validate()?;
            fuse::validate_mtimes(plan.entries.iter().map(|entry| entry.t))?;
            let cap: usize = opt(&args, "--cap-mb").map(|v| v.parse()).transpose()?.unwrap_or(64);
            let cap = cap.checked_mul(1024 * 1024).ok_or_else(|| anyhow::anyhow!("cache capacity overflow"))?;
            let initial_fd = if let Some(raw) = opt(&args, "--initial-fuse-fd") {
                use std::os::fd::{FromRawFd, AsRawFd};
                use std::os::unix::fs::{FileTypeExt, MetadataExt};
                let fd: i32 = raw.parse()?;
                if fd < 3 { bail!("initial FUSE descriptor must be a private inherited descriptor"); }
                let owned = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
                let metadata = std::fs::File::from(owned.try_clone()?).metadata()?;
                let device = std::fs::metadata("/dev/fuse")?;
                if !metadata.file_type().is_char_device() || metadata.rdev() != device.rdev() { bail!("initial descriptor is not the FUSE device"); }
                if unsafe { libc::fcntl(owned.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 { return Err(std::io::Error::last_os_error().into()); }
                Some(owned)
            } else { None };
            let store = volume::VolumeStore::new(&plan, Path::new(&args[3]), cap)?;
            if let Some(directory) = opt(&args, "--state-dir") { store.start_control_view(Path::new(&directory))?; }
            fuse::mount_volume(&plan, store, &args[4], flag(&args, "--allow-other"), initial_fd)?;
        }
        // swlazy mount <plan> <cache-dir> <mountpoint> [--allow-other] [--cap-mb N]
        "mount" => {
            let t = Instant::now();
            let plan = plan::Plan::load(&args[2])?;
            fuse::validate_mtimes(plan.entries.iter().map(|entry| entry.t))?;
            let store = if plan.packs.is_empty() { None } else { Some(open_store(&plan, &args[3], &args)?) };
            eprintln!("plan loaded: {} entries in {} ms", plan.entries.len(), t.elapsed().as_millis());
            if let Err(e) = fuse::mount(&plan, store, &args[4], flag(&args, "--allow-other")) {
                eprintln!("mount failed: {} (os error {:?})", e, e.raw_os_error());
                std::process::exit(1);
            }
        }
        // swlazy materialize <plan> <root>
        "materialize" => {
            let t = Instant::now();
            let plan = plan::Plan::load(&args[2])?;
            let t1 = t.elapsed();
            let m = hydrate::materialize(&plan, Path::new(&args[3]))?;
            println!(
                "{{\"plan_ms\":{},\"materialize_ms\":{},\"dirs\":{},\"files\":{},\"links\":{},\"placeholders\":{},\"skipped\":{}}}",
                t1.as_millis(), (t.elapsed() - t1).as_millis(), m.dirs, m.files, m.links, m.placeholders, m.skipped
            );
        }
        // swlazy daemon <plan> <root> <cache-dir> [--sock path] [--cap-mb N] [--no-materialize]
        "daemon" => {
            let t = Instant::now();
            let plan = plan::Plan::load(&args[2])?;
            let t1 = t.elapsed();
            if !flag(&args, "--no-materialize") {
                let m = hydrate::materialize(&plan, Path::new(&args[3]))?;
                eprintln!("materialized: plan_ms={} tree_ms={} dirs={} files={} placeholders={} skipped={}", t1.as_millis(), (t.elapsed() - t1).as_millis(), m.dirs, m.files, m.placeholders, m.skipped);
            }
            let store = open_store(&plan, &args[4], &args)?;
            let skip: Vec<Vec<u8>> = ["/usr/", "/lib/", "/lib64/", "/bin/", "/sbin/", "/etc/", "/proc/", "/sys/", "/dev/"].iter().map(|s| s.as_bytes().to_vec()).collect();
            let skip = if std::env::var("SWLAZY_NO_SKIP").is_ok() { vec![b"/proc/".to_vec(), b"/dev/".to_vec()] } else { skip };
            let d = Arc::new(notify::Daemon {
                store,
                c: Default::default(),
                skip,
                trust_root: std::env::var("SWLAZY_TRUST_ROOT").is_ok(),
                filled: Default::default(),
                root: CString::new(args[3].as_str())?,
                reserve: opt(&args, "--reserve-mb").and_then(|v| v.parse::<u64>().ok()).unwrap_or(300) << 20,
                evicted: Default::default(),
                evicted_bytes: Default::default(),
            });
            d.serve(&opt(&args, "--sock").unwrap_or_else(sock_default))?;
        }
        // swlazy run [--sock path] -- cmd args...
        "run" => {
            let i = args.iter().position(|a| a == "--").unwrap_or(1);
            notify::run(&opt(&args[..i], "--sock").unwrap_or_else(sock_default), &args[i + 1..])?;
        }
        "stats" => println!("{}", notify::client_stats(&opt(&args, "--sock").unwrap_or_else(sock_default))?),
        // swlazy eager <plan> <root> <cache-dir> [--jobs N]
        "eager" => {
            let t = Instant::now();
            let plan = plan::Plan::load(&args[2])?;
            let store = open_store(&plan, &args[4], &args)?;
            let jobs: usize = opt(&args, "--jobs").and_then(|v| v.parse().ok()).unwrap_or(4);
            let (files, bytes) = eager::restore(&plan, &store, Path::new(&args[3]), jobs)?;
            println!("{{\"eager_ms\":{},\"files\":{},\"bytes\":{}}}", t.elapsed().as_millis(), files, bytes);
        }
        // swlazy evict <plan> <root>: turn unmodified, unopened files back into placeholders
        "evict" => {
            let plan = plan::Plan::load(&args[2])?;
            let (mut done, mut kept, mut bytes) = (0u64, 0u64, 0u64);
            let t = Instant::now();
            for e in plan.entries.iter().filter(|e| e.k == "f" && e.s > 0) {
                let c = CString::new(Path::new(&args[3]).join(&e.p).to_string_lossy().as_bytes())?;
                if hydrate::placeholder(&c).is_some() {
                    continue;
                }
                if hydrate::dehydrate(&c, e.o, e.s, e.t)? {
                    done += 1;
                    bytes += e.s;
                } else {
                    kept += 1;
                }
            }
            println!("{{\"evict_ms\":{},\"dehydrated\":{},\"bytes\":{},\"kept\":{}}}", t.elapsed().as_millis(), done, bytes, kept);
        }
        // swlazy bench-open <n> <path>...: open+close each path n times, raw syscalls, no libc caching
        "bench-open" | "bench-stat" => {
            let n: u64 = args[2].parse()?;
            let paths: Vec<CString> = args[3..].iter().map(|p| CString::new(p.as_str()).unwrap()).collect();
            let t = Instant::now();
            let mut bad = 0u64;
            for _ in 0..n {
                for p in &paths {
                    if cmd == "bench-open" {
                        let fd = unsafe { libc::open(p.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
                        if fd < 0 { bad += 1 } else { unsafe { libc::close(fd) }; }
                    } else {
                        let mut st: libc::stat = unsafe { std::mem::zeroed() };
                        if unsafe { libc::stat(p.as_ptr(), &mut st) } != 0 { bad += 1 }
                    }
                }
            }
            let ops = n * paths.len() as u64;
            println!("{{\"op\":\"{}\",\"ops\":{},\"ns_per_op\":{},\"errors\":{}}}", cmd, ops, t.elapsed().as_nanos() as u64 / ops.max(1), bad);
        }
        _ => bail!("usage: swlazy mount|materialize|daemon|run|stats|eager|evict|bench-open|bench-stat ..."),
    }
    Ok(())
}
