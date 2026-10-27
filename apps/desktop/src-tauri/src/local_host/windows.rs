//! Windows-specific host facts that are not about a shell or a path layout: where the staged
//! `srt-win.exe` lives, what `srt-win status` says, and what that means for readiness.
//!
//! # The staged helper
//!
//! The sandboxed process is started by `srt-win.exe` itself, run as the sandbox account
//! (`logon.rs` in the fork: `CreateProcessWithLogonW(current_exe())`). That account cannot read the
//! user's profile, so the helper cannot run from the per-user bundle. The one-time elevated setup
//! (`resources/windows/sourceweft-sandbox-setup.ps1`) copies it under `Program Files`, where
//! `Users` can read and execute but only an administrator can write, after checking the copy
//! against the SHA-256 in the signed bundle manifest. Everything that runs elevated or as the
//! sandbox account is that copy, never the bundle.
//!
//! # Coexistence
//!
//! The helper is a namespaced build (`sourceweft-sandbox` account, its own registry hive, state
//! directory and WFP sublayer). Nothing here reads or writes the state of an upstream
//! `srt-sandbox` install: `srt-win status` of *our* copy only ever looks at our namespace.
//!
//! The classification of `srt-win status` is pure so it is tested on every platform; only the
//! process spawn is Windows-only.
#![cfg_attr(not(windows), allow(dead_code))]
use super::readiness::{Remedy, SandboxReadiness, SetupCode};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

/// The proxy port range the setup installs and the sidecar's policy names: the namespaced build's
/// own range (`.sourceweft/README.md` in the fork), disjoint from upstream's `60080-60089`. A test
/// pins it to `sandbox-sidecar/src/policy.ts` and to the setup script.
pub(crate) const PROXY_PORT_RANGE: [u16; 2] = [60180, 60189];

/// Where the setup stages `srt-win.exe`, below the machine-wide `Program Files`, where `Users`
/// can read and execute it (the sandbox account runs it as the second hop of the launch) but only
/// an administrator can write it. The copy in the user-writable app-data bundle is never what runs
/// elevated or as the sandbox account.
const STAGED_DIR: &str = "SourceWeft\\sandbox";
const STAGED_FILE: &str = "srt-win.exe";
/// The setup's result file sits beside the staged directory, in `Program Files\SourceWeft`: only
/// an administrator can create it there, so an unprivileged process can neither plant a file for
/// the elevated script to follow (as it could in `%ProgramData%`, where `Users` may create
/// directories) nor forge a result.
const RESULT_FILE: &str = "SourceWeft\\sandbox-setup-result.json";

/// The 64-bit `Program Files` from the given `ProgramW6432` and `ProgramFiles` values.
/// `ProgramW6432` (the 64-bit Program Files, also for a 32-bit process) wins; a value that is not
/// a drive-absolute directory is skipped rather than repaired, and `None` means the location
/// cannot be determined (the caller fails closed). Backslash-separated, without a trailing one.
fn program_files_root(program_w6432: Option<&str>, program_files: Option<&str>) -> Option<String> {
    [program_w6432, program_files]
        .into_iter()
        .flatten()
        .find_map(|root| {
            let bytes = root.as_bytes();
            let drive = bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && (bytes[2] == b'\\' || bytes[2] == b'/');
            let trimmed = root.trim_end_matches(['\\', '/']);
            (drive && trimmed.len() > 2 && !root.chars().any(char::is_control))
                .then(|| trimmed.replace('/', "\\"))
        })
}

/// `%ProgramFiles%\SourceWeft\sandbox\srt-win.exe` from the given `ProgramW6432` and
/// `ProgramFiles` values (see [`program_files_root`]).
pub(crate) fn staged_srt_win_path_from(
    program_w6432: Option<&str>,
    program_files: Option<&str>,
) -> Option<PathBuf> {
    program_files_root(program_w6432, program_files)
        .map(|root| PathBuf::from(format!("{root}\\{STAGED_DIR}\\{STAGED_FILE}")))
}

/// [`staged_srt_win_path_from`] for this process's environment.
pub(crate) fn staged_srt_win_path() -> Option<PathBuf> {
    staged_srt_win_path_from(
        std::env::var("ProgramW6432").ok().as_deref(),
        std::env::var("ProgramFiles").ok().as_deref(),
    )
}

