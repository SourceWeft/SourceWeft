#![cfg(target_os = "macos")]
//! Run explicitly on an unrestricted macOS test host:
//! cargo test --test macos_sandbox -- --ignored
//! The outer Codex sandbox cannot call sandbox_apply; do not skip or silently
//! replace this test with unconfined command execution.
use sourceweft_desktop::local_host::sandbox::{isolation_probe_profile, probe_seatbelt};
use std::{fs, process::Command};

fn run(profile: &str, command: &str, args: &[&str]) -> std::process::Output {
    Command::new("/usr/bin/sandbox-exec")
        .args(["-p", profile, command])
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap()
}

#[test]
#[ignore = "requires sandbox_apply on a real macOS host"]
fn seatbelt_enforces_filesystem_network_and_child_process_boundaries() {
    let working = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    probe_seatbelt(working.path()).unwrap();
    let policy = isolation_probe_profile(working.path()).unwrap();
    let allowed = working.path().join("output.txt");
    let denied = outside.path().join("secret.txt");
    fs::write(&denied, "private-data").unwrap();
    let output = run(
        &policy,
        "/bin/sh",
        &[
            "-c",
            "printf success > \"$1\"",
            "sh",
            allowed.to_str().unwrap(),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::read_to_string(&allowed).unwrap(), "success");
    let read = run(&policy, "/bin/cat", &[denied.to_str().unwrap()]);
    assert!(!read.status.success());
    assert!(!String::from_utf8_lossy(&read.stdout).contains("private-data"));
    let write = run(
        &policy,
        "/bin/sh",
        &[
            "-c",
            "printf overwritten > \"$1\"",
            "sh",
            denied.to_str().unwrap(),
        ],
    );
    assert!(!write.status.success());
    assert_eq!(fs::read_to_string(&denied).unwrap(), "private-data");
    let child = run(
        &policy,
        "/bin/sh",
        &["-c", "/bin/cat \"$1\"", "sh", denied.to_str().unwrap()],
    );
    assert!(!child.status.success());
    std::os::unix::fs::symlink(&denied, working.path().join("escape")).unwrap();
    assert!(!run(
        &policy,
        "/bin/cat",
        &[working.path().join("escape").to_str().unwrap()]
    )
    .status
    .success());

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let control = Command::new("/usr/bin/nc")
        .args(["-z", "-w", "1", "127.0.0.1", &port])
        .status()
        .unwrap();
    assert!(
        control.success(),
        "Network control must prove the endpoint is available"
    );
    let network = run(
        &policy,
        "/usr/bin/nc",
        &["-z", "-w", "1", "127.0.0.1", &port],
    );
    assert!(
        !network.status.success(),
        "Block-all probe unexpectedly reached localhost"
    );
}

#[test]
fn profile_cannot_be_injected_through_a_workspace_name() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("quoted\"(allow network*)");
    fs::create_dir(&path).unwrap();
    let profile = isolation_probe_profile(&path).unwrap();
    assert!(profile.contains("quoted\\\"(allow network*)"));
}
