//! Downloads, verifies and installs the sandbox runtime bundle (`<app data>/sandbox/current`).
//!
//! The bundle is a release asset of the exact app version (`sourceweft-sandbox-<target>.tar.gz`
//! plus its `.sig`, see `scripts/ci/sandbox-bundle.mjs` for the archive contract). It is only
//! ever fetched because the user asked for it, and nothing here is configurable at run time: the
//! URL is derived from the app version, the signer is the updater key embedded in the build, and
//! the platform comes from the build target.
//!
//! The flow, in order, with the first failure ending it (a stale or partial result is never
//! left behind; the previous `current` is only replaced by a fully verified one):
//!
//! 1. refuse a build that has no updater key (it cannot verify anything);
//! 2. download the archive and the signature into `.download-<id>/` (https only, size capped);
//! 3. verify the minisign signature over the whole archive file BEFORE reading any entry;
//! 4. extract strictly into `.staging-<id>/`: only plain files at the archive root, names from a
//!    safe character set, `manifest.json` first, exactly the files the manifest names, with
//!    per-file and total size caps; the manifest must match this app (schema, protocol version,
//!    app version, target) and every file its size and SHA-256;
//! 5. swap the staging directory in for `current` (the old one is moved aside first and put
//!    back if anything goes wrong), then delete the old one.
use super::{
    readiness::{settled_readiness, ReadinessCache, SandboxReadiness},
    sidecar::SANDBOX_PROTOCOL_VERSION,
    HostError, LocalHost, Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::read::GzDecoder;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

/// Where the signed release assets live; the app version selects the tag.
const RELEASE_BASE: &str = "https://github.com/SourceWeft/SourceWeft/releases/download";
/// The only platform a runtime is published for (`desktop-release.yml`, Linux leg).
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const RELEASE_TARGET: Option<&str> = Some("x86_64-unknown-linux-gnu");
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
const RELEASE_TARGET: Option<&str> = None;

/// Largest archive or signature download accepted (the same cap `sandbox-bundle.mjs` packs to).
const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;
/// A download is abandoned when no byte arrives for this long (a stalled connection)...
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// ...or, however steadily it trickles, after this long overall. A slow link is fine as long as
/// it keeps moving; a 256 MiB archive at 0.5 Mbit/s still fits.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Shown when the platform has no published runtime.
pub(crate) const NO_RUNTIME_PUBLISHED: &str = "No sandbox runtime is published for this platform.";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const MAX_FILES: usize = 32;
const MANIFEST_FILENAME: &str = "manifest.json";
const BLOCK: usize = 512;

pub const SANDBOX_DOWNLOAD_FAILED: &str = "SANDBOX_DOWNLOAD_FAILED";
pub const SANDBOX_SIGNATURE_INVALID: &str = "SANDBOX_SIGNATURE_INVALID";
pub const SANDBOX_BUNDLE_INVALID: &str = "SANDBOX_BUNDLE_INVALID";
pub const SANDBOX_UNVERIFIABLE_BUILD: &str = "SANDBOX_UNVERIFIABLE_BUILD";
pub const SANDBOX_PLATFORM_UNSUPPORTED: &str = "SANDBOX_PLATFORM_UNSUPPORTED";
/// Local filesystem failures (disk full, permissions) while staging or swapping.
pub const SANDBOX_INSTALL_FAILED: &str = "SANDBOX_INSTALL_FAILED";
/// A second install was requested while one is running.
pub const SANDBOX_INSTALL_IN_PROGRESS: &str = "SANDBOX_INSTALL_IN_PROGRESS";

fn download_failed(message: impl Into<String>) -> HostError {
    HostError::new(SANDBOX_DOWNLOAD_FAILED, message)
}
fn signature_invalid(message: impl Into<String>) -> HostError {
    HostError::new(SANDBOX_SIGNATURE_INVALID, message)
}
fn bundle_invalid(message: impl Into<String>) -> HostError {
    HostError::new(SANDBOX_BUNDLE_INVALID, message)
}
fn install_failed(context: &str, error: io::Error) -> HostError {
    HostError::new(SANDBOX_INSTALL_FAILED, format!("{context}: {error}"))
}

/// Everything that selects what is downloaded and how it is checked. Production values come
/// from [`InstallSpec::release`]; there is deliberately no run-time override.
#[derive(Debug, Clone)]
pub struct InstallSpec {
    /// The app version the runtime must belong to (`CARGO_PKG_VERSION` in production).
    pub app_version: String,
    /// The bundle protocol this app speaks (`SANDBOX_PROTOCOL_VERSION` in production).
    pub protocol_version: u32,
    /// Rust target triple of the runtime.
    pub target: String,
    /// The updater public key exactly as embedded in the app: base64 of the minisign `.pub`
    /// file. Empty when the build has none.
    pub pubkey_b64: String,
    /// `https://…/releases/download`, without a trailing slash.
    pub url_base: String,
}

impl InstallSpec {
    /// The spec for this build, or `SANDBOX_PLATFORM_UNSUPPORTED` when no runtime is published
    /// for the platform. A missing updater key is reported by [`install`], not here.
    pub fn release() -> Result<Self> {
        let target = RELEASE_TARGET
            .ok_or_else(|| HostError::new(SANDBOX_PLATFORM_UNSUPPORTED, NO_RUNTIME_PUBLISHED))?;
        Ok(Self {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: SANDBOX_PROTOCOL_VERSION,
            target: target.to_string(),
            pubkey_b64: option_env!("SOURCEWEFT_UPDATER_PUBLIC_KEY")
                .unwrap_or_default()
                .to_string(),
            url_base: RELEASE_BASE.to_string(),
        })
    }

    /// Whether a runtime is published for this platform at all (readiness uses this to avoid
    /// offering a download that can only fail).
    #[allow(dead_code)] // only the Linux readiness probe asks
    pub(crate) fn runtime_published() -> bool {
        RELEASE_TARGET.is_some()
    }

    fn archive_name(&self) -> String {
        format!("sourceweft-sandbox-{}.tar.gz", self.target)
    }

    fn archive_url(&self) -> String {
        format!(
            "{}/v{}/{}",
            self.url_base.trim_end_matches('/'),
            self.app_version,
            self.archive_name()
        )
    }

    fn signature_url(&self) -> String {
        format!("{}.sig", self.archive_url())
    }

    /// The target and version end up in a URL: only plain characters are allowed.
    fn validate_for_url(&self) -> Result<()> {
        let plain = |text: &str, extra: &[char]| {
            !text.is_empty()
                && text.len() <= 64
                && text
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
        };
        if !plain(&self.target, &['_', '-']) || !plain(&self.app_version, &['.', '-', '+']) {
            return Err(bundle_invalid(
                "The app version or platform is not a plain identifier.",
            ));
        }
        Ok(())
    }
}

/// HTTP GET of one URL into a file. Injected so tests never touch the network.
pub trait Fetch {
    /// Downloads `url` into `dest` (a new file in a directory the caller owns), failing with
    /// `SANDBOX_DOWNLOAD_FAILED` on any error, including a body larger than `max_bytes`.
    fn get_to_file(&self, url: &str, dest: &Path, max_bytes: u64) -> Result<()>;
}

/// Whether a download (or a redirect hop) may use this URL: https only. Under `cfg(test)` plain
/// http to the loopback address is allowed too, so the real client can be exercised against a
/// local test server.
fn url_allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        || (cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
}

/// The production [`Fetch`]: reqwest with rustls, https only (also across redirects), streamed
/// to the destination file. A stalled connection (no bytes for `IDLE_TIMEOUT`) and an overall
/// `TOTAL_TIMEOUT` both end the download; a slow but steady one does not. Owns a small runtime, so create
/// and use it from a blocking thread, never from async code.
pub struct HttpsFetch {
    runtime: tokio::runtime::Runtime,
    client: reqwest::Client,
}

impl HttpsFetch {
    pub fn new() -> Result<Self> {
        Self::with_timeouts(IDLE_TIMEOUT, TOTAL_TIMEOUT)
    }

    fn with_timeouts(idle: Duration, total: Duration) -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| download_failed(format!("Could not start the downloader: {error}")))?;
        let redirects = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if url_allowed(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("redirected to a URL that is not https")
            }
        });
        let builder = reqwest::Client::builder()
            .redirect(redirects)
            .read_timeout(idle)
            .timeout(total)
            .connect_timeout(idle.min(Duration::from_secs(20)))
            .user_agent(concat!("SourceWeft-Desktop/", env!("CARGO_PKG_VERSION")));
        // The test server is on loopback: never route it through a developer's proxy.
        let builder = if cfg!(test) {
            builder.no_proxy()
        } else {
            builder
        };
        let client = builder
            .build()
            .map_err(|error| download_failed(format!("Could not start the downloader: {error}")))?;
        Ok(Self { runtime, client })
    }
}

impl Fetch for HttpsFetch {
    fn get_to_file(&self, url: &str, dest: &Path, max_bytes: u64) -> Result<()> {
        let parsed = reqwest::Url::parse(url)
            .map_err(|error| download_failed(format!("Not a valid download URL: {error}")))?;
        if !url_allowed(&parsed) {
            return Err(download_failed("Sandbox runtime downloads must use https."));
        }
        self.runtime.block_on(async {
            let mut response = self
                .client
                .get(parsed)
                .send()
                .await
                .map_err(|error| download_failed(format!("Download failed: {error}")))?;
            let status = response.status();
            if !status.is_success() {
                return Err(download_failed(format!(
                    "The download server answered {status}."
                )));
            }
            if response
                .content_length()
                .is_some_and(|length| length > max_bytes)
            {
                return Err(download_failed("The download is larger than allowed."));
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(dest)
                .map_err(|error| install_failed("Could not create the download file", error))?;
            let mut total = 0u64;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| download_failed(format!("Download failed: {error}")))?
            {
                total += chunk.len() as u64;
                if total > max_bytes {
                    return Err(download_failed("The download is larger than allowed."));
                }
                file.write_all(&chunk)
                    .map_err(|error| install_failed("Could not write the download", error))?;
            }
            file.sync_all()
                .map_err(|error| install_failed("Could not write the download", error))?;
            Ok(())
        })
    }
}

