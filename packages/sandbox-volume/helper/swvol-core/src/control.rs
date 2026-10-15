//! Protected attachment control transport. Credentials are read only from a
//! private file and never appear in process arguments, environment or errors.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config { pub url: String, token: String, pub attachment: String, pub boot_id: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request { pub boot_id: String, pub epoch: u64, pub seq: u64, pub next_pack: u32, pub locator_chunk_ids: Vec<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub head: u64, pub confirmed_seq: u64, pub epoch: u64, pub has_more: bool,
    pub slots: serde_json::Value, pub slots_expires_at: String, pub control_expires_at: String,
    pub locators: Locators,
}
#[derive(Deserialize, Default)]
pub struct Locators { pub chunks: std::collections::HashMap<String, crate::ChunkLoc>, pub packs: std::collections::HashMap<String, String> }
pub fn validate_directory(directory: &Path) -> Result<()> {
    let md = fs::symlink_metadata(directory)?;
    if !directory.is_absolute() || !md.is_dir() || md.uid() != unsafe { libc::geteuid() } || md.mode() & 0o077 != 0 || fs::canonicalize(directory)? != directory {
        bail!("control state directory must be an absolute private real directory owned by the helper UID");
    }
    Ok(())
}
pub fn read_private<T: for<'de> Deserialize<'de>>(directory: &Path, name: &str, max: u64) -> Result<T> {
    validate_directory(directory)?;
    if name.is_empty() || name.contains('/') || name == "." || name == ".." { bail!("invalid control filename"); }
    let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(directory.join(name))?;
    let md = file.metadata()?;
    if !md.is_file() || md.uid() != unsafe { libc::geteuid() } || md.mode() & 0o077 != 0 || md.len() > max { bail!("control file ownership, permissions or size are invalid"); }
    let mut bytes = Vec::new(); (&mut file).take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max { bail!("control file exceeds its byte budget"); }
    Ok(serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("control file is malformed"))?)
}
pub fn atomic_json<T: Serialize>(directory: &Path, name: &str, value: &T) -> Result<()> {
    validate_directory(directory)?;
    if name.is_empty() || name.contains('/') || name == "." || name == ".." { bail!("invalid control filename"); }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let temporary = directory.join(format!(".{name}.{}.{stamp}.tmp", std::process::id()));
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&temporary)?;
    file.write_all(&serde_json::to_vec(value)?)?; file.sync_all()?;
    fs::rename(&temporary, directory.join(name))?;
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}
fn is_http_loopback(url: &str) -> bool {
    let Some(authority) = url.strip_prefix("http://").and_then(|tail| tail.split('/').next()) else { return false; };
    if let Ok(address) = authority.parse::<std::net::SocketAddr>() { return address.ip().is_loopback(); }
    authority.strip_prefix("localhost:").and_then(|port| port.parse::<u16>().ok()).is_some()
}
impl Config {
    pub fn load(directory: &Path, allow_http: bool) -> Result<Self> {
        let config: Self = read_private(directory, "control.json", 16 * 1024)?;
        let token = config.token.strip_prefix("svctl_").context("invalid control credential format")?;
        if token.len() != 43 || !token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') { bail!("invalid control credential format"); }
        let loopback = is_http_loopback(&config.url);
        let authority = config.url.split_once("://").and_then(|(_, tail)| tail.split('/').next()).unwrap_or("");
        if authority.contains('@') || config.url.contains('?') || config.url.contains('#') { bail!("control endpoint must not contain URL credentials, query or fragment"); }
        if !config.url.starts_with("https://") && !(allow_http && loopback) { bail!("control requires HTTPS; explicit HTTP test mode permits only loopback"); }
        if config.attachment.is_empty() || config.boot_id.is_empty() || !config.url.ends_with(&format!("/{}/control", config.attachment)) { bail!("control endpoint or attachment identity is invalid"); }
        Ok(config)
    }
    pub fn poll(&self, request: &Request) -> Result<Response> {
        if request.boot_id != self.boot_id || request.locator_chunk_ids.len() > 256 { bail!("invalid local control request identity or batch size"); }
        let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(15)).build();
        let response = agent.post(&self.url).set("Authorization", &format!("Bearer {}", self.token)).set("Content-Type", "application/json")
            .send_bytes(&serde_json::to_vec(request)?).map_err(|error| match error { ureq::Error::Status(code, _) => anyhow::anyhow!("control request rejected with HTTP {code}"), _ => anyhow::anyhow!("control transport unavailable") })?;
        if response.status() != 200 { bail!("control response status is not 200"); }
        let mut bytes = Vec::new(); response.into_reader().take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 8 * 1024 * 1024 { bail!("control response exceeds its byte budget"); }
        let response: Response = serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid control response"))?;
        if response.epoch != request.epoch || response.confirmed_seq > request.seq || response.confirmed_seq > response.head { bail!("control response identity or confirmation mismatch"); }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn http_exception_cannot_escape_loopback_with_url_userinfo() {
        assert!(is_http_loopback("http://127.0.0.1:1234/v1/a/control"));
        assert!(is_http_loopback("http://[::1]:1234/v1/a/control"));
        assert!(is_http_loopback("http://localhost:1234/v1/a/control"));
        assert!(!is_http_loopback("http://localhost:1234@remote.example/v1/a/control"));
        assert!(!is_http_loopback("http://127.0.0.1:1234@remote.example/v1/a/control"));
        assert!(!is_http_loopback("http://192.0.2.1:1234/v1/a/control"));
    }
}
