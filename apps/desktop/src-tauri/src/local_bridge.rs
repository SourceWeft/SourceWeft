//! Narrow discovery bridge for the existing Web UI. No separate native pages.
//! Workspace/file operations stay internal until authenticated dispatch is wired.
use serde::Serialize;
use sourceweft_desktop::local_host::{
    readiness::SandboxReadiness,
    vault::{NewSecret, SecretMeta, SecretStore, VaultListing},
    LocalHost,
};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHostStatus {
    protocol_version: u32,
    platform_supported: bool,
    storage_initialized: bool,
    authenticated_dispatch_available: bool,
    device_id: Option<String>,
    connected: bool,
    connection_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    readiness: Option<SandboxReadiness>,
}

#[tauri::command]
pub async fn authenticate_local_host(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = app
        .try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM")?;
    let _lease = host.host.admission.enter().map_err(str::to_owned)?;
    host.authenticate(ticket, user_id).await
}

/// Async, so Tauri runs it on its async runtime instead of the main thread: on Linux, the first
/// call (and every recheck while setup is needed) starts a sidecar, round-trips `init` + `probe`
/// through bwrap and spawns a login shell, which would otherwise stall the UI for seconds. The
/// probing itself is blocking I/O, so it runs on the blocking pool rather than an async worker.
#[tauri::command]
pub async fn local_host_status(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<LocalHostStatus, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let remote = app
        .try_state::<crate::remote_host::RemoteHost>()
        .map(|host| host.status())
        .unwrap_or_default();
    let host = app
        .try_state::<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>>()
        .map(|host| host.inner().clone());
    let storage_initialized = host.is_some();
    // macOS keeps its Seatbelt path, is always supported, and reports exactly the status it
    // reported before sandbox readiness existed: no `readiness` field, and no probing (which
    // there would spawn a login shell for nothing). Linux is supported only once a readiness
    // probe on the managed LocalHost reports something other than Unsupported; every other
    // platform is unsupported.
    let readiness = if cfg!(target_os = "macos") {
        None
    } else {
        match host {
            Some(host) => Some(
                tauri::async_runtime::spawn_blocking(move || host.sandbox_readiness())
                    .await
                    .map_err(|error| format!("Sandbox readiness check failed: {error}"))?,
            ),
            None => None,
        }
    };
    let platform_supported = if cfg!(target_os = "macos") {
        true
    } else if cfg!(target_os = "linux") {
        matches!(readiness, Some(ref r) if !matches!(r, SandboxReadiness::Unsupported))
    } else {
        false
    };
    Ok(LocalHostStatus {
        protocol_version: 2,
        platform_supported,
        storage_initialized,
        authenticated_dispatch_available: remote.connected,
        device_id: remote.device_id,
        connected: remote.connected,
        connection_error: remote.error,
        readiness,
    })
}

#[tauri::command]
pub async fn enable_local_host(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
) -> Result<crate::remote_host::RemoteStatus, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = app
        .try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM: Local execution currently requires macOS or Linux.")?;
    let _lease = host.host.admission.enter().map_err(str::to_owned)?;
    host.enroll(ticket).await
}

#[tauri::command]
pub fn disconnect_local_host(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    app.try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM: Local execution currently requires macOS or Linux.")?
        .disconnect();
    Ok(())
}

#[tauri::command]
pub async fn choose_local_folder(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = app
        .try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM")?;
    let _lease = host.host.admission.enter().map_err(str::to_owned)?;
    host.choose_folder(&app, ticket, user_id).await
}

/// Compatibility entry point; all folder selection uses account-bound authorization.
#[tauri::command]
pub async fn choose_working_directory(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    choose_local_folder(app, window, ticket, user_id).await
}

/// The device vault's secret values, in the OS keychain under `service` with the secret id as
/// the account. The library takes this as a trait because the keychain module belongs to the
/// app binary.
pub struct KeychainStore {
    service: String,
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self {
            service: sourceweft_desktop::local_host::vault::SERVICE.to_string(),
        }
    }
}

impl SecretStore for KeychainStore {
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        crate::secret_store::get(&self.service, account)
    }
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), String> {
        crate::secret_store::set(&self.service, account, secret)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        crate::secret_store::delete(&self.service, account)
    }
}

fn local_host(app: &AppHandle) -> Result<Arc<LocalHost>, String> {
    app.try_state::<Arc<LocalHost>>()
        .map(|host| host.inner().clone())
        .ok_or_else(|| "UNSUPPORTED_PLATFORM: Local execution currently requires macOS or Linux.".to_string())
}

/// The vault's secrets, metadata only: id, label, variable name, bound hosts, read-only flag,
/// creation time, and `enforced` (false where this platform does not inject them yet). Never a
/// value. Keychain and SQLite access is blocking, so it runs on the blocking pool.
#[tauri::command]
pub async fn vault_list(app: AppHandle, window: WebviewWindow) -> Result<VaultListing, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = local_host(&app)?;
    tauri::async_runtime::spawn_blocking(move || host.vault_list())
        .await
        .map_err(|error| format!("Vault listing failed: {error}"))?
        .map_err(|error| error.to_string())
}

/// Stores a secret: the value goes straight into the OS keychain, the metadata into the host's
/// database. The value is typed into the desktop webview and never leaves the device.
#[tauri::command]
pub async fn vault_set(
    app: AppHandle,
    window: WebviewWindow,
    input: NewSecret,
) -> Result<SecretMeta, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = local_host(&app)?;
    tauri::async_runtime::spawn_blocking(move || host.vault_set(input))
        .await
        .map_err(|error| format!("Vault update failed: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn vault_remove(app: AppHandle, window: WebviewWindow, id: String) -> Result<(), String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = local_host(&app)?;
    tauri::async_runtime::spawn_blocking(move || host.vault_remove(&id))
        .await
        .map_err(|error| format!("Vault update failed: {error}"))?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs the real OS keychain (and, on Linux, a running Secret Service), so it is ignored.
    /// Uses its own service name; the vault's real one is never touched.
    #[test]
    #[ignore = "requires the OS keychain"]
    fn keychain_store_round_trips_a_value() {
        let store = KeychainStore {
            service: format!("sourceweft-local-vault-test-{}", std::process::id()),
        };
        assert_eq!(store.get("account").unwrap(), None);
        store.set("account", b"placeholder-not-a-real-secret").unwrap();
        assert_eq!(
            store.get("account").unwrap().as_deref(),
            Some(&b"placeholder-not-a-real-secret"[..])
        );
        store.delete("account").unwrap();
        store.delete("account").unwrap();
        assert_eq!(store.get("account").unwrap(), None);
    }
}
