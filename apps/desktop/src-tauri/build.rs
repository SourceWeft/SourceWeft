fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "hub_window_action",
            "hub_window_send",
            "desktop_info",
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
