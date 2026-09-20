use super::{
    policy::{Channel, Result},
    service::{Service, Snapshot},
};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub fn get_update_state(app: AppHandle, window: WebviewWindow) -> Result<Snapshot> {
    crate::authorize_desktop_window(&app, &window, true)?;
    Ok(app.state::<Arc<Service>>().snapshot())
}
fn start(
    app: AppHandle,
    window: WebviewWindow,
    action: &'static str,
    candidate: Option<String>,
) -> Result<()> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let service = app.state::<Arc<Service>>().inner().clone();
    let guard = service
        .gate
        .clone()
        .try_lock_owned()
        .map_err(|_| "UPDATE_BUSY")?;
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let result = match action {
            "check" => service.check(&app).await,
            "download" => {
                service
                    .download(&app, candidate.as_deref().unwrap_or_default(), false)
                    .await
            }
            "install" => {
                service
                    .install(&app, candidate.as_deref().unwrap_or_default())
                    .await
            }
            _ => unreachable!(),
        };
        if let Err(error) = result {
            service.fail(&app, error);
        }
    });
    Ok(())
}
#[tauri::command]
pub fn check_for_updates(app: AppHandle, window: WebviewWindow) -> Result<()> {
    start(app, window, "check", None)
}
#[tauri::command]
pub fn download_update(app: AppHandle, window: WebviewWindow, candidate_id: String) -> Result<()> {
    start(app, window, "download", Some(candidate_id))
}
#[tauri::command]
pub fn install_update(app: AppHandle, window: WebviewWindow, candidate_id: String) -> Result<()> {
    start(app, window, "install", Some(candidate_id))
}
#[tauri::command]
pub fn cancel_update_download(
    app: AppHandle,
    window: WebviewWindow,
    operation_id: String,
) -> Result<()> {
    crate::authorize_desktop_window(&app, &window, true)?;
    app.state::<Arc<Service>>()
        .cancel_operation(&app, &operation_id)
}
#[tauri::command]
pub fn cancel_update_install(
    app: AppHandle,
    window: WebviewWindow,
    operation_id: String,
) -> Result<()> {
    cancel_update_download(app, window, operation_id)
}
#[tauri::command]
pub fn acknowledge_update_save(
    app: AppHandle,
    window: WebviewWindow,
    operation_id: String,
    error: Option<String>,
) -> Result<()> {
    crate::authorize_desktop_window(&app, &window, true)?;
    app.state::<Arc<Service>>()
        .acknowledge_save(&operation_id, error)
}
#[tauri::command]
pub fn set_update_preferences(
    app: AppHandle,
    window: WebviewWindow,
    channel: Channel,
    auto_check: bool,
    auto_download: bool,
) -> Result<()> {
    crate::authorize_desktop_window(&app, &window, true)?;
    app.state::<Arc<Service>>()
        .set_preferences(&app, channel, auto_check, auto_download)
}
#[tauri::command]
pub fn snooze_update(app: AppHandle, window: WebviewWindow, candidate_id: String) -> Result<()> {
    crate::authorize_desktop_window(&app, &window, true)?;
    app.state::<Arc<Service>>().snooze(&app, &candidate_id)
}
