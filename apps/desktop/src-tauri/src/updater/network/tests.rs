use super::*;
use std::sync::atomic::AtomicU32;
fn fixture() -> (tempfile::TempDir, Journal) {
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::new(dir.path().join("updater.log"));
    (dir, journal)
}
fn transient() -> Failure {
    Failure::transport(
        &std::io::Error::from(std::io::ErrorKind::ConnectionReset),
        false,
    )
}
#[tokio::test]
async fn recovers_after_two_failures_and_logs_correlation() {
    let (dir, journal) = fixture();
    let result = run(
        &journal,
        &Operation::new(Duration::from_secs(5)),
        "metadata",
        Policy {
            backoff: Duration::ZERO,
            ..Policy::METADATA
        },
        None,
        |n| async move {
            if n < 3 {
                Err(transient())
            } else {
                Ok(42)
            }
        },
    )
    .await
    .unwrap();
    assert_eq!(result, 42);
    let records: Vec<Value> = std::fs::read_to_string(dir.path().join("updater.log"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(records.len(), 6);
    assert!(records
        .iter()
        .all(|v| v["operationId"] == records[0]["operationId"]));
    assert_eq!(records[5]["recovered"], true);
    assert_eq!(records[5]["attempt"], 3);
}
#[tokio::test]
async fn exhaustion_and_nonretryable_failures_have_exact_attempt_limits() {
    let (_dir, journal) = fixture();
    for (failure, expected) in [
        (transient(), 3),
        (Failure::http(404, None), 1),
        (Failure::terminal("UPDATE_SIGNATURE_INVALID"), 1),
    ] {
        let calls = AtomicU32::new(0);
        let _ = run::<(), _, _>(
            &journal,
            &Operation::new(Duration::from_secs(5)),
            "metadata",
            Policy {
                backoff: Duration::ZERO,
                ..Policy::METADATA
            },
            None,
            |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                let f = failure.clone();
                async { Err(f) }
            },
        )
        .await
        .unwrap_err();
        assert_eq!(calls.load(Ordering::SeqCst), expected);
    }
}
#[tokio::test]
async fn cancellation_interrupts_requests_and_backoff() {
    let (_dir, journal) = fixture();
    for backoff in [false, true] {
        let cancel = AtomicBool::new(false);
        let operation = Operation::new(Duration::from_secs(30));
        let request = run::<(), _, _>(
            &journal,
            &operation,
            "package",
            Policy::DOWNLOAD,
            Some(&cancel),
            |_| async {
                if backoff {
                    Err(transient())
                } else {
                    std::future::pending().await
                }
            },
        );
        // Keep the operation alive across join.
        let trigger = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.store(true, Ordering::SeqCst);
        };
        let start = Instant::now();
        let (result, _) = tokio::join!(request, trigger);
        assert!(result.unwrap_err().cancelled());
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
#[tokio::test]
async fn deadline_bounds_hung_request_and_retry_after_never_sleeps_past_budget() {
    let (_dir, journal) = fixture();
    let op = Operation::new(Duration::from_millis(30));
    let start = Instant::now();
    let e = run::<(), _, _>(
        &journal,
        &op,
        "metadata",
        Policy::METADATA,
        None,
        |_| async { std::future::pending().await },
    )
    .await
    .unwrap_err();
    assert_eq!(e.kind, "timeout");
    assert!(start.elapsed() < Duration::from_secs(1));
    let calls = AtomicU32::new(0);
    let e = run::<(), _, _>(
        &journal,
        &Operation::new(Duration::from_secs(1)),
        "metadata",
        Policy::METADATA,
        None,
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(Failure::http(429, Some(Duration::from_secs(60)))) }
        },
    )
    .await
    .unwrap_err();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(e.status, Some(429));
}
#[test]
fn http_and_transport_classification_fails_closed() {
    for status in [408, 429, 500, 502, 503, 504] {
        assert!(Failure::http(status, None).retryable);
    }
    for status in [301, 400, 401, 403, 404, 501, 505] {
        assert!(!Failure::http(status, None).retryable);
    }
    let eof = std::io::Error::other("tls handshake eof");
    assert!(Failure::transport(&eof, false).retryable);
    let cert = std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        "invalid peer certificate: secret",
    );
    let f = Failure::transport(&cert, true);
    assert!(!f.retryable);
    assert_eq!(f.kind, "certificate");
    assert!(!Failure::transport(&std::io::Error::other("unknown secret"), false).retryable);
    assert!(
        !Failure::plugin(tauri_plugin_updater::Error::Network(
            "Download request failed with status: 503".into()
        ))
        .retryable
    );
}
#[test]
fn no_untrusted_text_is_written_and_retry_after_parses_both_forms() {
    let e = std::io::Error::other(
        "tls handshake eof https://user:password@proxy/?token=secret Authorization: Bearer token",
    );
    let f = Failure::transport(&e, false);
    assert_eq!(f.causes, vec!["tls handshake eof"]);
    assert!(!f.message().contains("password"));
    assert_eq!(retry_after(Some(" 7 ")), Some(Duration::from_secs(7)));
    assert_eq!(
        retry_after(Some("Wed, 21 Oct 2015 07:28:00 GMT")),
        Some(Duration::ZERO)
    );
    assert_eq!(retry_after(Some("invalid")), None);
}
#[test]
fn rotation_permissions_and_concurrent_records() {
    let (dir, journal) = fixture();
    std::fs::write(&journal.path, vec![b' '; LOG_LIMIT as usize]).unwrap();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let j = &journal;
            scope.spawn(move || {
                for i in 0..20 {
                    j.write(json!({"i":i}));
                }
            });
        }
    });
    let text = std::fs::read_to_string(&journal.path).unwrap();
    assert_eq!(text.lines().count(), 160);
    assert!(text
        .lines()
        .all(|l| serde_json::from_str::<Value>(l).is_ok()));
    assert!(dir.path().join("updater.log.1").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&journal.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[cfg(unix)]
#[test]
fn log_symlinks_are_rejected() {
    let (dir, journal) = fixture();
    let target = dir.path().join("secret");
    std::fs::write(&target, "preserved").unwrap();
    std::os::unix::fs::symlink(&target, &journal.path).unwrap();
    assert!(journal.append(json!({"event":"test"})).is_err());
    assert_eq!(std::fs::read_to_string(target).unwrap(), "preserved");
}

// Real sockets exercise reqwest's actual source chain (including body errors),
// rather than constructing the same Failure that the retry loop expects.
fn server(responses: Vec<&'static [u8]>) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/manifest", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request);
            if !response.is_empty() {
                stream.write_all(response).unwrap();
            }
        }
    });
    (endpoint, handle)
}
#[tokio::test]
async fn real_http_eof_and_partial_body_recover_without_partial_json() {
    let (url, thread) = server(vec![
        b"",
        b"HTTP/1.1 200 OK\r\nContent-Length: 99\r\nConnection: close\r\n\r\n{\"secret\":",
        b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
    ]);
    let (_dir, journal) = fixture();
    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .build()
        .unwrap();
    let value = run(
        &journal,
        &Operation::new(Duration::from_secs(5)),
        "metadata",
        Policy {
            backoff: Duration::ZERO,
            ..Policy::METADATA
        },
        None,
        |_| manifest(&client, &url),
    )
    .await
    .unwrap();
    assert_eq!(value, json!({"ok":true}));
    thread.join().unwrap();
}
#[tokio::test]
async fn real_http_status_and_invalid_json_are_classified() {
    for (response, code, retryable) in [
        (
            &b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nContent-Length: 0\r\n\r\n"[..],
            "UPDATE_HTTP_503",
            true,
        ),
        (
            &b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"[..],
            "UPDATE_HTTP_403",
            false,
        ),
        (
            &b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecret"[..],
            "INVALID_UPDATE_MANIFEST",
            false,
        ),
    ] {
        let (url, thread) = server(vec![response]);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let e = manifest(&client, &url).await.unwrap_err();
        assert_eq!(e.code, code);
        assert_eq!(e.retryable, retryable);
        if retryable {
            assert_eq!(e.retry_after, Some(Duration::from_secs(2)));
        }
        assert!(!e.message().contains("secret"));
        thread.join().unwrap();
    }
}
#[tokio::test]
async fn package_policy_never_exceeds_two_attempts() {
    let (_dir, journal) = fixture();
    let calls = AtomicU32::new(0);
    run::<(), _, _>(
        &journal,
        &Operation::new(Duration::from_secs(5)),
        "package",
        Policy {
            backoff: Duration::ZERO,
            ..Policy::DOWNLOAD
        },
        None,
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(transient()) }
        },
    )
    .await
    .unwrap_err();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn sequential_stages_share_one_deadline() {
    let (_dir, journal) = fixture();
    let start = Instant::now();
    let operation = Operation::new(Duration::from_millis(80));
    let deadline = operation.deadline;
    run(
        &journal,
        &operation,
        "metadata",
        Policy::METADATA,
        None,
        |_| async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(())
        },
    )
    .await
    .unwrap();
    assert_eq!(start.elapsed(), Duration::from_millis(50));
    assert_eq!(operation.deadline, deadline);
    let second_stage_start = Instant::now();
    let remaining = deadline - second_stage_start;
    assert_eq!(remaining, Duration::from_millis(30));
    let calls = AtomicU32::new(0);
    let e = run::<(), _, _>(
        &journal,
        &operation,
        "plugin_check",
        Policy::METADATA,
        None,
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { std::future::pending().await }
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.kind, "timeout");
    assert_eq!(e.code, "UPDATE_NETWORK");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(second_stage_start.elapsed(), remaining);
    assert_eq!(Instant::now(), deadline);
    assert_eq!(start.elapsed(), Duration::from_millis(80));
}
#[tokio::test(start_paused = true)]
async fn elapsed_deadline_rejects_a_stage_before_invoking_its_request() {
    let (_dir, journal) = fixture();
    let operation = Operation::new(Duration::from_millis(80));
    tokio::time::advance(Duration::from_millis(81)).await;
    let calls = AtomicU32::new(0);
    let error = run::<(), _, _>(
        &journal,
        &operation,
        "plugin_check",
        Policy::METADATA,
        None,
        |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "UPDATE_BUDGET_EXHAUSTED");
    assert_eq!(error.kind, "policy");
    assert!(!error.retryable);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn terminal_codes_and_rotated_files_do_not_leak_details() {
    assert_eq!(
        Failure::terminal("UPDATE_PREFERENCES_INVALID: password").message(),
        "UPDATE_PREFERENCES_INVALID"
    );
    assert_eq!(Failure::terminal("password").message(), "UPDATE_FAILED");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, journal) = fixture();
        std::fs::write(&journal.path, vec![b' '; LOG_LIMIT as usize]).unwrap();
        std::fs::set_permissions(&journal.path, std::fs::Permissions::from_mode(0o644)).unwrap();
        journal.write(json!({"event":"test"}));
        assert_eq!(
            std::fs::metadata(journal.path.with_extension("log.1"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn plugin_http_stack_discards_partial_package_and_recovers() {
    let (url, thread) = server(vec![
        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nPARTIAL",
        b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nCOMPLETE",
    ]);
    let (_dir, journal) = fixture();
    // Match tauri-plugin-updater::Updater::check's provider initialization.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = updater_http::Client::builder()
        .no_proxy()
        .retry(updater_http::retry::never())
        .build()
        .unwrap();
    let bytes = run(
        &journal,
        &Operation::new(Duration::from_secs(5)),
        "package",
        Policy {
            backoff: Duration::ZERO,
            ..Policy::DOWNLOAD
        },
        None,
        |_| async {
            let response = client
                .get(&url)
                .send()
                .await
                .map_err(|e| Failure::plugin(e.into()))?;
            response
                .bytes()
                .await
                .map_err(|e| Failure::plugin(e.into()))
        },
    )
    .await
    .unwrap();
    assert_eq!(&bytes[..], b"COMPLETE");
    thread.join().unwrap();
}
