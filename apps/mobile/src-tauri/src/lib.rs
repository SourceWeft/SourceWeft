#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_google_auth::init())
        .plugin(tauri_plugin_opener::init())
        .append_invoke_initialization_script(mobile_bridge_script())
        .invoke_handler(tauri::generate_handler![mobile_info, open_external_url])
        .setup(|app| {
            setup_deep_links(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri mobile application");
}

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

const DEEP_LINK_EVENT: &str = "sourceweft:deep-link";

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
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|error| error.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http and https URLs can be opened externally.".to_string());
    }

    if !is_allowed_external_url(&parsed) {
        return Err("Only SourceWeft authentication URLs can be opened externally.".to_string());
    }

    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>).map_err(|error| error.to_string())
}

fn is_allowed_external_url(url: &Url) -> bool {
    if !url.path().starts_with("/auth/") && url.path() != "/auth" {
        return false;
    }

    if let Ok(web_base_url) = std::env::var("NEXT_PUBLIC_WEB_BASE_URL") {
        if let Ok(web_base_url) = Url::parse(web_base_url.trim()) {
            return same_origin(url, &web_base_url);
        }
    }

    if url.scheme() == "http" && url.host_str() == Some("localhost") {
        return matches!(url.port_or_known_default(), Some(3000));
    }

    url.scheme() == "https" && matches!(url.host_str(), Some("sourceweft.com" | "www.sourceweft.com"))
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
            let _ = handle.emit(
                DEEP_LINK_EVENT,
                DeepLinkPayload {
                    url: url.to_string(),
                },
            );
        }
    });
}