/// `%ProgramFiles%\SourceWeft\sandbox-setup-result.json` from the given values.
pub(crate) fn setup_result_path_from(
    program_w6432: Option<&str>,
    program_files: Option<&str>,
) -> Option<PathBuf> {
    program_files_root(program_w6432, program_files)
        .map(|root| PathBuf::from(format!("{root}\\{RESULT_FILE}")))
}

/// [`setup_result_path_from`] for this process's environment.
pub(crate) fn setup_result_path() -> Option<PathBuf> {
    setup_result_path_from(
        std::env::var("ProgramW6432").ok().as_deref(),
        std::env::var("ProgramFiles").ok().as_deref(),
    )
}

/// Lowercase hex SHA-256 of the file at `path`, read in chunks.
pub(crate) fn file_sha256_hex(path: &Path) -> io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

// -------------------------------------------------------------------- srt-win status

/// What `srt-win status` reports that readiness needs. The real output is one line of JSON
/// `{"user":{"user":{"exists",...},"cred_present","marker_version","setup_version",...},
/// "wfp":{"state","filters","port_range","allow_loopback",...},"ambient":{...}}`, snake_case
/// (`vendor/srt-win-src/src/cli.rs` of the fork: `user_status_json`, `wfp_status`). Every field the
/// classification rests on is required, so an `srt-win` whose output changed shape is an error and
/// not a guess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SrtWinStatus {
    pub user_exists: bool,
    pub in_sandbox_group: bool,
    pub cred_present: bool,
    /// The setup version recorded by the install; `None` when nothing was recorded.
    pub marker_version: Option<u64>,
    /// The setup version this `srt-win` build needs.
    pub setup_version: u64,
    /// `installed`, `absent`, `cannot-read` (a non-elevated caller cannot enumerate the WFP
    /// filters) or `loopback-mismatch`.
    pub wfp_state: String,
    /// Known only when the filters could be read (`installed`).
    pub port_range: Option<[u16; 2]>,
    pub allow_loopback: bool,
}

#[derive(Deserialize)]
struct RawStatus {
    user: RawUser,
    wfp: RawWfp,
}

#[derive(Deserialize)]
struct RawUser {
    user: RawAccount,
    cred_present: bool,
    marker_version: Option<u64>,
    setup_version: u64,
}

#[derive(Deserialize)]
struct RawAccount {
    exists: bool,
    in_sandbox_group: bool,
}

#[derive(Deserialize)]
struct RawWfp {
    state: String,
    port_range: Option<[u16; 2]>,
    allow_loopback: bool,
}

/// Parses the stdout of `srt-win status`.
pub(crate) fn parse_srt_win_status(stdout: &str) -> Result<SrtWinStatus, String> {
    let raw: RawStatus = serde_json::from_str(stdout.trim()).map_err(|error| {
        let shown: String = stdout.trim().chars().take(200).collect();
        format!("The sandbox helper's status output was not understood ({error}): {shown:?}")
    })?;
    Ok(SrtWinStatus {
        user_exists: raw.user.user.exists,
        in_sandbox_group: raw.user.user.in_sandbox_group,
        cred_present: raw.user.cred_present,
        marker_version: raw.user.marker_version,
        setup_version: raw.user.setup_version,
        wfp_state: raw.wfp.state,
        port_range: raw.wfp.port_range,
        allow_loopback: raw.wfp.allow_loopback,
    })
}

// ------------------------------------------------------------------ classification

fn elevated_setup(code: SetupCode, reason: impl Into<String>) -> SandboxReadiness {
    SandboxReadiness::needs_setup(code, reason, Remedy::ElevatedSetup)
}

/// The sandbox helper has not been staged (or the sandbox was never set up).
pub(crate) fn windows_not_installed(reason: impl Into<String>) -> SandboxReadiness {
    elevated_setup(SetupCode::WindowsNotInstalled, reason)
}

/// Something is set up, but not what this release needs.
pub(crate) fn windows_setup_outdated(reason: impl Into<String>) -> SandboxReadiness {
    elevated_setup(SetupCode::WindowsSetupOutdated, reason)
}

