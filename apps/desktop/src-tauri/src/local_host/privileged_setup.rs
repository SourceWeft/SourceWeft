//! The one-time privileged Linux setup (copy bubblewrap to `/opt/sourceweft/libexec/bwrap` and
//! scope an AppArmor profile to it) for installs that cannot run package scripts, i.e. the
//! AppImage. The `.deb` runs the very same script from its maintainer scripts; CI runs it too.
//!
//! The script is embedded here as a constant. Nothing the user types or the web page sends ever
//! reaches it: the command shown in the UI and the one `run_privileged_setup` runs are both
//! built from this constant. The app never sees a password; `pkexec` shows the system
//! authentication dialog itself.

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

/// The argv `run_privileged_setup` passes to `pkexec`: no shell string, the script is one
/// argument.
#[cfg(any(target_os = "linux", test))]
fn setup_args() -> [&'static str; 5] {
    ["/bin/sh", "-c", SETUP_SCRIPT, SCRIPT_NAME, "install"]
}

/// Runs `program` (`pkexec` in production) with `setup_args()`, waits, and returns `Ok` on
/// exit status 0, otherwise the script's or pkexec's stderr text. Stdin is closed: nothing is
/// ever written to the child, in particular no password.
#[cfg(any(target_os = "linux", test))]
fn run_setup_with(program: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let output = Command::new(program)
        .args(setup_args())
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "{program} was not found. Install polkit, or run the setup command in a terminal as root."
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
    run_setup_with("pkexec")
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
            assert!(error.contains("was not found"), "{error}");
        }
    }
}
