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
    Ok(LocalHostStatus {
        protocol_version: 1,
        platform_supported: cfg!(target_os = "macos"),
        storage_initialized: app
            .try_state::<sourceweft_desktop::local_host::LocalHost>()
            .is_some(),
        authenticated_dispatch_available: false,
    })
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
