//! Narrow discovery bridge for the existing Web UI. No separate native pages.
//! Workspace/file operations stay internal until authenticated dispatch is wired.
use serde::Serialize;
use sourceweft_desktop::local_host::readiness::SandboxReadiness;
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

/// Linux (AppImage): runs the one-time privileged sandbox setup through `pkexec`, which shows
/// the system authentication dialog; the app never sees a password. The script is a constant
/// embedded in the app, nothing from the caller reaches it. Cached readiness is invalidated
/// afterwards, whatever the outcome, so the next status poll probes again. Other platforms
/// have no such setup.
#[tauri::command]
pub async fn run_sandbox_privileged_setup(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    #[cfg(target_os = "linux")]
    {
        let host = app
            .try_state::<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>>()
            .map(|host| host.inner().clone())
            .ok_or("UNSUPPORTED_PLATFORM")?;
        let result = tauri::async_runtime::spawn_blocking(
            sourceweft_desktop::local_host::privileged_setup::run_privileged_setup,
        )
        .await
        .map_err(|error| format!("Sandbox setup failed: {error}"))?;
        host.invalidate_sandbox_readiness();
        result
    }
    #[cfg(not(target_os = "linux"))]
    Err("UNSUPPORTED_PLATFORM".to_string())
}

/// Downloads, verifies and installs the sandbox runtime for this app version; the user asked
/// for it by clicking "Install", nothing downloads on its own. Holds an admission lease like the
/// other local commands, so a pending app update waits for it. Returns the readiness after the
/// install. Errors are strings starting with a stable code (`SANDBOX_DOWNLOAD_FAILED`,
/// `SANDBOX_SIGNATURE_INVALID`, `SANDBOX_BUNDLE_INVALID`, `SANDBOX_UNVERIFIABLE_BUILD`,
/// `SANDBOX_PLATFORM_UNSUPPORTED`, ...) followed by the reason.
#[tauri::command]
pub async fn install_sandbox_runtime(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<SandboxReadiness, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = app
        .try_state::<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>>()
        .map(|host| host.inner().clone())
        .ok_or("UNSUPPORTED_PLATFORM")?;
    let _lease = host.admission.enter().map_err(str::to_owned)?;
    #[cfg(unix)]
    {
        // Blocking work (download, hashing, a sidecar probe), on the blocking pool; the HTTP
        // client is created there too.
        tauri::async_runtime::spawn_blocking(move || host.install_sandbox_runtime())
            .await
            .map_err(|error| format!("SANDBOX_INSTALL_FAILED: {error}"))?
            .map_err(|error| error.to_string())
    }
    #[cfg(not(unix))]
    Err("SANDBOX_PLATFORM_UNSUPPORTED: No sandbox runtime is published for this platform.".to_string())
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
