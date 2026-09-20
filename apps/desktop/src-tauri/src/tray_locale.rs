//! Keeps the system tray's menu text in the locale the dashboard is actually
//! rendering, on both axes the user cares about (§ tray/page consistency):
//!
//! - On first launch (no prior session), the tray guesses from the OS locale
//!   via `sys-locale`, so a fresh install already matches the system.
//! - Once the webview has resolved its own locale (the same priority chain
//!   the web app uses: explicit user setting → `sw_locale` cookie →
//!   `Accept-Language` → default), it calls `sync_tray_locale` and that value
//!   wins and is persisted, so the tray tracks the page exactly — including
//!   a later in-app language switch — rather than drifting from it. Rust has
//!   no visibility into the webview's cookie jar or React state, so the page
//!   is the one source of truth here; the OS guess only covers the gap
//!   before the frontend has had a chance to report in.
//!
//! Supported locale set is duplicated from `@sourceweft/i18n` (`packages/i18n`)
//! by hand: three IDs, stable, not worth sharing across the Rust/TS boundary.
use tauri::menu::MenuItem;
use tauri::{AppHandle, State, WebviewWindow, Wry};

use crate::DesktopState;

/// The tray's two menu items, stashed in managed state at build time so a
/// later `sync_tray_locale` call can relabel them in place. Pinned to `Wry`
/// (unlike `AppHandle`/`WebviewWindow`, `MenuItem` has no default runtime
/// parameter) — like the rest of this app, it only ever runs on `Wry`.
pub struct TrayState {
    pub open: MenuItem<Wry>,
    pub quit: MenuItem<Wry>,
}

/// Mirrors `@sourceweft/i18n`'s `Locale` union.
const SUPPORTED_LOCALES: [&str; 3] = ["en", "zh-CN", "zh-TW"];
const DEFAULT_LOCALE: &str = "en";

/// Ports `normalizeToLocale` from `packages/i18n/src/resolve.ts` line for
/// line (exact match, then a `zh`-prefix branch that tells Traditional from
/// Simplified via script/region markers, then an `en`-prefix branch, then
/// the default) — not "close enough": an OS locale like `zh-Hant-TW` or
/// `zh-HK` must resolve the same way here as it would in the browser, or the
/// tray and the page could show different Chinese variants for the same
/// system locale.
pub fn normalize_locale(raw: &str) -> &'static str {
    let lower = raw.trim().to_lowercase();
    if lower.is_empty() {
        return DEFAULT_LOCALE;
    }

    for candidate in SUPPORTED_LOCALES {
        if lower == candidate.to_lowercase() {
            return candidate;
        }
    }

    if lower == "zh" || lower.starts_with("zh-") || lower.starts_with("zh_") {
        let is_traditional = ["hant", "-tw", "-hk", "-mo", "_tw", "_hk", "_mo"]
            .iter()
            .any(|marker| lower.contains(marker));
        return if is_traditional { "zh-TW" } else { "zh-CN" };
    }

    if lower == "en" || lower.starts_with("en-") || lower.starts_with("en_") {
        return "en";
    }

    DEFAULT_LOCALE
}

/// The OS-reported locale, normalized. Used only as the pre-frontend
/// startup guess — never overrides a page-reported locale once one arrives.
pub fn os_locale() -> &'static str {
    sys_locale::get_locale()
        .map(|tag| normalize_locale(&tag))
        .unwrap_or(DEFAULT_LOCALE)
}

pub fn tray_labels(locale: &str) -> (&'static str, &'static str) {
    match locale {
        "zh-CN" => ("打开 SourceWeft", "退出 SourceWeft"),
        "zh-TW" => ("打開 SourceWeft", "退出 SourceWeft"),
        _ => ("Open SourceWeft", "Quit SourceWeft"),
    }
}

#[tauri::command]
pub fn sync_tray_locale(
    app: AppHandle,
    window: WebviewWindow,
    locale: String,
    tray: State<'_, TrayState>,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    crate::authorize_desktop_window(&app, &window, false)?;
    let resolved = normalize_locale(&locale);
    apply_tray_locale(&tray, resolved)?;

    let snapshot = {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "Failed to lock desktop settings".to_string())?;
        settings.tray_locale = Some(resolved.to_string());
        settings.clone()
    };
    crate::write_settings(&state.settings_path, &snapshot)
}

