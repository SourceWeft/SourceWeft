//! Explicit, root-owned cgroup-v2 workload boundary. Never freezes the parent or controller.
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    boot_id: String,
    owner_nonce: String,
    parent: PathBuf,
    tree: PathBuf,
}

pub struct Freezer {
    tree: PathBuf,
}

fn protected(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        !metadata.file_type().is_symlink() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
        "cgroup controls must be root-owned and not writable by workloads"
    );
    Ok(())
}
fn write_control(path: &Path, value: &str) -> Result<()> {
    protected(path)?;
    OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?
        .write_all(value.as_bytes())?;
    Ok(())
}
fn event(tree: &Path, key: &str) -> Result<bool> {
    let data = fs::read_to_string(tree.join("cgroup.events"))?;
    match data.lines().find_map(|line| {
        line.split_once(' ')
            .filter(|(name, _)| *name == key)
            .map(|(_, value)| value)
    }) {
        Some("1") => Ok(true),
        Some("0") => Ok(false),
        _ => bail!("missing or invalid cgroup event {key}"),
    }
}
fn empty(tree: &Path) -> Result<()> {
    ensure!(
        !event(tree, "populated")?,
        "owned cgroup still contains live processes; retain it for recovery"
    );
    Ok(())
}
fn reclaim(tree: &Path) -> Result<()> {
    if !tree.exists() {
        return Ok(());
    }
    protected(tree)?;
    empty(tree)?;
    for entry in fs::read_dir(tree)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let name = entry.file_name();
            let name = name.to_str().context("invalid cgroup leaf name")?;
            ensure!(
                name.strip_prefix("exec-").is_some_and(super::token),
                "unexpected cgroup descendant; refuse cleanup"
            );
            protected(&entry.path())?;
            empty(&entry.path())?;
            ensure!(
                !fs::read_dir(entry.path())?.any(|child| child
                    .is_ok_and(|child| child.file_type().is_ok_and(|kind| kind.is_dir()))),
                "unexpected nested cgroup; refuse cleanup"
            );
            fs::remove_dir(entry.path())?;
        }
    }
    fs::remove_dir(tree)?;
    Ok(())
}
impl Freezer {
    pub fn setup(state: &Path, parent: &Path, boot_id: &str, nonce: &str) -> Result<Self> {
        ensure!(
            parent.is_absolute() && parent.canonicalize()? == parent,
            "cgroup parent must be canonical and absolute"
        );
        protected(parent)?;
        let name = std::ffi::CString::new(parent.as_os_str().as_bytes())?;
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        ensure!(
            unsafe { libc::statfs(name.as_ptr(), &mut stat) } == 0,
            "cannot inspect cgroup filesystem"
        );
        ensure!(
            stat.f_type == 0x63677270,
            "explicit freezer parent is not cgroup v2"
        );
        let own_pid = std::process::id().to_string();
        ensure!(
            fs::read_to_string(parent.join("cgroup.procs"))?
                .split_whitespace()
                .any(|pid| pid == own_pid),
            "explicit cgroup parent does not contain this controller"
        );
        protected(&parent.join("cgroup.procs"))?;
        let journal_path = state.join("cgroup.json");
        if journal_path.exists() {
            let previous: Journal = serde_json::from_slice(&fs::read(&journal_path)?)?;
            ensure!(
                previous.parent == parent
                    && super::token(&previous.owner_nonce)
                    && previous.tree == parent.join(format!("swvol-{}", previous.owner_nonce)),
                "cgroup recovery journal does not match this delegation"
            );
            if previous.boot_id == boot_id {
                reclaim(&previous.tree)?;
            } else {
                ensure!(
                    !previous.tree.exists(),
                    "previous-boot cgroup path unexpectedly exists"
                );
            }
        }
        ensure!(super::token(nonce), "invalid cgroup owner identity");
        let tree = parent.join(format!("swvol-{nonce}"));
        ensure!(!tree.exists(), "new controller cgroup already exists");
        // Persist ownership intent before creation, so a crash cannot leave an
        // untracked subtree. No user work is launched until setup succeeds.
        super::atomic_json(
            &journal_path,
            &Journal {
                boot_id: boot_id.into(),
                owner_nonce: nonce.into(),
                parent: parent.into(),
                tree: tree.clone(),
            },
        )?;
        fs::create_dir(&tree)?;
        protected(&tree)?;
        for control in ["cgroup.procs", "cgroup.threads", "cgroup.freeze"] {
            protected(&tree.join(control))?;
        }
        let result = Self { tree };
        result.freeze()?;
        result.thaw()?;
        Ok(result)
    }
    pub fn leaf(&self, execution_id: &str) -> Result<PathBuf> {
        ensure!(super::token(execution_id), "invalid cgroup execution id");
        let leaf = self.tree.join(format!("exec-{execution_id}"));
        fs::create_dir(&leaf)?;
        protected(&leaf)?;
        for name in ["cgroup.procs", "cgroup.threads", "cgroup.freeze"] {
            protected(&leaf.join(name))?;
        }
        Ok(leaf)
    }
    pub fn reap(&self, execution_id: &str) -> Result<()> {
        ensure!(super::token(execution_id), "invalid cgroup execution id");
        let leaf = self.tree.join(format!("exec-{execution_id}"));
        if leaf.exists() {
            protected(&leaf)?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while event(&leaf, "populated")? {
                ensure!(
                    Instant::now() < deadline,
                    "owned workload cgroup did not become empty; retain for recovery"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            fs::remove_dir(&leaf)?;
        }
        Ok(())
    }
    fn change(&self, frozen: bool) -> Result<()> {
        protected(&self.tree)?;
        let own_pid = std::process::id().to_string();
        let mut groups = vec![self.tree.clone()];
        for entry in fs::read_dir(&self.tree)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                groups.push(entry.path());
            }
        }
        for group in groups {
            ensure!(
                !fs::read_to_string(group.join("cgroup.procs"))?
                    .split_whitespace()
                    .any(|pid| pid == own_pid),
                "controller must remain outside the frozen subtree"
            );
        }
        write_control(
            &self.tree.join("cgroup.freeze"),
            if frozen { "1" } else { "0" },
        )?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if event(&self.tree, "frozen")? == frozen {
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "kernel freezer acknowledgement timed out; admission remains closed"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub fn freeze(&self) -> Result<()> {
        self.change(true)
    }
    pub fn thaw(&self) -> Result<()> {
        self.change(false)
    }
}
