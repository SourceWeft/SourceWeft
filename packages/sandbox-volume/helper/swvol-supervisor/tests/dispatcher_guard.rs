//! Native Linux qualification of the admission fence only. Actual swlazy owns
//! the FUSE dispatcher; this is not a stub, remount, or transparent FD recovery.
#![cfg(target_os = "linux")]
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
struct Case {
    root: PathBuf,
    dispatcher: Option<Child>,
    supervisor: Option<Child>,
    nonce: String,
    registration: Value,
    state_tmpfs: bool,
}
fn wait(mut predicate: impl FnMut() -> bool, message: &str) {
    let until = Instant::now() + Duration::from_secs(10);
    while !predicate() {
        assert!(Instant::now() < until, "{message}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn hash(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}
fn mount_line(path: &Path) -> Option<Vec<String>> {
    fs::read_to_string("/proc/self/mountinfo")
        .unwrap()
        .lines()
        .find_map(|line| {
            let fields: Vec<String> = line.split_whitespace().map(Into::into).collect();
            (fields.get(4).map(String::as_str) == path.to_str()).then_some(fields)
        })
}
impl Case {
    fn new() -> Self {
        Self::with_small_state(false)
    }
    fn with_small_state(small: bool) -> Self {
        assert_eq!(
            unsafe { libc::geteuid() },
            0,
            "isolated privileged native Linux required"
        );
        assert_eq!(std::env::consts::ARCH,"aarch64","the PID/exe attestation test requires the approved native target, never a QEMU executable identity");
        let root = std::env::temp_dir().join(format!(
            "swvol-dispatcher-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let mut case = Self {
            root,
            dispatcher: None,
            supervisor: None,
            nonce: String::new(),
            registration: Value::Null,
            state_tmpfs: small,
        };
        for name in ["state", "lower", "cache", "fs", "trusted"] {
            fs::create_dir(case.root.join(name)).unwrap();
        }
        if small {
            assert!(Command::new("mount")
                .args(["-t", "tmpfs", "-o", "size=64k,mode=0700", "tmpfs"])
                .arg(case.root.join("state"))
                .status()
                .unwrap()
                .success());
        }
        fs::set_permissions(case.root.join("state"), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(Command::new("mount")
            .args(["-t", "tmpfs", "-o", "size=64m", "tmpfs"])
            .arg(case.root.join("fs"))
            .status()
            .unwrap()
            .success());
        for name in ["upper", "work", "merged"] {
            fs::create_dir(case.root.join("fs").join(name)).unwrap();
        }
        chown(&case.root.join("fs/upper"), 65534);
        let plan = json!({"volume":"volume-test","attachment":"attachment-test","seq":7,"entries":[{"p":"lower-zero","k":"f","m":420,"t":0,"s":0,"c":[]}],"chunks":{},"packs":{}});
        fs::write(case.plan(), serde_json::to_vec(&plan).unwrap()).unwrap();
        fs::set_permissions(case.plan(), fs::Permissions::from_mode(0o400)).unwrap();
        fs::write(
            case.root.join("state/pending.manifest"),
            b"opaque-owned-pending-sentinel\0\xff",
        )
        .unwrap();
        // Install an exact copy of the explicitly selected real native helper
        // into a root-owned protected path; no image/implementation fallback.
        let source = std::env::var_os("SWVOL_LAZY_BIN")
            .expect("SWVOL_LAZY_BIN must select the actual native swlazy binary");
        let executable = case.root.join("trusted/swlazy");
        fs::copy(source, &executable).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o555)).unwrap();
        case.dispatcher = Some(
            Command::new(&executable)
                .arg("mount-volume")
                .arg(case.plan())
                .arg(case.root.join("cache"))
                .arg(case.root.join("lower"))
                .arg("--allow-other")
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        wait(
            || mount_line(&case.root.join("lower")).is_some(),
            "actual swlazy never mounted its FUSE tree",
        );
        assert!(Command::new("mount")
            .args(["-t", "overlay", "overlay", "-o"])
            .arg(format!(
                "lowerdir={0}/lower,upperdir={0}/fs/upper,workdir={0}/fs/work",
                case.root.display()
            ))
            .arg(case.workspace())
            .status()
            .unwrap()
            .success());
        fs::remove_file(case.workspace().join("lower-zero")).unwrap(); // real overlay whiteout
        for (name, bytes) in [
            ("upper-existing", b"before".as_slice()),
            ("sentinel", b"unconfirmed-dirty-upper"),
            ("counter", b""),
        ] {
            let path = case.workspace().join(name);
            fs::write(&path, bytes).unwrap();
            chown(&path, 65534);
        }
        case.start_supervisor(true);
        let dispatcher = case.dispatcher.as_ref().unwrap().id();
        let stat = fs::read_to_string(format!("/proc/{dispatcher}/stat")).unwrap();
        let start = stat
            .rsplit_once(')')
            .unwrap()
            .1
            .split_whitespace()
            .nth(19)
            .unwrap();
        let fields = mount_line(&case.root.join("lower")).unwrap();
        let sep = fields.iter().position(|s| s == "-").unwrap();
        let (major, minor) = fields[2].split_once(':').unwrap();
        case.registration = json!({"volume_id":"volume-test","attachment_id":"attachment-test","boot_id":fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim(),"fixed_base_seq":7,"plan_sha256":hash(&case.plan()),"plan_path":case.plan(),"mount_path":case.root.join("lower"),"mount_id":fields[0].parse::<u64>().unwrap(),"device_major":major.parse::<u32>().unwrap(),"device_minor":minor.parse::<u32>().unwrap(),"fs_name":fields[sep+2],"fs_type":fields[sep+1],"dispatcher_pid":dispatcher,"dispatcher_start_time":start,"dispatcher_executable":executable});
        eprintln!(
            "ACTUAL_SWLAZY_MOUNT {}",
            json!({"mount_id":case.registration["mount_id"],"major":case.registration["device_major"],"minor":case.registration["device_minor"],"fs_name":case.registration["fs_name"],"fs_type":case.registration["fs_type"]})
        );
        case
    }
    fn plan(&self) -> PathBuf {
        self.root.join("state/original-plan.json")
    }
    fn workspace(&self) -> PathBuf {
        self.root.join("fs/merged")
    }
    fn start_supervisor(&mut self, require_lazy: bool) {
        let mut command = Command::new(env!("CARGO_BIN_EXE_swvol-supervisor"));
        self.supervisor = Some(
            command
                .arg("serve")
                .arg(self.root.join("control.sock"))
                .arg(self.root.join("state"))
                .arg(self.workspace())
                .args(["65534", "65533"])
                .args(if require_lazy {
                    vec!["--require-lazy-mount"]
                } else {
                    vec![]
                })
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(Instant::now() < until, "supervisor readiness failed");
            if self.root.join("control.sock").exists() {
                if let Ok(mut stream) = UnixStream::connect(self.root.join("control.sock")) {
                    stream
                        .set_read_timeout(Some(Duration::from_millis(200)))
                        .unwrap();
                    writeln!(stream, "{{\"op\":\"identity\"}}").unwrap();
                    let mut line = String::new();
                    if BufReader::new(stream).read_line(&mut line).is_ok() {
                        if let Ok(value) = serde_json::from_str::<Value>(&line) {
                            if let Some(nonce) =
                                value["result"]["identity"]["supervisor_nonce"].as_str()
                            {
                                if nonce != self.nonce {
                                    self.nonce = nonce.into();
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn request(&self, value: Value) -> Value {
        let mut stream = UnixStream::connect(self.root.join("control.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        writeln!(stream, "{value}").unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn ok(&self, value: Value) -> Value {
        let reply = self.request(value);
        assert_eq!(reply["ok"], true, "{reply}");
        reply["result"].clone()
    }
    fn bind(&self) {
        self.ok(json!({"op":"register_lazy_mount","expected_nonce":self.nonce,"registration":self.registration}));
    }
    fn open(&self) {
        self.ok(json!({"op":"open","expected_nonce":self.nonce,"drain_id":null}));
    }
    fn closed_without_rpc(&self) {
        wait(
            || {
                let value: Value =
                    serde_json::from_slice(&fs::read(self.root.join("state/gate.json")).unwrap())
                        .unwrap();
                value["open"] == false && value["lazy_mount"]["state"] == "fenced"
            },
            "pidfd watcher did not durably close admission without a host request",
        );
    }
    fn denied(&self, value: Value) {
        let result = self.request(value);
        assert_eq!(result["ok"], false, "{result}");
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("LAZY_MOUNT_FENCED"),
            "{result}"
        );
    }
    fn retained(&self) -> (String, String, String, u32, u64) {
        let whiteout = fs::symlink_metadata(self.root.join("fs/upper/lower-zero")).unwrap();
        (
            hash(&self.root.join("fs/upper/sentinel")),
            hash(&self.root.join("state/pending.manifest")),
            hash(&self.plan()),
            whiteout.mode(),
            whiteout.rdev(),
        )
    }
}
fn chown(path: &Path, uid: u32) {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::chown(path.as_ptr(), uid, uid) }, 0);
}
impl Drop for Case {
    fn drop(&mut self) {
        if self
            .supervisor
            .as_mut()
            .is_some_and(|p| p.try_wait().ok().flatten().is_none())
            && !self.nonce.is_empty()
        {
            let _=self.request(json!({"op":"drain","expected_nonce":self.nonce,"drain_id":"explicit-owned-test-cleanup"}));
        }
        for child in [&mut self.supervisor, &mut self.dispatcher] {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if self.state_tmpfs {
            let _ = Command::new("umount")
                .arg("--lazy")
                .arg(self.root.join("state"))
                .status();
        }
        for name in ["fs/merged", "lower", "fs"] {
            let _ = Command::new("umount")
                .arg("--lazy")
                .arg(self.root.join(name))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let mounted = fs::read_to_string("/proc/self/mountinfo")
            .unwrap_or_default()
            .lines()
            .any(|l| {
                l.split_whitespace()
                    .nth(4)
                    .is_some_and(|p| Path::new(p).starts_with(&self.root))
            });
        if !mounted {
            let _ = fs::remove_dir_all(&self.root);
        } else {
            eprintln!(
                "retaining owned dispatcher fixture because mounts remain: {}",
                self.root.display()
            );
        }
    }
}
#[test]
#[ignore = "requires native ARM, real swlazy/FUSE/overlay and isolated mount privileges"]
fn whole_dispatcher_death_fences_new_work_and_retains_dirty_upper_and_pending() {
    let mut f = Case::new();
    f.denied(json!({"op":"open","expected_nonce":f.nonce,"drain_id":null}));
    let mut wrong = f.registration.clone();
    wrong["plan_sha256"] = "0".repeat(64).into();
    assert_eq!(
        f.request(
            json!({"op":"register_lazy_mount","expected_nonce":f.nonce,"registration":wrong})
        )["ok"],
        false
    );
    wrong = f.registration.clone();
    wrong["dispatcher_start_time"] = "0".into();
    assert_eq!(
        f.request(
            json!({"op":"register_lazy_mount","expected_nonce":f.nonce,"registration":wrong})
        )["ok"],
        false
    );
    f.bind();
    f.open();
    let retained = f.retained();
    let original = hash(&f.root.join("fs/upper/upper-existing"));
    f.ok(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"existing-writer","command":"python3 -c \"import os,time; f=open('counter','ab',buffering=0); [(f.write(b'x'),os.fsync(f.fileno()),time.sleep(.05)) for _ in range(1000)]\"","cwd":f.workspace()}}));
    wait(
        || fs::metadata(f.root.join("fs/upper/counter")).unwrap().len() >= 2,
        "existing upper writer not ready",
    );
    let before = fs::metadata(f.root.join("fs/upper/counter")).unwrap().len();
    f.dispatcher.as_mut().unwrap().kill().unwrap();
    f.dispatcher.as_mut().unwrap().wait().unwrap();
    f.closed_without_rpc();
    wait(
        || fs::metadata(f.root.join("fs/upper/counter")).unwrap().len() > before,
        "dispatcher death must not silently kill an existing upper writer",
    );
    f.denied(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"must-not-run","command":"printf forbidden >> upper-existing","cwd":f.workspace()}}));
    f.denied(json!({"op":"open","expected_nonce":f.nonce,"drain_id":null}));
    for op in ["resume", "thaw"] {
        f.denied(json!({"op":op,"expected_nonce":f.nonce,"pause_id":"not-a-recovery"}));
    }
    f.denied(
        json!({"op":"register_lazy_mount","expected_nonce":f.nonce,"registration":f.registration}),
    );
    assert_eq!(f.retained(), retained);
    assert_eq!(hash(&f.root.join("fs/upper/upper-existing")), original);
    assert!(!f.root.join("state/exec-must-not-run").exists());
    let drain =
        f.ok(json!({"op":"drain","expected_nonce":f.nonce,"drain_id":"explicit-test-restart"}));
    assert_eq!(drain["all_namespaces_exited"], true);
    f.supervisor.as_mut().unwrap().kill().unwrap();
    f.supervisor.as_mut().unwrap().wait().unwrap();
    f.start_supervisor(false);
    f.denied(json!({"op":"open","expected_nonce":f.nonce,"drain_id":null}));
    f.denied(
        json!({"op":"register_lazy_mount","expected_nonce":f.nonce,"registration":f.registration}),
    );
    assert_eq!(f.retained(), retained);
    eprintln!("WHOLE_DISPATCHER_DEATH actual_swlazy=true pidfd_fence_without_rpc=true new_work_refused=true existing_upper_writer_continued=true dirty_pending_fixed_plan_whiteout_retained=true restart_still_closed=true transparent_fd_recovery=false");
}
#[test]
#[ignore = "requires native ARM, real swlazy/FUSE/overlay and isolated mount privileges"]
fn original_plan_replacement_or_byte_change_fences_without_rebase() {
    for replace in [false, true] {
        let f = Case::new();
        f.bind();
        f.open();
        let upper = hash(&f.root.join("fs/upper/sentinel"));
        let pending = hash(&f.root.join("state/pending.manifest"));
        let sealed = f.root.join("state").join(format!(
            "lazy-fixed-plan-{}.json",
            f.registration["plan_sha256"].as_str().unwrap()
        ));
        let original_seal = hash(&sealed);
        if replace {
            let path = f.root.join("state/replacement.json");
            fs::copy(f.plan(), &path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
            fs::rename(path, f.plan()).unwrap();
        } else {
            let mut bytes = fs::read(f.plan()).unwrap();
            bytes.push(b'\n');
            fs::write(f.plan(), bytes).unwrap();
        }
        f.closed_without_rpc();
        f.denied(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"changed-plan","command":"true","cwd":f.workspace()}}));
        assert_eq!(hash(&f.root.join("fs/upper/sentinel")), upper);
        assert_eq!(hash(&f.root.join("state/pending.manifest")), pending);
        assert_eq!(
            hash(&sealed),
            original_seal,
            "original baseline bytes must survive plan path change"
        );
    }
}
#[test]
#[ignore = "requires native ARM, real swlazy/FUSE/overlay and isolated mount privileges"]
fn disappearance_of_mount_fences_even_with_a_live_dispatcher() {
    let mut f = Case::new();
    f.bind();
    f.open();
    let retained = f.retained();
    assert!(Command::new("umount")
        .arg("--lazy")
        .arg(f.root.join("lower"))
        .status()
        .unwrap()
        .success());
    assert!(
        f.dispatcher.as_mut().unwrap().try_wait().unwrap().is_none(),
        "this case must isolate mount disappearance from dispatcher death"
    );
    f.closed_without_rpc();
    f.denied(json!({"op":"start","expected_nonce":f.nonce,"launch":{"execution_id":"changed-mount","command":"true","cwd":f.workspace()}}));
    assert_eq!(f.retained(), retained);
}

#[test]
#[ignore = "requires native ARM and isolated tmpfs/FUSE/overlay privileges"]
fn seal_enospc_stays_required_and_partial_startup_never_guesses_eager() {
    let mut f = Case::with_small_state(true);
    let retained = f.retained();
    let mut fill = fs::File::create(f.root.join("state/own-fill")).unwrap();
    loop {
        match fill.write_all(&[0u8; 4096]) {
            Ok(()) => {}
            Err(error) => {
                assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
                break;
            }
        }
    }
    let reply = f.request(
        json!({"op":"register_lazy_mount","expected_nonce":f.nonce,"registration":f.registration}),
    );
    assert_eq!(reply["ok"], false, "seal cannot be acknowledged on ENOSPC");
    let status = f.ok(json!({"op":"identity"}));
    assert_eq!(status["open"], false);
    assert_eq!(status["lazy_mount_required"], true);
    assert!(status["lazy_mount"].is_null());
    f.denied(json!({"op":"open","expected_nonce":f.nonce,"drain_id":null}));
    assert_eq!(f.retained(), retained);
    drop(fill);
    fs::remove_file(f.root.join("state/own-fill")).unwrap();
    f.supervisor.as_mut().unwrap().kill().unwrap();
    f.supervisor.as_mut().unwrap().wait().unwrap();
    f.start_supervisor(false);
    f.denied(json!({"op":"open","expected_nonce":f.nonce,"drain_id":null}));
    assert_eq!(f.retained(), retained);
    // Interrupted gate publication is evidence, not a fresh eager workspace.
    f.supervisor.as_mut().unwrap().kill().unwrap();
    f.supervisor.as_mut().unwrap().wait().unwrap();
    fs::write(
        f.root.join("state/gate.tmp"),
        b"partial-intent-do-not-discard",
    )
    .unwrap();
    let failed = Command::new(env!("CARGO_BIN_EXE_swvol-supervisor"))
        .arg("serve")
        .arg(f.root.join("control.sock"))
        .arg(f.root.join("state"))
        .arg(f.workspace())
        .args(["65534", "65533"])
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("STARTUP_INCOMPLETE"));
    assert_eq!(
        fs::read(f.root.join("state/gate.tmp")).unwrap(),
        b"partial-intent-do-not-discard"
    );
    assert_eq!(f.retained(), retained);
    eprintln!("LAZY_INTENT_SEAL_FAULTS actual_enospc=true required_retained=true restart_without_flag_closed=true partial_gate_not_discarded=true dirty_pending_preserved=true");
}

struct StartupEvidence {
    root: PathBuf,
    namespace: Option<Child>,
}
impl Drop for StartupEvidence {
    fn drop(&mut self) {
        if let Some(mut child) = self.namespace.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = Command::new("umount")
            .arg("--lazy")
            .arg(self.root.join("state"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn refused_startup(root: &Path, required: bool) -> String {
    let mut command = Command::new(env!("CARGO_BIN_EXE_swvol-supervisor"));
    command
        .arg("serve")
        .arg(root.join("control.sock"))
        .arg(root.join("state"))
        .arg(root.join("workspace"))
        .args(["65534", "65533"]);
    if required {
        command.arg("--require-lazy-mount");
    }
    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("uncertain startup incorrectly accepted a live control session")
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    String::from_utf8(output.stderr).unwrap()
}
#[test]
#[ignore = "requires isolated Linux tmpfs for real initial intent ENOSPC"]
fn uncertain_or_unwritable_startup_never_listens_or_discards_evidence() {
    for fault in [
        "missing-gate",
        "invalid-gate",
        "missing-intent-field",
        "empty-nonce",
        "invalid-boot",
        "partial-gate",
        "initial-enospc",
    ] {
        let root = std::env::temp_dir().join(format!(
            "swvol-startup-fault-{}-{}-{}",
            std::process::id(),
            fault,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let mut owned = StartupEvidence {
            root,
            namespace: None,
        };
        fs::create_dir(owned.root.join("workspace")).unwrap();
        fs::create_dir(owned.root.join("state")).unwrap();
        assert!(Command::new("mount")
            .args(["-t", "tmpfs", "-o", "size=64k,mode=0700", "tmpfs"])
            .arg(owned.root.join("state"))
            .status()
            .unwrap()
            .success());
        let state = owned.root.join("state");
        fs::write(
            state.join("pending.manifest"),
            b"retain-owned-dirty-evidence",
        )
        .unwrap();
        match fault {
            "missing-gate" => {
                fs::write(state.join("supervisor.lock"), b"").unwrap();
            }
            "invalid-gate" => {
                fs::write(state.join("supervisor.lock"), b"").unwrap();
                fs::write(state.join("gate.json"), b"{invalid-original-gate").unwrap();
            }
            "missing-intent-field" | "empty-nonce" | "invalid-boot" => {
                fs::write(state.join("supervisor.lock"), b"").unwrap();
                let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")
                    .unwrap()
                    .trim()
                    .to_owned();
                let mut old = json!({"identity":{"boot_id":boot,"supervisor_nonce":fs::read_to_string("/proc/sys/kernel/random/uuid").unwrap().trim(),"stable_freeze":false,"freeze_mechanism":"signal-pause","user_threads_freeze":"signal-observation","kernel_io_quiescence":"unqualified"},"open":true,"drain_id":null,"freeze_id":null,"recovered_from":null,"recovered_journal_digest":null,"lazy_mount_required":false});
                match fault {
                    "missing-intent-field" => {
                        old.as_object_mut().unwrap().remove("lazy_mount_required");
                    }
                    "empty-nonce" => old["identity"]["supervisor_nonce"] = "".into(),
                    "invalid-boot" => old["identity"]["boot_id"] = "not-a-kernel-boot-id".into(),
                    _ => unreachable!(),
                }
                fs::write(state.join("gate.json"), serde_json::to_vec(&old).unwrap()).unwrap();
                let counter = owned.root.join("workspace/existing-writer");
                owned.namespace = Some(
                    Command::new("unshare")
                        .args([
                            "--pid",
                            "--fork",
                            "--mount-proc",
                            "--kill-child=KILL",
                            "sh",
                            "-c",
                        ])
                        .arg(format!(
                            "while :; do printf x >> {}; sleep 0.02; done",
                            counter.display()
                        ))
                        .stdout(Stdio::null())
                        .stderr(Stdio::inherit())
                        .spawn()
                        .unwrap(),
                );
                wait(
                    || fs::metadata(&counter).is_ok_and(|m| m.len() >= 2),
                    "old namespace writer did not become live",
                );
                let parent = owned.namespace.as_ref().unwrap().id();
                let children =
                    fs::read_to_string(format!("/proc/{parent}/task/{parent}/children")).unwrap();
                let pid = children
                    .split_whitespace()
                    .next()
                    .unwrap()
                    .parse::<u32>()
                    .unwrap();
                let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
                let start = stat
                    .rsplit_once(')')
                    .unwrap()
                    .1
                    .split_whitespace()
                    .nth(19)
                    .unwrap();
                let directory = state.join("exec-old-writer");
                fs::create_dir(&directory).unwrap();
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
                fs::write(directory.join("namespace.json"),serde_json::to_vec(&json!({"boot_id":boot,"init_pid":pid,"init_start_time":start,"namespace":fs::read_link(format!("/proc/{pid}/ns/pid")).unwrap()})).unwrap()).unwrap();
            }
            "partial-gate" => {
                fs::write(state.join("gate.tmp"), b"partial-original-intent").unwrap();
            }
            "initial-enospc" => {
                let mut fill = fs::File::create(state.join("owned-fill")).unwrap();
                loop {
                    match fill.write_all(&[0; 4096]) {
                        Ok(()) => {}
                        Err(error) => {
                            assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
                            break;
                        }
                    }
                }
            }
            _ => unreachable!(),
        }
        if state.join("gate.json").exists() {
            fs::set_permissions(state.join("gate.json"), fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        let old_gate = fs::read(state.join("gate.json")).ok();
        let writer_before = fs::metadata(owned.root.join("workspace/existing-writer"))
            .ok()
            .map(|m| m.len());
        let message = refused_startup(&owned.root, fault == "initial-enospc");
        assert!(message.contains("STARTUP_INCOMPLETE"), "{fault}: {message}");
        assert!(!owned.root.join("control.sock").exists());
        assert_eq!(
            fs::read(state.join("pending.manifest")).unwrap(),
            b"retain-owned-dirty-evidence"
        );
        if fault == "invalid-gate" {
            assert_eq!(
                fs::read(state.join("gate.json")).unwrap(),
                b"{invalid-original-gate"
            );
        }
        if let Some(bytes) = old_gate {
            assert_eq!(
                fs::read(state.join("gate.json")).unwrap(),
                bytes,
                "unknown metadata must not be replaced"
            );
        }
        if let Some(before) = writer_before {
            wait(
                || {
                    fs::metadata(owned.root.join("workspace/existing-writer"))
                        .unwrap()
                        .len()
                        > before
                },
                "unknown gate schema must not kill the existing journaled namespace",
            );
            assert!(owned
                .namespace
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
                .is_none());
        }
        if fault == "partial-gate" {
            assert_eq!(
                fs::read(state.join("gate.tmp")).unwrap(),
                b"partial-original-intent"
            );
        }
        if fault == "initial-enospc" {
            assert!(state.join("gate.tmp").exists());
            fs::remove_file(state.join("owned-fill")).unwrap();
            assert!(refused_startup(&owned.root, false).contains("STARTUP_INCOMPLETE"));
        }
        eprintln!("LAZY_STARTUP_FAULT case={fault} typed_refusal=true listener_never_opened=true pending_retained=true");
    }
}
