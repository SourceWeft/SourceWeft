//! Cross-platform storage for local-device credentials.
//!
//! macOS stores secrets in the Keychain via `security_framework`. Linux
//! stores them in the platform's Secret Service (gnome-keyring, KWallet,
//! etc.) via the `keyring` crate's synchronous DBus backend. There is
//! intentionally no file-based fallback: if neither store is reachable,
//! callers must surface that to the user rather than writing secrets to
//! disk unencrypted.
//!
//! `get` returns `Ok(None)` when the platform store has no matching item
//! (never an error), so call sites can keep treating "not found" as a
//! normal outcome exactly as they did before this module existed. `delete`
//! of a missing item is `Ok(())`.

#[cfg(target_os = "macos")]
mod imp {
    use security_framework::base::Error as KeychainError;

    /// `errSecItemNotFound`: https://developer.apple.com/documentation/security/errsecitemnotfound
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    /// Pure, so it's unit-testable without a real Keychain:
    /// `KeychainError::from_code` only ever formats an OSStatus into text
    /// (via `SecCopyErrorMessageString`), it never touches the Keychain.
    /// Mirrors exactly what the pre-`secret_store` call sites did with a
    /// `get_generic_password` result: not-found collapses to `None`, any
    /// other error keeps its raw OS message (callers that historically
    /// added their own prefix, e.g. `authenticate`'s "Keychain access
    /// failed: ", still do so themselves).
    fn map_lookup(result: Result<Vec<u8>, KeychainError>) -> Result<Option<Vec<u8>>, String> {
        match result {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub(crate) fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        map_lookup(security_framework::passwords::get_generic_password(
            service, account,
        ))
    }

    pub(crate) fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
        security_framework::passwords::set_generic_password(service, account, secret)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn delete(service: &str, account: &str) -> Result<(), String> {
        match security_framework::passwords::delete_generic_password(service, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    /// The exact text a `get` lookup used to surface for a not-found item,
    /// before this module existed (when every call site formatted its own
    /// `get_generic_password` error directly). `choose_folder` needs this
    /// one byte-identical string back, since `get`'s `Ok(None)` discards
    /// it; everywhere else "not found" is deliberately just `None`.
    pub(crate) fn not_found_message() -> String {
        KeychainError::from_code(ERR_SEC_ITEM_NOT_FOUND).to_string()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn not_found_maps_to_none() {
            let result = map_lookup(Err(KeychainError::from_code(ERR_SEC_ITEM_NOT_FOUND)));
            assert_eq!(result, Ok(None));
        }

        #[test]
        fn other_error_maps_to_its_raw_message() {
            // errSecParam: a stable, harmless code to format — this never
            // touches a real Keychain item.
            let error = KeychainError::from_code(-50);
            let expected = error.to_string();
            assert_eq!(map_lookup(Err(error)), Err(expected));
        }

        #[test]
        fn found_item_round_trips_its_bytes() {
            let result = map_lookup(Ok(b"secret".to_vec()));
            assert_eq!(result, Ok(Some(b"secret".to_vec())));
        }

        #[test]
        fn not_found_message_matches_what_a_lookup_error_would_format_to() {
            let formatted_by_a_real_lookup_error =
                KeychainError::from_code(ERR_SEC_ITEM_NOT_FOUND).to_string();
            assert_eq!(not_found_message(), formatted_by_a_real_lookup_error);
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use keyring::Entry;

    const NO_KEYRING_MESSAGE: &str =
        "No system keyring is available (Secret Service). Install and unlock a keyring, then retry.";

    pub(crate) fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        match entry(service, account)?.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(describe(error)),
        }
    }

    pub(crate) fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
        entry(service, account)?
            .set_secret(secret)
            .map_err(describe)
    }

    pub(crate) fn delete(service: &str, account: &str) -> Result<(), String> {
        match entry(service, account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(describe(error)),
        }
    }

    fn entry(service: &str, account: &str) -> Result<Entry, String> {
        // Entry::new never touches the bus (it only builds the lookup
        // attributes), so a failure here is a usage error, not a missing
        // keyring; it still gets the generic path below.
        Entry::new(service, account).map_err(describe)
    }

    /// Both of these variants mean the Secret Service couldn't do the work:
    /// `PlatformFailure` covers connecting to the DBus session/Secret
    /// Service at all (no bus, no provider registered on it), and
    /// `NoStorageAccess` covers a reachable-but-unusable store (e.g. a
    /// locked keyring). Either way the fix is the same, so both get the
    /// one actionable message instead of leaking DBus plumbing details —
    /// but the original error is logged first (not just discarded), since
    /// it's the only thing that lets anyone diagnose which of those two
    /// (or something else entirely, like a DBus timeout) actually happened.
    fn describe(error: keyring::Error) -> String {
        match error {
            keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
                eprintln!("sourceweft-desktop: Secret Service unavailable: {error}");
                NO_KEYRING_MESSAGE.to_owned()
            }
            other => format!("Keyring access failed: {other}"),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    pub(crate) fn get(_service: &str, _account: &str) -> Result<Option<Vec<u8>>, String> {
        Err("UNSUPPORTED_PLATFORM".into())
    }

    pub(crate) fn set(_service: &str, _account: &str, _secret: &[u8]) -> Result<(), String> {
        Err("UNSUPPORTED_PLATFORM".into())
    }

    pub(crate) fn delete(_service: &str, _account: &str) -> Result<(), String> {
        Err("UNSUPPORTED_PLATFORM".into())
    }
}

/// Reads a previously stored secret. `Ok(None)` means no matching item was
/// ever stored (or it was deleted) — never an error.
pub(crate) fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
    imp::get(service, account)
}

/// Creates or overwrites a stored secret.
pub(crate) fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
    imp::set(service, account, secret)
}

/// Removes a stored secret. Deleting an item that doesn't exist is `Ok(())`.
///
/// No current call site needs this yet (device credentials are only ever
/// overwritten, never explicitly revoked), but it's part of this module's
/// contract and is exercised by the round-trip test below.
#[allow(dead_code)]
pub(crate) fn delete(service: &str, account: &str) -> Result<(), String> {
    imp::delete(service, account)
}

/// macOS only: the exact message a `get` lookup used to surface for a
/// not-found item before this module existed. See `imp::not_found_message`.
#[cfg(target_os = "macos")]
pub(crate) fn not_found_message() -> String {
    imp::not_found_message()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_service(case: &str) -> String {
        format!(
            "com.sourceweft.desktop.test.{case}.{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        )
    }

    #[cfg(target_os = "linux")]
    const NO_KEYRING_MESSAGE: &str =
        "No system keyring is available (Secret Service). Install and unlock a keyring, then retry.";

    /// On Linux, a missing Secret Service (no session bus, or a bus with no
    /// provider registered on it) is a real possibility in CI/containers.
    /// When that happens every one of these calls fails with the same
    /// actionable message, so a round trip can't complete; skip instead of
    /// failing in that case, but only after confirming we got exactly the
    /// documented error, so a different failure still fails the test.
    #[cfg(target_os = "linux")]
    fn skip_if_no_keyring(message: &str) -> bool {
        if message == NO_KEYRING_MESSAGE {
            eprintln!("skipping: {message} (this environment has no usable Secret Service)");
            true
        } else {
            false
        }
    }

    #[test]
    fn round_trip_stores_and_reads_back() {
        let service = unique_service("round-trip");
        let account = "device";
        let secret = b"local-device-credential-bytes".to_vec();

        if let Err(message) = set(&service, account, &secret) {
            #[cfg(target_os = "linux")]
            if skip_if_no_keyring(&message) {
                return;
            }
            panic!("set should succeed: {message}");
        }

        let read_back = get(&service, account).expect("get should succeed");
        assert_eq!(read_back, Some(secret));

        delete(&service, account).expect("delete should succeed");
        let after_delete = get(&service, account).expect("get after delete should succeed");
        assert_eq!(after_delete, None);
    }

    #[test]
    fn missing_item_is_none() {
        let service = unique_service("missing-item");
        let account = "device";

        match get(&service, account) {
            Ok(value) => assert_eq!(value, None),
            Err(message) => {
                #[cfg(target_os = "linux")]
                if skip_if_no_keyring(&message) {
                    return;
                }
                panic!("get should succeed: {message}");
            }
        }
    }

    /// Proves the dedicated error path exists and is worded exactly as
    /// required, without requiring a special environment: if a usable
    /// Secret Service IS present (the common case), this skips with a
    /// clear message instead of silently passing; if it is NOT present
    /// (e.g. no session bus), it asserts the exact message. Both outcomes
    /// are exercised by this one test depending on the environment it
    /// runs in — never a silent pass either way.
    #[cfg(target_os = "linux")]
    #[test]
    fn missing_keyring_reports_clear_error() {
        let service = unique_service("no-keyring-probe");
        match set(&service, "device", b"probe") {
            Ok(()) => {
                delete(&service, "device").ok();
                eprintln!(
                    "skipping: a usable Secret Service is present in this environment"
                );
            }
            Err(message) => {
                assert_eq!(message, NO_KEYRING_MESSAGE);
            }
        }
    }
}
