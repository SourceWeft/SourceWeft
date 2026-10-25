#![cfg(target_os = "macos")]
//! macOS-only checks that the sandbox bundle can be signed with the hardened runtime and
//! that the `allow-jit` entitlement is what keeps the sidecar's JavaScript engine working.
//! Requires a built `sandbox-sidecar` bundle and `codesign`, so every test is `#[ignore]`;
//! run with `cargo test --test macos_signing -- --include-ignored --test-threads=1`.
//!
//! The bundle is located relative to `CARGO_MANIFEST_DIR`
//! (`apps/desktop/sandbox-sidecar/dist/bundle`, git-ignored, produced by that package's
//! `bun run scripts/build.ts --rg <path>`); no environment variable is involved. Each test
//! signs its own copy in a temporary directory, so the built bundle is never modified.
//!
//! What "necessary" means here (measured on macOS 26 with Bun 1.4.2, not assumed): a Bun
//! `--compile` binary signed with the hardened runtime but without `allow-jit` still starts and
//! still answers requests, because JavaScriptCore falls back to its interpreter when the kernel
//! refuses the `MAP_JIT` region. It does not crash. The observable difference is the "JS JIT
//! generated code" region in `vmmap`, which exists only when the entitlement is present, so
//! that region is the assertion; the functional probe and wrapped command are asserted to pass
//! in both cases so a regression in either direction is visible.
use serde_json::{json, Value};
use sourceweft_desktop::local_host::{
    execution::Executions,
    readiness::{bundle_dir, probe_bundle, Helpers, InitConfig, Platform, SandboxReadiness},
    LocalHost,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const ALLOW_JIT: &str = "com.apple.security.cs.allow-jit";

/// `apps/desktop/sandbox-sidecar`.
fn sidecar_package() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sandbox-sidecar")
}

fn sign_script() -> PathBuf {
    sidecar_package().join("scripts/sign-macos.sh")
}

