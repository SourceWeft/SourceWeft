//! The one-time privileged setup, per platform.
//!
//! **Linux** (this file's first half): copy bubblewrap to `/opt/sourceweft/libexec/bwrap` and scope
//! an AppArmor profile to it, for installs that cannot run package scripts, i.e. the AppImage. The
//! `.deb` runs the very same script from its maintainer scripts; CI runs it too.
//!
//! **Windows** (the second half): stage `srt-win.exe` under `Program Files` and install the sandbox
//! account and network rules, through one UAC prompt (`resources/windows/sourceweft-sandbox-setup.ps1`).
//!
//! In both, the script is embedded here as a constant. Nothing the user types or the web page sends
//! ever reaches it: the command shown in the UI and the one `run_privileged_setup` runs are both
//! built from this constant (on Windows the only variable parts are values the host validated
//! itself). The app never sees a password; `pkexec` and Windows show their own authentication
//! dialogs.

/// `resources/linux/sourceweft-sandbox-setup.sh`, the single source for the `.deb` and the
/// AppImage flow.
pub(crate) const SETUP_SCRIPT: &str = include_str!("../../resources/linux/sourceweft-sandbox-setup.sh");

/// The `$0` the script sees under `sh -c`, and the name of the shipped copy in the `.deb`.
const SCRIPT_NAME: &str = "sourceweft-sandbox-setup";

/// The exact shell command shown to the user (and copied from the UI):
/// `pkexec /bin/sh -c '<script>' sourceweft-sandbox-setup install`.
///
/// Single-quote-safe because the script contains no single quote (asserted by a test).
pub fn privileged_setup_command() -> String {
    format!("pkexec /bin/sh -c '{SETUP_SCRIPT}' {SCRIPT_NAME} install")
}

/// The `pkexec` that is spawned: an absolute path, so a `pkexec` earlier on the app's `PATH`
/// can never stand in for the real one in a flow that asks for the admin password. (The command
/// shown to the user says plain `pkexec`; a terminal resolves it with the user's own `PATH`.)
#[cfg(any(target_os = "linux", test))]
const PKEXEC_PATH: &str = "/usr/bin/pkexec";

/// The argv `run_privileged_setup` passes to `pkexec`: no shell string, the script is one
/// argument.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn setup_args() -> [&'static str; 5] {
    ["/bin/sh", "-c", SETUP_SCRIPT, SCRIPT_NAME, "install"]
}

/// Runs `program` (`pkexec` in production) with `setup_args()`, waits, and returns `Ok` on
/// exit status 0, otherwise the script's or pkexec's stderr text. Stdin is closed: nothing is
/// ever written to the child, in particular no password.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn run_setup_with(program: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let output = Command::new(program)
        .args(setup_args())
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "pkexec (polkit) is not installed ({program} was not found). Install polkit, or run the setup command shown in the app in a terminal as root."
                )
            } else {
                format!("failed to start {program}: {error}")
            }
        })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return Err(stderr);
    }
    // pkexec exits 126 when the user dismissed the dialog or is not authorized and 127 when no
    // authentication agent could be reached; neither prints anything useful on stderr.
    Err(match output.status.code() {
        Some(126) => "Authorization was cancelled or denied.".to_string(),
        Some(127) => "No authentication agent is available to ask for permission.".to_string(),
        Some(code) => format!("{program} exited with status {code}"),
        None => format!("{program} was terminated by a signal"),
    })
}

/// Runs the privileged setup through `pkexec` and waits for it to finish. Blocking; call it
/// from a blocking context.
#[cfg(target_os = "linux")]
pub fn run_privileged_setup() -> Result<(), String> {
    run_setup_with(PKEXEC_PATH)
}

// ------------------------------------------------------------------------- Windows

/// `resources/windows/sourceweft-sandbox-setup.ps1`.
#[cfg(any(windows, test))]
pub(crate) const WINDOWS_SETUP_SCRIPT: &str =
    include_str!("../../resources/windows/sourceweft-sandbox-setup.ps1");

/// What the user sees when they dismiss the UAC prompt or are not allowed to approve it.
#[cfg(any(windows, test))]
const CANCELLED: &str = "Authorization was cancelled or denied.";

/// The launcher's own exit codes (the script's are 0 and the codes documented in its header):
/// the UAC prompt was dismissed, and Windows could not start the elevated process at all.
#[cfg(any(windows, test))]
const EXIT_CANCELLED: i32 = 120;
#[cfg(any(windows, test))]
const EXIT_LAUNCH_FAILED: i32 = 121;

/// The longest `-EncodedCommand` value handed to `Start-Process -Verb RunAs`. A command line is
/// limited to 32,767 characters (`CreateProcess`); the elevation request carries it through the
/// shell and the consent process, which add a little. CI has run about 12,000 characters through
/// the real launcher; this leaves room for the script to grow while staying well clear of the
/// hard limit. The embedded script is compacted (comments and indentation removed), and UTF-16LE
/// plus base64 more than doubles its size.
#[cfg(any(windows, test))]
const MAX_ENCODED_COMMAND: usize = 20_000;

/// The helper the elevated script may stage: the bundle directory it is read from and the
/// SHA-256 it must have. The hash is the application's own pin (`windows::pinned_srt_win_sha256`),
/// never a value read from the user-writable runtime.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Helper {
    /// The runtime directory that holds `srt-win.exe`.
    pub bundle: String,
    /// 64 lowercase hex characters.
    pub sha256: String,
}

/// What the elevated script is asked to do.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SetupAction {
    /// Stage `srt-win.exe` from the helper's bundle after checking its SHA-256 and install the
    /// sandbox.
    Install(Helper),
    /// Remove the sandbox account, the network rules and the staged helper. With a helper, the
    /// script falls back to that pinned, hash-verified file when the staged one is missing (an
    /// installation whose staged copy was deleted can still be removed).
    Uninstall(Option<Helper>),
}

