//! Narrow discovery bridge for the existing Web UI. No separate native pages.
//! Workspace/file operations stay internal until authenticated dispatch is wired.
use serde::Serialize;
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
}

#[tauri::command]
pub async fn authenticate_local_host(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    app.try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM")?
        .authenticate(ticket, user_id)
        .await
}

#[tauri::command]
pub fn local_host_status(app: AppHandle, window: WebviewWindow) -> Result<LocalHostStatus, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let remote = app
        .try_state::<crate::remote_host::RemoteHost>()
        .map(|host| host.status())
        .unwrap_or_default();
    Ok(LocalHostStatus {
        protocol_version: 2,
        platform_supported: cfg!(target_os = "macos"),
        storage_initialized: app
            .try_state::<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>>()
            .is_some(),
        authenticated_dispatch_available: remote.connected,
        device_id: remote.device_id,
        connected: remote.connected,
        connection_error: remote.error,
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
        .ok_or("UNSUPPORTED_PLATFORM: Local execution currently requires macOS.")?;
    host.enroll(ticket).await
}

#[tauri::command]
pub fn disconnect_local_host(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    app.try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM: Local execution currently requires macOS.")?
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
    app.try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM")?
        .choose_folder(ticket, user_id)
        .await
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
