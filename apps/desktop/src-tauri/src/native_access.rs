//! IPC transport uses an Origin header; page-level authorization belongs in Rust.
use tauri::ipc::CapabilityBuilder;
use url::Url;

pub fn web_capability(base: &Url) -> CapabilityBuilder {
    // macOS custom-protocol IPC sends only scheme/host/port, while the
    // postMessage transport may send the full document URL. Match both with
    // the exact configured origin. Commands validate the real WebView URL.
    CapabilityBuilder::new("configured-web-window")
        .window("main")
        .local(false)
        .remote(base.origin().ascii_serialization())
        .permission("core:default")
        .permission("allow-desktop-info")
        .permission("allow-desktop-titlebar-action")
        .permission("allow-show-main-window")
        .permission("allow-get-autostart")
        .permission("allow-set-autostart")
        .permission("allow-open-external-url")
        .permission("allow-local-host-status")
        .permission("allow-authenticate-local-host")
        .permission("allow-choose-local-folder")
        .permission("allow-disconnect-local-host")
        .permission("allow-choose-working-directory")
        .permission("allow-enable-local-host")
        .permission("allow-hub-window-action")
        .permission("allow-hub-window-send")
}

pub fn hub_capability(base: &Url) -> CapabilityBuilder {
    CapabilityBuilder::new("configured-hub-window")
        .window("hub")
        .local(false)
        .remote(base.origin().ascii_serialization())
        .permission("core:event:allow-listen")
        .permission("core:event:allow-unlisten")
        .permission("allow-desktop-info")
        .permission("allow-open-external-url")
        .permission("allow-hub-window-action")
        .permission("allow-hub-window-send")
}

fn same_trusted_origin(url: &Url, base: &Url) -> bool {
    url.username().is_empty() && url.password().is_none() && url.origin() == base.origin()
}

pub fn is_allowed_caller(label: &str, url: &Url, base: &Url, dashboard_only: bool) -> bool {
    let dashboard = url.path() == "/dashboard" || url.path().starts_with("/dashboard/");
    label == "main"
        && same_trusted_origin(url, base)
        && (dashboard || (!dashboard_only && is_allowed_auth_url(url, base)))
}

pub fn is_allowed_auth_url(url: &Url, base: &Url) -> bool {
    same_trusted_origin(url, base) && (url.path() == "/auth" || url.path().starts_with("/auth/"))
}