#[cfg(any(windows, test))]
fn is_run_id(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8usize, 4, 4, 4, 12])
            .all(|(group, length)| {
                group.len() == length && group.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
}

#[cfg(any(windows, test))]
fn is_lower_hex_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The lines the script starts with, built only from validated values: the action, a GUID, the
/// `Program Files` directory the host asked Windows for (base64 of its UTF-8 bytes; the script
/// checks it against its own answer), a lowercase-hex hash and the bundle directory as base64 of
/// its UTF-8 bytes (both empty when the action has no helper). A bundle directory must be an
/// absolute local drive path (`super::winpath::to_wire_str`: no UNC, no device paths, no `..`, no
/// characters Windows forbids); since it travels as base64, a quote or a dollar sign in a user name
/// cannot be interpreted by PowerShell, and a path with one is simply a path. All five variables
/// are always defined: the script runs in strict mode.
#[cfg(any(windows, test))]
pub(crate) fn argument_block(
    action: &SetupAction,
    run_id: &str,
    program_files: &str,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if !is_run_id(run_id) {
        return Err("The setup run id is not a GUID.".to_string());
    }
    let program_files = super::windows::plain_drive_dir(program_files)
        .ok_or("The Program Files location is not a local drive path.")?;
    let (name, helper) = match action {
        SetupAction::Install(helper) => ("install", Some(helper)),
        SetupAction::Uninstall(helper) => ("uninstall", helper.as_ref()),
    };
    let (sha256, bundle) = match helper {
        None => (String::new(), String::new()),
        Some(Helper { bundle, sha256 }) => {
            if !is_lower_hex_sha256(sha256) {
                return Err("The sandbox helper checksum is not a SHA-256.".to_string());
            }
            let wire = super::winpath::to_wire_str(bundle).map_err(|error| error.message)?;
            let native = wire.replace('/', "\\");
            (sha256.clone(), STANDARD.encode(native.as_bytes()))
        }
    };
    Ok(format!(
        "$Action = \"{name}\"\n$RunId = \"{run_id}\"\n$ProgramFilesB64 = \"{}\"\n$Sha256 = \"{sha256}\"\n$BundleB64 = \"{bundle}\"\n",
        STANDARD.encode(program_files.as_bytes())
    ))
}

/// The script without comment lines, blank lines and indentation, which is all PowerShell needs
/// and a third of what `-EncodedCommand` can carry. Valid only because the script has no block
/// comments or here-strings (a test checks that).
#[cfg(any(windows, test))]
pub(crate) fn compact_script(script: &str) -> String {
    let mut out = String::new();
    for line in script.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// PowerShell's `-EncodedCommand` format: base64 of the UTF-16LE text.
#[cfg(any(windows, test))]
pub(crate) fn encode_command(text: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    STANDARD.encode(bytes)
}

/// The script plus its argument block as one `-EncodedCommand` value.
#[cfg(any(windows, test))]
pub(crate) fn encoded_setup(
    action: &SetupAction,
    run_id: &str,
    program_files: &str,
) -> Result<String, String> {
    let text = format!(
        "{}{}",
        argument_block(action, run_id, program_files)?,
        compact_script(WINDOWS_SETUP_SCRIPT)
    );
    let encoded = encode_command(&text);
    if encoded.len() > MAX_ENCODED_COMMAND {
        return Err(format!(
            "The setup script is too long to hand to Windows ({} characters).",
            encoded.len()
        ));
    }
    Ok(encoded)
}

/// The `-Command` text of the non-elevated PowerShell that asks Windows for elevation. Everything
/// in it is fixed text, the absolute path of Windows PowerShell (checked below), or base64.
/// `Start-Process -Verb RunAs` shows the UAC prompt; the elevated process runs the encoded script.
/// Exit 120 means the prompt was dismissed (recognised by the Win32 error code 1223, not by its
/// localised text), 121 that Windows could not start the process; otherwise the elevated
/// process's own exit code is returned. A missing exit code is a failure, never a success.
#[cfg(any(windows, test))]
fn launch_command(powershell: &str, encoded: &str) -> Result<String, String> {
    let plain = |text: &str| {
        text.bytes()
            .all(|b| b.is_ascii_graphic() || b == b' ')
            && !text.contains(['\'', '"', '`', '$'])
    };
    if !plain(powershell) || !encoded.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')) {
        return Err("The setup launcher was given a value it does not accept.".to_string());
    }
    Ok(format!(
        "$ErrorActionPreference = 'Stop'; try {{ \
$p = Start-Process -FilePath '{powershell}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{encoded}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; \
if ($null -eq $p.ExitCode) {{ exit {EXIT_LAUNCH_FAILED} }}; exit $p.ExitCode \
}} catch {{ \
$x = $_.Exception; \
while ($x) {{ if (($x -is [System.ComponentModel.Win32Exception]) -and ($x.NativeErrorCode -eq 1223)) {{ exit {EXIT_CANCELLED} }}; $x = $x.InnerException }}; \
[Console]::Error.WriteLine($_.Exception.Message); exit {EXIT_LAUNCH_FAILED} }}"
    ))
}

/// `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` for the given `SystemRoot`: the
/// absolute path of Windows PowerShell 5.1, never a `PATH` lookup (this process asks for
/// administrator rights, so which `powershell.exe` runs must not depend on `PATH`). `None` unless
/// `SystemRoot` is a plain local drive path.
#[cfg(any(windows, test))]
pub(crate) fn windows_powershell_path_from(system_root: Option<&str>) -> Option<String> {
    let root = system_root?.trim_end_matches(['\\', '/']);
    let bytes = root.as_bytes();
    let plain = bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && root.chars().all(|c| !c.is_control() && !matches!(c, '\'' | '"' | '`' | '$' | '%' | ';'));
    plain.then(|| {
        format!(
            "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            root.replace('/', "\\")
        )
    })
}

/// What the launcher process left: its exit code (`None` when it was ended by a signal) and its
/// standard error text.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LaunchOutput {
    pub code: Option<i32>,
    pub stderr: String,
}

/// The result file the script writes.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub(crate) struct SetupResult {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub exit: i64,
    pub message: String,
}

/// Parses the result file (UTF-8, with or without a byte-order mark) and accepts it only when it
/// belongs to this run: a stale file from an earlier run, or one a process planted, is ignored.
#[cfg(any(windows, test))]
pub(crate) fn parse_setup_result(text: &str, run_id: &str) -> Option<SetupResult> {
    let result: SetupResult = serde_json::from_str(text.trim_start_matches('\u{feff}').trim()).ok()?;
    (result.run_id == run_id).then_some(result)
}

/// What a non-zero exit code of the setup means, for the user.
#[cfg(any(windows, test))]
fn describe_exit(code: i32) -> String {
    match code {
        12 => "The sandbox network rules could not be installed.".to_string(),
        13 => "A different sandbox setup already exists on this computer and was not replaced. Remove it, then set up again.".to_string(),
        14 => "The sandbox account could not be created.".to_string(),
        17 => "The sandbox could not protect the system folders.".to_string(),
        22 => "A sandboxed command is still running. Stop it and try again.".to_string(),
        40 => "The setup did not get administrator rights.".to_string(),
        41 => "The sandbox helper in the downloaded runtime is not the one this version of SourceWeft expects. Install the runtime again.".to_string(),
        42 => "The setup could not finish.".to_string(),
        43 => "The setup could not find the sandbox runtime.".to_string(),
        44 => "Windows reports a different Program Files location than SourceWeft expected, so the setup was stopped.".to_string(),
        45 => "The folder the sandbox helper is installed in is not protected against changes by ordinary users, so the setup was stopped.".to_string(),
        46 => "The sandbox is set up on this computer but its helper is missing, and the runtime to repair it from is not available. Install the runtime again, then remove the sandbox.".to_string(),
        EXIT_LAUNCH_FAILED => "Windows could not start the setup.".to_string(),
        other => format!("The setup failed (exit code {other})."),
    }
}

/// Turns what the launcher process did into the outcome: `Ok` only for exit code 0 *and* a result
/// file of this run that also says 0. A dismissed UAC prompt is the one fixed text
/// `Authorization was cancelled or denied.`, whichever way it is reported.
#[cfg(any(windows, test))]
pub(crate) fn interpret_outcome(
    output: &LaunchOutput,
    result: Option<&SetupResult>,
) -> Result<(), String> {
    let lowered = output.stderr.to_lowercase();
    if output.code == Some(EXIT_CANCELLED)
        || lowered.contains("canceled by the user")
        || lowered.contains("cancelled by the user")
    {
        return Err(CANCELLED.to_string());
    }
    let Some(code) = output.code else {
        return Err("The setup was ended before it finished.".to_string());
    };
    if code == 0 {
        return match result {
            Some(result) if result.exit == 0 => Ok(()),
            Some(result) => Err(format!(
                "The setup reported a failure (exit code {}) after finishing.",
                result.exit
            )),
            None => Err("The setup finished without reporting a result.".to_string()),
        };
    }
    let mut message = describe_exit(code);
    let detail = match result {
        Some(result) if result.exit == i64::from(code) => result.message.trim(),
        _ => output.stderr.trim(),
    };
    if !detail.is_empty() && detail != "ok" {
        let shown: String = detail.chars().take(400).collect();
        message.push_str(&format!(" Details: {shown}"));
    }
    Err(message)
}

/// How much of the result file a failed setup's error shows.
#[cfg(any(windows, test))]
const RESULT_EXCERPT: usize = 600;

/// How long after one attempt to start the elevated setup the next one is refused. A web page can
/// ask the app to run the setup, and every attempt puts a UAC prompt on the user's screen; without
/// this a page could keep the prompt coming until it is approved by reflex. A successful setup
/// clears it, so a deliberate "set up, remove, set up" sequence is never held up.
#[cfg(any(windows, test))]
pub(crate) const ELEVATION_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(20);

/// When the last elevated attempt was started and did not succeed.
#[cfg(any(windows, test))]
#[derive(Debug, Default)]
pub(crate) struct Cooldown {
    last_attempt: Option<std::time::Instant>,
    /// Why that attempt did not succeed, so a refusal inside the window still names the cause
    /// instead of hiding it behind "wait".
    last_failure: Option<String>,
}

#[cfg(any(windows, test))]
impl Cooldown {
    /// Refuses (with the wait) when an attempt was started less than [`ELEVATION_COOLDOWN`] ago.
    pub(crate) fn check(&self, now: std::time::Instant) -> Result<(), String> {
        if let Some(last) = self.last_attempt {
            let elapsed = now.saturating_duration_since(last);
            if elapsed < ELEVATION_COOLDOWN {
                let wait = (ELEVATION_COOLDOWN - elapsed).as_secs() + 1;
                let previous = self
                    .last_failure
                    .as_deref()
                    .map(|failure| format!(" The previous attempt failed: {failure}"))
                    .unwrap_or_default();
                return Err(format!(
                    "The sandbox setup was just attempted. Wait {wait} seconds before trying again.{previous}"
                ));
            }
        }
        Ok(())
    }

    /// Records that an attempt is being started (an elevated launch is about to be made; a
    /// request refused before that, for any reason, never gets here).
    pub(crate) fn started(&mut self, now: std::time::Instant) {
        self.last_attempt = Some(now);
        self.last_failure = None;
    }

    /// The attempt that was started did not succeed.
    pub(crate) fn failed(&mut self, reason: &str) {
        self.last_failure = Some(reason.chars().take(1000).collect());
    }

