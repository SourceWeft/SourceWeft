#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = LAUNCHED_AT.set(Instant::now());
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_apple_sign_in::init())
        .plugin(tauri_plugin_google_auth::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            mobile_info,
            open_external_url,
            take_launch_elapsed_ms,
            set_session_hint,
            retry_launch,
            log_sign_in_failure
        ])
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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Emitter, Manager, WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;
use url::{Host, Url};

const DEEP_LINK_EVENT: &str = "sourceweft:deep-link";
const DEEP_LINK_SCHEME: &str = "sourceweft";
const MAIN_WINDOW_LABEL: &str = "main";
const APP_PROTOCOL_SCHEME: &str = "tauri";
const APP_PROTOCOL_ORIGIN: &str = "tauri://localhost";
const SIGN_IN_PATH: &str = "/auth/sign-in";
const HOME_PATH: &str = "/dashboard/chat";
/// Bundled page the window opens on. It paints at once, so the wait for the web app shows a
/// branded screen rather than a blank one.
const SPLASH_PATH: &str = "/splash.html";
const DASHBOARD_ROOT: &str = "/dashboard";
/// File that says a session existed when the app last looked. It holds no credential: it
/// only lets the next launch open the dashboard instead of the sign-in page, saving one
/// network round trip. The web app checks the real session either way.
const SESSION_HINT_FILE: &str = "session-hint";
/// The hosts named in `WKAppBoundDomains` (Info.ios.plist). WKWebView runs service workers
/// only for app-bound domains, and only once navigation is limited to them.
const APP_BOUND_HOSTS: [&str; 2] = ["sourceweft.com", "localhost"];

static LAUNCHED_AT: OnceLock<Instant> = OnceLock::new();
static LAUNCH_REPORTED: AtomicBool = AtomicBool::new(false);
/// Set when a web page finished loading (or reported its launch time), so the launch watch
/// knows the page arrived.
static WEB_READY: AtomicBool = AtomicBool::new(false);
/// Each launch attempt's number; a retry makes an earlier attempt's watch stand down.
static LAUNCH_ATTEMPT: AtomicUsize = AtomicUsize::new(0);

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

/// The bridge the page finds on `window`. It names the platform so the page knows at once,
/// without a round trip, which app it runs in: the iOS app, for one, may not sell anything.
fn mobile_bridge_script() -> String {
    MOBILE_BRIDGE_SCRIPT.replace("__SOURCEWEFT_PLATFORM__", std::env::consts::OS)
}

const MOBILE_BRIDGE_SCRIPT: &str = r#"
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
    platform: "__SOURCEWEFT_PLATFORM__",
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
"#;

fn create_main_window(app: &mut tauri::App) -> tauri::Result<()> {
    let mut window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
        .unwrap_or_else(|| app.config().app.windows[0].clone());

    let base = web_base_url(app.handle()).map_err(std::io::Error::other)?;
    window_config.url = tauri::WebviewUrl::App(SPLASH_PATH.trim_start_matches('/').into());
    window_config.limit_navigations_to_app_bound_domains = is_app_bound(&base);
    let handle = app.handle().clone();
    let launch_handle = app.handle().clone();
    // Injected as its own script, the way the desktop host does it.
    // `append_invoke_initialization_script` concatenates onto Tauri's IPC script, which ends
    // in `})()` with no semicolon, so a bridge starting with `(` is parsed as a call to that
    // expression and throws before defining anything.
    #[cfg_attr(not(target_os = "ios"), allow(unused_variables))]
    let window = WebviewWindowBuilder::from_config(app.handle(), &window_config)?
        .initialization_script(mobile_bridge_script())
        .on_navigation(move |url| handle_navigation(&handle, url))
        .on_page_load(move |webview, payload| {
            // The splash is on screen; only now start loading the web app behind it.
            let url = payload.url();
            if payload.event() == PageLoadEvent::Finished
                && is_splash_url(url)
                && !is_failed_splash_url(url)
            {
                if let Ok(target) = launch_url(&launch_handle) {
                    if webview.navigate(target).is_ok() {
                        watch_launch(launch_handle.clone());
                    }
                }
            }
        })
        .on_new_window(move |url, _features| {
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        })
        .build()?;
    #[cfg(target_os = "ios")]
    show_launch_screen_behind(&window);

    Ok(())
}

