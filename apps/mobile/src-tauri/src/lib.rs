#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_google_auth::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![mobile_info, open_external_url])
        .setup(|app| {
            setup_deep_links(app.handle());
            create_main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri mobile application");
}

use serde::Serialize;
use std::net::{Ipv4Addr, Ipv6Addr};
use tauri::{webview::NewWindowResponse, AppHandle, Emitter, Manager, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use url::{Host, Url};

const DEEP_LINK_EVENT: &str = "sourceweft:deep-link";
const DEEP_LINK_SCHEME: &str = "sourceweft";
const MAIN_WINDOW_LABEL: &str = "main";
const APP_PROTOCOL_SCHEME: &str = "tauri";
const APP_PROTOCOL_ORIGIN: &str = "tauri://localhost";
const SIGN_IN_PATH: &str = "/auth/sign-in";
const HOME_PATH: &str = "/dashboard/chat";
const DASHBOARD_ROOT: &str = "/dashboard";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileInfo {
    kind: &'static str,
    is_native: bool,
    is_mobile: bool,
    platform: &'static str,
    arch: &'static str,
    app_name: String,
    app_version: String,
    tauri_version: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeepLinkPayload {
    url: String,
}

fn mobile_bridge_script() -> &'static str {
    r#"
(() => {
  if (window.__SOURCEWEFT_NATIVE__ && window.__SOURCEWEFT_MOBILE__) return;

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
    kind: "mobile",
    capabilities: ["deepLink", "externalUrl", "hostInfo"],
    invoke,
    listen,
  });

  Object.defineProperty(window, "__SOURCEWEFT_NATIVE__", {
    value: nativeBridge,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  Object.defineProperty(window, "__SOURCEWEFT_MOBILE__", {
    value: Object.freeze({ isMobile: true, invoke, listen }),
    configurable: false,
    enumerable: false,
    writable: false,
  });

})();
"#
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
        resolve_app_url(app.handle(), SIGN_IN_PATH).map_err(std::io::Error::other)?,
    );
    let handle = app.handle().clone();
    // Injected as its own script, the way the desktop host does it.
    // `append_invoke_initialization_script` concatenates onto Tauri's IPC script, which ends
    // in `})()` with no semicolon, so a bridge starting with `(` is parsed as a call to that
    // expression and throws before defining anything.
    WebviewWindowBuilder::from_config(app.handle(), &window_config)?
        .initialization_script(mobile_bridge_script())
        .on_navigation(move |url| handle_navigation(&handle, url))
        .on_new_window(move |url, _features| {
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        })
        .build()?;

    Ok(())
}

fn handle_navigation(app: &AppHandle, url: &Url) -> bool {
    if url.scheme() == DEEP_LINK_SCHEME {
        emit_deep_link(app, url.to_string());
        return false;
    }

    if is_app_url(app, url) {
        if is_allowed_app_path(url.path()) {
            return true;
        }

        let _ = navigate_main_window(app, HOME_PATH);
        return false;
    }

    if url.scheme() == "http" || url.scheme() == "https" {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
        return false;
    }

    // Internal WebView schemes (ipc, about, blob) carry the Tauri runtime itself.
    true
}

fn is_app_url(app: &AppHandle, url: &Url) -> bool {
    url.scheme() == APP_PROTOCOL_SCHEME || is_app_web_url(app, url)
}

fn is_app_web_url(app: &AppHandle, url: &Url) -> bool {
    resolve_app_url(app, HOME_PATH).is_ok_and(|base| same_origin(url, &base))
}

fn is_allowed_app_path(path: &str) -> bool {
    path == DASHBOARD_ROOT
        || path.starts_with("/dashboard/")
        || path == "/auth"
        || path.starts_with("/auth/")
}

fn navigate_main_window(app: &AppHandle, path: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window was not found".to_string())?;
    let current = window.url().map_err(|error| error.to_string())?;
    let target = if current.scheme() == APP_PROTOCOL_SCHEME {
        app_protocol_url(path)?
    } else {
        resolve_app_url(app, path)?
    };
    window.navigate(target).map_err(|error| error.to_string())
}

fn app_protocol_url(path: &str) -> Result<Url, String> {
    Url::parse(APP_PROTOCOL_ORIGIN)
        .and_then(|base| base.join(path))
        .map_err(|error| error.to_string())
}

fn resolve_app_url(app: &AppHandle, path: &str) -> Result<Url, String> {
    let base = web_base_url(app)?;
    if !base.username().is_empty() || base.password().is_some() || !is_allowed_base_url(&base) {
        return Err("Web URL requires HTTPS; HTTP is limited to development servers".into());
    }
    base.join(path).map_err(|error| error.to_string())
}

fn web_base_url(app: &AppHandle) -> Result<Url, String> {
    if let Ok(configured) = std::env::var("NEXT_PUBLIC_WEB_BASE_URL") {
        return Url::parse(configured.trim()).map_err(|error| error.to_string());
    }

    if cfg!(debug_assertions) {
        return app
            .config()
            .build
            .dev_url
            .clone()
            .ok_or_else(|| "Missing development Web URL".to_string());
    }

    Url::parse("https://sourceweft.com").map_err(|error| error.to_string())
}

fn is_allowed_base_url(base: &Url) -> bool {
    match base.scheme() {
        "https" => true,
        "http" => cfg!(debug_assertions) && is_development_host(base),
        _ => false,
    }
}

/// The dev server is reachable at the loopback address from the simulator, at an mDNS
/// `.local` name from either, and at a private LAN address from a physical device.
fn is_development_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => {
            domain == "localhost" || domain.ends_with(".localhost") || domain.ends_with(".local")
        }
        Some(Host::Ipv4(address)) => is_development_ipv4(&address),
        Some(Host::Ipv6(address)) => is_development_ipv6(&address),
        None => false,
    }
}

fn is_development_ipv4(address: &Ipv4Addr) -> bool {
    address.is_loopback() || address.is_private() || address.is_link_local()
}

fn is_development_ipv6(address: &Ipv6Addr) -> bool {
    address.is_loopback()
}

#[tauri::command]
fn mobile_info(app: AppHandle) -> MobileInfo {
    MobileInfo {
        kind: "mobile",
        is_native: true,
        is_mobile: true,
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        app_name: app.package_info().name.clone(),
        app_version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION,
    }
}

#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|error| error.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http and https URLs can be opened externally.".to_string());
    }

    if !is_allowed_external_url(&app, &parsed) {
        return Err("Only SourceWeft authentication URLs can be opened externally.".to_string());
    }

    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>).map_err(|error| error.to_string())
}

fn is_allowed_external_url(app: &AppHandle, url: &Url) -> bool {
    if !url.path().starts_with("/auth/") && url.path() != "/auth" {
        return false;
    }

    is_app_web_url(app, url)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn setup_deep_links(app: &AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            emit_deep_link(&handle, url.to_string());
        }
    });
}

fn emit_deep_link(app: &AppHandle, url: String) {
    let _ = app.emit(DEEP_LINK_EVENT, DeepLinkPayload { url });
}
