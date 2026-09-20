#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod hub_window;
mod preview_window;
mod local_bridge;
mod native_access;
mod remote_host;
mod tray_locale;
mod window_chrome;
mod updater;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Emitter, Manager, State, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

const MAIN_WINDOW_LABEL: &str = "main";
const SETTINGS_FILE_NAME: &str = "desktop-settings.json";
const DEEP_LINK_EVENT: &str = "sourceweft:deep-link";
const DESKTOP_SCHEME: &str = "sourceweft";

static IS_QUITTING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    autostart_requested: bool,
    /// The dashboard's last-reported resolved locale (§tray_locale). `None`
    /// on a fresh install or a settings file predating this field — serde
    /// defaults `Option` fields to `None` on missing/older JSON automatically.
    tray_locale: Option<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            autostart_requested: false,
            tray_locale: None,
        }
    }
}

struct DesktopState {
    settings: Mutex<DesktopSettings>,
    settings_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    kind: &'static str,
    is_native: bool,
    is_desktop: bool,
    platform: &'static str,
    arch: &'static str,
    app_name: String,
    app_version: String,
    tauri_version: &'static str,
    updater_protocol_version: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutostartState {
    enabled: bool,
    requested: bool,
    supported: bool,
    reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeepLinkPayload {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAutostartInput {
    enabled: bool,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for url in argv
                .into_iter()
                .filter(|arg| arg.starts_with("sourceweft://"))
            {
                emit_deep_link(app, url);
            }
            let _ = focus_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            updater::get_update_state,
            updater::check_for_updates,
            updater::download_update,
            updater::install_update,
            updater::cancel_update_download,
            updater::cancel_update_install,
            updater::acknowledge_update_save,
            updater::set_update_preferences,
            updater::snooze_update,
            hub_window::hub_window_action,
            hub_window::hub_window_send,
            preview_window::open_file_preview,
            preview_window::read_file_preview,
            preview_window::close_file_preview,
            desktop_info,
            window_chrome::desktop_titlebar_action,
            show_main_window,
            get_autostart,
            set_autostart,
            open_external_url,
            local_bridge::local_host_status,
            local_bridge::authenticate_local_host,
            local_bridge::choose_local_folder,
            local_bridge::enable_local_host,
            local_bridge::disconnect_local_host,
            local_bridge::choose_working_directory,
            tray_locale::sync_tray_locale,
        ])
        .on_menu_event(|app, event| handle_tray_action(app, event.id().as_ref()))
        .on_tray_icon_event(|app, event| {
            if tray_event_should_open(&event) {
                let _ = focus_main_window(app);
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let host = std::sync::Arc::new(sourceweft_desktop::local_host::LocalHost::open(
                    &app.path().app_data_dir()?,
                )?);
                app.manage(
                    remote_host::RemoteHost::new(host.clone(), app.config().identifier.clone())
                        .map_err(std::io::Error::other)?,
                );
                app.manage(host);
            }
            let settings_path = resolve_settings_path(app.handle())?;
            let settings = read_settings(&settings_path);
            // The page's last-reported locale wins on relaunch, so a returning
            // user's explicit choice survives a restart; only a settings file
            // with no prior report (fresh install) falls back to the OS locale.
            let startup_locale = settings
                .tray_locale
                .clone()
                .unwrap_or_else(|| tray_locale::os_locale().to_string());
            app.manage(DesktopState {
                settings: Mutex::new(settings),
                settings_path,
            });

            app.manage(preview_window::PreviewState::default());
            setup_deep_links(app.handle());
            register_deep_links(app.handle());
            let base =
                resolve_app_url(app.handle(), "/dashboard/chat").map_err(std::io::Error::other)?;
            app.add_capability(native_access::web_capability(&base))?;
            app.add_capability(native_access::hub_capability(&base))?;
            app.add_capability(preview_window::opener_capability(&base))?;
            app.add_capability(preview_window::reader_capability(&base))?;
            create_main_window(app)?;
            setup_tray(app, &startup_locale)?;
            updater::setup(app.handle()).map_err(std::io::Error::other)?;
            emit_startup_deep_links(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == preview_window::LABEL {
                    api.prevent_close();
                    preview_window::clear(window.app_handle(), true);
                    return;
                }
                if !IS_QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if window.label() == hub_window::LABEL {
                        let _ = window.emit(
                            hub_window::EVENT,
                            serde_json::json!({"kind":"close-requested"}),
                        );
                    } else {
                        let _ = window.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}

fn create_main_window(app: &mut tauri::App) -> tauri::Result<()> {
    let mut window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
        .unwrap_or_else(|| app.config().app.windows[0].clone());

    window_config.url = tauri::WebviewUrl::External(
        resolve_app_url(app.handle(), "/dashboard/chat").map_err(std::io::Error::other)?,
    );
    let handle = app.handle().clone();
    let builder = WebviewWindowBuilder::from_config(app.handle(), &window_config)?;
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 20.0))
        .initialization_script(window_chrome::INITIALIZATION_SCRIPT);
    builder
        .initialization_script(desktop_bridge_script())
        .on_navigation(move |url| handle_navigation(&handle, url))
        .on_new_window(move |url, _features| {
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        })
        .build()?;

    Ok(())
}

fn handle_navigation(app: &AppHandle, url: &Url) -> bool {
    if url.scheme() == DESKTOP_SCHEME {
        emit_deep_link(app, url.to_string());
        return false;
    }

    if is_desktop_web_url(app, url) {
        if url.path() == "/auth" || url.path().starts_with("/auth/") {
            preview_window::clear(app, false);
        }
        if is_allowed_desktop_path(url.path()) {
            return true;
        }

        let _ = navigate_main_window(app, "/dashboard/chat");
        return false;
    }

    if url.scheme() == "http" || url.scheme() == "https" {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }

    false
}

fn is_desktop_web_url(app: &AppHandle, url: &Url) -> bool {
    resolve_app_url(app, "/dashboard").is_ok_and(|base| same_origin(url, &base))
}

fn is_allowed_desktop_path(path: &str) -> bool {
    path == "/dashboard"
        || path.starts_with("/dashboard/")
        || path == "/auth"
        || path.starts_with("/auth/")
}

fn navigate_main_window(app: &AppHandle, path: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window was not found".to_string())?;
    let target = resolve_app_url(app, path)?;
    window.navigate(target).map_err(|error| error.to_string())
}

fn resolve_app_url(app: &AppHandle, path: &str) -> Result<Url, String> {
    let configured = std::env::var("NEXT_PUBLIC_WEB_BASE_URL").ok();
    let base = if let Some(value) = configured {
        Url::parse(value.trim()).map_err(|e| e.to_string())?
    } else if cfg!(debug_assertions) {
        app.config()
            .build
            .dev_url
            .clone()
            .ok_or("Missing development Web URL")?
    } else {
        Url::parse("https://sourceweft.com").map_err(|e| e.to_string())?
    };
    if !base.username().is_empty()
        || base.password().is_some()
        || (base.scheme() != "https"
            && !(cfg!(debug_assertions)
                && base.scheme() == "http"
                && base.host_str() == Some("localhost")))
    {
        return Err("Web URL requires HTTPS; localhost HTTP is development-only".into());
    }
    base.join(path).map_err(|e| e.to_string())
}

fn desktop_bridge_script() -> &'static str {
    r#"
(() => {
  if (window.__SOURCEWEFT_NATIVE__ && window.__SOURCEWEFT_DESKTOP__) return;

  const getTauriInternals = () => {
    if (!window.__TAURI_INTERNALS__) {
      throw new Error("Tauri internals are not available.");
    }
    return window.__TAURI_INTERNALS__;
  };

  const invoke = (command, args = {}) => getTauriInternals().invoke(command, args);
  const listen = async (event, handler) => {
    const internals = getTauriInternals();
    const callbackId = internals.transformCallback(handler);
    const eventId = await invoke("plugin:event|listen", {
      event,
      target: { kind: "Any" },
      handler: callbackId,
    });

    return () => {
      getTauriInternals().unregisterCallback(callbackId);
      return invoke("plugin:event|unlisten", { event, eventId });
    };
  };

  const nativeBridge = Object.freeze({
    kind: "desktop",
    capabilities: ["deepLink", "desktopAutostart", "desktopWindow", "externalUrl", "hostInfo"],
    invoke,
    listen,
  });

  Object.defineProperty(window, "__SOURCEWEFT_NATIVE__", {
    value: nativeBridge,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  Object.defineProperty(window, "__SOURCEWEFT_DESKTOP__", {
    value: Object.freeze({ isDesktop: true, invoke, listen }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
"#
}

#[tauri::command]
fn desktop_info(app: AppHandle, window: tauri::WebviewWindow) -> Result<DesktopInfo, String> {
    if window.label() == preview_window::LABEL {
        preview_window::authorize(&app, &window)?;
    } else if window.label() == hub_window::LABEL {
        hub_window::authorize(&app, &window)?;
    } else {
        authorize_desktop_window(&app, &window, false)?;
    }
    Ok(DesktopInfo {
        kind: "desktop",
        is_native: true,
        is_desktop: true,
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        app_name: app.package_info().name.clone(),
        app_version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION,
        updater_protocol_version: 1,
    })
}

#[tauri::command]
fn show_main_window(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    authorize_desktop_window(&app, &window, false)?;
    focus_main_window(&app)
}

#[tauri::command]
fn get_autostart(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<AutostartState, String> {
    authorize_desktop_window(&app, &window, true)?;
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Failed to lock desktop settings".to_string())?;

    Ok(AutostartState {
        enabled: false,
        requested: settings.autostart_requested,
        supported: false,
        reason: Some(
            "Autostart requires the official Tauri autostart plugin in the next desktop pass."
                .to_string(),
        ),
    })
}

#[tauri::command]
fn set_autostart(
    app: AppHandle,
    window: tauri::WebviewWindow,
    input: SetAutostartInput,
    state: State<'_, DesktopState>,
) -> Result<AutostartState, String> {
    authorize_desktop_window(&app, &window, true)?;
    let snapshot = {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "Failed to lock desktop settings".to_string())?;
        settings.autostart_requested = input.enabled;
        settings.clone()
    };

    write_settings(&state.settings_path, &snapshot)?;

    Ok(AutostartState {
        enabled: false,
        requested: input.enabled,
        supported: false,
        reason: Some(
            "Autostart preference was saved, but OS registration is not active yet.".to_string(),
        ),
    })
}

#[tauri::command]
fn open_external_url(
    app: AppHandle,
    window: tauri::WebviewWindow,
    url: String,
) -> Result<(), String> {
    if window.label() == hub_window::LABEL {
        hub_window::authorize(&app, &window)?;
    } else {
        authorize_desktop_window(&app, &window, false)?;
    }
    let parsed = Url::parse(url.trim()).map_err(|error| error.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http and https URLs can be opened externally.".to_string());
    }

    let base = resolve_app_url(&app, "/dashboard")?;
    if !native_access::is_allowed_external_url(&parsed, &base) {
        return Err("Only SourceWeft URLs can be opened externally.".to_string());
    }

    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>).map_err(|error| error.to_string())
}

fn authorize_desktop_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    dashboard_only: bool,
) -> Result<(), String> {
    let url = window.url().map_err(|error| error.to_string())?;
    let base = resolve_app_url(app, "/dashboard")?;
    if native_access::is_allowed_caller(window.label(), &url, &base, dashboard_only) {
        Ok(())
    } else {
        Err(
            "DESKTOP_ACCESS_DENIED: Use the configured SourceWeft page in the main PC window."
                .into(),
        )
    }
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn setup_tray(app: &mut tauri::App, startup_locale: &str) -> tauri::Result<()> {
    let (open_label, quit_label) = tray_locale::tray_labels(startup_locale);
    let open = MenuItem::with_id(app, "open", open_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    // Not locale-aware yet (main's addition, landed independently of the
    // tray_locale sync) — a natural small follow-up, not this merge's job.
    let update = MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &update, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        // The tooltip is the brand name, not chrome copy — it stays
        // untranslated the same way "SourceWeft" does everywhere else.
        .tooltip("SourceWeft")
        .show_menu_on_left_click(true);

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    // `Menu::with_items` above only borrowed `open`/`quit`; the owned handles
    // are still ours to move here. Stashed so `sync_tray_locale` can relabel
    // them in place once the webview reports its own resolved locale,
    // without rebuilding the menu.
    app.manage(tray_locale::TrayState { open, quit });
    Ok(())
}

fn focus_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window was not found".to_string())?;

    let current_url = window.url().ok();
    if current_url
        .as_ref()
        .is_some_and(|url| is_desktop_web_url(app, url) && !is_allowed_desktop_path(url.path()))
    {
        let _ = navigate_main_window(app, "/dashboard/chat");
    }

    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn resolve_settings_path(app: &AppHandle) -> Result<PathBuf, tauri::Error> {
    let app_data_dir = app.path().app_data_dir()?;
    Ok(app_data_dir.join(SETTINGS_FILE_NAME))
}

fn read_settings(path: &PathBuf) -> DesktopSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<DesktopSettings>(&content).ok())
        .unwrap_or_default()
}

fn write_settings(path: &PathBuf, settings: &DesktopSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn emit_startup_deep_links(app: &AppHandle) {
    let mut links = std::env::args()
        .filter(|arg| arg.starts_with("sourceweft://"))
        .collect::<Vec<_>>();

    if let Ok(Some(current_links)) = app.deep_link().get_current() {
        links.extend(current_links.into_iter().map(|url| url.to_string()));
    }

    if links.is_empty() {
        return;
    }

    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(500));
        for url in links {
            emit_deep_link(&handle, url);
        }
    });
}

fn emit_deep_link(app: &AppHandle, url: String) {
    let _ = app.emit(DEEP_LINK_EVENT, DeepLinkPayload { url });
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_deep_links(app: &AppHandle) {
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        let handle = app.clone();
        app.deep_link().on_open_url(move |event| {
            for url in event.urls() {
                emit_deep_link(&handle, url.to_string());
            }
        });
    }
}

fn register_deep_links(_app: &AppHandle) {
    #[cfg(any(windows, target_os = "linux"))]
    {
        let _ = _app.deep_link().register_all();
    }
}

fn handle_tray_action(app: &AppHandle, menu_id: &str) {
    match menu_id {
        "update" => updater::menu(app),
        "open" => {
            let _ = focus_main_window(app);
        }
        "quit" => {
            if let Some(host) = app.try_state::<remote_host::RemoteHost>() {
                host.disconnect();
            }
            IS_QUITTING.store(true, Ordering::SeqCst);
            app.exit(0);
        }
        _ => {}
    }
}

#[allow(deprecated)]
fn tray_event_should_open(event: &TrayIconEvent) -> bool {
    match event {
        TrayIconEvent::Click {
            button,
            button_state,
            ..
        } => *button == MouseButton::Left && *button_state == MouseButtonState::Up,
        TrayIconEvent::DoubleClick { .. } => true,
        _ => false,
    }
}