/// Applies `locale` to the already-built tray's menu items in place — no
/// menu/tray rebuild, just `MenuItem::set_text` on the handles `setup_tray`
/// stashed in managed state.
pub fn apply_tray_locale(tray: &TrayState, locale: &str) -> Result<(), String> {
    let (open_label, quit_label) = tray_labels(locale);
    tray.open
        .set_text(open_label)
        .map_err(|error| error.to_string())?;
    tray.quit
        .set_text(quit_label)
        .map_err(|error| error.to_string())
}

// `apply_tray_locale`/`sync_tray_locale` need a real `MenuItem`/`AppHandle`
// built inside a running Tauri app (no headless mock for those in this
// codebase) — not exercised here. The pure mapping they both sit on top of
// is, which is where a locale/label mismatch would actually originate.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_exact_and_case_insensitive_matches() {
        assert_eq!(normalize_locale("en"), "en");
        assert_eq!(normalize_locale("EN"), "en");
        assert_eq!(normalize_locale("zh-CN"), "zh-CN");
        assert_eq!(normalize_locale("zh-cn"), "zh-CN");
        assert_eq!(normalize_locale("zh-TW"), "zh-TW");
        assert_eq!(normalize_locale("zh-tw"), "zh-TW");
    }

    #[test]
    fn normalizes_realistic_os_locale_tags_sys_locale_can_return() {
        // macOS/Windows/Linux locale tags observed in practice, none of
        // which are an exact match for our three supported IDs.
        assert_eq!(normalize_locale("en-US"), "en");
        assert_eq!(normalize_locale("en_GB"), "en");
        assert_eq!(normalize_locale("zh-Hans-CN"), "zh-CN");
        assert_eq!(normalize_locale("zh_CN"), "zh-CN");
    }

    #[test]
    fn traditional_chinese_script_and_region_markers_all_resolve_to_zh_tw() {
        // Ported line for line from `normalizeToLocale` — a mismatch here
        // means the tray and the page could disagree on which Chinese
        // variant a Traditional-Chinese OS locale should render as.
        assert_eq!(normalize_locale("zh-Hant-TW"), "zh-TW");
        assert_eq!(normalize_locale("zh-Hant"), "zh-TW");
        assert_eq!(normalize_locale("zh-TW"), "zh-TW");
        assert_eq!(normalize_locale("zh-HK"), "zh-TW");
        assert_eq!(normalize_locale("zh-MO"), "zh-TW");
        assert_eq!(normalize_locale("zh_TW"), "zh-TW");
        assert_eq!(normalize_locale("zh_HK"), "zh-TW");
        assert_eq!(normalize_locale("zh_MO"), "zh-TW");
    }

    #[test]
    fn bare_zh_without_a_region_defaults_to_simplified() {
        // Matches the web app's own default for unqualified Chinese.
        assert_eq!(normalize_locale("zh"), "zh-CN");
    }

    #[test]
    fn unsupported_languages_fall_back_to_the_default_locale() {
        assert_eq!(normalize_locale("fr-FR"), "en");
        assert_eq!(normalize_locale("ja"), "en");
        assert_eq!(normalize_locale(""), "en");
        assert_eq!(normalize_locale("not-a-locale-tag"), "en");
    }

    #[test]
    fn tray_labels_cover_every_supported_locale_and_fall_back_to_english() {
        assert_eq!(
            tray_labels("en"),
            ("Open SourceWeft", "Quit SourceWeft")
        );
        assert_eq!(tray_labels("zh-CN"), ("打开 SourceWeft", "退出 SourceWeft"));
        assert_eq!(tray_labels("zh-TW"), ("打開 SourceWeft", "退出 SourceWeft"));
        // Defensive: any value that reaches this point should already be
        // normalized, but an unrecognized one must still render in English
        // rather than panic or show a blank label.
        assert_eq!(
            tray_labels("unexpected"),
            ("Open SourceWeft", "Quit SourceWeft")
        );
    }
}
