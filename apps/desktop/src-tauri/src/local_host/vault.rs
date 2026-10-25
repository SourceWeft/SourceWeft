//! The device vault: secrets a user stores on this device so sandboxed commands can use them
//! without ever seeing them.
//!
//! Where things live (decision S4): the secret *value* only in the OS keychain, behind the
//! [`SecretStore`] the desktop app supplies (the keychain module belongs to the app binary, so
//! the library takes it as a trait); the *metadata* (id, label, variable name, bound hosts,
//! read-only flag, creation time) in this host's SQLite table `vault_secrets`. The backend and
//! the model never see values. A command sees only a placeholder in the variable; the sidecar's
//! TLS-terminating proxy swaps the real value in on requests to the bound hosts (see
//! `srt_exec.rs`).
//!
//! Values are held in [`SecretValue`], whose `Debug` redacts and which wipes its bytes on drop.
//! Nothing here logs a value, and no error message contains one.
use super::{HostError, LocalHost, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// Keychain service every vault value is stored under; the account is the secret id.
pub const SERVICE: &str = "sourceweft-local-vault";

/// At most this many secrets on a device.
pub const MAX_SECRETS: usize = 20;
/// Longest value, in bytes.
pub const MAX_VALUE_BYTES: usize = 4096;
/// Most hosts one secret may be bound to.
pub const MAX_HOSTS: usize = 50;
/// Most distinct hosts across the whole vault. The vault's hosts are merged into a command's
/// network allow list (S7), and the sidecar accepts at most 500 entries there, so this keeps the
/// merge from ever being able to overflow it.
pub const MAX_TOTAL_HOSTS: usize = 200;
/// Longest label, in characters.
pub const MAX_LABEL_CHARS: usize = 100;

/// Where values are kept. The app implements this over the OS keychain; tests use memory.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> std::result::Result<Option<Vec<u8>>, String>;
    fn set(&self, account: &str, secret: &[u8]) -> std::result::Result<(), String>;
    /// Deleting an item that does not exist is `Ok`.
    fn delete(&self, account: &str) -> std::result::Result<(), String>;
}

/// Overwrites `bytes` with zeros in a way the optimizer may not remove.
pub(crate) fn wipe(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        // SAFETY: `byte` is a valid, aligned, exclusive reference.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// A secret value. `Debug` prints nothing of it; the bytes are zeroed on drop.
pub struct SecretValue(String);

impl SecretValue {
    pub fn new(value: String) -> Self {
        Self(value)
    }
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretValue(<redacted>)")
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        // SAFETY: zero bytes are valid UTF-8, so the string stays valid.
        wipe(unsafe { self.0.as_bytes_mut() });
    }
}

/// What the UI and the command path may know about a secret. Never the value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMeta {
    pub id: String,
    pub label: String,
    pub env_var: String,
    pub hosts: Vec<String>,
    /// Requests other than GET/HEAD/OPTIONS to the bound hosts need the user's approval.
    pub read_only: bool,
    /// Unix seconds.
    pub created_at: i64,
}

/// `vault_list`'s answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultListing {
    pub secrets: Vec<SecretMeta>,
    /// Whether this platform substitutes the secrets into requests. macOS keeps Seatbelt for
    /// now: it stores and lists them but does not inject them.
    pub enforced: bool,
}

/// A secret to add. `Debug` redacts the value.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSecret {
    pub label: String,
    pub env_var: String,
    pub value: String,
    pub hosts: Vec<String>,
    #[serde(default = "default_read_only")]
    pub read_only: bool,
    /// The user ticked the interception consent ("this device will decrypt the sandbox's HTTPS
    /// so the proxy can substitute the secret"). Required for the first secret of an empty
    /// vault; the web UI sends it after the checkbox.
    #[serde(default)]
    pub acknowledged_interception: Option<bool>,
}

fn default_read_only() -> bool {
    true
}

impl std::fmt::Debug for NewSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewSecret")
            .field("label", &self.label)
            .field("env_var", &self.env_var)
            .field("value", &"<redacted>")
            .field("hosts", &self.hosts)
            .field("read_only", &self.read_only)
            .field("acknowledged_interception", &self.acknowledged_interception)
            .finish()
    }
}