    /// A successful setup or removal clears the wait.
    pub(crate) fn succeeded(&mut self) {
        self.last_attempt = None;
        self.last_failure = None;
    }
}

/// Runs the elevated setup: builds the encoded script for `action` (given the `Program Files`
/// directory the host got from Windows), refuses while the cooldown runs, starts the launcher with
/// `launch(powershell, args)`, reads the result file with `read_result`, and interprets both.
/// `launch` and `read_result` are parameters so the whole flow is tested without Windows.
#[cfg(any(windows, test))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_elevated_with(
    action: &SetupAction,
    run_id: &str,
    program_files: &str,
    powershell: &str,
    launch: &dyn Fn(&str, &[String]) -> std::io::Result<LaunchOutput>,
    read_result: &dyn Fn() -> Option<String>,
    cooldown: &std::sync::Mutex<Cooldown>,
    now: std::time::Instant,
) -> Result<(), String> {
    let encoded = encoded_setup(action, run_id, program_files)?;
    let command = launch_command(powershell, &encoded)?;
    let args = [
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-WindowStyle".to_string(),
        "Hidden".to_string(),
        "-Command".to_string(),
        command,
    ];
    {
        let mut cooldown = cooldown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        cooldown.check(now)?;
        cooldown.started(now);
    }
    let mut result_text: Option<String> = None;
    let outcome = launch(powershell, &args)
        .map_err(|error| format!("Windows PowerShell could not be started: {error}"))
        .and_then(|output| {
            result_text = read_result();
            let result = result_text.as_deref().and_then(|text| parse_setup_result(text, run_id));
            interpret_outcome(&output, result.as_ref())
        })
        // A failure that has this run's result file shows the start of that file: the script puts
        // what it found (permissions, identity, hashes) there, and a log that has it needs no
        // second run to be understood.
        .map_err(|reason| {
            match result_text.as_deref().filter(|text| parse_setup_result(text, run_id).is_some()) {
                Some(text) => {
                    let excerpt: String = text.trim_start_matches('\u{feff}').trim().chars().take(RESULT_EXCERPT).collect();
                    format!("{reason} Result file: {excerpt}")
                }
                None => reason,
            }
        });
    let mut cooldown = cooldown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match &outcome {
        Ok(()) => cooldown.succeeded(),
        Err(reason) => cooldown.failed(reason),
    }
    outcome
}

/// The checksum to give the elevated script for the bundle's `srt-win.exe`: the application's own
/// pin, and only if the file on disk has it. The bundle's manifest must list the same value, but
/// only as a consistency check: the manifest lives in the user-writable runtime directory, so
/// agreeing with it proves nothing about the file (a file that differs from its manifest is
/// reported as such, a file that agrees with its manifest but not with the pin as not being the
/// helper this release expects). A damaged, replaced or half-written bundle is refused here, with
/// the reason, instead of after a UAC prompt.
#[cfg(any(windows, test))]
pub(crate) fn helper_checksum(
    pinned: &str,
    manifest: super::Result<String>,
    on_disk: std::io::Result<String>,
) -> Result<String, String> {
    let listed = manifest.map_err(|error| error.message)?;
    let actual = on_disk
        .map_err(|error| format!("The sandbox helper in the runtime cannot be read: {error}"))?;
    if !actual.eq_ignore_ascii_case(&listed) {
        return Err("The sandbox helper in the runtime does not match its manifest. Install the runtime again.".to_string());
    }
    if !actual.eq_ignore_ascii_case(pinned) {
        return Err("The sandbox helper in the runtime is not the one this version of SourceWeft expects. Install the runtime again.".to_string());
    }
    Ok(pinned.to_ascii_lowercase())
}

/// Only one setup (or removal) at a time: a second UAC prompt for the same work would race the
/// first.
#[cfg(windows)]
static SETUP_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
struct SetupRunning;

#[cfg(windows)]
impl SetupRunning {
    fn begin() -> Result<Self, String> {
        use std::sync::atomic::Ordering;
        SETUP_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| "The sandbox setup is already running.".to_string())
    }
}

#[cfg(windows)]
impl Drop for SetupRunning {
    fn drop(&mut self) {
        SETUP_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Process-wide: the web page and the settings UI share one elevation budget.
#[cfg(windows)]
static COOLDOWN: std::sync::Mutex<Cooldown> =
    std::sync::Mutex::new(Cooldown { last_attempt: None, last_failure: None });

#[cfg(windows)]
impl super::LocalHost {
    /// Runs the one-time Windows setup: stages `srt-win.exe` from the installed runtime under
    /// `Program Files` (checked against the SHA-256 pinned in this application) and installs the
    /// sandbox account and network rules, behind a UAC prompt. Every running sandbox is stopped
    /// first (the setup replaces what they run) and cached readiness is invalidated before and
    /// after, whatever the outcome. Blocking: call it from a blocking thread.
    pub fn run_elevated_setup(&self) -> Result<(), String> {
        let _running = SetupRunning::begin()?;
        let _guard = self.begin_setup_guard()?;
        let helper = self.pinned_helper()?;
        self.run_setup_action(&SetupAction::Install(helper))
    }

    /// Removes what [`LocalHost::run_elevated_setup`] installed (the sandbox account, the network
    /// rules, the staged helper), behind a UAC prompt. If the staged helper is gone, the pinned
    /// helper of the installed runtime stands in for it; without that, a sandbox that is set up
    /// is reported as not removable (never as removed). Used by the CI suite and available to a
    /// future "remove" action. Blocking.
    pub fn run_elevated_uninstall(&self) -> Result<(), String> {
        let _running = SetupRunning::begin()?;
        let _guard = self.begin_setup_guard()?;
        let fallback = self.pinned_helper().ok();
        self.run_setup_action(&SetupAction::Uninstall(fallback))?;
        // The sandbox is gone; take back the access to the folders above workspaces that it was
        // given (`win_acl`). Only after a successful removal: a cancelled prompt leaves the
        // sandbox installed and working.
        self.revoke_ancestor_grants()
    }

    /// The runtime's `srt-win.exe` as the elevated script may stage it: it must be the file this
    /// application pins (see [`helper_checksum`]).
    fn pinned_helper(&self) -> Result<Helper, String> {
        let bundle = super::readiness::bundle_dir(&self.base);
        let helper = bundle.join("srt-win.exe");
        let sha256 = helper_checksum(
            &super::windows::pinned_srt_win_sha256()?,
            super::bundle_install::bundle_file_sha256(&bundle, "srt-win.exe"),
            super::windows::file_sha256_hex(&helper),
        )?;
        let bundle = bundle
            .to_str()
            .ok_or("The sandbox runtime location is not valid text.")?
            .to_string();
        Ok(Helper { bundle, sha256 })
    }

    /// While the setup runs, readiness reports "installing" instead of probing (a probe would run
    /// the helper the setup is replacing), and no runtime install can swap the bundle the setup
    /// has just checked. Refused while a runtime install is running. The guard clears cached
    /// readiness when it ends.
    fn begin_setup_guard(&self) -> Result<super::readiness::InstallGuard<'_>, String> {
        super::readiness::ReadinessCache::begin_install(&self.sandbox_readiness_cache).ok_or_else(
            || "The sandbox runtime is being installed; try again when it has finished.".to_string(),
        )
    }

    fn run_setup_action(&self, action: &SetupAction) -> Result<(), String> {
        let powershell = super::windows::windows_dir()
            .and_then(|dir| windows_powershell_path_from(Some(&dir)))
            .filter(|path| std::path::Path::new(path).is_file())
            .ok_or("Windows PowerShell was not found.")?;
        let program_files = super::windows::program_files_dir()
            .ok_or("The Program Files location could not be determined.")?;
        // Refused before anything is stopped: a request that will not be launched must not cost
        // the user a running sandbox.
        COOLDOWN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .check(std::time::Instant::now())?;
        self.stop_sandbox_sidecar();
        self.invalidate_sandbox_readiness();
        let run_id = uuid::Uuid::new_v4().to_string();
        let result_path = super::windows::setup_result_path_in(&program_files);
        let result = run_elevated_with(
            action,
            &run_id,
            &program_files,
            &powershell,
            &launch_elevated,
            &|| read_result_file(result_path.as_deref()),
            &COOLDOWN,
            std::time::Instant::now(),
        );
        self.invalidate_sandbox_readiness();
        result
    }
}

/// Starts the non-elevated PowerShell that asks for elevation, and waits for it: the user is
/// answering a system dialog, so there is no timeout. Its window is never shown.
#[cfg(windows)]
fn launch_elevated(powershell: &str, args: &[String]) -> std::io::Result<LaunchOutput> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let output = Command::new(powershell)
        .args(args)
        .stdin(Stdio::null())
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .output()?;
    Ok(LaunchOutput {
        code: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// The result file's text, if it is there and small.
#[cfg(windows)]
fn read_result_file(path: Option<&std::path::Path>) -> Option<String> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(path?)
        .ok()?
        .take(16 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_script_has_no_single_quote() {
        // The script is embedded inside `sh -c '...'` in the command shown to the user; one
        // single quote would end that quoting early.
        assert!(
            !SETUP_SCRIPT.contains('\''),
            "sourceweft-sandbox-setup.sh must not contain a single quote"
        );
    }

    #[test]
    fn privileged_setup_command_has_the_exact_shape() {
        let command = privileged_setup_command();
        assert_eq!(
            command,
            format!("pkexec /bin/sh -c '{SETUP_SCRIPT}' sourceweft-sandbox-setup install")
        );
        assert!(command.starts_with("pkexec /bin/sh -c '#!/bin/sh\n"));
        assert!(command.ends_with("' sourceweft-sandbox-setup install"));
    }

    #[test]
    fn pkexec_is_spawned_by_absolute_path() {
        assert_eq!(PKEXEC_PATH, "/usr/bin/pkexec");
        // A Unix absolute path; `Path::is_absolute` would be false for it on Windows.
        assert!(PKEXEC_PATH.starts_with('/'));
    }

    #[test]
    fn the_embedded_script_is_the_shipped_file() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/linux/sourceweft-sandbox-setup.sh"
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), SETUP_SCRIPT);
        assert!(SETUP_SCRIPT.starts_with("#!/bin/sh\n"));
    }