/// What was installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledBundle {
    /// `<app data>/sandbox/current`.
    pub dir: PathBuf,
    pub app_version: String,
    pub protocol_version: u32,
    pub target: String,
    pub srt_version: String,
    /// The files of the bundle, excluding `manifest.json`.
    pub files: Vec<String>,
}

// ------------------------------------------------------------------ manifest

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawManifest {
    schema_version: u64,
    protocol_version: u64,
    app_version: String,
    target: String,
    srt_version: String,
    files: BTreeMap<String, RawFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    sha256: String,
    size: u64,
}

/// A bundle file name is one path component of plain characters: this alone excludes absolute
/// paths, `..`, `.` and nested paths.
fn is_safe_name(name: &[u8]) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name[0].is_ascii_alphanumeric()
        && name
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn parse_manifest(bytes: &[u8], spec: &InstallSpec) -> Result<RawManifest> {
    let manifest: RawManifest = serde_json::from_slice(bytes).map_err(|error| {
        bundle_invalid(format!("manifest.json is not a valid manifest: {error}"))
    })?;
    if manifest.schema_version != 1 {
        return Err(bundle_invalid(format!(
            "Unsupported manifest schemaVersion {}.",
            manifest.schema_version
        )));
    }
    if manifest.protocol_version != u64::from(spec.protocol_version) {
        return Err(bundle_invalid(format!(
            "The downloaded sandbox runtime speaks protocol {}, this app needs {}.",
            manifest.protocol_version, spec.protocol_version
        )));
    }
    if manifest.app_version != spec.app_version {
        return Err(bundle_invalid(format!(
            "The downloaded sandbox runtime is for SourceWeft {}, this app is {}.",
            manifest.app_version, spec.app_version
        )));
    }
    if manifest.target != spec.target {
        return Err(bundle_invalid(format!(
            "The downloaded sandbox runtime is for {}, this platform is {}.",
            manifest.target, spec.target
        )));
    }
    let version_ok = !manifest.srt_version.is_empty()
        && manifest.srt_version.len() <= 64
        && manifest
            .srt_version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    if !version_ok {
        return Err(bundle_invalid("manifest srtVersion is not a version."));
    }
    if manifest.files.is_empty() || manifest.files.len() > MAX_FILES {
        return Err(bundle_invalid("manifest lists no files or too many."));
    }
    let mut total = 0u64;
    for (name, file) in &manifest.files {
        if !is_safe_name(name.as_bytes()) || name == MANIFEST_FILENAME {
            return Err(bundle_invalid(format!(
                "manifest file name is not allowed: {name}"
            )));
        }
        let hex = file.sha256.len() == 64
            && file
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !hex {
            return Err(bundle_invalid(format!(
                "manifest sha256 is not lowercase hex: {name}"
            )));
        }
        if file.size > MAX_FILE_BYTES {
            return Err(bundle_invalid(format!(
                "manifest size is out of range: {name}"
            )));
        }
        total += file.size;
    }
    if total > MAX_TOTAL_BYTES {
        return Err(bundle_invalid("The runtime is larger than allowed."));
    }
    Ok(manifest)
}

// ------------------------------------------------------------------- signature

fn decode_public_key(pubkey_b64: &str) -> Result<PublicKey> {
    let unverifiable = |why: &str| {
        HostError::new(
            SANDBOX_UNVERIFIABLE_BUILD,
            format!("This build cannot verify sandbox downloads ({why})."),
        )
    };
    let trimmed = pubkey_b64.trim();
    if trimmed.is_empty() {
        return Err(unverifiable("it has no update key"));
    }
    let text = STANDARD
        .decode(trimmed)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| unverifiable("its update key is unreadable"))?;
    PublicKey::decode(&text).map_err(|_| unverifiable("its update key is unreadable"))
}

/// Verifies `<signature>` (Tauri's base64-wrapped minisign file) over the whole of `tarball`,
/// streaming it. Only prehashed signatures are accepted, which is what `tauri signer sign`
/// writes.
fn verify_signature(key: &PublicKey, tarball: &Path, signature: &Path) -> Result<()> {
    let mut text = String::new();
    File::open(signature)
        .and_then(|file| file.take(MAX_SIGNATURE_BYTES + 1).read_to_string(&mut text))
        .map_err(|error| {
            signature_invalid(format!("The signature file cannot be read: {error}"))
        })?;
    if text.len() as u64 > MAX_SIGNATURE_BYTES {
        return Err(signature_invalid("The signature file is too large."));
    }
    let decoded = STANDARD
        .decode(text.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| signature_invalid("The signature file is not valid."))?;
    let signature = Signature::decode(&decoded)
        .map_err(|_| signature_invalid("The signature file is not valid."))?;
    let mut verifier = key.verify_stream(&signature).map_err(|_| {
        signature_invalid("The signature was not made by the SourceWeft update key.")
    })?;
    let mut file = File::open(tarball)
        .map_err(|error| install_failed("Could not read the download", error))?;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| install_failed("Could not read the download", error))?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier
        .finalize()
        .map_err(|_| signature_invalid("The download does not match its signature."))
}

// ------------------------------------------------------------------ scratch dirs

/// A directory under `<app data>/sandbox/` that is removed again unless [`Scratch::keep`] says
/// otherwise, so every error path cleans up after itself.
struct Scratch {
    path: PathBuf,
    armed: bool,
}

impl Scratch {
    fn create(parent: &Path, prefix: &str) -> Result<Self> {
        let path = parent.join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|error| install_failed("Could not create a working directory", error))?;
        Ok(Self { path, armed: true })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn keep(mut self) -> PathBuf {
        self.armed = false;
        self.path.clone()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

const SCRATCH_PREFIXES: [&str; 3] = [".download-", ".staging-", ".old-"];

/// Serialises the moments `current` is being moved (the swap, crash recovery, the sweep), so a
/// readiness check on another thread can never repair a swap that is half done.
static SWAP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn swap_lock() -> std::sync::MutexGuard<'static, ()> {
    SWAP_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// A real directory (not a link) that holds what an installed runtime always holds.
fn looks_like_runtime(dir: &Path) -> bool {
    let is_dir = |p: &Path| p.symlink_metadata().is_ok_and(|m| m.is_dir());
    let is_file = |p: &Path| p.symlink_metadata().is_ok_and(|m| m.is_file());
    is_dir(dir) && is_file(&dir.join("srt-sidecar")) && is_file(&dir.join(MANIFEST_FILENAME))
}

fn current_is_absent(sandbox_dir: &Path) -> bool {
    matches!(
        sandbox_dir.join("current").symlink_metadata(),
        Err(error) if error.kind() == io::ErrorKind::NotFound
    )
}

fn stale_entries(sandbox_dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(sandbox_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            SCRATCH_PREFIXES
                .iter()
                .any(|prefix| name.starts_with(prefix))
                .then(|| (name, entry.path()))
        })
        .collect()
}

/// Repairs a process death between the swap's two renames: `current` is gone and the previous
/// runtime sits in `.old-<id>`. When `current` is absent and exactly one `.old-*` directory
/// looks like a runtime, it is renamed back. With several candidates nothing is guessed. Returns
/// whether a runtime was restored. Cheap and idempotent: call it before looking at `current`.
pub(crate) fn recover_previous_runtime(sandbox_dir: &Path) -> bool {
    let _lock = swap_lock();
    if !current_is_absent(sandbox_dir) {
        return false;
    }
    let candidates: Vec<PathBuf> = stale_entries(sandbox_dir)
        .into_iter()
        .filter(|(name, path)| name.starts_with(".old-") && looks_like_runtime(path))
        .map(|(_, path)| path)
        .collect();
    match candidates.as_slice() {
        [only] => fs::rename(only, sandbox_dir.join("current")).is_ok(),
        _ => false,
    }
}

/// Removes working directories a crashed earlier install left behind. Installs never run
/// concurrently (`LocalHost` refuses a second one), so anything with these names is garbage,
/// except that while `current` is missing a `.old-*` that looks like a runtime may be the only
/// copy there is (see [`recover_previous_runtime`]) and is never deleted.
fn sweep_stale(sandbox_dir: &Path) {
    let _lock = swap_lock();
    let keep_old_runtimes = current_is_absent(sandbox_dir);
    for (name, path) in stale_entries(sandbox_dir) {
        if keep_old_runtimes && name.starts_with(".old-") && looks_like_runtime(&path) {
            continue;
        }
        remove_path(&path);
    }
}

/// Removes a file, symlink (not followed) or directory tree, ignoring failure.
fn remove_path(path: &Path) {
    match path.symlink_metadata() {
        Ok(meta) if meta.is_dir() => {
            let _ = fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = fs::remove_file(path);
        }
        Err(_) => {}
    }
}

// ----------------------------------------------------------------- extraction

fn archive_read(what: &str, error: io::Error) -> HostError {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        bundle_invalid("The runtime archive is truncated.")
    } else {
        bundle_invalid(format!(
            "The runtime archive cannot be read ({what}): {error}"
        ))
    }
}

