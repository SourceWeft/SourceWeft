//! Shared helpers for the macOS real-sandbox integration tests: `macos_sandbox.rs` and the
//! `#[ignore]`d real tests in `local_execution.rs`, both `#![cfg(target_os = "macos")]`. Each
//! pulls this in with `mod common;`, so it is only ever compiled into those macOS-gated test
//! binaries.
//!
//! The Linux suite keeps its own copy of the equivalent helpers inside `linux_sandbox.rs` by
//! design — that file is deliberately left untouched — so there is no cross-platform sharing
//! here; this module is macOS-only and mirrors the Linux helper style.
//!
//! The bundle is located relative to `CARGO_MANIFEST_DIR`, at
//! `apps/desktop/sandbox-sidecar/dist/bundle` (git-ignored), built by that package's
//! `bun run build --rg "$(command -v rg)"`; no new environment variable locates it.
#![allow(dead_code)]
use serde_json::{json, Value};
use sourceweft_desktop::local_host::{
    execution::Executions, readiness::bundle_dir, LocalHost, Workspace,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// `apps/desktop/sandbox-sidecar/dist/bundle`.
pub fn built_bundle_source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sandbox-sidecar/dist/bundle")
}

/// Copies the already-built bundle into `dest` (a `<app data>/sandbox/current` directory),
/// matching the layout `readiness::bundle_dir` expects under a real app-data directory.
pub fn copy_bundle_into(dest: &Path) {
    let source = built_bundle_source();
    assert!(
        source.join("srt-sidecar").is_file(),
        "expected a built sidecar bundle at {source:?}; run `bun run build --rg \
         \"$(command -v rg)\"` in apps/desktop/sandbox-sidecar first (see the plan's \
         verification recipe)"
    );
    fs::create_dir_all(dest).unwrap();
    for entry in fs::read_dir(&source).unwrap() {
        let entry = entry.unwrap();
        let target = dest.join(entry.file_name());
        fs::copy(entry.path(), &target).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions).unwrap();
    }
}

/// srt treats an existing `/tmp/claude` as its own writable TMPDIR (the state on any machine that
/// also runs Claude Code), so creating it once makes every test run in that configuration;
/// `cannot_write_srt_tmp_claude`-style checks then prove the sidecar's write deny covers it.
/// Creating or removing it mid-command would race srt's bind, so it is created once and never
/// removed.
pub fn ensure_tmp_claude() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        fs::create_dir_all("/tmp/claude").expect("create /tmp/claude");
    });
    assert!(
        Path::new("/tmp/claude").is_dir(),
        "/tmp/claude must be a directory"
    );
}

/// A `LocalHost` over a fresh temporary app-data directory (under `$TMPDIR`, i.e.
/// `/private/var/folders/...`) with the built bundle installed at `<app data>/sandbox/current`,
/// exactly where production looks for it.
pub fn host_with_bundle() -> (tempfile::TempDir, LocalHost) {
    ensure_tmp_claude();
    let app = tempfile::tempdir().unwrap();
    copy_bundle_into(&bundle_dir(app.path()));
    let host = LocalHost::open(app.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    (app, host)
}

/// A `LocalHost` over a caller-chosen app-data directory (e.g. one under `/tmp`, to exercise the
/// `/tmp`→`/private/tmp` symlink), with the bundle installed. The caller owns `app_path` and its
/// cleanup.
pub fn host_with_bundle_at(app_path: &Path) -> LocalHost {
    ensure_tmp_claude();
    copy_bundle_into(&bundle_dir(app_path));
    let host = LocalHost::open(app_path).unwrap();
    host.initialize_invocation_journal().unwrap();
    host
}

pub fn execute(host: &LocalHost, call: &str, workspace: &Workspace, command: &str) -> Value {
    host.dispatch(
        &Executions::default(),
        call,
        "owner",
        &workspace.thread_id,
        "command.execute",
        json!({"workspaceId": workspace.id, "command": command, "timeoutMs": 60000, "maxOutputChars": 20000}),
    )
    .unwrap_or_else(|error| panic!("command.execute failed: {error}"))
}

pub fn output(result: &Value) -> &str {
    result["output"].as_str().unwrap()
}

/// Runs `command` after a positive control that must succeed inside the sandbox, and asserts the
/// control ran, so a denial test cannot pass merely because the sandbox failed to start the
/// command at all (e.g. exit 127 from a missing helper).
pub fn execute_denied(host: &LocalHost, call: &str, workspace: &Workspace, command: &str) -> Value {
    let control = workspace.path.join(".sw-control");
    let _ = fs::remove_file(&control);
    let result = execute(
        host,
        call,
        workspace,
        &format!("printf ran > .sw-control && {command}"),
    );
    assert_eq!(
        fs::read_to_string(&control).ok().as_deref(),
        Some("ran"),
        "the sandboxed command never ran: {result}"
    );
    result
}

/// Single-quotes `path` for `/bin/sh`.
pub fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

pub fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME must be set for this test"))
}

/// Removes a planted file even when an assertion fails.
pub struct RemoveOnDrop(pub PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Sets an environment variable for the lifetime of the guard and restores its previous value (or
/// removes it) on drop. The real-sandbox tests run with `--test-threads=1`, so a transient
/// process-wide variable set here never races a sibling test.
pub struct EnvVarGuard {
    key: String,
    previous: Option<String>,
}
impl EnvVarGuard {
    pub fn set(key: &str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self {
            key: key.to_string(),
            previous,
        }
    }
}
impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(&self.key, value),
            None => std::env::remove_var(&self.key),
        }
    }
}