/// Puts the app's launch screen behind a transparent web view. Whenever the web view has
/// nothing painted (while it starts, between pages, after a failed load) the launch screen
/// shows through instead of a blank page. Every page the app shows paints its own background.
#[cfg(target_os = "ios")]
fn show_launch_screen_behind(window: &tauri::WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let _ = window.with_webview(|webview| {
        let web_view = webview.inner() as *mut AnyObject;
        let controller = webview.view_controller() as *mut AnyObject;
        if web_view.is_null() || controller.is_null() {
            return;
        }
        // SAFETY: both are live UIKit objects owned by the window, and with_webview runs this
        // on the main thread. Every message below is a public UIKit API.
        unsafe {
            let host: *mut AnyObject = msg_send![&*controller, view];
            let name: *mut AnyObject = msg_send![
                class!(NSString),
                stringWithUTF8String: c"LaunchScreen".as_ptr()
            ];
            let nil: *mut AnyObject = std::ptr::null_mut();
            let board: *mut AnyObject =
                msg_send![class!(UIStoryboard), storyboardWithName: name, bundle: nil];
            if host.is_null() || board.is_null() {
                return;
            }
            let launch: *mut AnyObject = msg_send![&*board, instantiateInitialViewController];
            if launch.is_null() {
                return;
            }
            let launch_view: *mut AnyObject = msg_send![&*launch, view];
            let _: () = msg_send![&*launch_view, setTag: LAUNCH_VIEW_TAG];
            let _: () =
                msg_send![&*launch_view, setTranslatesAutoresizingMaskIntoConstraints: false];
            let _: () = msg_send![&*host, insertSubview: launch_view, atIndex: 0usize];
            for anchor in [
                "topAnchor",
                "bottomAnchor",
                "leadingAnchor",
                "trailingAnchor",
            ] {
                let selector =
                    objc2::runtime::Sel::register(&std::ffi::CString::new(anchor).unwrap());
                let mine: *mut AnyObject = msg_send![&*launch_view, performSelector: selector];
                let theirs: *mut AnyObject = msg_send![&*host, performSelector: selector];
                let constraint: *mut AnyObject = msg_send![&*mine, constraintEqualToAnchor: theirs];
                let _: () = msg_send![&*constraint, setActive: true];
            }
            add_loading_bar(launch_view);
            let clear: *mut AnyObject = msg_send![class!(UIColor), clearColor];
            let _: () = msg_send![&*web_view, setBackgroundColor: clear];
            let scroll: *mut AnyObject = msg_send![&*web_view, scrollView];
            let _: () = msg_send![&*scroll, setBackgroundColor: clear];
        }
    });
}

/// Tag of the launch screen view put behind the web view, to find it again.
#[cfg(target_os = "ios")]
const LAUNCH_VIEW_TAG: isize = 0x5357_4c53;

