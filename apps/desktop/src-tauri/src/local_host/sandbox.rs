//! P0 Seatbelt policy probe, not a production command dispatcher. In particular,
//! network proxy and approval integration must pass validation before commands are
//! exposed to the Agent or a WebView.
use super::{HostError, Result};
use std::{path::Path, process::Command};

/// An explicit block-all profile for isolation tests. This is NOT the product's
/// default network policy (which requires the planned controlled-egress proxy).
pub fn isolation_probe_profile(workspace: &Path) -> Result<String> {
    if !cfg!(target_os = "macos") {
        return Err(HostError::new(
            "UNSUPPORTED_PLATFORM",
            "Seatbelt requires macOS.",
        ));
    }
    let root = workspace.canonicalize()?;
    let path = root
        .to_str()
        .ok_or_else(|| HostError::new("INVALID_PATH", "Workspace path must be UTF-8."))?;
    // JSON string escaping also escapes the Scheme string delimiters used here.
    let literal =
        serde_json::to_string(path).map_err(|e| HostError::new("INVALID_PATH", e.to_string()))?;
    Ok(format!(
        r#"(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (literal "/usr") (literal "/System"))
(allow file-read* (subpath "/usr/lib") (subpath "/System/Library") (subpath "/bin") (subpath "/usr/bin"))
(allow file-read* (subpath "/System/Volumes/Preboot/Cryptexes/OS"))
(allow file-read* file-write* (subpath {literal}))
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))
"#
    ))
}

pub fn probe_seatbelt(workspace: &Path) -> Result<()> {
    let profile = isolation_probe_profile(workspace)?;
    let output = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &profile, "/bin/echo", "sourceweft-seatbelt-ok"])
        .env_clear()
        .output()
        .map_err(|e| HostError::new("SANDBOX_UNAVAILABLE", e.to_string()))?;
    if !output.status.success() || output.stdout != b"sourceweft-seatbelt-ok\n" {
        return Err(HostError::new(
            "SANDBOX_UNAVAILABLE",
            format!(
                "Seatbelt probe exited with {}; stderr: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(())
}
