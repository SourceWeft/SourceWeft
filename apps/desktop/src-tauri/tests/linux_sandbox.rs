#![cfg(target_os = "linux")]
//! Linux-only sandbox readiness checks against a real sandbox bundle and `bwrap`. Requires
//! bubblewrap and a built `sandbox-sidecar` bundle, so every test here is `#[ignore]`; run with
//! `cargo test --test linux_sandbox -- --ignored` on a Linux host (see the Docker recipe in
//! `.superpowers/sdd/2026-10-24-local-sandbox-cross-platform/task-7-report.md`).
//!
//! `LocalHost::open` does not yet support Linux (a later task wires that up), so these tests
//! cannot go through `LocalHost::sandbox_readiness`. They drive `readiness::probe_bundle`
//! directly instead, which is exactly what that method itself calls on Linux.
//!
//! No new environment variables may be added to the product, and that restriction extends to
//! how this test locates its fixtures: the bundle is located relative to
//! `CARGO_MANIFEST_DIR`, at `apps/desktop/sandbox-sidecar/dist/bundle` (git-ignored). The
//! verification recipe copies a container-built bundle there before running `cargo test`.
use sourceweft_desktop::local_host::readiness::{
    bundle_dir, probe_bundle, Helpers, InitConfig, Platform, SandboxReadiness,
};
use std::{fs, path::PathBuf};

/// `apps/desktop/sandbox-sidecar/dist/bundle`, built by that package's
/// `bun run build --rg "$(command -v rg)"`.
fn built_bundle_source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sandbox-sidecar/dist/bundle")
}

/// Copies the already-built bundle into `<temp>/sandbox/current`, matching the layout
/// `readiness::bundle_dir` expects under a real app-data directory.
fn copy_bundle_into(dest: &std::path::Path) {
    let source = built_bundle_source();
    assert!(
        source.join("srt-sidecar").is_file(),
        "expected a built sidecar bundle at {source:?}; run \
         `bun run build --rg \"$(command -v rg)\"` in apps/desktop/sandbox-sidecar first \
         (see the Docker recipe in the task-7 report)"
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

fn harness_init(bwrap_path: &str, workspace_root: &std::path::Path) -> InitConfig {
    InitConfig {
        platform: Platform::Linux,
        home: std::env::var("HOME").unwrap_or_default(),
        workspace_roots: vec![workspace_root.to_string_lossy().into_owned()],
        read_roots: vec![],
        helpers: Helpers {
            ripgrep: "/usr/bin/rg".to_string(),
            apply_seccomp: None,
            java_agent_jar: None,
        },
        bwrap_path: Some(bwrap_path.to_string()),
    }
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn readiness_needs_setup_without_profile() {
    // On a real Ubuntu 24.04 kernel with kernel.apparmor_restrict_unprivileged_userns=1 (CI,
    // Task 9), bwrap at /usr/bin/bwrap has no AppArmor profile scoped to it, and the sandboxed
    // child's own network-namespace setup fails with RTM_NEWADDR. That failure is the whole
    // point of pinning bwrap to /opt/sourceweft/libexec/bwrap with a scoped profile instead of
    // ever loosening /usr/bin/bwrap or the sysctl; this test proves the unscoped path really
    // does fail closed rather than silently running unsandboxed.
    let temp = tempfile::tempdir().unwrap();
    let bundle = bundle_dir(temp.path());
    copy_bundle_into(&bundle);
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();

    let readiness = probe_bundle(&bundle, &harness_init("/usr/bin/bwrap", &workspace));
    match readiness {
        SandboxReadiness::NeedsSetup { reason } => {
            assert!(
                reason.contains("RTM_NEWADDR"),
                "expected the AppArmor-restricted-userns failure to surface RTM_NEWADDR, got: \
                 {reason}"
            );
        }
        other => panic!(
            "expected NeedsSetup on a kernel with kernel.apparmor_restrict_unprivileged_userns=1, \
             got {other:?}"
        ),
    }
}

#[test]
#[ignore = "requires bubblewrap and the sandbox bundle"]
fn readiness_ready_with_working_bwrap() {
    // Local-only counterpart to the test above: this Mac's Docker Desktop Linux container has
    // no AppArmor, so /usr/bin/bwrap is unrestricted here and the same harness should report
    // Ready. The RTM_NEWADDR/NeedsSetup assertion above is proven only on a real Ubuntu 24.04
    // kernel in Task 9 CI, not in this container.
    let temp = tempfile::tempdir().unwrap();
    let bundle = bundle_dir(temp.path());
    copy_bundle_into(&bundle);
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();

    let readiness = probe_bundle(&bundle, &harness_init("/usr/bin/bwrap", &workspace));
    assert!(
        matches!(readiness, SandboxReadiness::Ready { .. }),
        "expected Ready against a working /usr/bin/bwrap in this unrestricted container, got \
         {readiness:?}"
    );
}