impl Drop for NewSecret {
    fn drop(&mut self) {
        // SAFETY: zero bytes are valid UTF-8.
        wipe(unsafe { self.value.as_bytes_mut() });
    }
}

/// A secret with its value, for one command's `wrap` only.
#[derive(Debug)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct VaultEntry {
    pub meta: SecretMeta,
    pub value: SecretValue,
}

/// The keychain handle slot on `LocalHost`.
#[derive(Default)]
pub struct VaultStore {
    store: Mutex<Option<Arc<dyn SecretStore>>>,
}

impl VaultStore {
    fn get(&self) -> Result<Arc<dyn SecretStore>> {
        self.store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| HostError::new("VAULT_UNAVAILABLE", "The device keychain is not available."))
    }
}

fn invalid(message: impl Into<String>) -> HostError {
    HostError::new("VAULT_INVALID", message)
}

/// Environment variables a secret may not take: the ones the host pins for every command
/// (`srt_exec::child_env`), the ones the sandbox proxy sets for trust and routing, and the
/// loader/shell hooks that change how a program starts.
const RESERVED_ENV: &[&str] = &[
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "PIP_CACHE_DIR", "NODE_USE_ENV_PROXY", "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
    "PIP_CERT", "GIT_SSL_CAINFO", "AWS_CA_BUNDLE", "CARGO_HTTP_CAINFO", "DENO_CERT", "HTTP_PROXY",
    "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY", "GRPC_PROXY", "BASH_ENV", "ENV", "IFS",
    "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "LANG", "SANDBOX_RUNTIME",
];

fn validate_env_var(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == '_');
    if !first_ok
        || name.len() > 128
        || !name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(invalid(
            "The variable name must match [A-Z_][A-Z0-9_]* (at most 128 characters).",
        ));
    }
    if RESERVED_ENV.contains(&name)
        || name.starts_with("LD_")
        || name.starts_with("DYLD_")
        || name.starts_with("LC_")
    {
        return Err(invalid(format!(
            "{name} is reserved by the sandbox and cannot hold a secret."
        )));
    }
    Ok(())
}

