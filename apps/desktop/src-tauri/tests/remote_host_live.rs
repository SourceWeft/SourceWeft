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

#[test]
#[ignore = "supplemental live host protocol test; does not cover native UI enrollment"]
fn serve_context_host_with_real_authentication() {
    use serde_json::{json, Value};
    assert_eq!(
        std::env::var("SOURCEWEFT_API_BASE_URL").unwrap(),
        "http://localhost:3301"
    );
    let root = PathBuf::from(std::env::var("SOURCEWEFT_E2E_RUN_DIR").unwrap());
    assert!(root.is_absolute());
    let fixture: Value =
        serde_json::from_slice(&fs::read(root.join("environment.private.json")).unwrap()).unwrap();
    let previous = fs::read(root.join("context-host.private.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let previous_data = previous
        .as_ref()
        .and_then(|value| value["nativeData"].as_str())
        .map(PathBuf::from);
    let run = previous_data
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("host-"))
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    assert!(uuid::Uuid::parse_str(&run).is_ok());
    let data = root.join(format!("host-{run}"));
    let host = Arc::new(LocalHost::open(&data).unwrap());
    let remote =
        remote_host::RemoteHost::new(host, format!("nicelab.sourceweft.context-e2e.{run}"))
            .unwrap();
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();
        let response = client
            .post("http://localhost:3301/api/auth/sign-in/email")
            .header("Origin", "http://localhost:3300")
            .json(&json!({"email":fixture["email"],"password":fixture["password"]}))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let cookie = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().split(';').next().unwrap())
            .collect::<Vec<_>>()
            .join("; ");
        let mut proof = None;
        for _ in 0..2 {
            let response = client
                .post("http://localhost:3301/v1/local-devices/enroll")
                .header("Cookie", &cookie)
                .json(&json!({}))
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success());
            let ticket: Value = response.json().await.unwrap();
            let value = remote
                .authenticate(
                    ticket["ticket"].as_str().unwrap().into(),
                    ticket["userId"].as_str().unwrap().into(),
                )
                .await
                .expect("Real Keychain authentication is required");
            if value["proof"].is_string() {
                proof = Some(value);
                break;
            }
        }
        let proof = proof.expect("Native session proof required");
        let id = proof["deviceId"].as_str().unwrap();
        if proof["remoteEnabled"] != true {
            let response = client
                .post(format!(
                    "http://localhost:3301/v1/local-devices/{id}/policy"
                ))
                .header("Cookie", &cookie)
                .header("X-Local-Proof", proof["proof"].as_str().unwrap())
                .json(&json!({"remoteEnabled":true}))
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success());
        }
        fs::write(root.join("context-host.private.json"),serde_json::to_vec(&json!({"deviceId":id,"nativeData":data,"uiEnrollmentCovered":false,"nativeCookie":cookie,"nativeProof":proof["proof"]})).unwrap()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            root.join("context-host.private.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    });
    let started = Instant::now();
    while !remote.status().connected && started.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(remote.status().connected);
    println!("CONTEXT_NATIVE_HOST_READY (protocol test; UI enrollment not covered)");
    while !root.join("stop-context-host").exists() && started.elapsed() < Duration::from_secs(900) {
        std::thread::sleep(Duration::from_millis(200));
    }
    remote.disconnect();
    assert!(root.join("stop-context-host").exists());
}