/// Adds the splash page's loading bar under the launch screen's wordmark: a 44 by 3 point
/// track with a segment sliding across it, at the same place and pace as in splash.html and
/// the web app's launch cover. The launch image itself cannot animate, so the bar appears
/// once the app runs.
///
/// SAFETY: `launch_view` is the live launch screen view, and this runs on the main thread.
#[cfg(target_os = "ios")]
unsafe fn add_loading_bar(launch_view: *mut objc2::runtime::AnyObject) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    const WIDTH: f64 = 44.0;
    const HEIGHT: f64 = 3.0;
    const SEGMENT: f64 = WIDTH * 0.4;
    // splash.html puts the bar's top 32 points below the middle of the web view's span.
    const BELOW_CENTRE: f64 = 32.0 + HEIGHT / 2.0;

    // The storyboard's first subview is the hidden span the web view lays its pages out in.
    let subviews: *mut AnyObject = msg_send![&*launch_view, subviews];
    let span: *mut AnyObject = msg_send![&*subviews, firstObject];
    if span.is_null() {
        return;
    }
    let track: *mut AnyObject = msg_send![class!(UIView), new];
    let segment: *mut AnyObject = msg_send![class!(UIView), new];
    for view in [track, segment] {
        let _: () = msg_send![&*view, setTranslatesAutoresizingMaskIntoConstraints: false];
        let _: () = msg_send![&*view, setUserInteractionEnabled: false];
        let layer: *mut AnyObject = msg_send![&*view, layer];
        let _: () = msg_send![&*layer, setCornerRadius: HEIGHT / 2.0];
    }
    let grey: *mut AnyObject =
        msg_send![class!(UIColor), colorWithRed: 0.451f64, green: 0.451f64, blue: 0.451f64, alpha: 0.35f64];
    let _: () = msg_send![&*track, setBackgroundColor: grey];
    let _: () = msg_send![&*track, setClipsToBounds: true];
    let label: *mut AnyObject = msg_send![class!(UIColor), labelColor];
    let _: () = msg_send![&*segment, setBackgroundColor: label];
    let _: () = msg_send![&*launch_view, addSubview: track];
    let _: () = msg_send![&*track, addSubview: segment];

    let anchor = |view: *mut AnyObject, name: &str| -> *mut AnyObject {
        let selector = objc2::runtime::Sel::register(&std::ffi::CString::new(name).unwrap());
        msg_send![&*view, performSelector: selector]
    };
    let activate = |constraint: *mut AnyObject| {
        let _: () = msg_send![&*constraint, setActive: true];
    };
    activate(msg_send![&*anchor(track, "widthAnchor"), constraintEqualToConstant: WIDTH]);
    activate(msg_send![&*anchor(track, "heightAnchor"), constraintEqualToConstant: HEIGHT]);
    activate(msg_send![
        &*anchor(track, "centerXAnchor"),
        constraintEqualToAnchor: anchor(launch_view, "centerXAnchor")
    ]);
    activate(msg_send![
        &*anchor(track, "centerYAnchor"),
        constraintEqualToAnchor: anchor(span, "centerYAnchor"),
        constant: BELOW_CENTRE
    ]);
    activate(msg_send![&*anchor(segment, "widthAnchor"), constraintEqualToConstant: SEGMENT]);
    activate(msg_send![&*anchor(segment, "heightAnchor"), constraintEqualToConstant: HEIGHT]);
    activate(msg_send![
        &*anchor(segment, "leadingAnchor"),
        constraintEqualToAnchor: anchor(track, "leadingAnchor")
    ]);
    activate(msg_send![
        &*anchor(segment, "topAnchor"),
        constraintEqualToAnchor: anchor(track, "topAnchor")
    ]);

    let ns_string = |text: &std::ffi::CStr| -> *mut AnyObject {
        msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()]
    };
    let slide: *mut AnyObject = msg_send![
        class!(CABasicAnimation),
        animationWithKeyPath: ns_string(c"transform.translation.x")
    ];
    let from: *mut AnyObject = msg_send![class!(NSNumber), numberWithDouble: -SEGMENT];
    let to: *mut AnyObject = msg_send![class!(NSNumber), numberWithDouble: SEGMENT * 2.5];
    let easing: *mut AnyObject = msg_send![
        class!(CAMediaTimingFunction),
        functionWithName: ns_string(c"easeInEaseOut")
    ];
    let _: () = msg_send![&*slide, setFromValue: from];
    let _: () = msg_send![&*slide, setToValue: to];
    let _: () = msg_send![&*slide, setDuration: 1.1f64];
    let _: () = msg_send![&*slide, setRepeatCount: f32::INFINITY];
    let _: () = msg_send![&*slide, setTimingFunction: easing];
    // Kept when the app goes to the background, so the bar still moves on return.
    let _: () = msg_send![&*slide, setRemovedOnCompletion: false];
    let layer: *mut AnyObject = msg_send![&*segment, layer];
    let _: () = msg_send![&*layer, addAnimation: slide, forKey: ns_string(c"slide")];
}

/// Takes the launch screen away from behind the web view once the web app is on screen, and
/// gives the web view the system background instead. Otherwise anything that shows past the
/// page, such as the scroll iOS does when the keyboard opens, reveals the wordmark and bar.
#[cfg(target_os = "ios")]
fn hide_launch_screen_behind(window: &tauri::WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let _ = window.with_webview(|webview| {
        let web_view = webview.inner() as *mut AnyObject;
        let controller = webview.view_controller() as *mut AnyObject;
        if web_view.is_null() || controller.is_null() {
            return;
        }
        // SAFETY: live UIKit objects owned by the window; with_webview runs on the main thread.
        unsafe {
            let host: *mut AnyObject = msg_send![&*controller, view];
            if host.is_null() {
                return;
            }
            let launch: *mut AnyObject = msg_send![&*host, viewWithTag: LAUNCH_VIEW_TAG];
            if launch.is_null() {
                return;
            }
            let _: () = msg_send![&*launch, removeFromSuperview];
            let background: *mut AnyObject = msg_send![class!(UIColor), systemBackgroundColor];
            let _: () = msg_send![&*web_view, setBackgroundColor: background];
            let scroll: *mut AnyObject = msg_send![&*web_view, scrollView];
            let _: () = msg_send![&*scroll, setBackgroundColor: background];
        }
    });
}