    #[cfg(unix)]
    mod run {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// A fake `pkexec`: appends its argv (one per line, `---` between calls) to `<dir>/argv`
        /// and then runs `body`.
        fn fake_pkexec(dir: &std::path::Path, body: &str) -> String {
            let path = dir.join("pkexec");
            let script = format!(
                "#!/bin/sh\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\"; done >> \"{}/argv\"\nprintf -- '---\\n' >> \"{}/argv\"\n{body}\n",
                dir.display(),
                dir.display()
            );
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::File::open(&path).unwrap().sync_all().unwrap();
            path.to_string_lossy().into_owned()
        }

        #[test]
        fn spawns_the_program_with_the_script_as_one_argument() {
            let dir = tempfile::tempdir().unwrap();
            let program = fake_pkexec(dir.path(), "exit 0");
            run_setup_with(&program).unwrap();
            let recorded = std::fs::read_to_string(dir.path().join("argv")).unwrap();
            let expected = format!(
                "/bin/sh\n-c\n{SETUP_SCRIPT}\nsourceweft-sandbox-setup\ninstall\n---\n"
            );
            assert_eq!(recorded, expected);
        }

        #[test]
        fn failure_returns_the_stderr_text() {
            let dir = tempfile::tempdir().unwrap();
            let program = fake_pkexec(dir.path(), "echo 'bubblewrap is missing' >&2; exit 1");
            assert_eq!(
                run_setup_with(&program).unwrap_err(),
                "bubblewrap is missing"
            );
        }

        #[test]
        fn pkexec_dismissal_and_missing_agent_are_explained() {
            let dir = tempfile::tempdir().unwrap();
            let cancelled = fake_pkexec(dir.path(), "exit 126");
            assert_eq!(
                run_setup_with(&cancelled).unwrap_err(),
                "Authorization was cancelled or denied."
            );
            let no_agent = fake_pkexec(dir.path(), "exit 127");
            assert_eq!(
                run_setup_with(&no_agent).unwrap_err(),
                "No authentication agent is available to ask for permission."
            );
            let other = fake_pkexec(dir.path(), "exit 3");
            assert!(run_setup_with(&other).unwrap_err().ends_with("exited with status 3"));
        }

        #[test]
        fn a_missing_program_says_so() {
            let error = run_setup_with("/definitely/not/a/pkexec").unwrap_err();
            assert!(
                error.starts_with("pkexec (polkit) is not installed (/definitely/not/a/pkexec was not found)"),
                "{error}"
            );
            assert!(error.contains("in a terminal as root"), "{error}");
        }
    }
}

#[cfg(test)]
mod windows_tests {
    use super::*;
    use std::cell::RefCell;

    const RUN_ID: &str = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
    const PF: &str = r"C:\Program Files";
    const HASH: &str = "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5";
    const POWERSHELL: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

    fn helper(bundle: &str) -> Helper {
        Helper {
            bundle: bundle.to_string(),
            sha256: HASH.to_string(),
        }
    }

    fn install(bundle: &str) -> SetupAction {
        SetupAction::Install(helper(bundle))
    }

    fn uninstall() -> SetupAction {
        SetupAction::Uninstall(None)
    }

