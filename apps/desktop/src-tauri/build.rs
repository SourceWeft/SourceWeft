fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
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
        ]),
    ))
    .expect("failed to build Tauri application metadata");
}