/// Copies the already-built bundle into `dest`, matching the layout `readiness::bundle_dir`
/// expects under a real app-data directory.
fn copy_bundle_into(dest: &Path) {
    let source = sidecar_package().join("dist/bundle");
    assert!(
        source.join("srt-sidecar").is_file(),
        "expected a built sidecar bundle at {source:?}; run \
         `bun run scripts/build.ts --rg <path-to-rg>` in apps/desktop/sandbox-sidecar first"
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

fn run_ok(command: &mut Command) -> std::process::Output {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{command:?} failed ({}): {}{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

/// Signs `bundle` with `scripts/sign-macos.sh` (ad-hoc, hardened runtime, `allow-jit` on the
/// sidecar only).
fn sign_with_script(bundle: &Path) -> String {
    let output = run_ok(Command::new("/bin/bash").arg(sign_script()).arg(bundle));
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Signs `bundle` ad-hoc with the hardened runtime and an entitlements file with an empty
/// dictionary: everything `sign-macos.sh` does except the `allow-jit` entitlement.
fn sign_without_allow_jit(bundle: &Path, scratch: &Path) {
    let empty = scratch.join("empty-entitlements.plist");
    fs::write(
        &empty,
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
"#,
    )
    .unwrap();
    run_ok(
        Command::new("/usr/bin/codesign")
            .args(["--force", "--options", "runtime", "--entitlements"])
            .arg(&empty)
            .args(["--sign", "-"])
            .arg(bundle.join("srt-sidecar")),
    );
    run_ok(
        Command::new("/usr/bin/codesign")
            .args(["--force", "--options", "runtime", "--sign", "-"])
            .arg(bundle.join("rg")),
    );
}

/// `codesign -d --entitlements - --xml <binary>` output (empty when there are none).
fn entitlements_xml(binary: &Path) -> String {
    let output = Command::new("/usr/bin/codesign")
        .args(["-d", "--entitlements", "-", "--xml"])
        .arg(binary)
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn code_signature_flags(binary: &Path) -> String {
    let output = run_ok(Command::new("/usr/bin/codesign").arg("-dv").arg(binary));
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn harness_init(bundle: &Path, workspace_root: &Path) -> InitConfig {
    InitConfig {
        platform: Platform::Darwin,
        home: std::env::var("HOME").unwrap_or_default(),
        workspace_roots: vec![workspace_root.to_string_lossy().into_owned()],
        read_roots: vec![],
        deny_roots: vec![],
        helpers: Helpers {
            ripgrep: bundle.join("rg").to_string_lossy().into_owned(),
            apply_seccomp: None,
            java_agent_jar: None,
        },
        bwrap_path: None,
    }
}

/// A `LocalHost` whose bundle (already copied and signed in `app/sandbox/current`) is exactly
/// where production looks for it, plus a workspace to run commands in.
fn execute_in_signed_bundle(app: &Path, command: &str) -> Value {
    let host = LocalHost::open(app).unwrap();
    host.initialize_invocation_journal().unwrap();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    host.dispatch(
        &Executions::default(),
        "signed-bundle",
        "owner",
        &workspace.thread_id,
        "command.execute",
        json!({"workspaceId": workspace.id, "command": command, "timeoutMs": 60000, "maxOutputChars": 20000}),
    )
    .unwrap_or_else(|error| panic!("command.execute failed: {error}"))
}

/// Kills and reaps the child on drop, so a panic while inspecting it never leaks a sidecar.
struct KillOnDrop(std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A region every JavaScriptCore process maps at VM startup, signed with or without `allow-jit`.
/// It is the readiness marker: once it is present the engine has initialised, so the absence of
/// the JIT region is a result and not "vmmap ran too early".
const VM_STARTED_MARKER: &str = "JS VM Gigacage";
const JIT_REGION: &str = "JS JIT generated code";

/// What `vmmap` saw in the idle sidecar once the JavaScript engine had started.
struct SidecarMemory {
    vmmap: String,
}

impl SidecarMemory {
    fn has_jit_region(&self) -> bool {
        self.vmmap.contains(JIT_REGION)
    }
}

/// Starts the idle sidecar from `bundle` and polls `vmmap` (up to 15 s) until the engine's
/// start-up marker region is mapped, then takes one more snapshot after a short settle so the
/// JIT pool, which is created in the same initialisation, has had its chance to appear. Panics
/// if the marker never shows up, so a caller can never read "no JIT region" off a process that
/// had not started yet.
fn inspect_idle_sidecar(bundle: &Path) -> SidecarMemory {
    let child = Command::new(bundle.join("srt-sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // Keep stdin open (inside the guard's child) so the idle sidecar keeps running.
    let mut sidecar = KillOnDrop(child);
    let _stdin = sidecar.0.stdin.take();
    let pid = sidecar.0.id().to_string();
    let vmmap = |pid: &str| {
        let output = Command::new("/usr/bin/vmmap").arg(pid).output().unwrap();
        String::from_utf8_lossy(&output.stdout).into_owned()
    };

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let text = vmmap(&pid);
        if text.contains("Process:") && text.contains(VM_STARTED_MARKER) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the sidecar never mapped {VM_STARTED_MARKER:?} within 15s, so its memory cannot be \
             judged; last vmmap output:\n{text}"
        );
        assert!(
            sidecar.0.try_wait().unwrap().is_none(),
            "the sidecar exited before it could be inspected; last vmmap output:\n{text}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(300));
    let text = vmmap(&pid);
    assert!(
        text.contains(VM_STARTED_MARKER),
        "the sidecar went away while being inspected:\n{text}"
    );
    SidecarMemory { vmmap: text }
}

fn assert_bundle_runs(bundle_root: &Path, label: &str) {
    // Readiness (init + probe round trip) through the signed sidecar.
    let workspace = bundle_root.join("probe-workspace");
    fs::create_dir_all(&workspace).unwrap();
    let bundle = bundle_dir(bundle_root);
    let readiness = probe_bundle(
        &bundle,
        &harness_init(&bundle, &workspace.canonicalize().unwrap()),
    );
    assert!(
        matches!(readiness, SandboxReadiness::Ready { .. }),
        "{label}: expected Ready from probe_bundle, got {readiness:?}"
    );
    // A wrapped command through the production LocalHost path.
    let result = execute_in_signed_bundle(bundle_root, "printf signed-ok");
    assert_eq!(result["exitCode"], 0, "{label}: {result}");
    assert_eq!(result["output"], "signed-ok", "{label}: {result}");
}

#[test]
#[ignore = "requires the built sandbox bundle and codesign"]
fn bundle_signed_with_allow_jit_runs_with_jit() {
    let app = tempfile::tempdir().unwrap();
    let bundle = bundle_dir(app.path());
    copy_bundle_into(&bundle);
    let script_output = sign_with_script(&bundle);
    assert!(
        script_output.contains(ALLOW_JIT),
        "sign-macos.sh must print the sidecar entitlements: {script_output}"
    );

    // Hardened runtime + ad-hoc on both binaries.
    for binary in ["srt-sidecar", "rg"] {
        let flags = code_signature_flags(&bundle.join(binary));
        assert!(
            flags.contains("flags=0x10002(adhoc,runtime)"),
            "{binary} must be ad-hoc signed with the hardened runtime: {flags}"
        );
        run_ok(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--strict"])
                .arg(bundle.join(binary)),
        );
    }

    // The sidecar carries allow-jit and nothing else; rg carries no entitlements at all.
    let entitlements = entitlements_xml(&bundle.join("srt-sidecar"));
    assert!(entitlements.contains(ALLOW_JIT), "{entitlements}");
    assert_eq!(
        entitlements.matches("<key>").count(),
        1,
        "the sidecar must carry exactly one entitlement: {entitlements}"
    );
    assert!(entitlements.contains("<true/>"), "{entitlements}");
    let rg_entitlements = entitlements_xml(&bundle.join("rg"));
    assert!(
        !rg_entitlements.contains("<key>"),
        "rg must be signed without entitlements: {rg_entitlements}"
    );

    // The jar is data and stays unsigned.
    assert!(bundle.join("srt-proxy-agent.jar").is_file());

    // rg keeps working under the hardened runtime.
    let rg = run_ok(Command::new(bundle.join("rg")).arg("--version"));
    assert!(String::from_utf8_lossy(&rg.stdout).starts_with("ripgrep "));

    // The signed sidecar passes readiness and runs a wrapped command, and maps a JIT region.
    assert_bundle_runs(app.path(), "allow-jit");
    let memory = inspect_idle_sidecar(&bundle);
    assert!(
        memory.has_jit_region(),
        "the allow-jit sidecar must map a JS JIT region:\n{}",
        memory.vmmap
    );
}

#[test]
#[ignore = "requires the built sandbox bundle and codesign"]
fn bundle_signed_without_allow_jit_loses_jit() {
    let app = tempfile::tempdir().unwrap();
    let bundle = bundle_dir(app.path());
    copy_bundle_into(&bundle);
    let scratch = tempfile::tempdir().unwrap();
    sign_without_allow_jit(&bundle, scratch.path());

    // Same hardened-runtime signature, but with an empty entitlements dictionary.
    let flags = code_signature_flags(&bundle.join("srt-sidecar"));
    assert!(
        flags.contains("flags=0x10002(adhoc,runtime)"),
        "the control copy must differ from the good one only in entitlements: {flags}"
    );
    assert!(
        !entitlements_xml(&bundle.join("srt-sidecar")).contains(ALLOW_JIT),
        "the control copy must not carry allow-jit"
    );

    // It is not a test artifact: the copy is a validly signed, runnable sidecar...
    run_ok(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(bundle.join("srt-sidecar")),
    );
    assert_bundle_runs(app.path(), "no allow-jit");

    // ...but the kernel refuses its executable-memory region, so JavaScriptCore runs without
    // its JIT.
    let memory = inspect_idle_sidecar(&bundle);
    assert!(
        memory.vmmap.contains(VM_STARTED_MARKER),
        "the engine start-up marker must be present for the absence below to mean anything"
    );
    assert!(
        !memory.has_jit_region(),
        "without allow-jit the sidecar must not map a JS JIT region:\n{}",
        memory.vmmap
    );
}