/// A host a secret may be bound to, normalised to lower case: an EXACT hostname with at least
/// one dot. No wildcards at all (a wildcard such as `*.github.io` or `*.co.uk` would send the
/// real value to every tenant of a shared suffix), no port, no IP literal, no path. The sidecar
/// re-validates every request.
fn normalise_host(entry: &str) -> Result<String> {
    let bad = || {
        invalid(format!(
            "{entry:?} is not a valid host: use an exact hostname such as api.example.com."
        ))
    };
    let host = entry.trim().to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 {
        return Err(bad());
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
    {
        return Err(bad());
    }
    // `1.2.3.4`, `127.1`, `0x7f.0.0.1` and friends are IP spellings, not names: a real name's
    // last label starts with a letter.
    if !labels
        .last()
        .and_then(|l| l.chars().next())
        .is_some_and(|c| c.is_ascii_lowercase())
    {
        return Err(bad());
    }
    Ok(host)
}

fn has_control(text: &str) -> bool {
    text.chars().any(char::is_control)
}

fn validate(new: &NewSecret) -> Result<Vec<String>> {
    let label = new.label.trim();
    if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS || has_control(label) {
        return Err(invalid(format!(
            "The label must be 1 to {MAX_LABEL_CHARS} characters without control characters."
        )));
    }
    validate_env_var(&new.env_var)?;
    if new.value.is_empty() || new.value.len() > MAX_VALUE_BYTES || has_control(&new.value) {
        return Err(invalid(format!(
            "The value must be 1 to {MAX_VALUE_BYTES} bytes without control characters."
        )));
    }
    if new.hosts.is_empty() || new.hosts.len() > MAX_HOSTS {
        return Err(invalid(format!("Bind the secret to 1 to {MAX_HOSTS} hosts.")));
    }
    let mut hosts = Vec::new();
    for entry in &new.hosts {
        let host = normalise_host(entry)?;
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    Ok(hosts)
}

pub(crate) const CREATE_TABLE: &str = "CREATE TABLE IF NOT EXISTS vault_secrets(
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    env_var TEXT NOT NULL UNIQUE,
    hosts TEXT NOT NULL,
    read_only INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL);";

impl LocalHost {
    /// Supplies the keychain. Until this is called every vault operation fails with
    /// `VAULT_UNAVAILABLE` (nothing falls back to another store).
    pub fn set_secret_store(&self, store: Arc<dyn SecretStore>) {
        *self.vault_store.store.lock().unwrap_or_else(|e| e.into_inner()) = Some(store);
    }

    fn vault_rows(&self) -> Result<Vec<SecretMeta>> {
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Database lock failed"))?;
        let mut statement = db.prepare(
            "SELECT id,label,env_var,hosts,read_only,created_at FROM vault_secrets ORDER BY created_at,id",
        )?;
        let rows = statement.query_map([], |row| {
            let hosts: String = row.get(3)?;
            Ok(SecretMeta {
                id: row.get(0)?,
                label: row.get(1)?,
                env_var: row.get(2)?,
                hosts: serde_json::from_str(&hosts).unwrap_or_default(),
                read_only: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Metadata only, never values.
    pub fn vault_list(&self) -> Result<VaultListing> {
        Ok(VaultListing {
            secrets: self.vault_rows()?,
            enforced: cfg!(target_os = "linux"),
        })
    }

    pub fn vault_is_empty(&self) -> Result<bool> {
        Ok(self.vault_rows()?.is_empty())
    }

    /// Validates and stores a secret: the value in the keychain, the metadata in SQLite.
    pub fn vault_set(&self, new: NewSecret) -> Result<SecretMeta> {
        let hosts = validate(&new)?;
        let store = self.vault_store.get()?;
        let existing = self.vault_rows()?;
        if existing.len() >= MAX_SECRETS {
            return Err(invalid(format!("At most {MAX_SECRETS} secrets can be stored.")));
        }
        if existing.iter().any(|m| m.env_var == new.env_var) {
            return Err(invalid(format!("{} is already used by another secret.", new.env_var)));
        }
        if existing.is_empty() && new.acknowledged_interception != Some(true) {
            return Err(HostError::new(
                "VAULT_CONSENT_REQUIRED",
                "Storing the first secret turns on TLS interception for sandboxed commands; \
                 acknowledge it to continue.",
            ));
        }
        let mut distinct: Vec<&str> = existing
            .iter()
            .flat_map(|m| m.hosts.iter().map(String::as_str))
            .collect();
        for host in &hosts {
            if !distinct.contains(&host.as_str()) {
                distinct.push(host);
            }
        }
        if distinct.len() > MAX_TOTAL_HOSTS {
            return Err(invalid(format!(
                "The vault can bind at most {MAX_TOTAL_HOSTS} distinct hosts in total."
            )));
        }
        let meta = SecretMeta {
            id: uuid::Uuid::new_v4().to_string(),
            label: new.label.trim().to_string(),
            env_var: new.env_var.clone(),
            hosts,
            read_only: new.read_only,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        };
        store
            .set(&meta.id, new.value.as_bytes())
            .map_err(|e| HostError::new("VAULT_UNAVAILABLE", e))?;
        let inserted = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Database lock failed"))
            .and_then(|db| {
                db.execute(
                    "INSERT INTO vault_secrets(id,label,env_var,hosts,read_only,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![
                        meta.id,
                        meta.label,
                        meta.env_var,
                        serde_json::to_string(&meta.hosts).unwrap_or_else(|_| "[]".into()),
                        meta.read_only as i64,
                        meta.created_at
                    ],
                )
                .map_err(HostError::from)
            });
        if let Err(error) = inserted {
            // Do not leave a keychain item that no row describes.
            let _ = store.delete(&meta.id);
            return Err(error);
        }
        Ok(meta)
    }

    /// Removes a secret everywhere. The keychain item goes first: a failure there leaves the
    /// row (and the secret) intact and reported, rather than an invisible orphan value.
    pub fn vault_remove(&self, id: &str) -> Result<()> {
        let store = self.vault_store.get()?;
        store
            .delete(id)
            .map_err(|e| HostError::new("VAULT_UNAVAILABLE", e))?;
        self.db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Database lock failed"))?
            .execute("DELETE FROM vault_secrets WHERE id=?1", [id])?;
        Ok(())
    }

    /// Every secret with its value, for one command's `wrap`. A secret whose keychain item is
    /// missing fails the command (naming the label, never a value) instead of running it
    /// without the secret.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn vault_entries(&self) -> Result<Vec<VaultEntry>> {
        let rows = self.vault_rows()?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let store = self.vault_store.get()?;
        rows.into_iter()
            .map(|meta| {
                let bytes = store
                    .get(&meta.id)
                    .map_err(|e| HostError::new("VAULT_UNAVAILABLE", e))?
                    .ok_or_else(|| {
                        HostError::new(
                            "VAULT_VALUE_MISSING",
                            format!("The stored value for the secret {:?} is missing from the keychain.", meta.label),
                        )
                    })?;
                let value = String::from_utf8(bytes).map_err(|error| {
                    let mut bytes = error.into_bytes();
                    wipe(&mut bytes);
                    HostError::new("VAULT_VALUE_MISSING", "A stored secret value is not valid text.")
                })?;
                Ok(VaultEntry {
                    meta,
                    value: SecretValue::new(value),
                })
            })
            .collect()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    /// An in-memory keychain.
    #[derive(Default)]
    pub(crate) struct MemoryStore {
        pub items: Mutex<HashMap<String, Vec<u8>>>,
        pub fail_set: Mutex<bool>,
        pub fail_get: Mutex<bool>,
    }

    impl SecretStore for MemoryStore {
        fn get(&self, account: &str) -> std::result::Result<Option<Vec<u8>>, String> {
            if *self.fail_get.lock().unwrap() {
                return Err("keychain is locked".into());
            }
            Ok(self.items.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &[u8]) -> std::result::Result<(), String> {
            if *self.fail_set.lock().unwrap() {
                return Err("keychain locked".into());
            }
            self.items.lock().unwrap().insert(account.into(), secret.to_vec());
            Ok(())
        }
        fn delete(&self, account: &str) -> std::result::Result<(), String> {
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    pub(crate) fn host_with_store() -> (tempfile::TempDir, LocalHost, Arc<MemoryStore>) {
        let app = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        let store = Arc::new(MemoryStore::default());
        host.set_secret_store(store.clone());
        (app, host, store)
    }

    pub(crate) fn secret(env_var: &str, value: &str, hosts: &[&str]) -> NewSecret {
        NewSecret {
            label: format!("{env_var} token"),
            env_var: env_var.into(),
            value: value.into(),
            hosts: hosts.iter().map(|h| h.to_string()).collect(),
            read_only: true,
            acknowledged_interception: Some(true),
        }
    }

    #[test]
    fn a_secret_round_trips_with_the_value_only_in_the_keychain() {
        let (_app, host, store) = host_with_store();
        assert!(host.vault_is_empty().unwrap());
        let meta = host
            .vault_set(secret("GITHUB_TOKEN", "ghp_REALVALUE", &["API.github.com", "uploads.github.com"]))
            .unwrap();
        assert_eq!(meta.hosts, ["api.github.com", "uploads.github.com"]);
        assert!(meta.read_only);
        // Metadata listing carries no value anywhere.
        let listing = host.vault_list().unwrap();
        assert_eq!(listing.secrets, std::slice::from_ref(&meta));
        let listed = serde_json::to_string(&listing).unwrap();
        assert!(!listed.contains("ghp_REALVALUE"), "{listed}");
        assert_eq!(listing.enforced, cfg!(target_os = "linux"));
        // The SQLite file does not contain it either.
        let db_text = {
            let db = host.db.lock().unwrap();
            let rows: Vec<String> = db
                .prepare("SELECT label||env_var||hosts FROM vault_secrets")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            rows.join("")
        };
        assert!(!db_text.contains("ghp_REALVALUE"));
        // The keychain does.
        assert_eq!(store.items.lock().unwrap()[&meta.id], b"ghp_REALVALUE");
        let entries = host.vault_entries().unwrap();
        assert_eq!(entries[0].value.expose(), "ghp_REALVALUE");
        assert_eq!(entries[0].meta, meta);
    }

    #[test]
    fn remove_deletes_the_keychain_item_and_the_row() {
        let (_app, host, store) = host_with_store();
        let meta = host.vault_set(secret("API_KEY", "v", &["example.com"])).unwrap();
        host.vault_remove(&meta.id).unwrap();
        assert!(host.vault_is_empty().unwrap());
        assert!(store.items.lock().unwrap().is_empty());
        // Removing again is fine.
        host.vault_remove(&meta.id).unwrap();
    }

    #[test]
    fn a_keychain_failure_stores_nothing() {
        let (_app, host, store) = host_with_store();
        *store.fail_set.lock().unwrap() = true;
        let error = host.vault_set(secret("API_KEY", "v", &["example.com"])).unwrap_err();
        assert_eq!(error.code, "VAULT_UNAVAILABLE");
        assert!(host.vault_is_empty().unwrap());
    }

    #[test]
    fn without_a_keychain_everything_fails_closed() {
        let app = tempfile::tempdir().unwrap();
        let host = LocalHost::open(app.path()).unwrap();
        let error = host.vault_set(secret("API_KEY", "v", &["example.com"])).unwrap_err();
        assert_eq!(error.code, "VAULT_UNAVAILABLE");
        // An empty vault needs no keychain to run commands.
        assert!(host.vault_entries().unwrap().is_empty());
    }

    #[test]
    fn a_missing_keychain_item_fails_the_command_without_naming_a_value() {
        let (_app, host, store) = host_with_store();
        let meta = host.vault_set(secret("API_KEY", "topsecret", &["example.com"])).unwrap();
        store.items.lock().unwrap().remove(&meta.id);
        let error = host.vault_entries().unwrap_err();
        assert_eq!(error.code, "VAULT_VALUE_MISSING");
        assert!(!error.message.contains("topsecret"));
    }

    #[test]
    fn limits_and_names_are_enforced() {
        let (_app, host, _store) = host_with_store();
        let reject = |s: NewSecret| host.vault_set(s).unwrap_err();
        for name in ["lower", "1ABC", "A-B", "", "A B"] {
            assert_eq!(reject(secret(name, "v", &["example.com"])).code, "VAULT_INVALID", "{name}");
        }
        for name in ["PATH", "HOME", "TMPDIR", "PIP_CACHE_DIR", "NODE_USE_ENV_PROXY", "LD_PRELOAD", "HTTPS_PROXY", "SSL_CERT_FILE"] {
            let error = reject(secret(name, "v", &["example.com"]));
            assert!(error.message.contains("reserved"), "{name}: {error}");
        }
        assert_eq!(reject(secret("A", "", &["example.com"])).code, "VAULT_INVALID");
        assert_eq!(reject(secret("A", &"x".repeat(4097), &["example.com"])).code, "VAULT_INVALID");
        assert!(host.vault_set(secret("A", &"x".repeat(4096), &["example.com"])).is_ok());
        for value in ["a\nb", "a\rb", "a\0b", "a\u{7f}b", "a\tb"] {
            assert_eq!(reject(secret("B", value, &["example.com"])).code, "VAULT_INVALID", "{value:?}");
        }
        let mut long_label = secret("C", "v", &["example.com"]);
        long_label.label = "l".repeat(101);
        assert_eq!(reject(long_label).code, "VAULT_INVALID");
        let mut control_label = secret("C", "v", &["example.com"]);
        control_label.label = "a\nb".into();
        assert_eq!(reject(control_label).code, "VAULT_INVALID");
        // Names are unique.
        assert!(reject(secret("A", "other", &["example.com"])).message.contains("already used"));
        assert!(host.vault_set(secret("D", "v", &[])).is_err());
        let many: Vec<String> = (0..51).map(|i| format!("h{i}.example.com")).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(host.vault_set(secret("D", "v", &refs)).is_err());
        assert!(host.vault_set(secret("D", "v", &refs[..50])).is_ok());
    }

    #[test]
    fn at_most_twenty_secrets() {
        let (_app, host, _store) = host_with_store();
        for i in 0..MAX_SECRETS {
            host.vault_set(secret(&format!("SECRET_{i}"), "v", &["example.com"])).unwrap();
        }
        let error = host.vault_set(secret("ONE_TOO_MANY", "v", &["example.com"])).unwrap_err();
        assert!(error.message.contains("At most 20"), "{error}");
        assert_eq!(host.vault_list().unwrap().secrets.len(), MAX_SECRETS);
    }

    #[test]
    fn hosts_must_be_exact_hostnames() {
        for ok in ["example.com", "API.Example.COM", "a-b.example.com", "xn--bcher-kva.example", "a.b.c.example.co.uk"] {
            assert!(normalise_host(ok).is_ok(), "{ok}");
        }
        for bad in [
            // No wildcards of any shape: a shared suffix would receive the real value.
            "*", "*.com", "*.example.com", "*.github.io", "*.co.uk", "*.a.b.example.co.uk", "*.",
            "*example.com", "a.*.com", "*.*.com", "a*.example.com",
            "", "com", "localhost", "example.com:443", "https://example.com", "example.com/path",
            "1.2.3.4", "*.1.2.3.4", "[::1]", "::1", "10.0.0.1", ".example.com", "example.com.",
            "a..com", "-a.com", "a-.com", "exa mple.com", "ex\nample.com", "ünicode.com", "127.1",
            "0x7f.0.0.1",
        ] {
            assert!(normalise_host(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn the_first_secret_needs_the_interception_acknowledgement() {
        let (_app, host, _store) = host_with_store();
        for ack in [None, Some(false)] {
            let mut first = secret("API_KEY", "v", &["example.com"]);
            first.acknowledged_interception = ack;
            let error = host.vault_set(first).unwrap_err();
            assert_eq!(error.code, "VAULT_CONSENT_REQUIRED", "{ack:?}");
        }
        assert!(host.vault_is_empty().unwrap());
        host.vault_set(secret("API_KEY", "v", &["example.com"])).unwrap();
        // Once the vault is non-empty the consent has already been given.
        let mut second = secret("OTHER_KEY", "v", &["example.com"]);
        second.acknowledged_interception = None;
        assert!(host.vault_set(second).is_ok());
        // A missing field deserialises to "not acknowledged" (and so is refused when first).
        let parsed: NewSecret = serde_json::from_value(serde_json::json!({
            "label": "l", "envVar": "X_KEY", "value": "v", "hosts": ["example.com"]
        }))
        .unwrap();
        assert_eq!(parsed.acknowledged_interception, None);
        assert!(parsed.read_only);
    }

    #[test]
    fn at_most_two_hundred_distinct_hosts_in_total() {
        let (_app, host, _store) = host_with_store();
        let names = |from: usize, to: usize| -> Vec<String> {
            (from..to).map(|i| format!("h{i}.example.com")).collect()
        };
        for (n, range) in [(0, (0, 50)), (1, (50, 100)), (2, (100, 150)), (3, (150, 200))] {
            let hosts = names(range.0, range.1);
            let refs: Vec<&str> = hosts.iter().map(String::as_str).collect();
            host.vault_set(secret(&format!("S_{n}"), "v", &refs)).unwrap();
        }
        // One more distinct host is over the limit...
        let error = host.vault_set(secret("S_4", "v", &["extra.example.com"])).unwrap_err();
        assert_eq!(error.code, "VAULT_INVALID");
        assert!(error.message.contains("200"), "{error}");
        // ...hosts that are already bound do not count twice.
        assert!(host.vault_set(secret("S_5", "v", &["h0.example.com", "h199.example.com"])).is_ok());
        assert_eq!(host.vault_list().unwrap().secrets.len(), 5);
    }

    #[test]
    fn debug_output_never_shows_a_value() {
        let new = secret("API_KEY", "TOPSECRETVALUE", &["example.com"]);
        assert!(!format!("{new:?}").contains("TOPSECRETVALUE"));
        assert!(format!("{new:?}").contains("API_KEY"));
        let value = SecretValue::new("TOPSECRETVALUE".into());
        assert!(!format!("{value:?}").contains("TOPSECRETVALUE"));
    }

    /// `sidecar` (and so `WrapSecret`) exists on unix only.
    #[cfg(unix)]
    #[test]
    fn the_wire_secret_debug_output_never_shows_a_value() {
        let hosts = vec!["example.com".to_string()];
        let wire = super::super::sidecar::WrapSecret {
            env_var: "API_KEY",
            value: "TOPSECRETVALUE",
            hosts: &hosts,
            read_only: true,
        };
        assert!(!format!("{wire:?}").contains("TOPSECRETVALUE"));
    }

    #[test]
    fn wipe_zeroes_the_bytes() {
        let mut bytes = b"abcdef".to_vec();
        wipe(&mut bytes);
        assert_eq!(bytes, [0u8; 6]);
        let mut value = SecretValue::new("secret".into());
        // Wiping in place leaves a string of NULs the same length (what Drop does).
        wipe(unsafe { value.0.as_bytes_mut() });
        assert_eq!(value.0, "\0".repeat(6));
    }
}
