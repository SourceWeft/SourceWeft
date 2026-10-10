//! Native services. These methods are deliberately not exposed as generic IPC commands.
//! A future authenticated device dispatcher must supply the account and thread identities.
pub mod credentials;
pub mod execution;
mod files;
pub mod maintenance;
mod proxy;
pub mod sandbox;
#[cfg(windows)]
pub mod windows_execution;
#[cfg(windows)]
mod windows_files;
mod workspace;

pub use workspace::{LocalHost, Workspace};

/// Stable, forward-slash paths on the device protocol; Rust canonical paths on
/// Windows carry a verbatim prefix which must not leak into agent commands.
pub fn wire_path(path: &std::path::Path) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        value
            .strip_prefix(r"\\?\")
            .unwrap_or(&value)
            .replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        value
    }
}

fn serialize_path<S: serde::Serializer>(
    path: &std::path::Path,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    serializer.serialize_str(&wire_path(path))
}

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
        Self::new("LOCAL_IO_ERROR", error.to_string())
    }
}
impl From<rusqlite::Error> for HostError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("LOCAL_DATABASE_ERROR", error.to_string())
    }
}
