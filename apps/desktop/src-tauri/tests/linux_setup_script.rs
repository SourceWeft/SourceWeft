//! Runs `resources/linux/sourceweft-sandbox-setup.sh` against a fake root directory with
//! `--root` (the script's test-only switch), so it is exercised on every platform including
//! macOS. The real thing (root, the system `/usr/bin/bwrap`, the kernel's AppArmor) is proven by
//! CI's `linux-sandbox` and `deb-install` jobs, which run this same script for real.
#![cfg(unix)]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const SCRIPT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/linux/sourceweft-sandbox-setup.sh"
);
const PROFILE: &str = "profile sourceweft-bwrap /opt/sourceweft/libexec/bwrap flags=(unconfined) {\n  userns,\n}\n";
const FAKE_BWRAP: &str = "#!/bin/sh\necho fake bwrap\n";

struct FakeRoot {
    dir: tempfile::TempDir,
}

impl FakeRoot {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
        }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.dir.path().join(relative)
    }

    fn write(&self, relative: &str, content: &str, mode: u32) -> PathBuf {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn with_system_bwrap(self) -> Self {
        self.write("usr/bin/bwrap", FAKE_BWRAP, 0o755);
        self
    }

    /// A fake `apparmor_parser` that appends its arguments to `<root>/parser.log`.
    fn with_apparmor(self) -> Self {
        self.write(
            "sbin/apparmor_parser",
            &format!(
                "#!/bin/sh\necho \"$@\" >> \"{}\"\n",
                self.path("parser.log").display()
            ),
            0o755,
        );
        fs::create_dir_all(self.path("etc/apparmor.d")).unwrap();
        self
    }

    fn run(&self, action: &str) -> Output {
        Command::new("/bin/sh")
            .arg(SCRIPT)
            .arg("--root")
            .arg(self.dir.path())
            .arg(action)
            .output()
            .unwrap()
    }

    fn parser_log(&self) -> String {
        fs::read_to_string(self.path("parser.log")).unwrap_or_default()
    }

    fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.path(relative)).unwrap()
    }

    fn mode(&self, relative: &str) -> u32 {
        fs::metadata(self.path(relative)).unwrap().permissions().mode() & 0o7777
    }

    fn listing(&self, relative: &str) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.path(relative))
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn assert_ok(output: &Output) {
    assert!(output.status.success(), "script failed: {}", stderr(output));
}

#[test]
fn install_copies_bwrap_and_writes_and_loads_the_scoped_profile() {
    let root = FakeRoot::new().with_system_bwrap().with_apparmor();
    assert_ok(&root.run("install"));

    assert_eq!(root.read("opt/sourceweft/libexec/bwrap"), FAKE_BWRAP);
    assert_eq!(root.mode("opt/sourceweft/libexec/bwrap"), 0o755);
    assert_eq!(root.read("etc/apparmor.d/sourceweft-bwrap"), PROFILE);
    assert_eq!(root.mode("etc/apparmor.d/sourceweft-bwrap"), 0o644);
    let profile = root.path("etc/apparmor.d/sourceweft-bwrap");
    assert_eq!(root.parser_log(), format!("-r {}\n", profile.display()));
    // No temporary files left behind.
    assert_eq!(root.listing("opt/sourceweft/libexec"), ["bwrap"]);
    assert_eq!(root.listing("etc/apparmor.d"), ["sourceweft-bwrap"]);
    // The system bubblewrap is untouched.
    assert_eq!(root.read("usr/bin/bwrap"), FAKE_BWRAP);
}

#[test]
fn install_is_idempotent_and_refreshes_the_copy() {
    let root = FakeRoot::new().with_system_bwrap().with_apparmor();
    assert_ok(&root.run("install"));
    root.write("usr/bin/bwrap", "#!/bin/sh\necho newer bwrap\n", 0o755);
    assert_ok(&root.run("install"));

    assert_eq!(
        root.read("opt/sourceweft/libexec/bwrap"),
        "#!/bin/sh\necho newer bwrap\n"
    );
    assert_eq!(root.read("etc/apparmor.d/sourceweft-bwrap"), PROFILE);
    assert_eq!(root.listing("opt/sourceweft/libexec"), ["bwrap"]);
    assert_eq!(root.parser_log().lines().count(), 2);
}