/// The NUL-terminated text of a header field.
fn header_field(block: &[u8; BLOCK], offset: usize, length: usize) -> &[u8] {
    let field = &block[offset..offset + length];
    let end = field.iter().position(|b| *b == 0).unwrap_or(length);
    &field[..end]
}

fn header_octal(block: &[u8; BLOCK], offset: usize, length: usize, what: &str) -> Result<u64> {
    let field = header_field(block, offset, length);
    let text = std::str::from_utf8(field).unwrap_or("").trim();
    if text.is_empty() || !text.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
        return Err(bundle_invalid(format!(
            "The archive has an invalid {what} field."
        )));
    }
    u64::from_str_radix(text, 8)
        .map_err(|_| bundle_invalid(format!("The archive has an invalid {what} field.")))
}

fn lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Reads exactly `size` payload bytes plus the zero padding to a block boundary, writing the
/// payload to `out` (if any) and returning its SHA-256.
fn read_payload<R: Read>(
    archive: &mut R,
    size: u64,
    mut out: Option<&mut File>,
    name: &str,
) -> Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut remaining = size;
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        let read = archive
            .read(&mut buffer[..want])
            .map_err(|error| archive_read(name, error))?;
        if read == 0 {
            return Err(bundle_invalid("The runtime archive is truncated."));
        }
        hasher.update(&buffer[..read]);
        if let Some(file) = out.as_deref_mut() {
            file.write_all(&buffer[..read])
                .map_err(|error| install_failed("Could not write the runtime", error))?;
        }
        remaining -= read as u64;
    }
    let padding = (BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64;
    let mut pad = [0u8; BLOCK];
    archive
        .read_exact(&mut pad[..padding as usize])
        .map_err(|error| archive_read(name, error))?;
    if pad[..padding as usize].iter().any(|b| *b != 0) {
        return Err(bundle_invalid(format!(
            "The archive padding is not zero: {name}"
        )));
    }
    Ok(hasher.finalize().into())
}

/// Reads the archive at `tarball` strictly and writes its files into `staging` (an existing,
/// empty directory). Everything is checked here, and every violation is a
/// `SANDBOX_BUNDLE_INVALID`; the signature has already been verified by the caller.
///
/// Accepted: a ustar stream of plain files at the archive root with `manifest.json` first, modes
/// 0755 or 0644, exactly the files the manifest names, each with the sizes and hashes it says,
/// ending in two zero blocks and nothing else. Anything else (directories, links, devices,
/// pax/GNU headers, prefixes, absolute or nested names, duplicates, extra or missing files,
/// oversize entries, trailing data) is refused.
fn extract_bundle(tarball: &Path, staging: &Path, spec: &InstallSpec) -> Result<RawManifest> {
    let file = File::open(tarball)
        .map_err(|error| install_failed("Could not read the download", error))?;
    let mut archive = GzDecoder::new(BufReader::new(file));
    let mut seen = BTreeSet::new();
    let mut manifest: Option<RawManifest> = None;
    loop {
        let mut block = [0u8; BLOCK];
        archive
            .read_exact(&mut block)
            .map_err(|error| archive_read("header", error))?;
        if block.iter().all(|b| *b == 0) {
            archive
                .read_exact(&mut block)
                .map_err(|error| archive_read("end marker", error))?;
            let mut extra = [0u8; 1];
            let trailing = archive
                .read(&mut extra)
                .map_err(|error| archive_read("end", error))?;
            if block.iter().any(|b| *b != 0) || trailing != 0 {
                return Err(bundle_invalid(
                    "The archive has a bad end marker or trailing data.",
                ));
            }
            break;
        }

        let stored = header_octal(&block, 148, 8, "checksum")?;
        let mut copy = block;
        copy[148..156].fill(b' ');
        let actual: u64 = copy.iter().map(|b| u64::from(*b)).sum();
        if stored != actual {
            return Err(bundle_invalid(
                "The archive has a corrupt header (checksum mismatch).",
            ));
        }
        let name_bytes = header_field(&block, 0, 100);
        let shown = String::from_utf8_lossy(name_bytes).into_owned();
        if !matches!(block[156], b'0' | 0) {
            return Err(bundle_invalid(format!(
                "Unexpected archive entry type for {shown:?}: only plain files are allowed."
            )));
        }
        if header_field(&block, 257, 6) != b"ustar" {
            return Err(bundle_invalid("The archive is not a ustar archive."));
        }
        if !header_field(&block, 345, 155).is_empty() {
            return Err(bundle_invalid(format!(
                "Archive entry has a path prefix: {shown:?}"
            )));
        }
        if !header_field(&block, 157, 100).is_empty() {
            return Err(bundle_invalid(format!(
                "Archive entry has a link target: {shown:?}"
            )));
        }
        if !is_safe_name(name_bytes) {
            return Err(bundle_invalid(format!(
                "Unsafe archive entry name: {shown:?}"
            )));
        }
        if !seen.insert(shown.clone()) {
            return Err(bundle_invalid(format!("Duplicate archive entry: {shown}")));
        }
        let mode = header_octal(&block, 100, 8, "mode")? & 0o7777;
        if mode != 0o755 && mode != 0o644 {
            return Err(bundle_invalid(format!(
                "Unexpected file mode {mode:o} on {shown}."
            )));
        }
        let size = header_octal(&block, 124, 12, "size")?;

        let Some(manifest_ref) = manifest.as_ref() else {
            if shown != MANIFEST_FILENAME {
                return Err(bundle_invalid(
                    "manifest.json must be the first archive entry.",
                ));
            }
            if mode != 0o644 {
                return Err(bundle_invalid("manifest.json must not be executable."));
            }
            if size > MAX_MANIFEST_BYTES {
                return Err(bundle_invalid("manifest.json is too large."));
            }
            let mut bytes = vec![0u8; size as usize];
            archive
                .read_exact(&mut bytes)
                .map_err(|error| archive_read(&shown, error))?;
            let padding = (BLOCK - size as usize % BLOCK) % BLOCK;
            let mut pad = [0u8; BLOCK];
            archive
                .read_exact(&mut pad[..padding])
                .map_err(|error| archive_read(&shown, error))?;
            if pad[..padding].iter().any(|b| *b != 0) {
                return Err(bundle_invalid("The archive padding is not zero."));
            }
            // Validated before anything else is read from, let alone written by, the archive.
            let parsed = parse_manifest(&bytes, spec)?;
            write_file(&staging.join(MANIFEST_FILENAME), &bytes, 0o644)?;
            manifest = Some(parsed);
            continue;
        };

        let Some(expected) = manifest_ref.files.get(&shown) else {
            return Err(bundle_invalid(format!(
                "Archive file is not listed in the manifest: {shown}"
            )));
        };
        if size != expected.size {
            return Err(bundle_invalid(format!("Size mismatch: {shown}")));
        }
        let path = staging.join(&shown);
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|error| install_failed("Could not write the runtime", error))?;
        let digest = read_payload(&mut archive, size, Some(&mut out), &shown)?;
        if lower_hex(&digest) != expected.sha256 {
            return Err(bundle_invalid(format!("sha256 mismatch: {shown}")));
        }
        out.set_permissions(fs::Permissions::from_mode(mode as u32))
            .and_then(|()| out.sync_all())
            .map_err(|error| install_failed("Could not write the runtime", error))?;
    }

    let manifest = manifest.ok_or_else(|| bundle_invalid("The archive is empty."))?;
    for name in manifest.files.keys() {
        if !seen.contains(name) {
            return Err(bundle_invalid(format!("The archive is missing {name}.")));
        }
    }
    Ok(manifest)
}

fn write_file(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| install_failed("Could not write the runtime", error))?;
    file.write_all(bytes)
        .and_then(|()| file.set_permissions(fs::Permissions::from_mode(mode)))
        .and_then(|()| file.sync_all())
        .map_err(|error| install_failed("Could not write the runtime", error))
}

// ----------------------------------------------------------------------- swap

