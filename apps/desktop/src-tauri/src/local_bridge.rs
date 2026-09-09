//! Narrow discovery bridge for the existing Web UI. No separate native pages.
//! Workspace/file operations stay internal until authenticated dispatch is wired.
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;

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

fn allowed_caller(label: &str, url: &Url, dev_url: Option<&Url>) -> bool {
    if label != "main" {
        return false;
    }
    let is_app = url.scheme() == "tauri" && url.host_str() == Some("localhost");
    let is_dev = dev_url.is_some_and(|base| url.origin() == base.origin());
    (is_app || is_dev) && (url.path() == "/dashboard" || url.path().starts_with("/dashboard/"))
}

#[tauri::command]
pub fn local_host_status(app: AppHandle, window: WebviewWindow) -> Result<LocalHostStatus, String> {
    let url = window.url().map_err(|error| error.to_string())?;
    let dev = if cfg!(debug_assertions) {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    if !allowed_caller(window.label(), &url, dev) {
        return Err(
            "LOCAL_HOST_ACCESS_DENIED: Use the existing dashboard in this PC client.".into(),
        );
    }
    let remote = app
        .try_state::<crate::remote_host::RemoteHost>()
        .map(|host| host.status())
        .unwrap_or_default();
    Ok(LocalHostStatus {
        protocol_version: 1,
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
    let url = window.url().map_err(|e| e.to_string())?;
    let dev = if cfg!(debug_assertions) {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    if !allowed_caller(window.label(), &url, dev) {
        return Err("LOCAL_HOST_ACCESS_DENIED".into());
    }
    let host = app
        .try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM: Local execution currently requires macOS.")?;
    host.enroll(ticket).await
}

#[tauri::command]
pub fn disconnect_local_host(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let dev = if cfg!(debug_assertions) {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    if !allowed_caller(window.label(), &url, dev) {
        return Err("LOCAL_HOST_ACCESS_DENIED".into());
    }
    app.try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM: Local execution currently requires macOS.")?
        .disconnect();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_is_scoped_to_native_main_dashboard() {
        let development = Url::parse("http://localhost:3000/dashboard").unwrap();
        for (label, value, allowed) in [
            ("main", "http://localhost:3000/dashboard/chat", true),
            ("main", "http://localhost:3000/auth", false),
            ("other", "http://localhost:3000/dashboard", false),
            ("main", "http://localhost:3001/dashboard", false),
            ("main", "https://example.com/dashboard", false),
            ("main", "tauri://localhost/dashboard", true),
        ] {
            assert_eq!(
                allowed_caller(label, &Url::parse(value).unwrap(), Some(&development)),
                allowed
            );
        }
        assert!(!allowed_caller("main", &development, None));
    }
}