/// Pages the app may hand to the system browser. Origin-scoped rather than
/// path-scoped: the desktop window refuses to navigate outside /dashboard and
/// /auth, so public pages such as the changelog can only be opened externally.
pub fn is_allowed_external_url(url: &Url, base: &Url) -> bool {
    same_trusted_origin(url, base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::RuntimeCapability;
    use tauri::utils::acl::{capability::CapabilityFile, RemoteUrlPattern};

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn path_scoped_capability_reproduces_origin_only_ipc_denial() {
        let previous: RemoteUrlPattern = "http://localhost:3300/auth/*".parse().unwrap();
        assert!(previous.test(&url(
            "http://localhost:3300/auth/sign-in?redirectTo=%2Fdashboard"
        )));
        assert!(!previous.test(&url("http://localhost:3300")));
    }

    #[test]
    fn configured_capability_handles_both_transports_without_matching_other_origins() {
        for origin in [
            "http://localhost:3300",
            "https://sourceweft.com",
            "https://workspace.example:8443",
        ] {
            let CapabilityFile::Capability(capability) = web_capability(&url(origin)).build()
            else {
                panic!("expected capability")
            };
            assert!(!capability.local);
            assert_eq!(capability.windows, vec!["main"]);
            let permissions = serde_json::to_value(&capability.permissions).unwrap();
            assert!(permissions
                .as_array()
                .unwrap()
                .iter()
                .any(|permission| permission == "allow-desktop-titlebar-action"));
            let patterns: Vec<RemoteUrlPattern> = capability
                .remote
                .unwrap()
                .urls
                .iter()
                .map(|value| value.parse().unwrap())
                .collect();
            for path in [
                "",
                "/",
                "/auth/sign-in?redirectTo=%2Fdashboard",
                "/dashboard/chat/test",
            ] {
                assert!(patterns
                    .iter()
                    .any(|pattern| pattern.test(&url(&format!("{origin}{path}")))));
            }
            for unrelated in [
                "https://evil.example/auth/sign-in",
                "http://localhost:3301/auth/sign-in",
                "https://sourceweft.com.evil.example/auth/sign-in",
            ] {
                assert!(!patterns.iter().any(|pattern| pattern.test(&url(unrelated))));
            }
        }
    }

    #[test]
    fn hub_transport_grants_only_scoped_relay_and_view_actions() {
        let CapabilityFile::Capability(capability) =
            hub_capability(&url("http://localhost:3300")).build()
        else {
            panic!("expected capability")
        };
        assert_eq!(capability.windows, vec!["hub"]);
        assert!(!capability.local);
        let permissions = serde_json::to_value(&capability.permissions).unwrap();
        let permissions = permissions.as_array().unwrap();
        assert!(permissions.iter().any(|p| p == "allow-hub-window-send"));
        for denied in [
            "allow-desktop-titlebar-action",
            "allow-authenticate-local-host",
            "allow-choose-local-folder",
            "allow-enable-local-host",
            "allow-set-autostart",
        ] {
            assert!(!permissions.iter().any(|p| p == denied));
        }
        let patterns: Vec<RemoteUrlPattern> = capability
            .remote
            .unwrap()
            .urls
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        assert!(patterns
            .iter()
            .any(|p| p.test(&url("http://localhost:3300"))));
        assert!(!patterns
            .iter()
            .any(|p| p.test(&url("https://evil.example"))));
    }

    #[test]
    fn commands_authorize_the_actual_main_window_page() {
        let base = url("http://localhost:3300");
        for (label, value, dashboard_only, allowed) in [
            (
                "main",
                "http://localhost:3300/auth/sign-in?desktop=1",
                false,
                true,
            ),
            ("main", "http://localhost:3300/auth/sign-in", true, false),
            ("main", "http://localhost:3300/dashboard", true, true),
            (
                "main",
                "http://localhost:3300/dashboard/chat/thread",
                true,
                true,
            ),
            ("other", "http://localhost:3300/dashboard", false, false),
            ("main", "http://localhost:3300/", false, false),
            (
                "main",
                "http://localhost:3300/published/untrusted",
                false,
                false,
            ),
            ("main", "http://localhost:3300/dashboard-evil", true, false),
            ("main", "http://localhost:3300/auth-evil", false, false),
            ("main", "http://localhost:3301/dashboard", true, false),
            ("main", "https://sourceweft.com/dashboard", true, false),
            (
                "main",
                "http://user@localhost:3300/auth/sign-in",
                false,
                false,
            ),
        ] {
            assert_eq!(
                is_allowed_caller(label, &url(value), &base, dashboard_only),
                allowed,
                "{label} {value}"
            );
        }
    }

    #[test]
    fn browser_login_uses_the_same_configured_origin_as_the_webview() {
        let base = url("http://localhost:3300/dashboard");
        assert!(is_allowed_auth_url(
            &url("http://localhost:3300/auth/sign-in?desktop=1"),
            &base
        ));
        for value in [
            "http://localhost:3000/auth/sign-in",
            "http://localhost:3300/dashboard",
            "https://sourceweft.com/auth/sign-in",
            "https://evil.example/auth",
            "javascript:alert(1)",
        ] {
            assert!(!is_allowed_auth_url(&url(value), &base));
        }
    }

    #[test]
    fn external_open_allows_other_paths_on_the_configured_origin_only() {
        let base = url("https://sourceweft.com/dashboard");
        for value in [
            "https://sourceweft.com/changelog",
            "https://sourceweft.com/about",
            "https://sourceweft.com/auth/sign-in",
        ] {
            assert!(is_allowed_external_url(&url(value), &base), "{value}");
        }
        for value in [
            "https://evil.example/changelog",
            "https://sourceweft.com.evil.example/changelog",
            "http://sourceweft.com/changelog",
            "https://user:pass@sourceweft.com/changelog",
        ] {
            assert!(!is_allowed_external_url(&url(value), &base), "{value}");
        }
    }
}