/// The page a launch opens: the dashboard when a session existed last time, otherwise the
/// sign-in page. A stale hint costs nothing: the dashboard sends a signed-out visitor on to
/// sign in, as it always has.
fn launch_url(app: &AppHandle) -> Result<Url, String> {
    let signed_in = session_hint_path(app).is_some_and(|path| path.exists());
    resolve_app_url(app, launch_path(signed_in))
}

fn launch_path(signed_in: bool) -> &'static str {
    if signed_in {
        HOME_PATH
    } else {
        SIGN_IN_PATH
    }
}

fn session_hint_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(SESSION_HINT_FILE))
}

fn is_failed_splash_url(url: &Url) -> bool {
    is_splash_url(url) && url.fragment() == Some("failed")
}

/// A failed load leaves WKWebView on a blank, untitled page rather than on the splash, and
/// wry reports no failure. So once loading has stopped on such a page for a while, the splash
/// comes back in its failed state, with a retry button.
fn watch_launch(app: AppHandle) {
    WEB_READY.store(false, Ordering::SeqCst);
    let attempt = LAUNCH_ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        const POLL: Duration = Duration::from_millis(500);
        const IDLE_LIMIT: Duration = Duration::from_secs(1);
        let mut idle_since: Option<Instant> = None;
        loop {
            std::thread::sleep(POLL);
            if WEB_READY.load(Ordering::SeqCst) || LAUNCH_ATTEMPT.load(Ordering::SeqCst) != attempt
            {
                return;
            }
            let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
                return;
            };
            match page_state(&window) {
                // A failed load also ends in a finished page: an empty one, at the URL that
                // failed. Every page of the web app has a title, so a titled page arrived.
                Some(PageState::Loaded { titled: true }) => return,
                Some(PageState::Loaded { titled: false }) => {
                    if idle_since.get_or_insert_with(Instant::now).elapsed() >= IDLE_LIMIT {
                        if let Ok(failed) = app_protocol_url(&format!("{SPLASH_PATH}#failed")) {
                            let _ = window.navigate(failed);
                        }
                        return;
                    }
                }
                // Still loading, or the state is unknown: keep waiting.
                _ => idle_since = None,
            }
        }
    });
}

/// What the web view shows, as far as the launch watch needs to know.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
enum PageState {
    Loading,
    Loaded { titled: bool },
}

#[cfg(target_os = "ios")]
fn page_state(window: &tauri::WebviewWindow) -> Option<PageState> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let view = webview.inner() as *mut AnyObject;
            if view.is_null() {
                return;
            }
            // SAFETY: `inner()` is the live WKWebView, and this runs on the main thread.
            let state = unsafe {
                let loading: bool = msg_send![&*view, isLoading];
                if loading {
                    PageState::Loading
                } else {
                    let title: *mut AnyObject = msg_send![&*view, title];
                    let length: usize = if title.is_null() {
                        0
                    } else {
                        msg_send![&*title, length]
                    };
                    PageState::Loaded { titled: length > 0 }
                }
            };
            let _ = sender.send(state);
        })
        .ok()?;
    receiver.recv_timeout(Duration::from_secs(2)).ok()
}

/// Other platforms have no failed-load blank page to recover from.
#[cfg(not(target_os = "ios"))]
fn page_state(_window: &tauri::WebviewWindow) -> Option<PageState> {
    None
}

fn is_app_bound(base: &Url) -> bool {
    base.host_str()
        .is_some_and(|host| APP_BOUND_HOSTS.contains(&host))
}

fn handle_navigation(app: &AppHandle, url: &Url) -> bool {
    if url.scheme() == DEEP_LINK_SCHEME {
        emit_deep_link(app, url.to_string());
        return false;
    }

    if is_splash_url(url) {
        return true;
    }

    if is_app_url(app, url) {
        // Pages of the app's own site stay in the app: the web app shows public pages such
        // as the terms and privacy policy in its own sheet, a same-origin frame. Only the
        // site root, where a redirect can land, returns to the app's home.
        if lands_on_site_root(url.path()) {
            let _ = navigate_main_window(app, HOME_PATH);
            return false;
        }
        return true;
    }

    if url.scheme() == "http" || url.scheme() == "https" {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
        return false;
    }

    // Internal WebView schemes (ipc, about, blob) carry the Tauri runtime itself.
    true
}

