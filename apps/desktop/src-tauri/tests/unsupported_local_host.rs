#![cfg(not(target_os = "macos"))]

use sourceweft_desktop::local_host::LocalHost;

#[test]
fn unsupported_platform_rejects_local_host_without_creating_state() {
    let temp = tempfile::tempdir().unwrap();
    let app_data = temp.path().join("app-data");
    let error = match LocalHost::open(&app_data) {
        Ok(_) => panic!("Local execution must not become available without a platform sandbox"),
        Err(error) => error,
    };
    assert_eq!(error.code, "UNSUPPORTED_PLATFORM");
    assert!(!app_data.exists());
}