    fn decode(encoded: &str) -> String {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let bytes = STANDARD.decode(encoded).unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    // ---- the script ------------------------------------------------------------------

    #[test]
    fn the_embedded_script_is_the_shipped_file() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/windows/sourceweft-sandbox-setup.ps1"
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), WINDOWS_SETUP_SCRIPT);
    }

    #[test]
    fn the_script_is_ascii_without_single_quotes_block_comments_or_here_strings() {
        assert!(WINDOWS_SETUP_SCRIPT.is_ascii(), "Windows PowerShell 5.1 reads BOM-less files as ANSI");
        assert!(!WINDOWS_SETUP_SCRIPT.contains('\''), "no single quote anywhere");
        // Comment compaction is only valid without these.
        for forbidden in ["<#", "#>", "@\"", "@'"] {
            assert!(!WINDOWS_SETUP_SCRIPT.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn the_script_installs_the_namespaced_range_never_forces_and_checks_the_copy() {
        let script = compact_script(WINDOWS_SETUP_SCRIPT);
        let range = format!("{}-{}", crate::local_host::windows::PROXY_PORT_RANGE[0], crate::local_host::windows::PROXY_PORT_RANGE[1]);
        assert!(script.contains(&format!("\"install\", \"--proxy-port-range\", \"{range}\"")), "{script}");
        assert!(!script.to_lowercase().contains("--force"), "an install is never forced implicitly");
        // The hash of the copy inside the admin-only directory is compared before it is run.
        let hash_check = script
            .find("(Get-FileHash -LiteralPath $Temp -Algorithm SHA256).Hash -ne $Sha256")
            .expect("the copy is hashed");
        let first_run = script.find("RunSrtWin @(\"install\"").expect("install runs");
        assert!(hash_check < first_run);
        assert!(script.contains("Move-Item -LiteralPath $Temp -Destination $Exe"));
        // Only the namespaced build's own names; upstream's are never mentioned.
        for upstream in ["srt-sandbox", "sandbox-runtime", "2c5d0ad6"] {
            assert!(!WINDOWS_SETUP_SCRIPT.contains(upstream), "{upstream}");
        }
    }

    #[test]
    fn the_script_takes_no_location_or_trust_from_the_environment() {
        let script = compact_script(WINDOWS_SETUP_SCRIPT);
        // No environment variable of any kind, in code or in the header's promises.
        for forbidden in ["$env:", "[Environment]::GetEnvironmentVariable", "ProgramW6432", "SystemRoot", "%ProgramFiles%"] {
            assert!(!script.contains(forbidden), "{forbidden}");
        }
        // Program Files comes from the .NET known-folder call and is compared with the app's.
        assert!(script.contains("$Root = [Environment]::GetFolderPath(\"ProgramFiles\")"));
        assert!(script.contains("-ne $Expected) { Finish 44"), "{script}");
        assert!(script.contains("-not [Environment]::Is64BitProcess"));
        // The directories are verified before anything is placed in them.
        let base_check = script.find("Ensure $Base").expect("the base directory is ensured and checked");
        let dispatch = script.find("if ($Action -eq \"install\")").expect("the dispatch");
        assert!(base_check < dispatch);
        let stage = script.find("function Stage").unwrap();
        let stage_check = script[stage..].find("Ensure $Dir").expect("the staging directory is ensured and checked");
        let copy = script[stage..].find("Copy-Item").unwrap();
        assert!(stage_check < copy, "the staging directory is checked before the copy");
        // Reparse points, the owner and the write-granting entries are what AssertProtected looks at.
        for part in ["-band 1024", "GetOwner([Security.Principal.SecurityIdentifier])", "GetAccessRules($true, $true", "-band 0x500D0156", "Refuse 45"] {
            assert!(script.contains(part), "{part}");
        }
    }

    /// A directory that exists must be checked as it is (one owned by an ordinary account is
    /// refused); only a directory this run creates is claimed first. Real CI evidence: on a runner
    /// whose administrator account has no split token the elevated process creates folders owned
    /// by that user, not by the Administrators group.
    #[test]
    fn only_a_directory_the_script_created_is_claimed_before_it_is_checked() {
        let script = compact_script(WINDOWS_SETUP_SCRIPT);
        let ensure = &script[script.find("function Ensure").unwrap()..script.find("function Stage").unwrap()];
        // Created only when absent, never with -Force, claimed, then checked; an existing one is only checked.
        let absent = ensure.find("if (-not (Test-Path -LiteralPath $Path))").expect("claims only when absent");
        let create = ensure.find("New-Item -ItemType Directory -Path $Path").unwrap();
        let claim = ensure.find("Claim $Path").unwrap();
        let check = ensure.find("AssertProtected $Path").unwrap();
        assert!(absent < create && create < claim && claim < check);
        assert!(!ensure.contains("-Force"), "an existing folder must not pass as ours");
        // Claim replaces owner and the whole permission list in one write (never rule by rule):
        // owner Administrators, protected DACL, SYSTEM and Administrators full control, Users
        // read and execute, inherited by what is below.
        let claim_fn = &script[script.find("function Claim").unwrap()..script.find("function Ensure").unwrap()];
        for part in [
            "SetSecurityDescriptorSddlForm(\"O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)\", [Security.AccessControl.AccessControlSections]\"Owner,Access\")",
            "[IO.Directory]::SetAccessControl($Path, $Sd)",
        ] {
            assert!(claim_fn.contains(part), "{part}");
        }
        for rule_by_rule in ["RemoveAccessRule", "Set-Acl", "GetAccessRules", "icacls"] {
            assert!(!claim_fn.contains(rule_by_rule), "{rule_by_rule}");
        }
        // The strict check itself still refuses an owner that is not SYSTEM, an administrator
        // account or TrustedInstaller, and the uninstall of an existing folder still only checks.
        let assert_fn = &script[script.find("function AssertProtected").unwrap()..script.find("function Claim").unwrap()];
        assert!(assert_fn.contains("$Trusted -notcontains $Owner"));
        assert!(assert_fn.contains("Refuse 45 \"owner of $Path is $Owner\" $Path"));
        let uninstall = &script[script.find("function Uninstall").unwrap()..script.rfind("try {").unwrap()];
        assert!(uninstall.contains("if (Test-Path -LiteralPath $Dir) { AssertProtected $Dir }"));
        assert!(!uninstall.contains("Claim"));
        // The SDDL grants only to trustees AssertProtected accepts (and Users, read and execute).
        let sddl = claim_fn.split('"').find(|part| part.starts_with("O:BA")).unwrap();
        let trustees: Vec<&str> = sddl[sddl.find('(').unwrap()..]
            .split(')')
            .filter(|ace| !ace.is_empty())
            .map(|ace| ace.rsplit(';').next().unwrap())
            .collect();
        assert_eq!(trustees, ["SY", "BA", "BU"]);
        // Nothing but Ensure may call Claim.
        assert_eq!(script.matches("Claim $").count(), 1);
    }

    /// One CI round must be enough to understand a refusal: the permissions of the folder and the
    /// identity of the process ride along in the result message, and the host shows the start of
    /// the result file.
    #[test]
    fn a_refusal_carries_the_folders_permissions_and_the_identity_of_the_process() {
        let script = compact_script(WINDOWS_SETUP_SCRIPT);
        let refuse = &script[script.find("function Refuse").unwrap()..script.find("function AssertProtected").unwrap()];
        assert!(refuse.contains("\"; sddl=\" + (Sddl $Path)") && refuse.contains("(WhoAmI)"), "{refuse}");
        let sddl = &script[script.find("function Sddl").unwrap()..script.find("function Refuse").unwrap()];
        assert!(sddl.contains("GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)"));
        let who = &script[script.find("function WhoAmI").unwrap()..script.find("function Sddl").unwrap()];
        for part in ["$Id.User.Value", "$Id.Owner.Value", "IsInRole"] {
            assert!(who.contains(part), "{part}");
        }
        // The exits that mean "refused" say what was found, not just a code.
        for exit in ["Finish 40 (WhoAmI)", "Finish 41 (", "Finish 44 (", "Finish 46 \"the sourceweft-sandbox account exists"] {
            assert!(script.contains(exit), "{exit}");
        }
        assert!(!script.contains("Finish 45"), "45 goes through Refuse");
    }

    #[test]
    fn a_failed_setup_shows_the_start_of_its_result_file() {
        let cooldown = Mutex::new(Cooldown::default());
        let detail = format!("owner of C:/x is S-1-5-21-1-2-3-500; sddl=O:S-1-5-21-1-2-3-500D:{}", "(A;;FA;;;SY)".repeat(80));
        let text = format!("{{\"runId\":\"{RUN_ID}\",\"exit\":45,\"message\":\"{detail}\"}}");
        let failing = |_: &str, _: &[String]| -> std::io::Result<LaunchOutput> { Ok(output(Some(45), "")) };
        let read = || Some(text.clone());
        let error = run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &failing, &read, &cooldown, Instant::now()).unwrap_err();
        let (_, excerpt) = error.split_once(" Result file: ").unwrap();
        assert_eq!(excerpt.chars().count(), 600, "the first 600 characters of the file");
        assert!(excerpt.starts_with(&text[..600]));
        assert!(excerpt.contains("S-1-5-21-1-2-3-500"));
        // A result file of another run is not shown (it says nothing about this one) ...
        let stale = |_: &str, _: &[String]| -> std::io::Result<LaunchOutput> { Ok(output(Some(13), "boom")) };
        let other = || Some("{\"runId\":\"11111111-1111-4111-8111-111111111111\",\"exit\":0,\"message\":\"ok\"}".to_string());
        let error = run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &stale, &other, &Mutex::new(Cooldown::default()), Instant::now()).unwrap_err();
        assert!(!error.contains("Result file"), "{error}");
        // ... and neither is one for a launch that failed before the script ran or a success.
        let ok = run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &ok_launch, &ok_result, &Mutex::new(Cooldown::default()), Instant::now());
        assert!(ok.is_ok());
        // The cooldown's refusal repeats the cause, with the file excerpt.
        let again = run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &failing, &read, &cooldown, Instant::now()).unwrap_err();
        assert!(again.contains("The previous attempt failed: ") && again.contains("S-1-5-21-1-2-3-500"), "{again}");
    }

    #[test]
    fn the_script_uninstall_falls_back_to_the_pinned_helper_and_reports_honestly() {
        let script = compact_script(WINDOWS_SETUP_SCRIPT);
        let uninstall = &script[script.find("function Uninstall").unwrap()..script.rfind("try {").unwrap()];
        // The staged helper first; when it is missing, the hash-checked one from the runtime
        // (Stage verifies the copy against the pin before it is ever run).
        let staged = uninstall.find("Test-Path -LiteralPath $Exe -PathType Leaf").unwrap();
        let fallback = uninstall.find("Stage $Source").expect("falls back to the pinned helper");
        let run = uninstall.find("RunSrtWin @(\"uninstall\")").unwrap();
        assert!(staged < fallback && fallback < run);
        // With neither helper, an existing sandbox account is a failure (46), not a silent success.
        assert!(uninstall.contains("Get-LocalUser -Name \"sourceweft-sandbox\""));
        assert!(uninstall.contains("Finish 46"));
        // The staged directory goes, and a directory that cannot be removed is reported.
        assert!(uninstall.contains("Remove-Item -LiteralPath $Dir -Recurse -Force"));
        assert!(uninstall.contains("Finish 42 \"The staged folder could not be removed.\""));
        assert!(uninstall.rfind("Finish 0 \"ok\"").unwrap() > uninstall.find("Finish 42").unwrap());
    }

    #[test]
    fn the_proxy_port_range_matches_the_sidecar_policy() {
        let policy = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sandbox-sidecar/src/policy.ts"
        ))
        .unwrap();
        let [low, high] = crate::local_host::windows::PROXY_PORT_RANGE;
        assert!(
            policy.contains(&format!("WINDOWS_PROXY_PORT_RANGE: [number, number] = [{low}, {high}]")),
            "policy.ts and windows.rs must name the same proxy port range"
        );
    }

    #[test]
    fn compaction_keeps_code_and_drops_only_comments_blank_lines_and_indentation() {
        assert_eq!(
            compact_script("# top\n\n  $a = 1 # not a full-line comment\n    # indented comment\n\t$b = 2\n"),
            "$a = 1 # not a full-line comment\n$b = 2\n"
        );
        let compact = compact_script(WINDOWS_SETUP_SCRIPT);
        assert!(!compact.lines().any(|line| line.starts_with('#')));
        assert!(compact.contains("function Finish"));
        assert!(compact.len() < WINDOWS_SETUP_SCRIPT.len() / 2 + 400);
    }

    #[test]
    fn the_real_encoded_command_fits_the_command_line_budget() {
        for action in [install(r"C:\Users\someone\AppData\Roaming\com.sourceweft.desktop\sandbox\current"), uninstall(), SetupAction::Uninstall(Some(helper(r"C:\Users\someone\AppData\Roaming\com.sourceweft.desktop\sandbox\current")))] {
            let encoded = encoded_setup(&action, RUN_ID, PF).unwrap();
            assert!(encoded.len() <= MAX_ENCODED_COMMAND, "{} characters", encoded.len());
            let command = launch_command(POWERSHELL, &encoded).unwrap();
            assert!(command.len() < MAX_ENCODED_COMMAND + 700, "{}", command.len());
        }
        // A very long (but legal) bundle path still fits, or is refused with a reason.
        let long = format!(r"C:\{}", vec!["a".repeat(60); 3].join(r"\"));
        assert!(encoded_setup(&install(&long), RUN_ID, PF).is_ok());
    }

    // ---- the argument block ----------------------------------------------------------

    #[test]
    fn the_argument_block_carries_only_validated_values() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let block = argument_block(&install(r"C:\Users\me\AppData\Roaming\app\sandbox\current"), RUN_ID, PF).unwrap();
        let lines: Vec<&str> = block.lines().collect();
        assert_eq!(lines[0], "$Action = \"install\"");
        assert_eq!(lines[1], format!("$RunId = \"{RUN_ID}\""));
        assert_eq!(lines[2], format!("$ProgramFilesB64 = \"{}\"", STANDARD.encode(PF)));
        assert_eq!(lines[3], format!("$Sha256 = \"{HASH}\""));
        assert_eq!(lines[4], format!("$BundleB64 = \"{}\"", STANDARD.encode(r"C:\Users\me\AppData\Roaming\app\sandbox\current")));
        assert_eq!(lines.len(), 5);
        // Every variable is defined for every action: the script runs in strict mode.
        assert_eq!(
            argument_block(&uninstall(), RUN_ID, "C:/Program Files/").unwrap(),
            format!(
                "$Action = \"uninstall\"\n$RunId = \"{RUN_ID}\"\n$ProgramFilesB64 = \"{}\"\n$Sha256 = \"\"\n$BundleB64 = \"\"\n",
                STANDARD.encode(PF)
            )
        );
        let with_fallback = argument_block(&SetupAction::Uninstall(Some(helper(r"C:\rt"))), RUN_ID, PF).unwrap();
        assert!(with_fallback.starts_with("$Action = \"uninstall\"\n"));
        assert!(with_fallback.contains(&format!("$Sha256 = \"{HASH}\"")));
        assert!(with_fallback.contains(&format!("$BundleB64 = \"{}\"", STANDARD.encode(r"C:\rt"))));
    }

    #[test]
    fn the_program_files_directory_must_be_a_local_drive_path() {
        let action = uninstall();
        for bad in ["", "relative", r"\\server\share", "C:", r"C:\", "C:\\x\n", "C:rel"] {
            assert!(argument_block(&action, RUN_ID, bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_path_travels_as_base64_so_no_character_in_it_can_be_interpreted() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        for dir in [
            r"C:\Users\O'Brien\AppData\Roaming\app\sandbox\current",
            r"C:\Users\a b\$(calc)\sandbox",
            r"C:\Users\`n;x&y%PATH%\current",
            "C:/Users/\u{4e2d}\u{6587}/[x]/current",
        ] {
            let block = argument_block(&install(dir), RUN_ID, PF).unwrap();
            let value = block
                .lines()
                .find_map(|line| line.strip_prefix("$BundleB64 = \"")?.strip_suffix('"'))
                .unwrap();
            assert!(value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')), "{value}");
            let decoded = String::from_utf8(STANDARD.decode(value).unwrap()).unwrap();
            assert_eq!(decoded, dir.replace('/', "\\"));
            // The script text itself holds nothing of it.
            assert!(!block.contains("calc") && !block.contains("O'Brien"));
        }
    }

    #[test]
    fn the_argument_block_refuses_unvalidated_values() {
        let ok = r"C:\Users\me\sandbox\current";
        for (action, why) in [
            (install(r"relative\dir"), "relative"),
            (install(r"\\server\share\dir"), "UNC"),
            (install(r"\\?\UNC\server\share\dir"), "verbatim UNC"),
            (install(r"C:rel"), "drive relative"),
            (install(r"C:\Users\..\x"), "dot dot"),
            (install("C:\\Users\\me\n\\x"), "control character"),
            (install(r"C:\Users\a|b"), "forbidden character"),
            (install(r"\\.\C:\x"), "device path"),
            (install(""), "empty"),
            (SetupAction::Install(Helper { bundle: ok.into(), sha256: HASH.to_uppercase() }), "uppercase hash"),
            (SetupAction::Install(Helper { bundle: ok.into(), sha256: HASH[..63].into() }), "short hash"),
            (SetupAction::Install(Helper { bundle: ok.into(), sha256: format!("{}\"; calc; \"", &HASH[..40]) }), "injection in hash"),
            (SetupAction::Install(Helper { bundle: ok.into(), sha256: String::new() }), "empty hash"),
        ] {
            assert!(argument_block(&action, RUN_ID, PF).is_err(), "{why}");
        }
        for run_id in ["", "x", "0B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D", "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4", "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d\"; x"] {
            assert!(argument_block(&uninstall(), run_id, PF).is_err(), "{run_id:?}");
        }
    }

    #[test]
    fn the_encoded_command_is_utf16le_base64_of_the_block_then_the_compact_script() {
        let action = install(r"C:\Users\me\sandbox\current");
        let encoded = encoded_setup(&action, RUN_ID, PF).unwrap();
        let text = decode(&encoded);
        assert!(text.starts_with(&argument_block(&action, RUN_ID, PF).unwrap()));
        assert!(text.ends_with(&compact_script(WINDOWS_SETUP_SCRIPT)));
        assert_eq!(decode(&encode_command("Write-Output \"h\u{e9}\"")), "Write-Output \"h\u{e9}\"");
    }

    // ---- the launcher ----------------------------------------------------------------

    #[test]
    fn the_launcher_is_windows_powershell_by_absolute_path_with_a_runas_start_process() {
        let encoded = encoded_setup(&uninstall(), RUN_ID, PF).unwrap();
        let command = launch_command(POWERSHELL, &encoded).unwrap();
        assert!(command.contains(&format!("-FilePath '{POWERSHELL}'")));
        assert!(command.contains("-Verb RunAs -Wait -PassThru -WindowStyle Hidden"));
        assert!(command.contains(&format!("'-EncodedCommand','{encoded}'")));
        assert!(!command.contains('"'), "no double quote: the argument is quoted by the OS command line rules only");
        // Cancellation is recognised by the Win32 error code, not by localised text.
        assert!(command.contains("NativeErrorCode -eq 1223"));
        // A missing exit code is a failure.
        assert!(command.contains("if ($null -eq $p.ExitCode) { exit 121 }"));
    }

    #[test]
    fn the_launcher_refuses_values_it_cannot_quote() {
        let encoded = encoded_setup(&uninstall(), RUN_ID, PF).unwrap();
        assert!(launch_command(r"C:\x'y\powershell.exe", &encoded).is_err());
        assert!(launch_command("C:\\x\n\\powershell.exe", &encoded).is_err());
        assert!(launch_command(POWERSHELL, "abc'; calc; '").is_err());
        assert!(launch_command(POWERSHELL, "ab c").is_err());
    }

    #[test]
    fn windows_powershell_is_found_by_system_root_never_by_path() {
        assert_eq!(windows_powershell_path_from(Some(r"C:\Windows")).as_deref(), Some(POWERSHELL));
        assert_eq!(windows_powershell_path_from(Some("D:/WINNT/")).as_deref(), Some(r"D:\WINNT\System32\WindowsPowerShell\v1.0\powershell.exe"));
        for bad in [None, Some(""), Some("Windows"), Some(r"\\server\share"), Some("C:"), Some(r"C:\Win'dows"), Some("C:\\Win\ndows"), Some(r"C:\%x%")] {
            assert_eq!(windows_powershell_path_from(bad), None, "{bad:?}");
        }
    }

    // ---- the outcome -----------------------------------------------------------------

    fn output(code: Option<i32>, stderr: &str) -> LaunchOutput {
        LaunchOutput { code, stderr: stderr.to_string() }
    }

    fn result(exit: i64, message: &str) -> SetupResult {
        SetupResult { run_id: RUN_ID.to_string(), exit, message: message.to_string() }
    }

    #[test]
    fn a_dismissed_uac_prompt_is_the_one_fixed_text() {
        assert_eq!(CANCELLED, "Authorization was cancelled or denied.");
        for out in [
            output(Some(120), ""),
            output(Some(121), "Start-Process : This command cannot be run due to the error: The operation was canceled by the user."),
            output(Some(1), "The operation was CANCELLED BY THE USER."),
        ] {
            assert_eq!(interpret_outcome(&out, None).unwrap_err(), "Authorization was cancelled or denied.");
            // Even a stale "ok" result cannot turn it into a success.
            assert_eq!(interpret_outcome(&out, Some(&result(0, "ok"))).unwrap_err(), CANCELLED);
        }
    }

    #[test]
    fn success_needs_exit_zero_and_a_result_of_this_run_that_says_zero() {
        assert_eq!(interpret_outcome(&output(Some(0), ""), Some(&result(0, "ok"))), Ok(()));
        assert!(interpret_outcome(&output(Some(0), ""), None).unwrap_err().contains("without reporting a result"));
        assert!(interpret_outcome(&output(Some(0), ""), Some(&result(13, "x"))).unwrap_err().contains("exit code 13"));
        assert!(interpret_outcome(&output(None, ""), None).is_err());
    }

    #[test]
    fn failures_are_explained_with_the_scripts_detail() {
        let err = interpret_outcome(&output(Some(13), ""), Some(&result(13, "srt-win: error: already installed with port_range=60080-60089"))).unwrap_err();
        assert!(err.starts_with("A different sandbox setup already exists"), "{err}");
        assert!(err.contains("Details: srt-win: error: already installed"), "{err}");
        for (code, start) in [
            (12, "The sandbox network rules could not be installed."),
            (14, "The sandbox account could not be created."),
            (17, "The sandbox could not protect"),
            (22, "A sandboxed command is still running."),
            (40, "The setup did not get administrator rights."),
            (41, "The sandbox helper in the downloaded runtime is not the one this version of SourceWeft expects."),
            (42, "The setup could not finish."),
            (43, "The setup could not find the sandbox runtime."),
            (44, "Windows reports a different Program Files location"),
            (45, "The folder the sandbox helper is installed in is not protected"),
            (46, "The sandbox is set up on this computer but its helper is missing"),
            (121, "Windows could not start the setup."),
            (99, "The setup failed (exit code 99)."),
        ] {
            let err = interpret_outcome(&output(Some(code), "boom"), None).unwrap_err();
            assert!(err.starts_with(start), "{code}: {err}");
        }
        // The launcher's own stderr is the detail when no result of this run exists; a result of
        // another exit code is not used.
        assert!(interpret_outcome(&output(Some(121), "Access is denied"), None).unwrap_err().ends_with("Details: Access is denied"));
        assert!(!interpret_outcome(&output(Some(12), ""), Some(&result(99, "stale"))).unwrap_err().contains("stale"));
        // Long details are cut.
        let long = "x".repeat(2000);
        assert!(interpret_outcome(&output(Some(12), ""), Some(&result(12, &long))).unwrap_err().len() < 600);
    }

    #[test]
    fn a_result_file_counts_only_for_its_own_run() {
        let text = format!("{{\"runId\":\"{RUN_ID}\",\"exit\":0,\"message\":\"ok\"}}");
        assert_eq!(parse_setup_result(&text, RUN_ID), Some(result(0, "ok")));
        assert_eq!(parse_setup_result(&format!("\u{feff}{text}\r\n"), RUN_ID), Some(result(0, "ok")), "Windows PowerShell may add a byte-order mark");
        assert_eq!(parse_setup_result(&text, "11111111-1111-4111-8111-111111111111"), None);
        for bad in ["", "{", "[]", "{\"runId\":1}", "{\"runId\":\"x\",\"exit\":\"0\",\"message\":\"\"}"] {
            assert_eq!(parse_setup_result(bad, RUN_ID), None, "{bad}");
        }
    }

    // ---- the whole flow, with an injected launcher ------------------------------------

    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// `run_elevated_with` for tests: a fresh cooldown unless one is given.
    fn run(
        action: &SetupAction,
        run_id: &str,
        powershell: &str,
        launch: &dyn Fn(&str, &[String]) -> std::io::Result<LaunchOutput>,
        read_result: &dyn Fn() -> Option<String>,
    ) -> Result<(), String> {
        run_elevated_with(action, run_id, PF, powershell, launch, read_result, &Mutex::new(Cooldown::default()), Instant::now())
    }

    #[test]
    fn the_flow_launches_powershell_with_the_encoded_script_and_reads_the_result() {
        let seen: RefCell<Vec<(String, Vec<String>)>> = RefCell::new(Vec::new());
        let launch = |program: &str, args: &[String]| -> std::io::Result<LaunchOutput> {
            seen.borrow_mut().push((program.to_string(), args.to_vec()));
            Ok(output(Some(0), ""))
        };
        let read = || Some(format!("{{\"runId\":\"{RUN_ID}\",\"exit\":0,\"message\":\"ok\"}}"));
        run(&install(r"C:\Users\me\sandbox\current"), RUN_ID, POWERSHELL, &launch, &read).unwrap();
        let seen = seen.borrow();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, POWERSHELL);
        let args = &seen[0].1;
        assert_eq!(&args[..5], ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command"]);
        assert_eq!(args.len(), 6);
        assert!(args[5].contains("-Verb RunAs"));
    }

    #[test]
    fn the_flow_maps_a_cancelled_launch_and_reports_a_launcher_that_cannot_start() {
        let cancelled = |_: &str, _: &[String]| -> std::io::Result<LaunchOutput> {
            Ok(output(Some(EXIT_CANCELLED), ""))
        };
        assert_eq!(
            run(&uninstall(), RUN_ID, POWERSHELL, &cancelled, &|| None).unwrap_err(),
            "Authorization was cancelled or denied."
        );
        let missing = |_: &str, _: &[String]| -> std::io::Result<LaunchOutput> {
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        };
        assert!(run(&uninstall(), RUN_ID, POWERSHELL, &missing, &|| None)
            .unwrap_err()
            .starts_with("Windows PowerShell could not be started"));
    }

    #[test]
    fn nothing_is_launched_for_invalid_input() {
        let launch = |_: &str, _: &[String]| -> std::io::Result<LaunchOutput> { panic!("must not launch") };
        assert!(run(&install(r"relative"), RUN_ID, POWERSHELL, &launch, &|| None).is_err());
        assert!(run(&uninstall(), "not a guid", POWERSHELL, &launch, &|| None).is_err());
        assert!(run(&uninstall(), RUN_ID, "C:\\a'b\\powershell.exe", &launch, &|| None).is_err());
        let cooldown = Mutex::new(Cooldown::default());
        assert!(run_elevated_with(&uninstall(), RUN_ID, "relative", POWERSHELL, &launch, &|| None, &cooldown, Instant::now()).is_err());
        // Input that was refused never started an attempt.
        assert!(cooldown.lock().unwrap().check(Instant::now()).is_ok());
    }

    // ---- the elevation cooldown ---------------------------------------------------------

    fn ok_launch(_: &str, _: &[String]) -> std::io::Result<LaunchOutput> {
        Ok(output(Some(0), ""))
    }

    fn ok_result() -> Option<String> {
        Some(format!("{{\"runId\":\"{RUN_ID}\",\"exit\":0,\"message\":\"ok\"}}"))
    }

    #[test]
    fn a_second_attempt_inside_the_cooldown_is_refused_without_launching() {
        let cooldown = Mutex::new(Cooldown::default());
        let start = Instant::now();
        let launches = RefCell::new(0);
        let cancelled = |_: &str, _: &[String]| -> std::io::Result<LaunchOutput> {
            *launches.borrow_mut() += 1;
            Ok(output(Some(EXIT_CANCELLED), ""))
        };
        let attempt = |at: Instant| run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &cancelled, &|| None, &cooldown, at);
        assert_eq!(attempt(start).unwrap_err(), "Authorization was cancelled or denied.");
        let refused = attempt(start + Duration::from_secs(5)).unwrap_err();
        assert!(refused.contains("Wait 16 seconds"), "{refused}");
        assert_eq!(*launches.borrow(), 1, "a refused attempt must not put a UAC prompt on the screen");
        // The refused attempt did not extend the wait.
        assert!(attempt(start + ELEVATION_COOLDOWN).is_err());
        assert_eq!(*launches.borrow(), 2);
    }

    #[test]
    fn a_refusal_inside_the_window_names_why_the_previous_attempt_failed() {
        let cooldown = Mutex::new(Cooldown::default());
        let start = Instant::now();
        let failing = |_: &str, _: &[String]| -> std::io::Result<LaunchOutput> { Ok(output(Some(45), "")) };
        let result45 = || Some(format!("{{\"runId\":\"{RUN_ID}\",\"exit\":45,\"message\":\"owner of C:\\\\x is S-1-5-21-1-2-3-500\"}}"));
        let first = run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &failing, &result45, &cooldown, start).unwrap_err();
        assert!(first.contains("not protected"), "{first}");
        let second = run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &failing, &result45, &cooldown, start + Duration::from_secs(2)).unwrap_err();
        assert!(second.starts_with("The sandbox setup was just attempted. Wait 19 seconds"), "{second}");
        assert!(second.contains("The previous attempt failed: The folder the sandbox helper is installed in is not protected"), "{second}");
        // After the window the next attempt is a fresh one.
        assert!(run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &ok_launch, &ok_result, &cooldown, start + ELEVATION_COOLDOWN).is_ok());
    }

    /// Only a launch that was made starts the wait: a request refused before it (bad input, a
    /// helper that does not match, the cooldown itself) must not hold up the next, valid one.
    #[test]
    fn a_request_refused_before_any_launch_does_not_start_the_cooldown() {
        let cooldown = Mutex::new(Cooldown::default());
        let start = Instant::now();
        let launch = |_: &str, _: &[String]| -> std::io::Result<LaunchOutput> { panic!("must not launch") };
        assert!(run_elevated_with(&install(r"relative"), RUN_ID, PF, POWERSHELL, &launch, &|| None, &cooldown, start).is_err());
        assert!(run_elevated_with(&uninstall(), RUN_ID, "relative", POWERSHELL, &launch, &|| None, &cooldown, start).is_err());
        assert!(cooldown.lock().unwrap().check(start).is_ok());
        // The refusal for being inside the window does not extend the window either.
        cooldown.lock().unwrap().started(start);
        for step in [1, 5, 10, 19] {
            assert!(run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &launch, &|| None, &cooldown, start + Duration::from_secs(step)).is_err());
        }
        assert!(run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &ok_launch, &ok_result, &cooldown, start + ELEVATION_COOLDOWN).is_ok());
    }

    #[test]
    fn a_failed_attempt_and_a_launcher_that_cannot_start_both_start_the_cooldown() {
        let start = Instant::now();
        for launch in [
            (|_: &str, _: &[String]| Ok(output(Some(13), ""))) as fn(&str, &[String]) -> std::io::Result<LaunchOutput>,
            |_: &str, _: &[String]| Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
        ] {
            let cooldown = Mutex::new(Cooldown::default());
            let go = |at: Instant| run_elevated_with(&uninstall(), RUN_ID, PF, POWERSHELL, &launch, &ok_result, &cooldown, at);
            assert!(go(start).is_err());
            assert!(go(start + Duration::from_secs(1)).unwrap_err().contains("just attempted"));
        }
    }

    #[test]
    fn a_successful_setup_clears_the_cooldown() {
        let cooldown = Mutex::new(Cooldown::default());
        let start = Instant::now();
        let go = |action: &SetupAction, at: Instant| run_elevated_with(action, RUN_ID, PF, POWERSHELL, &ok_launch, &ok_result, &cooldown, at);
        go(&install(r"C:\rt"), start).unwrap();
        // Set up, remove, set up again: never held up.
        go(&uninstall(), start + Duration::from_secs(1)).unwrap();
        go(&install(r"C:\rt"), start + Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn the_cooldown_ends_after_the_window() {
        let mut cooldown = Cooldown::default();
        let start = Instant::now();
        assert!(cooldown.check(start).is_ok());
        cooldown.started(start);
        assert!(cooldown.check(start + ELEVATION_COOLDOWN - Duration::from_millis(1)).is_err());
        assert!(cooldown.check(start + ELEVATION_COOLDOWN).is_ok());
        cooldown.started(start);
        cooldown.succeeded();
        assert!(cooldown.check(start).is_ok());
        assert_eq!(ELEVATION_COOLDOWN, Duration::from_secs(20));
    }

    // ---- the checksum handed to the script ----------------------------------------------

    #[test]
    fn the_helper_checksum_is_the_pin_and_only_if_the_file_and_its_manifest_have_it() {
        use crate::local_host::HostError;
        assert_eq!(helper_checksum(HASH, Ok(HASH.into()), Ok(HASH.into())), Ok(HASH.to_string()));
        // Hex case does not matter; the script gets the lowercase pin.
        assert_eq!(helper_checksum(HASH, Ok(HASH.to_uppercase()), Ok(HASH.into())), Ok(HASH.to_string()));
        // A file that is not what its manifest says.
        assert!(helper_checksum(HASH, Ok(HASH.into()), Ok("0".repeat(64))).unwrap_err().contains("does not match its manifest"));
        // A file that agrees with a manifest that agrees with nothing the app knows: the manifest
        // sits in user-writable app data, so a rewritten pair is refused by the pin alone.
        let other = "0".repeat(64);
        let err = helper_checksum(HASH, Ok(other.clone()), Ok(other)).unwrap_err();
        assert!(err.contains("not the one this version of SourceWeft expects"), "{err}");
        assert!(helper_checksum(HASH, Err(HostError::new("SANDBOX_BUNDLE_INVALID", "The runtime does not contain srt-win.exe.")), Ok(HASH.into())).unwrap_err().contains("does not contain"));
        assert!(helper_checksum(HASH, Ok(HASH.into()), Err(std::io::Error::from(std::io::ErrorKind::NotFound))).unwrap_err().contains("cannot be read"));
    }
}

/// Windows-only checks that need the real PowerShell: the script parses, and the encoded form is
/// what `-EncodedCommand` expects. A syntax error in the script cannot be seen on any other OS, so
/// CI's Windows jobs run these.
#[cfg(all(test, windows))]
mod powershell_tests {
    use super::*;
    use std::process::Command;

    fn powershell() -> String {
        windows_powershell_path_from(crate::local_host::windows::windows_dir().as_deref()).unwrap()
    }

    /// Parses `text` with PowerShell's own parser (the script arrives on standard input, so no
    /// path or environment is involved) and returns its error messages, one per line.
    fn parse_errors(text: &str) -> String {
        use std::io::Write;
        use std::process::Stdio;
        let mut child = Command::new(powershell())
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$t = $null; $e = $null; $s = [Console]::In.ReadToEnd(); [void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$t, [ref]$e); $e | ForEach-Object { $_.Message + ' at line ' + $_.Extent.StartLineNumber }",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn the_parser_check_itself_finds_errors() {
        assert_eq!(parse_errors("$a = 1\n"), "");
        assert!(!parse_errors("function F { \n").is_empty());
        assert!(!parse_errors("if ($a -eq ) { }").is_empty());
    }

    #[test]
    fn the_shipped_script_parses() {
        assert_eq!(parse_errors(WINDOWS_SETUP_SCRIPT), "");
    }

    #[test]
    fn the_script_as_the_app_sends_it_parses_for_every_action() {
        let run_id = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
        for (name, action) in [
            (
                "install",
                SetupAction::Install(Helper {
                    bundle: r"C:\Users\O'Brien\AppData\Roaming\app\sandbox\current".to_string(),
                    sha256: "7".repeat(64),
                }),
            ),
            ("uninstall", SetupAction::Uninstall(None)),
            (
                "uninstall with a fallback helper",
                SetupAction::Uninstall(Some(Helper {
                    bundle: r"C:\Users\a\sandbox\current".to_string(),
                    sha256: "7".repeat(64),
                })),
            ),
        ] {
            let text = format!(
                "{}{}",
                argument_block(&action, run_id, r"C:\Program Files").unwrap(),
                compact_script(WINDOWS_SETUP_SCRIPT)
            );
            assert_eq!(parse_errors(&text), "", "{name}");
        }
    }

    #[test]
    fn an_encoded_command_runs_and_its_exit_code_comes_back() {
        let encoded = encode_command("Write-Output \"h\u{e9}llo\"; exit 7");
        let output = Command::new(powershell())
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert!(String::from_utf8_lossy(&output.stdout).contains("llo"));
    }

    #[test]
    fn the_real_launcher_command_is_accepted_by_the_command_line_parser() {
        // Not elevated: a non-existent target makes Start-Process fail, which must come back as
        // the launcher's own failure code and not as a PowerShell parse error.
        let encoded = encoded_setup(&SetupAction::Uninstall(None), "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", r"C:\Program Files").unwrap();
        let command = launch_command(r"C:\definitely\not\here\powershell.exe", &encoded).unwrap();
        let output = Command::new(powershell())
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &command])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(EXIT_LAUNCH_FAILED), "{}", String::from_utf8_lossy(&output.stderr));
    }
}