#[test]
fn install_without_the_system_bubblewrap_names_the_package_and_changes_nothing() {
    let root = FakeRoot::new().with_apparmor();
    let output = root.run("install");
    assert_eq!(output.status.code(), Some(1));
    let message = stderr(&output);
    assert!(message.contains("bubblewrap"), "{message}");
    assert!(message.contains("/usr/bin/bwrap"), "{message}");
    assert!(!root.path("opt").exists());
    assert!(!root.path("etc/apparmor.d/sourceweft-bwrap").exists());
    assert_eq!(root.parser_log(), "");
}

#[test]
fn install_without_apparmor_installs_bwrap_and_writes_no_profile() {
    let root = FakeRoot::new().with_system_bwrap();
    let output = root.run("install");
    assert_ok(&output);
    assert_eq!(root.read("opt/sourceweft/libexec/bwrap"), FAKE_BWRAP);
    assert!(!root.path("etc").exists());
    assert!(stderr(&output).contains("AppArmor was not found"));
}

#[test]
fn install_with_an_apparmor_directory_but_no_parser_writes_the_profile_only() {
    let root = FakeRoot::new().with_system_bwrap();
    fs::create_dir_all(root.path("etc/apparmor.d")).unwrap();
    assert_ok(&root.run("install"));
    assert_eq!(root.read("etc/apparmor.d/sourceweft-bwrap"), PROFILE);
    assert_eq!(root.parser_log(), "");
}

#[test]
fn a_failing_profile_load_fails_the_install() {
    let root = FakeRoot::new().with_system_bwrap().with_apparmor();
    root.write("sbin/apparmor_parser", "#!/bin/sh\necho cannot load >&2\nexit 7\n", 0o755);
    let output = root.run("install");
    assert!(!output.status.success());
    assert!(stderr(&output).contains("cannot load"));
}

#[test]
fn uninstall_unloads_and_removes_exactly_what_install_created() {
    let root = FakeRoot::new().with_system_bwrap().with_apparmor();
    assert_ok(&root.run("install"));
    // A neighbour that is not ours stays.
    root.write("etc/apparmor.d/other-profile", "other\n", 0o644);
    let profile = root.path("etc/apparmor.d/sourceweft-bwrap");

    assert_ok(&root.run("uninstall"));
    assert!(!root.path("opt/sourceweft").exists());
    assert_eq!(root.listing("etc/apparmor.d"), ["other-profile"]);
    assert_eq!(
        root.parser_log(),
        format!(
            "-r {profile}\n-R {profile}\n",
            profile = profile.display()
        )
    );
    assert_eq!(root.read("usr/bin/bwrap"), FAKE_BWRAP);
}

#[test]
fn uninstall_keeps_the_shipped_script_directory_and_is_idempotent() {
    let root = FakeRoot::new().with_system_bwrap().with_apparmor();
    assert_ok(&root.run("install"));
    root.write("opt/sourceweft/libexec/sourceweft-sandbox-setup", "#!/bin/sh\n", 0o755);
    assert_ok(&root.run("uninstall"));
    assert_eq!(root.listing("opt/sourceweft/libexec"), ["sourceweft-sandbox-setup"]);
    // Nothing left to remove: still success.
    assert_ok(&root.run("uninstall"));
}

#[test]
fn uninstall_with_nothing_installed_succeeds() {
    let root = FakeRoot::new();
    assert_ok(&root.run("uninstall"));
    assert_eq!(root.parser_log(), "");
}