/// Replaces `<sandbox_dir>/current` with `staging`. The old directory is moved aside first and
/// moved back if the new one cannot be put in place, so `current` is always either the old or
/// the new bundle (briefly absent between the two renames). `rename` is a parameter so a test
/// can make a step fail.
fn swap_into_place(
    sandbox_dir: &Path,
    staging: &Path,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<()> {
    let _lock = swap_lock();
    let current = sandbox_dir.join("current");
    let aside = sandbox_dir.join(format!(".old-{}", uuid::Uuid::new_v4().simple()));
    let had_old = match current.symlink_metadata() {
        Ok(_) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(install_failed(
                "Could not inspect the installed runtime",
                error,
            ))
        }
    };
    if had_old {
        rename(&current, &aside)
            .map_err(|error| install_failed("Could not move the old runtime aside", error))?;
    }
    if let Err(error) = rename(staging, &current) {
        if had_old {
            if let Err(restore) = rename(&aside, &current) {
                return Err(HostError::new(
                    SANDBOX_INSTALL_FAILED,
                    format!(
                        "Could not install the new runtime ({error}) and could not put the old one back ({restore}); it is in {}.",
                        aside.display()
                    ),
                ));
            }
        }
        return Err(install_failed("Could not install the new runtime", error));
    }
    if had_old {
        remove_path(&aside);
    }
    if let Ok(dir) = File::open(sandbox_dir) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Extracts the already signature-verified `tarball` and swaps the result in. On any error the
/// previous `current` is untouched and no working directory remains.
fn install_verified_tarball(
    sandbox_dir: &Path,
    tarball: &Path,
    spec: &InstallSpec,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<InstalledBundle> {
    let staging = Scratch::create(sandbox_dir, ".staging-")?;
    let manifest = extract_bundle(tarball, staging.path(), spec)?;
    if let Ok(dir) = File::open(staging.path()) {
        let _ = dir.sync_all();
    }
    swap_into_place(sandbox_dir, staging.path(), rename)?;
    staging.keep();
    Ok(InstalledBundle {
        dir: sandbox_dir.join("current"),
        app_version: manifest.app_version,
        protocol_version: spec.protocol_version,
        target: manifest.target,
        srt_version: manifest.srt_version,
        files: manifest.files.into_keys().collect(),
    })
}

/// Downloads, verifies and installs the sandbox runtime under `<app_data>/sandbox/current`.
/// See the module documentation for the order of checks. Callers must not run two installs
/// for the same `app_data` at once (`LocalHost::install_sandbox_runtime` guarantees this).
pub fn install(app_data: &Path, spec: &InstallSpec, fetch: &dyn Fetch) -> Result<InstalledBundle> {
    spec.validate_for_url()?;
    let key = decode_public_key(&spec.pubkey_b64)?;
    let sandbox_dir = app_data.join("sandbox");
    fs::create_dir_all(&sandbox_dir)
        .map_err(|error| install_failed("Could not create the sandbox directory", error))?;
    // A crash between the swap's renames leaves the previous runtime in `.old-*` and no
    // `current`: put it back first, so even a failed install leaves the user's runtime in place.
    recover_previous_runtime(&sandbox_dir);
    sweep_stale(&sandbox_dir);

    let download = Scratch::create(&sandbox_dir, ".download-")?;
    let tarball = download.path().join("runtime.tar.gz");
    let signature = download.path().join("runtime.tar.gz.sig");
    // The small signature first: a release without the asset fails fast, before the big download.
    fetch.get_to_file(&spec.signature_url(), &signature, MAX_SIGNATURE_BYTES)?;
    fetch.get_to_file(&spec.archive_url(), &tarball, MAX_DOWNLOAD_BYTES)?;
    verify_signature(&key, &tarball, &signature)?;

    install_verified_tarball(&sandbox_dir, &tarball, spec, &|from, to| {
        fs::rename(from, to)
    })
}

// ------------------------------------------------------------------ host side

impl LocalHost {
    /// Downloads and installs the sandbox runtime for this build. While it runs,
    /// `sandbox_readiness()` reports `installing`; afterwards (success or failure) the running
    /// sidecar is shut down, the readiness cache is invalidated, and on success the result is
    /// the freshly probed readiness. A platform without a published runtime fails with
    /// `SANDBOX_PLATFORM_UNSUPPORTED`. Blocking: call from a blocking thread.
    pub fn install_sandbox_runtime(&self) -> Result<SandboxReadiness> {
        let spec = InstallSpec::release()?;
        let fetch = HttpsFetch::new()?;
        self.install_and_probe_with(&spec, &fetch)
    }

    /// Installs, then returns a real readiness: any probe still in flight from before the
    /// install is waited out (it does not cache its stale answer), so the result is never the
    /// transient "checking" placeholder.
    pub(crate) fn install_and_probe_with(
        &self,
        spec: &InstallSpec,
        fetch: &dyn Fetch,
    ) -> Result<SandboxReadiness> {
        self.install_sandbox_runtime_with(spec, fetch)?;
        self.invalidate_sandbox_readiness();
        settled_readiness(
            || self.sandbox_readiness(),
            Duration::from_millis(50),
            Duration::from_secs(120),
        )
        .ok_or_else(|| {
            HostError::new(
                SANDBOX_INSTALL_FAILED,
                "The runtime was installed, but the readiness check did not finish.",
            )
        })
    }

    /// The install half of [`LocalHost::install_sandbox_runtime`], with the spec and downloader
    /// supplied, so the host integration is testable offline on any unix.
    pub(crate) fn install_sandbox_runtime_with(
        &self,
        spec: &InstallSpec,
        fetch: &dyn Fetch,
    ) -> Result<InstalledBundle> {
        let guard =
            ReadinessCache::begin_install(&self.sandbox_readiness_cache).ok_or_else(|| {
                HostError::new(
                    SANDBOX_INSTALL_IN_PROGRESS,
                    "The sandbox runtime is already being installed.",
                )
            })?;
        let result = install(&self.base, spec, fetch);
        // Whatever happened, no sidecar started from the previous files may keep serving
        // commands; the next command starts one from whatever `current` is now.
        self.stop_sandbox_sidecar();
        drop(guard);
        result
    }

    #[cfg(target_os = "linux")]
    fn stop_sandbox_sidecar(&self) {
        super::srt_exec::stop_sidecar(&self.sandbox);
    }

    /// Only Linux keeps a sidecar.
    #[cfg(not(target_os = "linux"))]
    fn stop_sandbox_sidecar(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::{
        cell::RefCell,
        collections::HashMap,
        net::{TcpListener, TcpStream},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Instant,
    };

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sandbox-bundle");
    const FIXTURE_TARGET: &str = "x86_64-unknown-linux-gnu";
    const FIXTURE_APP_VERSION: &str = "0.0.0-fixture";
    const FIXTURE_FILES: [&str; 4] = ["apply-seccomp", "rg", "srt-proxy-agent.jar", "srt-sidecar"];

    fn fixture(name: &str) -> Vec<u8> {
        fs::read(Path::new(FIXTURES).join(name)).unwrap()
    }
    fn fixture_key() -> String {
        String::from_utf8(fixture("throwaway-signer.pub"))
            .unwrap()
            .trim()
            .to_string()
    }
    fn fixture_tarball() -> Vec<u8> {
        fixture(&format!("sourceweft-sandbox-{FIXTURE_TARGET}.tar.gz"))
    }
    fn fixture_signature() -> Vec<u8> {
        fixture(&format!("sourceweft-sandbox-{FIXTURE_TARGET}.tar.gz.sig"))
    }

    fn spec() -> InstallSpec {
        InstallSpec {
            app_version: FIXTURE_APP_VERSION.into(),
            protocol_version: 1,
            target: FIXTURE_TARGET.into(),
            pubkey_b64: fixture_key(),
            url_base: "https://example.test/releases/download".into(),
        }
    }

    /// Serves canned bodies by URL; records requests.
    struct MemFetch {
        bodies: HashMap<String, std::result::Result<Vec<u8>, String>>,
        requests: RefCell<Vec<String>>,
    }
    impl MemFetch {
        fn serving(spec: &InstallSpec, tarball: Vec<u8>, signature: Vec<u8>) -> Self {
            let mut bodies = HashMap::new();
            bodies.insert(spec.archive_url(), Ok(tarball));
            bodies.insert(spec.signature_url(), Ok(signature));
            Self {
                bodies,
                requests: RefCell::new(Vec::new()),
            }
        }
        fn fixture(spec: &InstallSpec) -> Self {
            Self::serving(spec, fixture_tarball(), fixture_signature())
        }
    }
    impl Fetch for MemFetch {
        fn get_to_file(&self, url: &str, dest: &Path, max_bytes: u64) -> Result<()> {
            self.requests.borrow_mut().push(url.to_string());
            match self.bodies.get(url) {
                Some(Ok(bytes)) if bytes.len() as u64 <= max_bytes => {
                    fs::write(dest, bytes).unwrap();
                    Ok(())
                }
                Some(Ok(_)) => Err(download_failed("too large")),
                Some(Err(message)) => Err(download_failed(message.clone())),
                None => Err(download_failed("404")),
            }
        }
    }

    fn code<T: std::fmt::Debug>(result: Result<T>) -> &'static str {
        result.expect_err("expected an error").code
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    // ---------------------------------------------------------------- install

    #[test]
    fn a_good_bundle_installs_with_the_right_modes_and_leaves_nothing_else() {
        let app_data = tempfile::tempdir().unwrap();
        let spec = spec();
        let fetch = MemFetch::fixture(&spec);
        let installed = install(app_data.path(), &spec, &fetch).unwrap();

        let current = app_data.path().join("sandbox/current");
        assert_eq!(installed.dir, current);
        assert_eq!(installed.files, FIXTURE_FILES);
        assert_eq!(installed.app_version, FIXTURE_APP_VERSION);
        assert_eq!(installed.protocol_version, 1);
        assert_eq!(installed.target, FIXTURE_TARGET);
        assert_eq!(installed.srt_version, "0.0.0");
        assert_eq!(
            fetch.requests.into_inner(),
            // The small signature first, so a release without it fails before the big download.
            [
                "https://example.test/releases/download/v0.0.0-fixture/sourceweft-sandbox-x86_64-unknown-linux-gnu.tar.gz.sig",
                "https://example.test/releases/download/v0.0.0-fixture/sourceweft-sandbox-x86_64-unknown-linux-gnu.tar.gz",
            ]
        );
        assert_eq!(
            entries(app_data.path().join("sandbox").as_path()),
            ["current"]
        );
        assert_eq!(
            entries(&current),
            [
                "apply-seccomp",
                "manifest.json",
                "rg",
                "srt-proxy-agent.jar",
                "srt-sidecar"
            ]
        );
        for executable in ["srt-sidecar", "rg", "apply-seccomp"] {
            assert_eq!(mode(&current.join(executable)), 0o755, "{executable}");
        }
        assert_eq!(mode(&current.join("srt-proxy-agent.jar")), 0o644);
        assert_eq!(mode(&current.join("manifest.json")), 0o644);
        assert_eq!(
            fs::read(current.join("srt-proxy-agent.jar")).unwrap(),
            b"fake jar\n"
        );
    }

    #[test]
    fn a_second_install_replaces_the_first_and_removes_it() {
        let app_data = tempfile::tempdir().unwrap();
        let current = app_data.path().join("sandbox/current");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("previous-only"), "old runtime").unwrap();

        let spec = spec();
        install(app_data.path(), &spec, &MemFetch::fixture(&spec)).unwrap();
        assert!(
            !current.join("previous-only").exists(),
            "the old runtime is gone"
        );
        assert!(current.join("srt-sidecar").is_file());
        // And once more over an installed fixture: still exactly one directory.
        install(app_data.path(), &spec, &MemFetch::fixture(&spec)).unwrap();
        assert_eq!(
            entries(app_data.path().join("sandbox").as_path()),
            ["current"]
        );
        assert!(current.join("srt-sidecar").is_file());
    }

    #[test]
    fn stale_working_directories_from_a_crashed_install_are_swept() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        for stale in [".download-dead", ".staging-dead", ".old-dead"] {
            fs::create_dir_all(sandbox.join(stale)).unwrap();
            fs::write(sandbox.join(stale).join("junk"), "x").unwrap();
        }
        let spec = spec();
        install(app_data.path(), &spec, &MemFetch::fixture(&spec)).unwrap();
        assert_eq!(entries(&sandbox), ["current"]);
    }

    #[test]
    fn a_failed_install_keeps_the_previous_runtime_and_leaves_no_working_directory() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        let current = sandbox.join("current");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("marker"), "previous").unwrap();

        let good = spec();
        let mut bad_signature = fixture_signature();
        // Inside the signature line, not the (unchecked) comment before it.
        bad_signature[100] = if bad_signature[100] == b'A' {
            b'B'
        } else {
            b'A'
        };
        let mut tampered = fixture_tarball();
        let last = tampered.len() - 12;
        tampered[last] ^= 1;
        let mut wrong_protocol = good.clone();
        wrong_protocol.protocol_version = 2;
        let mut wrong_app = good.clone();
        wrong_app.app_version = "9.9.9".into();
        let mut wrong_target = good.clone();
        wrong_target.target = "aarch64-unknown-linux-gnu".into();
        let mut other_key = good.clone();
        other_key.pubkey_b64 = String::from_utf8(fixture("other-throwaway-signer.pub"))
            .unwrap()
            .trim()
            .to_string();
        let mut no_key = good.clone();
        no_key.pubkey_b64 = String::new();
        let mut unreadable_key = good.clone();
        unreadable_key.pubkey_b64 = "not base64 !!".into();

        let cases: Vec<(&str, InstallSpec, MemFetch, &str)> = vec![
            (
                "bad signature",
                good.clone(),
                MemFetch::serving(&good, fixture_tarball(), bad_signature),
                SANDBOX_SIGNATURE_INVALID,
            ),
            (
                "garbage signature",
                good.clone(),
                MemFetch::serving(&good, fixture_tarball(), b"hello".to_vec()),
                SANDBOX_SIGNATURE_INVALID,
            ),
            (
                "empty signature",
                good.clone(),
                MemFetch::serving(&good, fixture_tarball(), Vec::new()),
                SANDBOX_SIGNATURE_INVALID,
            ),
            (
                "tampered tarball",
                good.clone(),
                MemFetch::serving(&good, tampered, fixture_signature()),
                SANDBOX_SIGNATURE_INVALID,
            ),
            (
                "signed by another key",
                other_key.clone(),
                MemFetch::fixture(&other_key),
                SANDBOX_SIGNATURE_INVALID,
            ),
            (
                "wrong protocol",
                wrong_protocol.clone(),
                MemFetch::fixture(&wrong_protocol),
                SANDBOX_BUNDLE_INVALID,
            ),
            (
                "wrong app version",
                wrong_app.clone(),
                MemFetch::fixture(&wrong_app),
                SANDBOX_BUNDLE_INVALID,
            ),
            (
                "wrong target",
                wrong_target.clone(),
                MemFetch::fixture(&wrong_target),
                SANDBOX_BUNDLE_INVALID,
            ),
            (
                "no updater key",
                no_key.clone(),
                MemFetch::fixture(&no_key),
                SANDBOX_UNVERIFIABLE_BUILD,
            ),
            (
                "unreadable updater key",
                unreadable_key.clone(),
                MemFetch::fixture(&unreadable_key),
                SANDBOX_UNVERIFIABLE_BUILD,
            ),
            (
                "archive 404",
                good.clone(),
                MemFetch {
                    bodies: HashMap::new(),
                    requests: RefCell::new(vec![]),
                },
                SANDBOX_DOWNLOAD_FAILED,
            ),
            (
                "signature download fails",
                good.clone(),
                {
                    let mut fetch = MemFetch::fixture(&good);
                    fetch
                        .bodies
                        .insert(good.signature_url(), Err("connection reset".into()));
                    fetch
                },
                SANDBOX_DOWNLOAD_FAILED,
            ),
        ];
        for (label, spec, fetch, expected) in cases {
            let error = install(app_data.path(), &spec, &fetch).expect_err(label);
            assert_eq!(error.code, expected, "{label}: {error}");
            assert_eq!(
                fs::read_to_string(current.join("marker")).unwrap(),
                "previous",
                "{label}"
            );
            assert_eq!(
                entries(&sandbox),
                ["current"],
                "{label}: no working directory remains"
            );
            assert_eq!(entries(&current), ["marker"], "{label}");
        }
    }

    #[test]
    fn nothing_is_downloaded_without_an_updater_key() {
        let app_data = tempfile::tempdir().unwrap();
        let mut spec = spec();
        spec.pubkey_b64 = "  ".into();
        let fetch = MemFetch::fixture(&spec);
        let error = install(app_data.path(), &spec, &fetch).unwrap_err();
        assert_eq!(error.code, SANDBOX_UNVERIFIABLE_BUILD);
        assert_eq!(
            error.message,
            "This build cannot verify sandbox downloads (it has no update key)."
        );
        assert!(
            fetch.requests.borrow().is_empty(),
            "no request without a key"
        );
        assert!(
            !app_data.path().join("sandbox").exists(),
            "nothing was created"
        );
    }

    #[test]
    fn the_signature_is_checked_before_any_entry_is_read() {
        // A tarball that is not even gzip: only the signature check can be what rejects it.
        let app_data = tempfile::tempdir().unwrap();
        let spec = spec();
        let fetch = MemFetch::serving(
            &spec,
            b"definitely not an archive".to_vec(),
            fixture_signature(),
        );
        assert_eq!(
            code(install(app_data.path(), &spec, &fetch)),
            SANDBOX_SIGNATURE_INVALID
        );
    }

    #[test]
    fn urls_and_identifiers_are_derived_from_the_spec_only() {
        let mut spec = spec();
        spec.url_base = "https://github.com/SourceWeft/SourceWeft/releases/download/".into();
        spec.app_version = "0.3.0-rc.9".into();
        assert_eq!(
            spec.archive_url(),
            "https://github.com/SourceWeft/SourceWeft/releases/download/v0.3.0-rc.9/sourceweft-sandbox-x86_64-unknown-linux-gnu.tar.gz"
        );
        assert_eq!(spec.signature_url(), format!("{}.sig", spec.archive_url()));
        for bad in ["../x", "a/b", "a b", "", "a?b=c", "a#b"] {
            let mut hostile = spec.clone();
            hostile.target = bad.into();
            assert!(hostile.validate_for_url().is_err(), "target {bad:?}");
            let mut hostile = spec.clone();
            hostile.app_version = bad.into();
            assert!(hostile.validate_for_url().is_err(), "version {bad:?}");
        }
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn the_release_spec_uses_the_build_constants() {
        let spec = InstallSpec::release().unwrap();
        assert_eq!(spec.target, "x86_64-unknown-linux-gnu");
        assert_eq!(spec.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(spec.protocol_version, SANDBOX_PROTOCOL_VERSION);
        assert_eq!(
            spec.url_base,
            "https://github.com/SourceWeft/SourceWeft/releases/download"
        );
        assert_eq!(
            spec.archive_url(),
            format!(
                "https://github.com/SourceWeft/SourceWeft/releases/download/v{}/sourceweft-sandbox-x86_64-unknown-linux-gnu.tar.gz",
                env!("CARGO_PKG_VERSION")
            )
        );
    }

    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    #[test]
    fn only_linux_x86_64_has_a_published_runtime() {
        assert_eq!(
            InstallSpec::release().unwrap_err().code,
            SANDBOX_PLATFORM_UNSUPPORTED
        );
    }

    // --------------------------------------------------------- hostile archives

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    struct Entry {
        name: Vec<u8>,
        data: Vec<u8>,
        mode: u32,
        typeflag: u8,
        linkname: Vec<u8>,
        prefix: Vec<u8>,
        declared_size: Option<usize>,
    }
    impl Entry {
        fn file(name: &str, data: &[u8], mode: u32) -> Self {
            Self {
                name: name.as_bytes().to_vec(),
                data: data.to_vec(),
                mode,
                typeflag: b'0',
                linkname: Vec::new(),
                prefix: Vec::new(),
                declared_size: None,
            }
        }
    }

    /// An independent, deliberately permissive tar writer for building hostile archives.
    fn tar(entries: &[Entry], end: bool) -> Vec<u8> {
        let mut out = Vec::new();
        for entry in entries {
            let mut block = [0u8; BLOCK];
            block[..entry.name.len()].copy_from_slice(&entry.name);
            let octal = |value: usize, width: usize| format!("{value:0w$o}\0", w = width - 1);
            block[100..108].copy_from_slice(octal(entry.mode as usize, 8).as_bytes());
            block[108..116].copy_from_slice(octal(0, 8).as_bytes());
            block[116..124].copy_from_slice(octal(0, 8).as_bytes());
            block[124..136].copy_from_slice(
                octal(entry.declared_size.unwrap_or(entry.data.len()), 12).as_bytes(),
            );
            block[136..148].copy_from_slice(octal(0, 12).as_bytes());
            block[148..156].fill(b' ');
            block[156] = entry.typeflag;
            block[157..157 + entry.linkname.len()].copy_from_slice(&entry.linkname);
            block[257..263].copy_from_slice(b"ustar\0");
            block[263..265].copy_from_slice(b"00");
            block[345..345 + entry.prefix.len()].copy_from_slice(&entry.prefix);
            let sum: usize = block.iter().map(|b| *b as usize).sum();
            block[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
            out.extend_from_slice(&block);
            out.extend_from_slice(&entry.data);
            out.resize(out.len().div_ceil(BLOCK) * BLOCK, 0);
        }
        if end {
            out.extend_from_slice(&[0u8; BLOCK * 2]);
        }
        out
    }

    fn sha(bytes: &[u8]) -> String {
        lower_hex(&Sha256::digest(bytes))
    }

    fn manifest_with(
        files: &[(&str, &[u8])],
        edit: impl FnOnce(&mut serde_json::Value),
    ) -> Vec<u8> {
        let mut listed = serde_json::Map::new();
        for (name, data) in files {
            listed.insert(
                (*name).into(),
                serde_json::json!({ "sha256": sha(data), "size": data.len() }),
            );
        }
        let mut value = serde_json::json!({
            "schemaVersion": 1,
            "protocolVersion": 1,
            "appVersion": FIXTURE_APP_VERSION,
            "target": FIXTURE_TARGET,
            "srtVersion": "0.0.0",
            "files": listed,
        });
        edit(&mut value);
        serde_json::to_vec(&value).unwrap()
    }

    const A: &[u8] = b"first file";
    const B: &[u8] = b"second file";

    fn good_entries() -> Vec<Entry> {
        vec![
            Entry::file(
                MANIFEST_FILENAME,
                &manifest_with(&[("a", A), ("b", B)], |_| {}),
                0o644,
            ),
            Entry::file("a", A, 0o755),
            Entry::file("b", B, 0o644),
        ]
    }

    /// Runs `install_verified_tarball` over `archive` with a previous `current` in place and
    /// returns the error code, after asserting the previous runtime and the directory listing
    /// are untouched. For `None` it asserts success instead.
    fn run_archive(archive: Vec<u8>) -> Option<&'static str> {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        let current = sandbox.join("current");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("marker"), "previous").unwrap();
        let tarball = app_data.path().join("runtime.tar.gz");
        fs::write(&tarball, archive).unwrap();

        let result =
            install_verified_tarball(&sandbox, &tarball, &spec(), &|a, b| fs::rename(a, b));
        match result {
            Ok(bundle) => {
                assert_eq!(bundle.files, ["a", "b"]);
                assert_eq!(entries(&sandbox), ["current"]);
                assert_eq!(mode(&current.join("a")), 0o755);
                assert_eq!(mode(&current.join("b")), 0o644);
                None
            }
            Err(error) => {
                assert_eq!(
                    fs::read_to_string(current.join("marker")).unwrap(),
                    "previous"
                );
                assert_eq!(entries(&current), ["marker"]);
                assert_eq!(
                    entries(&sandbox),
                    ["current"],
                    "no staging directory remains: {error}"
                );
                Some(error.code)
            }
        }
    }

    #[test]
    fn the_test_archive_builder_produces_an_installable_archive() {
        assert_eq!(run_archive(gz(&tar(&good_entries(), true))), None);
    }

    #[test]
    fn hostile_archives_are_refused_and_change_nothing() {
        let with = |edit: &dyn Fn(&mut Vec<Entry>)| {
            let mut entries = good_entries();
            edit(&mut entries);
            gz(&tar(&entries, true))
        };
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("parent traversal", with(&|e| e[1].name = b"../a".to_vec())),
            ("absolute path", with(&|e| e[1].name = b"/etc/a".to_vec())),
            ("nested path", with(&|e| e[1].name = b"sub/a".to_vec())),
            ("dot-slash path", with(&|e| e[1].name = b"./a".to_vec())),
            (
                "hidden-looking dot name",
                with(&|e| e[1].name = b".a".to_vec()),
            ),
            ("name with a space", with(&|e| e[1].name = b"a b".to_vec())),
            (
                "path prefix field",
                with(&|e| e[1].prefix = b"evil".to_vec()),
            ),
            (
                "symlink",
                with(&|e| {
                    e[1].typeflag = b'2';
                    e[1].linkname = b"/etc/passwd".to_vec();
                    e[1].data.clear();
                }),
            ),
            (
                "hard link",
                with(&|e| {
                    e[1].typeflag = b'1';
                    e[1].linkname = b"b".to_vec();
                    e[1].data.clear();
                }),
            ),
            (
                "directory",
                with(&|e| {
                    e[1].typeflag = b'5';
                    e[1].data.clear();
                }),
            ),
            (
                "character device",
                with(&|e| {
                    e[1].typeflag = b'3';
                    e[1].data.clear();
                }),
            ),
            (
                "fifo",
                with(&|e| {
                    e[1].typeflag = b'6';
                    e[1].data.clear();
                }),
            ),
            ("GNU long name", with(&|e| e[1].typeflag = b'L')),
            ("pax header", with(&|e| e[1].typeflag = b'x')),
            (
                "link target on a plain file",
                with(&|e| e[1].linkname = b"x".to_vec()),
            ),
            (
                "duplicate entry",
                with(&|e| e.push(Entry::file("a", A, 0o755))),
            ),
            (
                "extra file not in the manifest",
                with(&|e| e.push(Entry::file("extra", b"x", 0o644))),
            ),
            (
                "missing file",
                with(&|e| {
                    e.pop();
                }),
            ),
            ("manifest not first", with(&|e| e.swap(0, 1))),
            (
                "no manifest at all",
                with(&|e| {
                    e.remove(0);
                }),
            ),
            ("executable manifest", with(&|e| e[0].mode = 0o755)),
            ("setuid mode", with(&|e| e[1].mode = 0o4755)),
            ("group-writable mode", with(&|e| e[1].mode = 0o664)),
            (
                "content differs from the manifest hash",
                with(&|e| e[1].data = b"FIRST FILE".to_vec()),
            ),
            (
                "size differs from the manifest",
                with(&|e| e[1].data = b"first file!".to_vec()),
            ),
            (
                "entry claims more bytes than the archive has",
                with(&|e| e[2].declared_size = Some(1 << 30)),
            ),
            (
                "manifest listing itself",
                with(&|e| {
                    e[0].data =
                        manifest_with(&[("a", A), ("b", B), (MANIFEST_FILENAME, b"x")], |_| {});
                }),
            ),
            (
                "oversize file in the manifest",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B)], |m| {
                        m["files"]["a"]["size"] = serde_json::json!(MAX_FILE_BYTES + 1);
                    });
                }),
            ),
            (
                "total size over the cap",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B)], |m| {
                        m["files"]["a"]["size"] = serde_json::json!(MAX_FILE_BYTES);
                        m["files"]["b"]["size"] = serde_json::json!(MAX_FILE_BYTES);
                        m["files"]["c"] = serde_json::json!({"sha256": sha(b""), "size": 1});
                    });
                }),
            ),
            // The manifest and the archive agree on a hostile name: only the name rules stop it.
            (
                "manifest and archive both name a traversal path",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B), ("../c", b"x")], |_| {});
                    e.push(Entry::file("../c", b"x", 0o644));
                }),
            ),
            (
                "manifest and archive both name an absolute path",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B), ("/tmp/c", b"x")], |_| {});
                    e.push(Entry::file("/tmp/c", b"x", 0o644));
                }),
            ),
            (
                "manifest and archive both name a nested path",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B), ("d/c", b"x")], |_| {});
                    e.push(Entry::file("d/c", b"x", 0o644));
                }),
            ),
            (
                "uppercase hash",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B)], |m| {
                        let upper = sha(A).to_uppercase();
                        m["files"]["a"]["sha256"] = serde_json::json!(upper);
                    });
                }),
            ),
            (
                "unknown manifest key",
                with(&|e| {
                    e[0].data =
                        manifest_with(&[("a", A), ("b", B)], |m| m["extra"] = serde_json::json!(1));
                }),
            ),
            (
                "unknown schema version",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B)], |m| {
                        m["schemaVersion"] = serde_json::json!(2)
                    });
                }),
            ),
            (
                "protocol version as a string",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B)], |m| {
                        m["protocolVersion"] = serde_json::json!("1")
                    });
                }),
            ),
            (
                "older protocol",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B)], |m| {
                        m["protocolVersion"] = serde_json::json!(0)
                    });
                }),
            ),
            (
                "newer protocol",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B)], |m| {
                        m["protocolVersion"] = serde_json::json!(2)
                    });
                }),
            ),
            (
                "other app version",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B)], |m| {
                        m["appVersion"] = serde_json::json!("0.0.1")
                    });
                }),
            ),
            (
                "other target",
                with(&|e| {
                    e[0].data = manifest_with(&[("a", A), ("b", B)], |m| {
                        m["target"] = serde_json::json!("aarch64-apple-darwin")
                    });
                }),
            ),
            (
                "manifest is not JSON",
                with(&|e| e[0].data = b"{nope".to_vec()),
            ),
            (
                "manifest too large",
                with(&|e| e[0].data = vec![b' '; (MAX_MANIFEST_BYTES + 1) as usize]),
            ),
            ("no end marker", gz(&tar(&good_entries(), false))),
            ("trailing data after the end marker", {
                let mut raw = tar(&good_entries(), true);
                raw.extend_from_slice(b"trailing");
                gz(&raw)
            }),
            ("truncated archive", {
                let raw = tar(&good_entries(), true);
                gz(&raw[..raw.len() - BLOCK * 3])
            }),
            ("corrupt header checksum", {
                let mut raw = tar(&good_entries(), true);
                raw[1] ^= 1; // a byte of the first header's name
                gz(&raw)
            }),
            ("nonzero padding", {
                let mut raw = tar(&good_entries(), true);
                let manifest_len = good_entries()[0].data.len();
                assert_ne!(manifest_len % BLOCK, 0, "the manifest must leave padding");
                raw[BLOCK + manifest_len] = 1;
                gz(&raw)
            }),
            ("empty archive", gz(&[0u8; BLOCK * 2])),
            ("not gzip", b"plain text".to_vec()),
            ("empty file", Vec::new()),
        ];
        for (label, archive) in cases {
            assert_eq!(
                run_archive(archive),
                Some(SANDBOX_BUNDLE_INVALID),
                "{label}"
            );
        }
    }

    #[test]
    fn a_failure_while_swapping_restores_the_previous_runtime_and_cleans_up() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        let current = sandbox.join("current");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("marker"), "previous").unwrap();
        let tarball = app_data.path().join("runtime.tar.gz");
        fs::write(&tarball, gz(&tar(&good_entries(), true))).unwrap();

        // Step 1 moves the old one aside, step 2 would move the new one in: fail step 2.
        let step = std::cell::Cell::new(0);
        let failing = |from: &Path, to: &Path| {
            step.set(step.get() + 1);
            if step.get() == 2 {
                Err(io::Error::other("injected"))
            } else {
                fs::rename(from, to)
            }
        };
        let error = install_verified_tarball(&sandbox, &tarball, &spec(), &failing).unwrap_err();
        assert_eq!(error.code, SANDBOX_INSTALL_FAILED);
        assert_eq!(step.get(), 3, "aside, failed install, restore");
        assert_eq!(
            fs::read_to_string(current.join("marker")).unwrap(),
            "previous"
        );
        assert_eq!(
            entries(&sandbox),
            ["current"],
            "staging and the aside copy are gone"
        );

        // The very first rename failing leaves the old one where it was.
        let failing_first = |_: &Path, _: &Path| Err(io::Error::other("injected"));
        let error =
            install_verified_tarball(&sandbox, &tarball, &spec(), &failing_first).unwrap_err();
        assert_eq!(error.code, SANDBOX_INSTALL_FAILED);
        assert_eq!(
            fs::read_to_string(current.join("marker")).unwrap(),
            "previous"
        );
        assert_eq!(entries(&sandbox), ["current"]);
    }

    #[test]
    fn a_failure_with_no_previous_runtime_leaves_no_current_either() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        fs::create_dir_all(&sandbox).unwrap();
        let tarball = app_data.path().join("runtime.tar.gz");
        fs::write(&tarball, gz(&tar(&good_entries(), true))).unwrap();
        let failing = |_: &Path, _: &Path| Err(io::Error::other("injected"));
        assert!(install_verified_tarball(&sandbox, &tarball, &spec(), &failing).is_err());
        assert!(entries(&sandbox).is_empty());
    }

    // ------------------------------------------------------------ host integration

    fn host(app_data: &Path) -> LocalHost {
        LocalHost::open(app_data).unwrap()
    }

    #[test]
    fn readiness_says_installing_while_an_install_runs_and_a_second_one_is_refused() {
        struct Probing<'a> {
            host: &'a LocalHost,
            inner: MemFetch,
            seen: RefCell<Vec<SandboxReadiness>>,
            second: RefCell<Option<&'static str>>,
            spec: InstallSpec,
        }
        impl Fetch for Probing<'_> {
            fn get_to_file(&self, url: &str, dest: &Path, max: u64) -> Result<()> {
                self.seen.borrow_mut().push(self.host.sandbox_readiness());
                let second = self
                    .host
                    .install_sandbox_runtime_with(&self.spec, &self.inner);
                *self.second.borrow_mut() = Some(second.unwrap_err().code);
                self.inner.get_to_file(url, dest, max)
            }
        }
        let app_data = tempfile::tempdir().unwrap();
        let host = host(app_data.path());
        let spec = spec();
        let fetch = Probing {
            host: &host,
            inner: MemFetch::fixture(&spec),
            seen: RefCell::new(Vec::new()),
            second: RefCell::new(None),
            spec: spec.clone(),
        };
        host.install_sandbox_runtime_with(&spec, &fetch).unwrap();
        assert_eq!(fetch.seen.borrow()[0], SandboxReadiness::installing());
        assert_eq!(*fetch.second.borrow(), Some(SANDBOX_INSTALL_IN_PROGRESS));
        // Finished: no longer installing, and the same host can install again.
        assert!(!ReadinessCache::is_installing(
            &host.sandbox_readiness_cache
        ));
        host.install_sandbox_runtime_with(&spec, &MemFetch::fixture(&spec))
            .unwrap();
    }

    #[test]
    fn a_failed_install_ends_the_installing_state_and_drops_the_cached_answer() {
        let app_data = tempfile::tempdir().unwrap();
        let host = host(app_data.path());
        let spec = spec();
        ReadinessCache::seed_for_test(
            &host.sandbox_readiness_cache,
            SandboxReadiness::bundle_missing(),
        );
        let broken = MemFetch {
            bodies: HashMap::new(),
            requests: RefCell::new(vec![]),
        };
        let error = host
            .install_sandbox_runtime_with(&spec, &broken)
            .unwrap_err();
        assert_eq!(error.code, SANDBOX_DOWNLOAD_FAILED);
        assert!(!ReadinessCache::is_installing(
            &host.sandbox_readiness_cache
        ));
        assert!(ReadinessCache::cached_for_test(&host.sandbox_readiness_cache).is_none());
        // A later attempt is allowed.
        host.install_sandbox_runtime_with(&spec, &MemFetch::fixture(&spec))
            .unwrap();
        assert!(ReadinessCache::cached_for_test(&host.sandbox_readiness_cache).is_none());
    }

    #[test]
    fn the_install_result_is_a_real_readiness_and_installing_is_over() {
        let app_data = tempfile::tempdir().unwrap();
        let host = host(app_data.path());
        let spec = spec();
        let readiness = host
            .install_and_probe_with(&spec, &MemFetch::fixture(&spec))
            .unwrap();
        assert_ne!(readiness, SandboxReadiness::installing());
        assert_ne!(readiness, SandboxReadiness::checking());
        // A failed install is an error, not a readiness.
        let broken = MemFetch {
            bodies: HashMap::new(),
            requests: RefCell::new(vec![]),
        };
        assert_eq!(
            host.install_and_probe_with(&spec, &broken)
                .unwrap_err()
                .code,
            SANDBOX_DOWNLOAD_FAILED
        );
    }

    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    #[test]
    fn the_production_install_reports_an_unsupported_platform_without_touching_anything() {
        let app_data = tempfile::tempdir().unwrap();
        let host = host(app_data.path());
        let error = host.install_sandbox_runtime().unwrap_err();
        assert_eq!(error.code, SANDBOX_PLATFORM_UNSUPPORTED);
        assert!(!app_data.path().join("sandbox").exists());
        assert!(!ReadinessCache::is_installing(
            &host.sandbox_readiness_cache
        ));
    }

    // -------------------------------------------------------------- real HTTP client

    /// A one-connection-at-a-time HTTP/1.1 server on loopback that answers every request with
    /// `respond`. Stops when `stop` is set.
    fn serve(
        respond: impl Fn(&mut TcpStream, &AtomicBool) + Send + 'static,
    ) -> (String, Arc<AtomicBool>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let handle = std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let mut request = [0u8; 4096];
                        let _ = stream.read(&mut request);
                        respond(&mut stream, &flag);
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        });
        (base, stop, handle)
    }

    fn finish(stop: Arc<AtomicBool>, handle: std::thread::JoinHandle<()>) {
        stop.store(true, Ordering::SeqCst);
        handle.join().unwrap();
    }

    #[test]
    fn the_real_client_streams_a_body_within_the_cap_into_the_file() {
        let (base, stop, handle) = serve(|stream, _| {
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
            );
        });
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("body");
        HttpsFetch::new()
            .unwrap()
            .get_to_file(&format!("{base}/a"), &dest, 100)
            .unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"hello");
        finish(stop, handle);
    }

    #[test]
    fn the_real_client_enforces_the_size_cap_with_and_without_a_content_length() {
        let (declared, stop_a, handle_a) = serve(|stream, _| {
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n",
            );
        });
        let (streamed, stop_b, handle_b) = serve(|stream, _| {
            // No Content-Length: the connection close ends the body; it just never stops early.
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
            for _ in 0..100 {
                if stream.write_all(&[b'x'; 1024]).is_err() {
                    break;
                }
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let fetch = HttpsFetch::new().unwrap();
        for (label, base) in [("declared", &declared), ("streamed", &streamed)] {
            let dest = dir.path().join(label);
            let error = fetch
                .get_to_file(&format!("{base}/a"), &dest, 4096)
                .unwrap_err();
            assert_eq!(error.code, SANDBOX_DOWNLOAD_FAILED, "{label}");
            assert!(
                error.message.contains("larger than allowed"),
                "{label}: {error}"
            );
        }
        finish(stop_a, handle_a);
        finish(stop_b, handle_b);
    }

    /// Sends a 200 with `chunks` pieces of 10 bytes, `pause` apart (until the test is over).
    fn trickle(chunks: usize, pause: Duration) -> impl Fn(&mut TcpStream, &AtomicBool) + Send {
        move |stream, stop| {
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    chunks * 10
                )
                .as_bytes(),
            );
            for _ in 0..chunks {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                if stream
                    .write_all(&[b'x'; 10])
                    .and_then(|()| stream.flush())
                    .is_err()
                {
                    return;
                }
                std::thread::sleep(pause);
            }
        }
    }

    #[test]
    fn a_slow_but_steady_download_outlives_the_idle_timeout() {
        // 12 pieces 100 ms apart take ~1.2 s, three times the 400 ms idle timeout: only
        // inactivity ends a download, not its duration.
        let (base, stop, handle) = serve(trickle(12, Duration::from_millis(100)));
        let dir = tempfile::tempdir().unwrap();
        let fetch =
            HttpsFetch::with_timeouts(Duration::from_millis(400), Duration::from_secs(30)).unwrap();
        let dest = dir.path().join("body");
        let started = Instant::now();
        fetch
            .get_to_file(&format!("{base}/a"), &dest, 1000)
            .unwrap();
        assert!(started.elapsed() > Duration::from_millis(900));
        assert_eq!(fs::read(&dest).unwrap().len(), 120);
        finish(stop, handle);
    }

    #[test]
    fn the_real_client_gives_up_on_a_stalled_server_within_its_idle_timeout() {
        let (base, stop, handle) = serve(|stream, stop| {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nab");
            let _ = stream.flush();
            // Stall mid-body until the test is over.
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let fetch =
            HttpsFetch::with_timeouts(Duration::from_millis(400), Duration::from_secs(60)).unwrap();
        let started = Instant::now();
        let error = fetch
            .get_to_file(&format!("{base}/a"), &dir.path().join("body"), 100)
            .unwrap_err();
        assert_eq!(error.code, SANDBOX_DOWNLOAD_FAILED);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
        finish(stop, handle);
    }

    #[test]
    fn the_overall_ceiling_ends_a_download_that_never_goes_idle() {
        // Steady progress, but longer than the 700 ms overall limit.
        let (base, stop, handle) = serve(trickle(100, Duration::from_millis(100)));
        let dir = tempfile::tempdir().unwrap();
        let fetch =
            HttpsFetch::with_timeouts(Duration::from_millis(400), Duration::from_millis(700))
                .unwrap();
        let started = Instant::now();
        let error = fetch
            .get_to_file(&format!("{base}/a"), &dir.path().join("body"), 10_000)
            .unwrap_err();
        assert_eq!(error.code, SANDBOX_DOWNLOAD_FAILED);
        assert!(started.elapsed() < Duration::from_secs(5));
        finish(stop, handle);
    }

    #[test]
    fn the_production_timeouts_are_an_idle_limit_and_a_generous_ceiling() {
        assert_eq!(IDLE_TIMEOUT, Duration::from_secs(30));
        assert_eq!(TOTAL_TIMEOUT, Duration::from_secs(15 * 60));
    }

    // --------------------------------------------------------------- crash recovery

    /// What an installed runtime looks like on disk.
    fn make_runtime(dir: &Path, marker: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("srt-sidecar"), "x").unwrap();
        fs::write(dir.join("manifest.json"), "{}").unwrap();
        fs::write(dir.join("marker"), marker).unwrap();
    }

    fn offline_fetch() -> MemFetch {
        MemFetch {
            bodies: HashMap::new(),
            requests: RefCell::new(vec![]),
        }
    }

    #[test]
    fn a_crash_between_the_renames_is_repaired_before_anything_is_swept() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        // The state after `rename(current, .old-X)` and a death before `rename(staging, current)`.
        make_runtime(&sandbox.join(".old-aaaa"), "previous");
        make_runtime(&sandbox.join(".staging-bbbb"), "half installed");
        assert!(!sandbox.join("current").exists());

        // (a) The retry fails offline, and the user still has the previous runtime.
        let error = install(app_data.path(), &spec(), &offline_fetch()).unwrap_err();
        assert_eq!(error.code, SANDBOX_DOWNLOAD_FAILED);
        assert_eq!(
            fs::read_to_string(sandbox.join("current/marker")).unwrap(),
            "previous"
        );
        assert_eq!(entries(&sandbox), ["current"], "the leftovers are gone");
    }

    #[test]
    fn a_repaired_runtime_is_then_replaced_by_a_successful_install() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        make_runtime(&sandbox.join(".old-aaaa"), "previous");
        let spec = spec();
        install(app_data.path(), &spec, &MemFetch::fixture(&spec)).unwrap();
        assert!(!sandbox.join("current/marker").exists());
        assert_eq!(entries(&sandbox), ["current"]);
    }

    #[test]
    fn recovery_never_guesses_between_several_candidates_and_never_deletes_them() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        make_runtime(&sandbox.join(".old-one"), "one");
        make_runtime(&sandbox.join(".old-two"), "two");
        assert!(!recover_previous_runtime(&sandbox));
        assert!(!sandbox.join("current").exists());

        let error = install(app_data.path(), &spec(), &offline_fetch()).unwrap_err();
        assert_eq!(error.code, SANDBOX_DOWNLOAD_FAILED);
        assert_eq!(
            entries(&sandbox),
            [".old-one", ".old-two"],
            "both copies survive a failed retry while current is missing"
        );
    }

    #[test]
    fn garbage_old_directories_are_not_restored_and_are_swept_around_a_real_one() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        make_runtime(&sandbox.join(".old-real"), "real");
        // Not runtimes: empty, only half the files, a file, and a symlink to a real runtime.
        fs::create_dir_all(sandbox.join(".old-empty")).unwrap();
        fs::create_dir_all(sandbox.join(".old-partial")).unwrap();
        fs::write(sandbox.join(".old-partial/srt-sidecar"), "x").unwrap();
        fs::write(sandbox.join(".old-file"), "x").unwrap();
        make_runtime(&app_data.path().join("elsewhere"), "elsewhere");
        std::os::unix::fs::symlink(app_data.path().join("elsewhere"), sandbox.join(".old-link"))
            .unwrap();

        let error = install(app_data.path(), &spec(), &offline_fetch()).unwrap_err();
        assert_eq!(error.code, SANDBOX_DOWNLOAD_FAILED);
        assert_eq!(
            fs::read_to_string(sandbox.join("current/marker")).unwrap(),
            "real"
        );
        assert_eq!(entries(&sandbox), ["current"]);
        assert!(
            app_data.path().join("elsewhere/marker").exists(),
            "the link's target is not touched"
        );
    }

    #[test]
    fn only_garbage_with_no_current_is_swept_and_nothing_is_invented() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        fs::create_dir_all(sandbox.join(".old-empty")).unwrap();
        assert!(!recover_previous_runtime(&sandbox));
        let _ = install(app_data.path(), &spec(), &offline_fetch());
        assert!(entries(&sandbox).is_empty());
    }

    #[test]
    fn recovery_does_nothing_while_current_exists() {
        let app_data = tempfile::tempdir().unwrap();
        let sandbox = app_data.path().join("sandbox");
        make_runtime(&sandbox.join("current"), "live");
        make_runtime(&sandbox.join(".old-aaaa"), "stale");
        assert!(!recover_previous_runtime(&sandbox));
        assert_eq!(
            fs::read_to_string(sandbox.join("current/marker")).unwrap(),
            "live"
        );
        // And a sweep with a live `current` does remove the leftover.
        let _ = install(app_data.path(), &spec(), &offline_fetch());
        assert_eq!(entries(&sandbox), ["current"]);
        assert_eq!(
            fs::read_to_string(sandbox.join("current/marker")).unwrap(),
            "live"
        );
    }

    #[test]
    fn the_real_client_refuses_http_errors_non_https_urls_and_redirects_to_them() {
        let (base, stop, handle) = serve(|stream, _| {
            let _ = stream.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        });
        let (redirecting, stop_r, handle_r) = serve(|stream, _| {
            let _ = stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://example.invalid/runtime\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        let dir = tempfile::tempdir().unwrap();
        let fetch = HttpsFetch::new().unwrap();
        let dest = |name: &str| dir.path().join(name);

        let not_found = fetch
            .get_to_file(&format!("{base}/a"), &dest("a"), 100)
            .unwrap_err();
        assert!(not_found.message.contains("404"), "{not_found}");
        let redirected = fetch
            .get_to_file(&format!("{redirecting}/a"), &dest("b"), 100)
            .unwrap_err();
        assert_eq!(redirected.code, SANDBOX_DOWNLOAD_FAILED);
        for url in [
            "http://example.com/a",
            "http://localhost:1/a",
            "ftp://127.0.0.1/a",
            "file:///etc/passwd",
            "not a url",
        ] {
            let error = fetch.get_to_file(url, &dest("c"), 100).unwrap_err();
            assert_eq!(error.code, SANDBOX_DOWNLOAD_FAILED, "{url}");
        }
        assert!(!dest("c").exists(), "nothing is created for a refused URL");
        finish(stop, handle);
        finish(stop_r, handle_r);
    }
}