fn is_splash_url(url: &Url) -> bool {
    url.scheme() == APP_PROTOCOL_SCHEME && url.path() == SPLASH_PATH
}

fn is_app_url(app: &AppHandle, url: &Url) -> bool {
    url.scheme() == APP_PROTOCOL_SCHEME || is_app_web_url(app, url)
}

fn is_app_web_url(app: &AppHandle, url: &Url) -> bool {
    resolve_app_url(app, HOME_PATH).is_ok_and(|base| same_origin(url, &base))
}

fn lands_on_site_root(path: &str) -> bool {
    path.is_empty() || path == "/"
}

fn navigate_main_window(app: &AppHandle, path: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window was not found".to_string())?;
    let current = window.url().map_err(|error| error.to_string())?;
    let target = if current.scheme() == APP_PROTOCOL_SCHEME && !is_splash_url(&current) {
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

/// Milliseconds from process start to this call, the first time it is called; later calls
/// return nothing, so only the launch itself is measured, not later page loads.
#[tauri::command]
fn take_launch_elapsed_ms(app: AppHandle) -> Option<u64> {
    WEB_READY.store(true, Ordering::SeqCst);
    #[cfg(target_os = "ios")]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        hide_launch_screen_behind(&window);
    }
    #[cfg(not(target_os = "ios"))]
    let _ = app;
    if LAUNCH_REPORTED.swap(true, Ordering::SeqCst) {
        return None;
    }
    LAUNCHED_AT
        .get()
        .map(|started| started.elapsed().as_millis() as u64)
}

/// Records whether the web app found a session, for the next launch to pick its first page.
#[tauri::command]
fn set_session_hint(app: AppHandle, signed_in: bool) -> Result<(), String> {
    let path = session_hint_path(&app).ok_or_else(|| "No app data directory".to_string())?;
    if signed_in {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        std::fs::write(&path, b"1").map_err(|error| error.to_string())
    } else {
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    }
}

/// Writes why a native sign-in failed to the device log. The person only sees a plain
/// sentence; the SDK's own text goes here, where it can be read with the phone attached
/// to a Mac (Console, or `idevicesyslog`).
#[tauri::command]
fn log_sign_in_failure(provider: String, reason: String) {
    let line = sign_in_failure_line(&provider, &reason);
    #[cfg(target_os = "ios")]
    ios_log(&line);
    #[cfg(not(target_os = "ios"))]
    eprintln!("{line}");
}

/// One log line, with the provider and reason cut to a bounded length.
fn sign_in_failure_line(provider: &str, reason: &str) -> String {
    let provider: String = provider.chars().take(32).collect();
    let reason: String = reason.chars().take(500).collect();
    format!("[SourceWeft sign-in] {provider} failed: {reason}")
}

/// NSLog, which reaches the device's unified log in release builds (stderr does not).
#[cfg(target_os = "ios")]
fn ios_log(line: &str) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::CString;

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        fn NSLog(format: *const AnyObject, ...);
    }

    let (Ok(format), Ok(text)) = (CString::new("%@"), CString::new(line.replace('\0', ""))) else {
        return;
    };
    unsafe {
        let format: *const AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: format.as_ptr()];
        let text: *const AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()];
        if !format.is_null() && !text.is_null() {
            NSLog(format, text);
        }
    }
}

/// The launch screen's retry button: start loading the web app again.
#[tauri::command]
fn retry_launch(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window was not found".to_string())?;
    window
        .navigate(launch_url(&app)?)
        .map_err(|error| error.to_string())?;
    watch_launch(app);
    Ok(())
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
            open_deep_link(&handle, &url);
        }
    });
}

/// A universal link to the app's own dashboard opens that page in the main window. Every
/// other deep link is handed to the page as an event.
fn open_deep_link(app: &AppHandle, url: &Url) {
    let target = resolve_app_url(app, HOME_PATH)
        .ok()
        .and_then(|base| universal_link_target(&base, url));
    if let Some(target) = target {
        let opened = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .is_some_and(|window| window.navigate(target).is_ok());
        if opened {
            return;
        }
    }
    emit_deep_link(app, url.to_string());
}

/// The page a universal link opens: the link itself, when it is a dashboard page on the
/// origin the app loads. The paths match the ones the website associates with the app
/// (`/.well-known/apple-app-site-association`); sign-in pages are deliberately not among
/// them, so a link from outside can never drive the app's sign-in flow.
fn universal_link_target(base: &Url, url: &Url) -> Option<Url> {
    let opens_dashboard = same_origin(url, base)
        && url.username().is_empty()
        && url.password().is_none()
        && is_dashboard_path(url.path());
    opens_dashboard.then(|| url.clone())
}