#[test]
fn uninstall_removes_the_files_even_when_the_profile_was_not_loaded() {
    let root = FakeRoot::new().with_system_bwrap().with_apparmor();
    assert_ok(&root.run("install"));
    root.write("sbin/apparmor_parser", "#!/bin/sh\necho not loaded >&2\nexit 1\n", 0o755);
    let output = root.run("uninstall");
    assert_ok(&output);
    assert!(stderr(&output).contains("could not unload"));
    assert!(!root.path("etc/apparmor.d/sourceweft-bwrap").exists());
    assert!(!root.path("opt/sourceweft/libexec/bwrap").exists());
}

#[test]
fn bad_usage_exits_with_status_2() {
    for args in [
        vec![],
        vec!["frobnicate"],
        vec!["install", "extra"],
        vec!["--root"],
    ] {
        let output = Command::new("/bin/sh")
            .arg(SCRIPT)
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}: {}", stderr(&output));
    }
}

#[test]
fn without_root_and_without_the_test_switch_it_refuses() {
    // Skipped when the test suite itself runs as root (some containers), where the check passes.
    let id = Command::new("id").arg("-u").output().unwrap();
    if String::from_utf8_lossy(&id.stdout).trim() == "0" {
        return;
    }
    let output = Command::new("/bin/sh").arg(SCRIPT).arg("install").output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("must run as root"));
}

#[test]
fn the_script_runs_under_a_posix_only_shell_too() {
    // `dash` is /bin/sh on Debian and Ubuntu; check it when present (macOS has none).
    if !Path::new("/bin/dash").exists() {
        return;
    }
    let root = FakeRoot::new().with_system_bwrap().with_apparmor();
    let output = Command::new("/bin/dash")
        .arg(SCRIPT)
        .arg("--root")
        .arg(root.dir.path())
        .arg("install")
        .output()
        .unwrap();
    assert_ok(&output);
}

#[test]
fn directories_are_traversable_even_under_a_restrictive_umask() {
    let root = FakeRoot::new().with_system_bwrap().with_apparmor();
    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg("umask 077; exec /bin/sh \"$0\" --root \"$1\" install")
        .arg(SCRIPT)
        .arg(root.dir.path())
        .output()
        .unwrap();
    assert_ok(&output);
    assert_eq!(root.mode("opt/sourceweft"), 0o755);
    assert_eq!(root.mode("opt/sourceweft/libexec"), 0o755);
    assert_eq!(root.mode("opt/sourceweft/libexec/bwrap"), 0o755);
    assert_eq!(root.mode("etc/apparmor.d/sourceweft-bwrap"), 0o644);
}

#[test]
fn install_refuses_to_write_through_a_symlinked_install_directory() {
    for link in ["opt/sourceweft", "opt/sourceweft/libexec"] {
        let root = FakeRoot::new().with_system_bwrap().with_apparmor();
        let elsewhere = root.path("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        if link == "opt/sourceweft/libexec" {
            fs::create_dir_all(root.path("opt/sourceweft")).unwrap();
        } else {
            fs::create_dir_all(root.path("opt")).unwrap();
        }
        std::os::unix::fs::symlink(&elsewhere, root.path(link)).unwrap();

        let output = root.run("install");
        assert!(!output.status.success(), "{link}: should refuse");
        assert!(stderr(&output).contains("symbolic link"), "{link}: {}", stderr(&output));
        assert!(root.listing("elsewhere").is_empty(), "{link}: nothing written through the link");
        assert!(root.parser_log().is_empty(), "{link}: no profile was loaded");
        assert!(!root.path("etc/apparmor.d/sourceweft-bwrap").exists());
    }
}

#[test]
fn install_refuses_an_install_path_that_is_a_file() {
    let root = FakeRoot::new().with_system_bwrap().with_apparmor();
    root.write("opt/sourceweft", "not a directory", 0o644);
    let output = root.run("install");
    assert!(!output.status.success());
    assert!(stderr(&output).contains("not a directory"), "{}", stderr(&output));
}
