fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=SOURCEWEFT_SIGNED_RELEASE");
    let key = std::env::var("TAURI_UPDATER_PUBLIC_KEY").unwrap_or_default();
    if std::env::var("SOURCEWEFT_SIGNED_RELEASE").as_deref() == Ok("true") {
        assert!(!key.trim().is_empty(), "Signed releases require TAURI_UPDATER_PUBLIC_KEY");
    }
    assert!(!key.contains(['\n', '\r']), "Updater key must be one base64 line");
    println!("cargo:rustc-env=SOURCEWEFT_UPDATER_PUBLIC_KEY={}", key.trim());
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_update_state", "check_for_updates", "download_update", "install_update",
            "cancel_update_download", "cancel_update_install", "acknowledge_update_save",
            "set_update_preferences", "snooze_update",
            "hub_window_action",
            "hub_window_send",
            "open_file_preview",
            "read_file_preview",
            "close_file_preview",
            "desktop_info",
            "desktop_titlebar_action",
            "show_main_window",
            "get_autostart",
            "set_autostart",
            "open_external_url",
            "local_host_status",
            "authenticate_local_host",
            "choose_local_folder",
            "enable_local_host",
            "disconnect_local_host",
            "choose_working_directory",
        ]),
    ))
    .expect("failed to build Tauri application metadata");
}
