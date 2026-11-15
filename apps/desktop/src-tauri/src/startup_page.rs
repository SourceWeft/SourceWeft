//! The bundled page the main window opens on (`apps/desktop/startup-dist`).
//!
//! The main window shows the hosted web app, which takes a network round trip to arrive. Opening
//! the window on the web app directly leaves it blank until then, and blank for good on macOS
//! when the server cannot be reached. The window opens on this local page instead; the page
//! shows a progress indicator, loads the web app, and stays on screen until the web app starts
//! rendering. A load that fails leaves the page in place with a message and a retry.
//!
//! The page is static and is the only local page the main window may show. It gets no access to
//! the desktop commands: those authorize the page by its URL (`authorize_desktop_window`), which
//! is never the web origin here.
use url::Url;

/// Whether `url` is the startup page as Tauri serves it on this platform.
pub fn is_startup_page_url(url: &Url) -> bool {
    matches_startup_page(url, cfg!(windows))
}

/// Tauri serves bundled pages from `tauri://localhost`, and from `http://tauri.localhost` on
/// Windows, where WebView2 has no custom schemes. Each form is accepted only on its own
/// platform: elsewhere `http://tauri.localhost` is an ordinary loopback address.
fn matches_startup_page(url: &Url, windows: bool) -> bool {
    let bundled_origin = if windows {
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    };
    bundled_origin
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        // `tauri://localhost` parses with an empty path: `tauri` is not a scheme the URL
        // standard gives a default path to.
        && matches!(url.path(), "" | "/" | "/index.html")
}

/// Hands the startup page the web app address to load and the locale to speak. It defines
/// nothing on any other page of the window.
pub fn initialization_script(target: &Url, locale: &str) -> String {
    let config = serde_json::json!({ "url": target.as_str(), "locale": locale });
    format!(
        r#"
(() => {{
  const bundled = location.protocol === "tauri:" || location.hostname === "tauri.localhost";
  if (!bundled || window.__SOURCEWEFT_STARTUP__) return;
  Object.defineProperty(window, "__SOURCEWEFT_STARTUP__", {{
    value: Object.freeze({config}),
    configurable: false,
    enumerable: false,
    writable: false,
  }});
}})();
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn the_bundled_page_is_recognized_in_the_form_each_platform_serves() {
        for value in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
        ] {
            assert!(matches_startup_page(&url(value), false), "{value}");
            assert!(
                !matches_startup_page(&url(value), true),
                "{value} on Windows"
            );
        }
        for value in [
            "http://tauri.localhost",
            "http://tauri.localhost/index.html",
        ] {
            assert!(matches_startup_page(&url(value), true), "{value}");
            // Off Windows this is a loopback address anyone can serve, not the bundled page.
            assert!(
                !matches_startup_page(&url(value), false),
                "{value} off Windows"
            );
        }
    }

    #[test]
    fn nothing_else_passes_as_the_startup_page() {
        for value in [
            "tauri://localhost/other.html",
            "tauri://localhost/startup.js",
            "tauri://evil.example/",
            "tauri://localhost.evil.example/",
            "tauri://user@localhost/",
            "tauri://localhost:8080/",
            "https://tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://tauri.localhost.evil.example/",
            "http://localhost/",
            "https://sourceweft.com/",
            "https://sourceweft.com/index.html",
            "file:///index.html",
            "about:blank",
        ] {
            assert!(!matches_startup_page(&url(value), false), "{value}");
            assert!(
                !matches_startup_page(&url(value), true),
                "{value} on Windows"
            );
        }
    }

    #[test]
    fn the_script_carries_the_address_and_locale_as_inert_data() {
        let script = initialization_script(&url("https://sourceweft.com/dashboard/chat"), "zh-CN");
        assert!(script.contains(r#""url":"https://sourceweft.com/dashboard/chat""#));
        assert!(script.contains(r#""locale":"zh-CN""#));

        // A value with quotes and script syntax stays inside its JSON string.
        let hostile = initialization_script(
            &url("https://sourceweft.com/dashboard/chat"),
            "\"});alert(1);//",
        );
        assert!(hostile.contains(r#""locale":"\"});alert(1);//""#));
    }
}