fn is_dashboard_path(path: &str) -> bool {
    path == DASHBOARD_ROOT || path.starts_with("/dashboard/")
}

fn emit_deep_link(app: &AppHandle, url: String) {
    let _ = app.emit(DEEP_LINK_EVENT, DeepLinkPayload { url });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("test URL")
    }

    #[test]
    fn a_sign_in_failure_is_logged_as_one_bounded_line() {
        assert_eq!(
            sign_in_failure_line("google", "Token exchange failed"),
            "[SourceWeft sign-in] google failed: Token exchange failed"
        );
        let long = sign_in_failure_line("google", &"x".repeat(2000));
        assert_eq!(
            long.chars().count(),
            "[SourceWeft sign-in] google failed: ".len() + 500
        );
    }

    #[test]
    fn a_launch_opens_the_dashboard_only_when_a_session_existed() {
        assert_eq!(launch_path(true), "/dashboard/chat");
        assert_eq!(launch_path(false), "/auth/sign-in");
    }

    #[test]
    fn navigation_is_limited_to_app_bound_domains_only_for_bound_hosts() {
        assert!(is_app_bound(&url("https://sourceweft.com")));
        assert!(is_app_bound(&url("http://localhost:3200")));
        for other in [
            "http://192.168.1.20:3000",
            "http://0.0.0.0:3000",
            "https://www.sourceweft.com",
            "https://staging.sourceweft.com",
        ] {
            assert!(!is_app_bound(&url(other)), "{other}");
        }
    }

    #[test]
    fn only_the_bundled_splash_page_is_the_splash() {
        assert!(is_splash_url(&url("tauri://localhost/splash.html")));
        assert!(is_splash_url(&url("tauri://localhost/splash.html#failed")));
        assert!(is_failed_splash_url(&url(
            "tauri://localhost/splash.html#failed"
        )));
        assert!(!is_failed_splash_url(&url("tauri://localhost/splash.html")));
        for other in [
            "https://sourceweft.com/splash.html",
            "tauri://localhost/",
            "tauri://localhost/splash.html.evil",
        ] {
            assert!(!is_splash_url(&url(other)), "{other}");
        }
    }

    #[test]
    fn a_dashboard_link_on_the_app_origin_opens_that_page() {
        let base = url("https://sourceweft.com/dashboard/chat");
        for link in [
            "https://sourceweft.com/dashboard",
            "https://sourceweft.com/dashboard/chat/abc?tab=sources#top",
            "https://sourceweft.com:443/dashboard/billing",
        ] {
            assert_eq!(universal_link_target(&base, &url(link)), Some(url(link)));
        }
    }

    #[test]
    fn other_links_are_not_opened_in_the_main_window() {
        let base = url("https://sourceweft.com/dashboard/chat");
        for link in [
            // Not a dashboard page: sign-in, marketing and look-alike paths.
            "https://sourceweft.com/auth/sign-in",
            "https://sourceweft.com/",
            "https://sourceweft.com/dashboardx",
            "https://sourceweft.com/pricing/dashboard/",
            // Not the origin the app loads.
            "http://sourceweft.com/dashboard",
            "https://sourceweft.com:8443/dashboard",
            "https://www.sourceweft.com/dashboard",
            "https://sourceweft.com.example.org/dashboard",
            "https://user:secret@sourceweft.com/dashboard",
            "https://user@sourceweft.com/dashboard",
            // Custom-scheme deep links stay events for the page.
            "sourceweft://auth/complete?code=1",
            "sourceweft://dashboard",
        ] {
            assert_eq!(universal_link_target(&base, &url(link)), None, "{link}");
        }
    }

    #[test]
    fn the_bridge_names_the_platform_it_runs_on() {
        let script = mobile_bridge_script();
        assert!(script.contains(&format!(r#"platform: "{}","#, std::env::consts::OS)));
        assert!(!script.contains("__SOURCEWEFT_PLATFORM__"));
    }

    #[test]
    fn only_the_site_root_sends_the_app_home() {
        assert!(lands_on_site_root("/"));
        for path in ["/privacy", "/terms", "/dashboard/chat", "/auth/sign-in"] {
            assert!(!lands_on_site_root(path), "{path}");
        }
    }
}
