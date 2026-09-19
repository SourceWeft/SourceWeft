//! A single read-only preview of bytes supplied by an authorized application window.
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::CapabilityBuilder, AppHandle, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use url::Url;

use crate::hub_window::placement::{centered_position, matching_inner_height, Rect};

pub const LABEL: &str = "preview";
pub const PATH: &str = "/dashboard/preview-window";
const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    id: String,
    account_id: String,
    name: String,
    description: String,
    mime_type: String,
    base64: String,
}

#[derive(Default)]
pub struct PreviewState(Mutex<Option<(PreviewFile, String)>>);

fn same_origin(url: &Url, base: &Url) -> bool {
    url.scheme() == base.scheme()
        && url.host_str() == base.host_str()
        && url.port_or_known_default() == base.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn authorize(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let base = crate::resolve_app_url(app, PATH)?;
    let url = window.url().map_err(|e| e.to_string())?;
    if window.label() == LABEL && same_origin(&url, &base) && url.path() == PATH {
        Ok(())
    } else {
        Err("PREVIEW_ACCESS_DENIED".into())
    }
}

pub fn opener_capability(base: &Url) -> CapabilityBuilder {
    CapabilityBuilder::new("preview-openers")
        .window("main")
        .window("hub")
        .remote(base.origin().ascii_serialization())
        .permission("allow-open-file-preview")
}

pub fn reader_capability(base: &Url) -> CapabilityBuilder {
    CapabilityBuilder::new("preview-reader")
        .window(LABEL)
        .remote(base.origin().ascii_serialization())
        .permission("allow-desktop-info")
        .permission("allow-read-file-preview")
        .permission("allow-close-file-preview")
}

fn validate(file: &PreviewFile) -> Result<(), String> {
    if file.id.is_empty()
        || file.id.len() > 128
        || file.account_id.is_empty()
        || file.account_id.len() > 256
        || file.name.is_empty()
        || file.name.len() > 4096
        || file.description.len() > 8192
        || file.mime_type.len() > 256
        || file.base64.len() > MAX_BYTES.div_ceil(3) * 4
    {
        return Err("PREVIEW_INVALID_FILE".into());
    }
    let bytes = STANDARD
        .decode(&file.base64)
        .map_err(|_| "PREVIEW_INVALID_DATA")?;
    if bytes.len() > MAX_BYTES {
        return Err("PREVIEW_FILE_TOO_LARGE".into());
    }
    Ok(())
}

pub fn clear(app: &AppHandle, focus_owner: bool) {
    let owner = app
        .state::<PreviewState>()
        .0
        .lock()
        .ok()
        .and_then(|mut s| s.take())
        .map(|(_, owner)| owner);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
    if focus_owner {
        if let Some(window) = owner
            .and_then(|label| app.get_webview_window(&label))
            .or_else(|| app.get_webview_window("main"))
        {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn center_existing(app: &AppHandle, preview: &WebviewWindow) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Main window was not found")?;
    let monitor = main
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Main window monitor was not found")?;
    let area = monitor.work_area();
    let position = main.outer_position().map_err(|e| e.to_string())?;
    let size = main.outer_size().map_err(|e| e.to_string())?;
    let preview_size = preview.outer_size().map_err(|e| e.to_string())?;
    let (x, y) = centered_position(
        Rect {
            x: position.x as f64,
            y: position.y as f64,
            width: size.width as f64,
            height: size.height as f64,
        },
        Rect {
            x: area.position.x as f64,
            y: area.position.y as f64,
            width: area.size.width as f64,
            height: area.size.height as f64,
        },
        preview_size.width as f64,
        preview_size.height as f64,
    );
    preview
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_file_preview(
    app: AppHandle,
    window: WebviewWindow,
    file: PreviewFile,
) -> Result<(), String> {
    crate::hub_window::authorize(&app, &window)?;
    validate(&file)?;
    let mut url = crate::resolve_app_url(&app, PATH)?;
    url.query_pairs_mut().append_pair("id", &file.id);
    let title = format!(
        "{} · SourceWeft",
        file.name.rsplit(['/', '\\']).next().unwrap_or("Preview")
    );
    *app.state::<PreviewState>()
        .0
        .lock()
        .map_err(|_| "PREVIEW_STATE_UNAVAILABLE")? = Some((file, window.label().into()));
    let result = (|| -> Result<(), String> {
        if let Some(preview) = app.get_webview_window(LABEL) {
            preview.set_title(&title).map_err(|e| e.to_string())?;
            preview.navigate(url).map_err(|e| e.to_string())?;
            preview.show().map_err(|e| e.to_string())?;
            preview.unminimize().map_err(|e| e.to_string())?;
            center_existing(&app, &preview)?;
            return preview.set_focus().map_err(|e| e.to_string());
        }
        let main = app
            .get_webview_window("main")
            .ok_or("Main window was not found")?;
        let monitor = main
            .current_monitor()
            .map_err(|e| e.to_string())?
            .or(main.primary_monitor().map_err(|e| e.to_string())?)
            .ok_or("No monitor is available for preview")?;
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let main_position = main.outer_position().map_err(|e| e.to_string())?;
        let main_size = main.outer_size().map_err(|e| e.to_string())?;
        let allowed = url.clone();
        let defaults = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .ok_or("Main window defaults were not found")?;
        let width = defaults.width.min(area.size.width as f64 / scale);
        let default_outer_height = (defaults.height * scale).round() as u32;
        let height = (default_outer_height.min(area.size.height) as f64 / scale - 40.0).max(1.0);
        let preview = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
            .title(title)
            .visible(false)
            .inner_size(width, height)
            .min_inner_size(
                width.min(defaults.min_width.unwrap_or(640.0)),
                height.min(defaults.min_height.unwrap_or(480.0)),
            )
            .initialization_script(crate::desktop_bridge_script())
            .on_navigation(move |url| same_origin(url, &allowed) && url.path() == PATH)
            .on_new_window(|url, _| {
                if matches!(url.scheme(), "https" | "http") {
                    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                }
                tauri::webview::NewWindowResponse::Deny
            })
            .build()
            .map_err(|e| e.to_string())?;
        preview
            .set_position(area.position)
            .map_err(|e| e.to_string())?;
        let outer = preview.outer_size().map_err(|e| e.to_string())?;
        let inner = preview.inner_size().map_err(|e| e.to_string())?;
        let content_height = matching_inner_height(
            default_outer_height,
            area.size.height,
            outer.height.saturating_sub(inner.height),
        );
        preview
            .set_size(tauri::PhysicalSize::new(inner.width, content_height))
            .map_err(|e| e.to_string())?;
        let outer = preview.outer_size().map_err(|e| e.to_string())?;
        let (x, y) = centered_position(
            Rect {
                x: main_position.x as f64,
                y: main_position.y as f64,
                width: main_size.width as f64,
                height: main_size.height as f64,
            },
            Rect {
                x: area.position.x as f64,
                y: area.position.y as f64,
                width: area.size.width as f64,
                height: area.size.height as f64,
            },
            outer.width as f64,
            outer.height as f64,
        );
        preview
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        preview.show().map_err(|e| e.to_string())?;
        preview.set_focus().map_err(|e| e.to_string())
    })();
    if result.is_err() {
        clear(&app, false);
    }
    result
}

#[tauri::command]
pub fn read_file_preview(
    app: AppHandle,
    window: WebviewWindow,
    state: State<PreviewState>,
    id: String,
) -> Result<PreviewFile, String> {
    authorize(&app, &window)?;
    let guard = state.0.lock().map_err(|_| "PREVIEW_STATE_UNAVAILABLE")?;
    guard
        .as_ref()
        .filter(|(file, _)| file.id == id)
        .map(|(file, _)| file.clone())
        .ok_or("PREVIEW_FILE_UNAVAILABLE".into())
}

#[tauri::command]
pub fn close_file_preview(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    authorize(&app, &window)?;
    clear(&app, true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_can_only_read_its_snapshot_and_close() {
        use tauri::ipc::RuntimeCapability;
        use tauri::utils::acl::capability::CapabilityFile;
        let CapabilityFile::Capability(capability) =
            reader_capability(&Url::parse("http://localhost:3400").unwrap()).build()
        else {
            panic!("expected capability");
        };
        assert_eq!(capability.windows, vec!["preview"]);
        let permissions = serde_json::to_value(capability.permissions).unwrap();
        assert_eq!(permissions.as_array().unwrap().len(), 3);
        for permission in [
            "allow-desktop-info",
            "allow-read-file-preview",
            "allow-close-file-preview",
        ] {
            assert!(permissions
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == permission));
        }
    }
    #[test]
    fn rejects_malformed_payloads_and_accepts_empty_files() {
        let mut file = PreviewFile {
            id: "id".into(),
            account_id: "account".into(),
            name: "file.txt".into(),
            description: "Local file".into(),
            mime_type: "text/plain".into(),
            base64: "".into(),
        };
        assert!(validate(&file).is_ok());
        file.base64 = "invalid".into();
        assert!(validate(&file).is_err());
        file.base64 = "b2s=".into();
        assert!(validate(&file).is_ok());
        file.account_id.clear();
        assert!(validate(&file).is_err());
    }
    #[test]
    fn origin_check_rejects_other_ports_hosts_and_credentials() {
        let base = Url::parse("tauri://localhost/dashboard").unwrap();
        assert!(same_origin(
            &Url::parse("tauri://localhost/dashboard/preview-window").unwrap(),
            &base
        ));
        for candidate in [
            "tauri://other/dashboard",
            "http://localhost/dashboard",
            "tauri://user@localhost/dashboard",
        ] {
            assert!(!same_origin(&Url::parse(candidate).unwrap(), &base));
        }
    }
}
