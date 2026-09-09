#![cfg(target_os = "macos")]
//! Opt-in execution E2E host. This runs the production RemoteHost, Keychain,
//! WebSocket, SQLite and Seatbelt code. Only the UI enrollment interaction is
//! supplied by the isolated E2E fixture. It is not a simulated device.
#[path = "../src/remote_host.rs"]
mod remote_host;

use sourceweft_desktop::local_host::LocalHost;
use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

#[test]
#[ignore = "requires isolated live backend and real macOS Keychain/Seatbelt"]
fn serve_real_local_host_for_browser_execution_e2e() {
    assert_eq!(
        std::env::var("SOURCEWEFT_API_BASE_URL").unwrap(),
        "http://localhost:3101"
    );
    let root = PathBuf::from(
        std::env::var("SOURCEWEFT_E2E_RUN_DIR").expect("An explicit E2E run directory is required"),
    );
    assert!(root.is_absolute());
    let enrollment: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("enrollment.private.json")).unwrap()).unwrap();
    let ticket = enrollment["ticket"].as_str().unwrap().to_owned();
    let run_id = enrollment["runId"].as_str().unwrap();
    assert!(uuid::Uuid::parse_str(run_id).is_ok());
    let data = root.join("native-data");
    let host = Arc::new(LocalHost::open(&data).unwrap());
    let service = format!("nicelab.sourceweft.execution-e2e.{run_id}");
    let remote = remote_host::RemoteHost::new(host, service).unwrap();
    tauri::async_runtime::block_on(remote.enroll(ticket))
        .expect("Real enrollment/Keychain must work; no storage fallback");
    let started = Instant::now();
    while !remote.status().connected && started.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let status = remote.status();
    assert!(
        status.connected,
        "Actual native WebSocket must connect: {:?}",
        status.error
    );
    let device_id = status.device_id.unwrap();
    fs::write(
        root.join("host-ready.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "deviceId": device_id, "connected": true, "nativeData": data,
            "kind": "production-rust-host-with-fixture-enrollment", "uiEnrollmentCovered": false
        }))
        .unwrap(),
    )
    .unwrap();
    println!("E2E_NATIVE_HOST_READY {device_id}");
    while !root.join("stop").exists() && started.elapsed() < Duration::from_secs(900) {
        std::thread::sleep(Duration::from_millis(200));
    }
    remote.disconnect();
    assert!(
        root.join("stop").exists(),
        "E2E host reached its bounded lifetime without completion"
    );
}
