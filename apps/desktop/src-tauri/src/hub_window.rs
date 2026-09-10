//! The Hub is a single auxiliary view. Only trusted main/Hub pages may relay
//! messages; resource authorization remains with the authenticated API.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

pub const LABEL: &str = "hub";
pub const PATH: &str = "/dashboard/hub-window";
pub const EVENT: &str = "sourceweft:hub";

fn same_app_origin(url: &Url, origin: &Url) -> bool {
    // Url::origin() is opaque for custom schemes such as tauri://; compare the
    // explicitly configured origin parts instead of two fresh opaque origins.
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
}

fn caller_allowed(label: &str, url: &Url, origin: &Url) -> bool {
    same_app_origin(url, origin)
        && match label {
            "main" => url.path() == "/dashboard" || url.path().starts_with("/dashboard/"),
            LABEL => url.path() == PATH,
            _ => false,
        }
}

pub(crate) fn authorize(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let origin = crate::resolve_app_url(app, PATH)?;
    if !caller_allowed(window.label(), &url, &origin) {
        return Err("HUB_ACCESS_DENIED".into());
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn save_geometry(app: &AppHandle, window: &WebviewWindow) {
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let (Ok(position), Ok(size), Ok(dir)) = (
        window.outer_position(),
        window.inner_size(),
        app.path().app_data_dir(),
    ) else {
        return;
    };
    let geometry = Geometry {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    };
    if let Ok(bytes) = serde_json::to_vec(&geometry) {
        let _ = std::fs::write(dir.join("hub-window.json"), bytes);
    }
}

#[tauri::command]
pub fn hub_window_action(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
) -> Result<(), String> {
    authorize(&app, &window)?;
    match (window.label(), action.as_str()) {
        ("main", "open" | "focus") => {
            if let Some(hub) = app.get_webview_window(LABEL) {
                hub.show().map_err(|e| e.to_string())?;
                hub.unminimize().map_err(|e| e.to_string())?;
                return hub.set_focus().map_err(|e| e.to_string());
            }
            if action == "focus" {
                return Err("HUB_WINDOW_NOT_FOUND".into());
            }
            let url = crate::resolve_app_url(&app, PATH)?;
            let allowed_url = url.clone();
            let handle = app.clone();
            let mut builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
                .title("Hub · SourceWeft")
                .on_document_title_changed(|window, title| {
                    let _ = window.set_title(&title);
                })
                .inner_size(560.0, 760.0)
                .min_inner_size(420.0, 480.0)
                .visible(false)
                .initialization_script(crate::desktop_bridge_script())
                .on_navigation(move |url| same_app_origin(url, &allowed_url) && url.path() == PATH)
                .on_new_window(|url, _| {
                    if matches!(url.scheme(), "https" | "http") {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                });
            // Clamp saved coordinates to a currently attached monitor.
            if let Some(main) = app.get_webview_window("main") {
                if let Ok(monitors) = main.available_monitors() {
                    let saved = app
                        .path()
                        .app_data_dir()
                        .ok()
                        .and_then(|p| std::fs::read(p.join("hub-window.json")).ok())
                        .and_then(|b| serde_json::from_slice::<Geometry>(&b).ok());
                    let monitor = monitors
                        .iter()
                        .find(|m| {
                            saved.as_ref().is_some_and(|g| {
                                let area = m.work_area();
                                let s = m.scale_factor();
                                g.x >= area.position.x as f64 / s
                                    && g.x < (area.position.x as f64 + area.size.width as f64) / s
                                    && g.y >= area.position.y as f64 / s
                                    && g.y < (area.position.y as f64 + area.size.height as f64) / s
                            })
                        })
                        .or_else(|| monitors.first());
                    if let Some(m) = monitor {
                        let area = m.work_area();
                        let s = m.scale_factor();
                        let x = area.position.x as f64 / s;
                        let y = area.position.y as f64 / s;
                        let w = area.size.width as f64 / s;
                        let h = area.size.height as f64 / s;
                        let g = saved.unwrap_or(Geometry {
                            x: x + 40.0,
                            y: y + 40.0,
                            width: 560.0,
                            height: 760.0,
                        });
                        let width = g.width.max(420.0).min(w);
                        let height = g.height.max(480.0).min((h - 40.0).max(1.0));
                        builder = builder.inner_size(width, height).position(
                            g.x.max(x).min(x + w - width),
                            g.y.max(y).min(y + h - height - 30.0),
                        );
                    }
                }
            }
            let hub = builder.build().map_err(|e| e.to_string())?;
            hub.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    let _ = handle.emit_to("main", EVENT, json!({"kind":"destroyed"}));
                }
            });
            Ok(())
        }
        (LABEL, "show") => {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())
        }
        (LABEL, "close" | "docked") | ("main", "abort" | "logout") => {
            if let Some(hub) = app.get_webview_window(LABEL) {
                save_geometry(&app, &hub);
                app.emit_to("main", EVENT, json!({"kind":"closed", "reason": action}))
                    .map_err(|e| e.to_string())?;
                hub.destroy().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        (LABEL, "main") => crate::focus_main_window(&app),
        _ => Err("HUB_ACTION_DENIED".into()),
    }
}

fn message_allowed(label: &str, message: &Value) -> bool {
    let Some(kind) = message.get("kind").and_then(Value::as_str) else {
        return false;
    };
    match label {
        "main" => matches!(
            kind,
            "snapshot" | "result" | "dock-applied" | "disconnected" | "barrier"
        ),
        LABEL => matches!(
            kind,
            "ready" | "applied" | "command" | "dock" | "view" | "barrier-result"
        ),
        _ => false,
    }
}

#[tauri::command]
pub fn hub_window_send(
    app: AppHandle,
    window: WebviewWindow,
    message: Value,
) -> Result<(), String> {
    authorize(&app, &window)?;
    if !message_allowed(window.label(), &message) || message.to_string().len() > 4 * 1024 * 1024 {
        return Err("HUB_MESSAGE_DENIED".into());
    }
    let target = if window.label() == "main" {
        LABEL
    } else {
        "main"
    };
    if app.get_webview_window(target).is_none() {
        return Err("HUB_PEER_NOT_FOUND".into());
    }
    app.emit_to(target, EVENT, message)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packaged_custom_origin_is_accepted_without_admitting_another_host() {
        let base = Url::parse("tauri://localhost/dashboard").unwrap();
        assert!(caller_allowed(
            "hub",
            &Url::parse("tauri://localhost/dashboard/hub-window").unwrap(),
            &base
        ));
        assert!(!caller_allowed(
            "hub",
            &Url::parse("tauri://other/dashboard/hub-window").unwrap(),
            &base
        ));
        assert!(!caller_allowed(
            "hub",
            &Url::parse("http://localhost/dashboard/hub-window").unwrap(),
            &base
        ));
    }
    #[test]
    fn relay_is_scoped_to_window_origin_path_and_direction() {
        let base = Url::parse("http://localhost:3000/dashboard").unwrap();
        for (label, url, expected) in [
            ("main", "http://localhost:3000/dashboard/chat/a", true),
            ("hub", "http://localhost:3000/dashboard/hub-window", true),
            ("hub", "http://localhost:3000/dashboard/chat/a", false),
            ("other", "http://localhost:3000/dashboard/hub-window", false),
            ("main", "http://localhost:3001/dashboard", false),
            ("main", "https://example.com/dashboard", false),
            ("main", "http://localhost:3000/auth", false),
        ] {
            assert_eq!(
                caller_allowed(label, &Url::parse(url).unwrap(), &base),
                expected
            );
        }
        assert!(message_allowed("main", &json!({"kind":"snapshot"})));
        assert!(!message_allowed("hub", &json!({"kind":"snapshot"})));
        assert!(!message_allowed("main", &json!({"kind":"command"})));
        assert!(!message_allowed("hub", &json!({"kind":"eval"})));
    }
}
