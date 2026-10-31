//! Native services. These methods are deliberately not exposed as generic IPC commands.
//! A future authenticated device dispatcher must supply the account and thread identities.
#[cfg(any(unix, windows))]
pub mod bundle_install;
pub mod device_status;
pub mod execution;
pub mod maintenance;
pub mod network;
mod files;
#[cfg(any(unix, windows))]
pub(crate) mod process;
#[cfg(any(unix, windows))]
mod sidecar;
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
mod srt_exec;
pub mod privileged_setup;
pub mod readiness;
pub mod winpath;
mod win_acl;
mod win_shell;
mod windows;
mod workspace;

pub use workspace::{LocalHost, Workspace};

use serde::Serialize;

pub type Result<T> = std::result::Result<T, HostError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub code: &'static str,
    pub message: String,
}

impl HostError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for HostError {}
impl From<std::io::Error> for HostError {
    fn from(error: std::io::Error) -> Self {
        Self::new(
            if error.kind() == std::io::ErrorKind::NotFound {
                "FILE_NOT_FOUND"
            } else {
                "LOCAL_IO_ERROR"
            },
            error.to_string(),
        )
    }
}
impl From<rusqlite::Error> for HostError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("LOCAL_DATABASE_ERROR", error.to_string())
    }
}
