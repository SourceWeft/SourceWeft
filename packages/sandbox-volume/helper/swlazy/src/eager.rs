//! Baseline: download every pack and write every file before anything can run.
use crate::hydrate;
use crate::plan::Plan;
use crate::store::Store;
use anyhow::Result;
use std::ffi::CString;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

pub fn restore(plan: &Plan, store: &Arc<Store>, root: &Path, jobs: usize) -> Result<(u64, u64)> {
    // The tree first (as placeholders), then the bytes, pack by pack, in parallel.
    let made = hydrate::materialize(plan, root)?;
    let mut files: Vec<(u64, u64, String)> = plan.entries.iter().filter(|e| e.k == "f" && e.s > 0).map(|e| (e.o, e.s, e.p.clone())).collect();
    files.sort();
    let files = Arc::new(files);
    let npacks = ((plan.total + plan.pack_size - 1) / plan.pack_size) as usize;
    let next = Arc::new(AtomicUsize::new(0));
    let mut hs = Vec::new();
    for _ in 0..jobs {
        let (store, files, next, root) = (store.clone(), files.clone(), next.clone(), root.to_path_buf());
        let (psz, total) = (plan.pack_size, plan.total);
        hs.push(std::thread::spawn(move || -> Result<u64> {
            let mut bytes = 0u64;
            loop {
                let p = next.fetch_add(1, Ordering::SeqCst);
                if p >= npacks {
                    return Ok(bytes);
                }
                let data = store.fetch_pack(p)?;
                let (lo, hi) = (p as u64 * psz, (p as u64 * psz + psz).min(total));
                let mut i = files.partition_point(|f| f.0 + f.1 <= lo);
                while i < files.len() && files[i].0 < hi {
                    let (o, s, ref path) = files[i];
                    let (a, b) = (o.max(lo), (o + s).min(hi));
                    let full = root.join(path);
                    let f = match std::fs::OpenOptions::new().write(true).open(&full) {
                        Ok(f) => f,
                        Err(_) => {
                            // read-only file: lend the write bit for the duration of the write
                            let c = CString::new(full.to_string_lossy().as_bytes())?;
                            let mut st: libc::stat = unsafe { std::mem::zeroed() };
                            unsafe {
                                libc::stat(c.as_ptr(), &mut st);
                                libc::chmod(c.as_ptr(), st.st_mode | 0o200);
                            }
                            let f = std::fs::OpenOptions::new().write(true).open(&full)?;
                            unsafe { libc::chmod(c.as_ptr(), st.st_mode & 0o7777) };
                            f
                        }
                    };
                    f.write_all_at(&data[(a - lo) as usize..(b - lo) as usize], a - o)?;
                    bytes += b - a;
                    i += 1;
                }
            }
        }));
    }
    let mut bytes = 0;
    for h in hs {
        bytes += h.join().unwrap()?;
    }
    // Drop the placeholder markers and put the mtimes back.
    let name = hydrate::XATTR.as_ptr() as *const libc::c_char;
    for e in plan.entries.iter().filter(|e| e.k == "f") {
        let c = CString::new(root.join(&e.p).to_string_lossy().as_bytes())?;
        let ts = [
            libc::timespec { tv_sec: 0, tv_nsec: libc::UTIME_OMIT },
            libc::timespec { tv_sec: e.t.div_euclid(1_000_000_000) as libc::time_t, tv_nsec: e.t.rem_euclid(1_000_000_000) as _ },
        ];
        unsafe {
            if e.s > 0 {
                libc::removexattr(c.as_ptr(), name);
            }
            libc::utimensat(libc::AT_FDCWD, c.as_ptr(), ts.as_ptr(), 0);
        }
    }
    Ok((made.files, bytes))
}