/// The staged helper against the bundle's: a different file is a different release (or a
/// tampered copy), and nothing runs until the setup replaces it. `None` when they are the same
/// file; `staged` is `None` when no helper is staged.
pub(crate) fn classify_staged_helper(
    staged_hash: Option<&str>,
    bundle_hash: &str,
) -> Option<SandboxReadiness> {
    match staged_hash {
        None => Some(windows_not_installed(
            "The sandbox helper is not set up on this computer. Setup needs administrator approval.",
        )),
        Some(staged) if !staged.eq_ignore_ascii_case(bundle_hash) => {
            Some(windows_setup_outdated(
                "The sandbox helper installed on this computer is not the one that comes with this version of SourceWeft. Setup needs administrator approval.",
            ))
        }
        Some(_) => None,
    }
}

/// What the helper's own status means for local execution. `None` means nothing stands in the way
/// of the sidecar `init` + `probe`, which is the behavioural check that settles it (the WFP fence
/// is verified there, under the token a command gets).
///
/// - the staged helper differs from the bundle's -> `windowsSetupOutdated`;
/// - no sandbox account, credential, group membership or recorded setup, or no WFP filters ->
///   `windowsNotInstalled`;
/// - a recorded setup of another version -> `windowsSetupOutdated`; of a newer one -> the app is
///   older than the setup (`bundleNewer`, update the app: the setup never replaces a newer one);
/// - filters for another port range or with open loopback, or a loopback mode that differs from
///   the install record -> `windowsSetupOutdated` (a conflicting install: the setup never uses
///   `--force`, so it will say so instead of replacing it);
/// - `cannot-read` is what a non-elevated caller always gets, so it decides nothing here.
pub(crate) fn classify_windows_status(
    status: &SrtWinStatus,
    bundle_hash: &str,
    staged_hash: &str,
) -> Option<SandboxReadiness> {
    if let Some(readiness) = classify_staged_helper(Some(staged_hash), bundle_hash) {
        return Some(readiness);
    }
    if !status.user_exists || !status.cred_present || !status.in_sandbox_group {
        return Some(windows_not_installed(
            "The sandbox account is not set up on this computer. Setup needs administrator approval.",
        ));
    }
    match status.marker_version {
        None => {
            return Some(windows_not_installed(
                "The sandbox setup on this computer is incomplete. Setup needs administrator approval.",
            ))
        }
        Some(marker) if marker > status.setup_version => {
            return Some(SandboxReadiness::needs_setup(
                SetupCode::BundleNewer,
                format!(
                    "The sandbox on this computer was set up by a newer SourceWeft (setup version {marker}; this version needs {}). Update SourceWeft.",
                    status.setup_version
                ),
                Remedy::UpdateApp,
            ))
        }
        Some(marker) if marker != status.setup_version => {
            return Some(windows_setup_outdated(format!(
                "The sandbox setup on this computer is from another SourceWeft release (setup version {marker}; this version needs {}). Setup needs administrator approval.",
                status.setup_version
            )))
        }
        Some(_) => {}
    }
    match status.wfp_state.as_str() {
        "cannot-read" => {}
        "absent" => {
            return Some(windows_not_installed(
                "The sandbox network rules are not installed. Setup needs administrator approval.",
            ))
        }
        "installed" => {
            if let Some(range) = status.port_range.filter(|range| *range != PROXY_PORT_RANGE) {
                return Some(windows_setup_outdated(format!(
                    "The sandbox network rules allow ports {}-{}, SourceWeft needs {}-{}.",
                    range[0], range[1], PROXY_PORT_RANGE[0], PROXY_PORT_RANGE[1]
                )));
            }
            if status.allow_loopback {
                return Some(windows_setup_outdated(
                    "The sandbox network rules leave local network ports open; SourceWeft needs them closed.",
                ));
            }
        }
        "loopback-mismatch" => {
            return Some(windows_setup_outdated(
                "The sandbox network rules do not match what the setup recorded.",
            ))
        }
        other => {
            return Some(SandboxReadiness::needs_setup(
                SetupCode::SandboxFailed,
                format!("The sandbox helper reported an unknown network rule state {other:?}."),
                Remedy::None,
            ))
        }
    }
    None
}

