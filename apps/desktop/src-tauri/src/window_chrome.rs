//! Main-window titlebar actions retain the same page authorization as other IPC.
use serde::Deserialize;
use tauri::{AppHandle, WebviewWindow};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TitlebarAction {
    Drag,
    ToggleMaximize,
}

#[tauri::command]
pub fn desktop_titlebar_action(
    app: AppHandle,
    window: WebviewWindow,
    action: TitlebarAction,
) -> Result<(), String> {
    crate::authorize_desktop_window(&app, &window, false)?;
    // Native fullscreen continues to belong to the system window controls.
    if window.is_fullscreen().map_err(|error| error.to_string())? {
        return Ok(());
    }
    match action {
        TitlebarAction::Drag => window.start_dragging(),
        TitlebarAction::ToggleMaximize => {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
    }
    .map_err(|error| error.to_string())
}

// Injected only into the macOS main window, before the shared web app hydrates.
// Hub windows and ordinary browsers keep their existing layout.
#[cfg(target_os = "macos")]
pub const INITIALIZATION_SCRIPT: &str = r#"
Object.defineProperty(window, "__SOURCEWEFT_TITLEBAR_OVERLAY__", {
  value: true, writable: false, configurable: false
});
"#;