/// The `[code] ` prefix the sidecar puts on a failure that srt raised as a `WindowsSandboxError`
/// (`sandbox-sidecar/src/server.ts` `windowsErrorMessage`), if the message starts with one.
fn windows_error_code(message: &str) -> Option<&str> {
    let rest = message.strip_prefix('[')?;
    let (code, _) = rest.split_once(']')?;
    (!code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')).then_some(code)
}

/// Maps a failed sidecar `init` / `probe` to the readiness it means on Windows: the codes srt
/// raises for a missing or stale setup become the same remedies the status classification gives;
/// the bundle codes keep their meaning; everything else is `sandboxFailed` with srt's own message
/// and no remedy (nothing is guessed).
pub(crate) fn classify_windows_probe_failure(code: &str, message: &str) -> SandboxReadiness {
    match windows_error_code(message) {
        Some("not_provisioned" | "wfp_fence_inactive") => {
            return windows_not_installed(format!(
                "{message} Setup needs administrator approval."
            ))
        }
        Some("reinstall_required" | "wfp_loopback_mismatch" | "srt_win_outdated" | "srt_win_too_old") => {
            return windows_setup_outdated(format!(
                "{message} Setup needs administrator approval."
            ))
        }
        _ => {}
    }
    super::readiness::classify_bundle_failure(code, message).unwrap_or_else(|| {
        SandboxReadiness::needs_setup(SetupCode::SandboxFailed, message, Remedy::None)
    })
}

// ------------------------------------------------------------------------ processes

/// The most a status or setup process may say on either stream.
const OUTPUT_CAP: u64 = 1024 * 1024;

/// Runs `command` with stdin closed and both output streams captured (capped), and kills it if it
/// has not exited within `limit`. A kill is an error: a process that did not finish says nothing.
pub(crate) fn output_within(command: &mut Command, limit: Duration) -> io::Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let drain = |stream: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(stream) = stream {
                let _ = stream.take(OUTPUT_CAP).read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = drain(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Output {
                status,
                stdout: stdout.join().unwrap_or_default(),
                stderr: stderr.join().unwrap_or_default(),
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // The reader threads end with the pipes; a grandchild holding them open must not
            // hold this call, so they are left to finish on their own.
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("did not finish within {} seconds", limit.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// How long `srt-win status` may take (a cold start under a virus scanner is slow, a hang is not
/// acceptable).
#[cfg(windows)]
const STATUS_TIMEOUT: Duration = Duration::from_secs(30);

/// Runs `<exe> status` (no elevation) and parses it. A helper that cannot run, exits non-zero,
/// times out or prints something unexpected is an error with its reason.
#[cfg(windows)]
pub(crate) fn srt_win_status(exe: &Path) -> Result<SrtWinStatus, String> {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(exe);
    command
        .arg("status")
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    let output = output_within(&mut command, STATUS_TIMEOUT)
        .map_err(|error| format!("The sandbox helper could not be run ({}): {error}", exe.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "The sandbox helper's status check failed ({}): {}",
            output.status,
            stderr.trim()
        ));
    }
    parse_srt_win_status(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_staged_helper_lives_under_the_64_bit_program_files() {
        assert_eq!(
            staged_srt_win_path_from(Some(r"C:\Program Files"), Some(r"C:\Program Files (x86)")),
            Some(PathBuf::from(
                r"C:\Program Files\SourceWeft\sandbox\srt-win.exe"
            ))
        );
    }

    #[test]
    fn program_files_is_used_when_program_w6432_is_absent_or_unusable() {
        let expected = Some(PathBuf::from(r"D:\Programs\SourceWeft\sandbox\srt-win.exe"));
        assert_eq!(
            staged_srt_win_path_from(None, Some(r"D:\Programs")),
            expected
        );
        assert_eq!(
            staged_srt_win_path_from(Some(""), Some(r"D:\Programs")),
            expected
        );
        assert_eq!(
            staged_srt_win_path_from(Some("relative"), Some("D:/Programs/")),
            expected
        );
    }

    #[test]
    fn nothing_usable_means_no_path() {
        assert_eq!(staged_srt_win_path_from(None, None), None);
        for bad in [
            "",
            "relative",
            r"\\server\share",
            "C:",
            r"C:\",
            "C:rel",
            "C:\\x\n",
        ] {
            assert_eq!(
                staged_srt_win_path_from(Some(bad), Some(bad)),
                None,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_result_is_a_native_absolute_drive_path() {
        let path = staged_srt_win_path_from(Some("c:/Program Files//"), None).unwrap();
        assert_eq!(
            path,
            Path::new(r"c:\Program Files\SourceWeft\sandbox\srt-win.exe")
        );
    }

    #[test]
    fn the_result_file_sits_beside_the_staged_directory_in_program_files() {
        assert_eq!(
            setup_result_path_from(Some(r"C:\Program Files"), None),
            Some(PathBuf::from(
                r"C:\Program Files\SourceWeft\sandbox-setup-result.json"
            ))
        );
        assert_eq!(setup_result_path_from(Some("relative"), None), None);
    }

    #[test]
    fn a_file_hash_is_lowercase_hex_sha256() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            file_sha256_hex(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::write(&path, vec![7u8; 200_000]).unwrap();
        assert_eq!(file_sha256_hex(&path).unwrap().len(), 64);
        assert_eq!(
            file_sha256_hex(&dir.path().join("missing")).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }

    // ---- srt-win status ------------------------------------------------------------------

    const BUNDLE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    /// The real shape of `srt-win status` (`cli.rs` `Cmd::Status`) for a healthy, non-elevated
    /// read: the WFP filters cannot be enumerated without administrator rights.
    const REAL_STATUS_CANNOT_READ: &str = r#"{"user":{"user":{"name":"sourceweft-sandbox","exists":true,"sid":"S-1-5-21-1-2-3-1001","group_exists":true,"group_sid":"S-1-5-21-1-2-3-1002","in_builtin_users":true,"in_sandbox_group":true,"hidden_from_logon":true},"cred_present":true,"marker_version":3,"setup_version":3,"marker_user_sid":"S-1-5-21-1-2-3-1001","real_user_sid":"S-1-5-21-1-2-3-1000","ca_cert_thumb":null,"ca_cert_pem":null,"persistent_grants":{"state":"none","roots":[],"pending":[]},"profile_grant":"none","capabilities":["a"],"session_user_sid":"S-1-5-21-1-2-3-1000","seclogon":"ok"},"wfp":{"state":"cannot-read","filters":0,"allow_loopback":false,"hint":"elevation required"},"ambient":[]}"#;

    fn healthy() -> SrtWinStatus {
        SrtWinStatus {
            user_exists: true,
            in_sandbox_group: true,
            cred_present: true,
            marker_version: Some(3),
            setup_version: 3,
            wfp_state: "installed".to_string(),
            port_range: Some(PROXY_PORT_RANGE),
            allow_loopback: false,
        }
    }

    fn parts(readiness: &SandboxReadiness) -> (SetupCode, Remedy, String) {
        match readiness {
            SandboxReadiness::NeedsSetup { code, remedy, reason, .. } => (*code, *remedy, reason.clone()),
            other => panic!("expected NeedsSetup, got {other:?}"),
        }
    }

    #[test]
    fn the_real_status_line_is_parsed() {
        let status = parse_srt_win_status(&format!("{REAL_STATUS_CANNOT_READ}\r\n")).unwrap();
        assert_eq!(
            status,
            SrtWinStatus {
                wfp_state: "cannot-read".to_string(),
                port_range: None,
                ..healthy()
            }
        );
        let installed = r#"{"user":{"user":{"exists":true,"in_sandbox_group":true},"cred_present":true,"marker_version":null,"setup_version":3},"wfp":{"state":"installed","filters":12,"port_range":[60180,60189],"allow_loopback":true}}"#;
        let status = parse_srt_win_status(installed).unwrap();
        assert_eq!(status.marker_version, None);
        assert_eq!(status.port_range, Some([60180, 60189]));
        assert!(status.allow_loopback);
    }

    #[test]
    fn a_status_that_is_not_understood_is_an_error_not_a_guess() {
        for bad in [
            "",
            "not json",
            "{}",
            r#"{"user":{},"wfp":{}}"#,
            // each required field missing in turn
            r#"{"user":{"user":{"exists":true},"cred_present":true,"setup_version":3},"wfp":{"state":"installed","allow_loopback":false}}"#,
            r#"{"user":{"user":{"exists":true,"in_sandbox_group":true},"setup_version":3},"wfp":{"state":"installed","allow_loopback":false}}"#,
            r#"{"user":{"user":{"exists":true,"in_sandbox_group":true},"cred_present":true},"wfp":{"state":"installed","allow_loopback":false}}"#,
            r#"{"user":{"user":{"exists":true,"in_sandbox_group":true},"cred_present":true,"setup_version":3},"wfp":{"allow_loopback":false}}"#,
            r#"{"user":{"user":{"exists":"yes","in_sandbox_group":true},"cred_present":true,"setup_version":3},"wfp":{"state":"installed","allow_loopback":false}}"#,
        ] {
            let error = parse_srt_win_status(bad).unwrap_err();
            assert!(error.starts_with("The sandbox helper's status output was not understood"), "{bad:?}: {error}");
        }
        // The shown excerpt is bounded.
        assert!(parse_srt_win_status(&"x".repeat(5000)).unwrap_err().len() < 400);
    }

    #[test]
    fn a_healthy_status_leaves_the_decision_to_the_sidecar_probe() {
        assert_eq!(classify_windows_status(&healthy(), BUNDLE, BUNDLE), None);
        // What a non-elevated caller sees is not a verdict.
        let unreadable = SrtWinStatus { wfp_state: "cannot-read".into(), port_range: None, ..healthy() };
        assert_eq!(classify_windows_status(&unreadable, BUNDLE, BUNDLE), None);
        // Hex case does not matter.
        assert_eq!(classify_windows_status(&healthy(), BUNDLE, &BUNDLE.to_uppercase()), None);
    }

    #[test]
    fn no_staged_helper_or_another_one_needs_the_elevated_setup() {
        let (code, remedy, _) = parts(&classify_staged_helper(None, BUNDLE).unwrap());
        assert_eq!((code, remedy), (SetupCode::WindowsNotInstalled, Remedy::ElevatedSetup));
        let (code, remedy, _) = parts(&classify_staged_helper(Some(OTHER), BUNDLE).unwrap());
        assert_eq!((code, remedy), (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup));
        assert_eq!(classify_staged_helper(Some(BUNDLE), BUNDLE), None);
        // The status table starts with the same hash comparison.
        let (code, remedy, _) = parts(&classify_windows_status(&healthy(), BUNDLE, OTHER).unwrap());
        assert_eq!((code, remedy), (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup));
    }

    #[test]
    fn every_status_branch_maps_to_its_code_and_remedy() {
        let not_installed = (SetupCode::WindowsNotInstalled, Remedy::ElevatedSetup);
        let outdated = (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup);
        let cases: Vec<(&str, SrtWinStatus, (SetupCode, Remedy))> = vec![
            ("no account", SrtWinStatus { user_exists: false, ..healthy() }, not_installed),
            ("no credential", SrtWinStatus { cred_present: false, ..healthy() }, not_installed),
            ("not in the group", SrtWinStatus { in_sandbox_group: false, ..healthy() }, not_installed),
            ("no marker", SrtWinStatus { marker_version: None, ..healthy() }, not_installed),
            ("older marker", SrtWinStatus { marker_version: Some(2), ..healthy() }, outdated),
            ("newer marker", SrtWinStatus { marker_version: Some(4), ..healthy() }, (SetupCode::BundleNewer, Remedy::UpdateApp)),
            ("no filters", SrtWinStatus { wfp_state: "absent".into(), port_range: None, ..healthy() }, not_installed),
            ("another port range", SrtWinStatus { port_range: Some([60080, 60089]), ..healthy() }, outdated),
            ("a narrower port range", SrtWinStatus { port_range: Some([60180, 60188]), ..healthy() }, outdated),
            ("open loopback", SrtWinStatus { allow_loopback: true, ..healthy() }, outdated),
            ("loopback mismatch", SrtWinStatus { wfp_state: "loopback-mismatch".into(), ..healthy() }, outdated),
            ("unknown filter state", SrtWinStatus { wfp_state: "who-knows".into(), ..healthy() }, (SetupCode::SandboxFailed, Remedy::None)),
        ];
        for (name, status, expected) in cases {
            let readiness = classify_windows_status(&status, BUNDLE, BUNDLE)
                .unwrap_or_else(|| panic!("{name}: expected a verdict"));
            let (code, remedy, reason) = parts(&readiness);
            assert_eq!((code, remedy), expected, "{name}: {reason}");
            assert!(!reason.is_empty(), "{name}");
        }
        // A missing account wins over everything after it.
        let worst = SrtWinStatus { user_exists: false, marker_version: Some(1), wfp_state: "absent".into(), ..healthy() };
        assert_eq!(parts(&classify_windows_status(&worst, BUNDLE, BUNDLE).unwrap()).0, SetupCode::WindowsNotInstalled);
    }

    #[test]
    fn a_newer_setup_is_never_offered_a_replacement() {
        // The setup never uses --force and srt-win refuses to replace a newer setup, so the
        // remedy is to update the app, not a button that can only fail.
        let status = SrtWinStatus { marker_version: Some(9), ..healthy() };
        let (code, remedy, reason) = parts(&classify_windows_status(&status, BUNDLE, BUNDLE).unwrap());
        assert_eq!((code, remedy), (SetupCode::BundleNewer, Remedy::UpdateApp));
        assert!(reason.contains("version 9") && reason.contains("needs 3"), "{reason}");
    }

    // ---- sidecar init failures -------------------------------------------------------------

    #[test]
    fn srt_error_codes_from_the_sidecar_map_to_the_windows_remedies() {
        for (message, expected) in [
            ("[not_provisioned] Windows sandbox user is not provisioned", (SetupCode::WindowsNotInstalled, Remedy::ElevatedSetup)),
            ("[wfp_fence_inactive] direct egress succeeded", (SetupCode::WindowsNotInstalled, Remedy::ElevatedSetup)),
            ("[reinstall_required] set up by a different release", (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup)),
            ("[wfp_loopback_mismatch] loopback mode", (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup)),
            ("[srt_win_outdated] older than the library", (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup)),
            ("[srt_win_too_old] --allow-loopback", (SetupCode::WindowsSetupOutdated, Remedy::ElevatedSetup)),
        ] {
            // The sidecar reports srt failures under any of its error codes.
            for code in ["SANDBOX_UNAVAILABLE", "POLICY_INVALID"] {
                let readiness = classify_windows_probe_failure(code, message);
                let (got_code, got_remedy, reason) = parts(&readiness);
                assert_eq!((got_code, got_remedy), expected, "{message}");
                assert!(reason.starts_with(message), "srt's text is kept: {reason}");
            }
        }
    }

    #[test]
    fn bundle_failures_keep_their_meaning_and_everything_else_is_reported_verbatim() {
        let (code, remedy, _) = parts(&classify_windows_probe_failure("BUNDLE_STALE", "old"));
        assert_eq!((code, remedy), (SetupCode::BundleStale, Remedy::DownloadRuntime));
        let (code, remedy, _) = parts(&classify_windows_probe_failure("BUNDLE_NEWER", "new"));
        assert_eq!((code, remedy), (SetupCode::BundleNewer, Remedy::UpdateApp));
        let (code, remedy, _) = parts(&classify_windows_probe_failure("HELPER_MISSING", "gone"));
        assert_eq!((code, remedy), (SetupCode::BundleInvalid, Remedy::DownloadRuntime));
        for message in [
            "[profile_grant_outdated] read grant",
            "[srt_win_timeout] timed out",
            "[Not_Provisioned] odd case",
            "not_provisioned without brackets",
            "[] empty",
            "sidecar exited without replying",
        ] {
            let (code, remedy, reason) = parts(&classify_windows_probe_failure("SANDBOX_UNAVAILABLE", message));
            assert_eq!((code, remedy), (SetupCode::SandboxFailed, Remedy::None), "{message}");
            assert_eq!(reason, message);
        }
    }

    // ---- processes -------------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn a_process_is_captured_and_a_hung_one_is_killed() {
        let mut quick = Command::new("/bin/sh");
        quick.args(["-c", "echo out; echo err >&2; exit 3"]);
        let output = output_within(&mut quick, Duration::from_secs(10)).unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&output.stdout), "out\n");
        assert_eq!(String::from_utf8_lossy(&output.stderr), "err\n");

        let started = Instant::now();
        let mut hung = Command::new("/bin/sh");
        hung.args(["-c", "sleep 30"]);
        let error = output_within(&mut hung, Duration::from_millis(300)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn a_process_that_cannot_start_is_an_error() {
        let mut missing = Command::new("/definitely/not/here");
        assert!(output_within(&mut missing, Duration::from_secs(1)).is_err());
    }
}
