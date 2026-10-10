//! Account-scoped device credentials in the OS credential store.
#[derive(Debug)]
pub struct CredentialError {
    missing: bool,
    message: String,
}
impl CredentialError {
    pub fn code(&self) -> i32 {
        if self.missing {
            -25300
        } else {
            -1
        }
    }
}
impl std::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(target_os = "macos")]
pub fn get_generic_password(service: &str, account: &str) -> Result<Vec<u8>, CredentialError> {
    security_framework::passwords::get_generic_password(service, account).map_err(|e| {
        CredentialError {
            missing: e.code() == -25300,
            message: e.to_string(),
        }
    })
}
#[cfg(target_os = "macos")]
pub fn set_generic_password(
    service: &str,
    account: &str,
    bytes: &[u8],
) -> Result<(), CredentialError> {
    security_framework::passwords::set_generic_password(service, account, bytes).map_err(|e| {
        CredentialError {
            missing: false,
            message: e.to_string(),
        }
    })
}

#[cfg(all(windows, test))]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    #[test]
    fn credentials_round_trip_in_the_os_store_and_do_not_cross_accounts() {
        let service = format!("SourceWeft-test-{}", uuid::Uuid::new_v4());
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let name = target(&self.0, "owner").unwrap();
                unsafe {
                    CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0);
                }
            }
        }
        let _cleanup = Cleanup(service.clone());
        assert_eq!(
            get_generic_password(&service, "owner").unwrap_err().code(),
            -25300
        );
        set_generic_password(&service, "owner", b"test-only-credential").unwrap();
        assert_eq!(
            get_generic_password(&service, "owner").unwrap(),
            b"test-only-credential"
        );
        assert_eq!(
            get_generic_password(&service, "other").unwrap_err().code(),
            -25300
        );
    }
}

#[cfg(windows)]
fn target(service: &str, account: &str) -> Result<Vec<u16>, CredentialError> {
    if service.contains('\0') || account.contains('\0') {
        return Err(CredentialError {
            missing: false,
            message: "Invalid credential scope".into(),
        });
    }
    Ok(format!("{service}/{account}")
        .encode_utf16()
        .chain(Some(0))
        .collect())
}

#[cfg(windows)]
pub fn get_generic_password(service: &str, account: &str) -> Result<Vec<u8>, CredentialError> {
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_NOT_FOUND},
        Security::Credentials::*,
    };
    let name = target(service, account)?;
    let mut credential = std::ptr::null_mut();
    if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        let code = unsafe { GetLastError() };
        return Err(CredentialError {
            missing: code == ERROR_NOT_FOUND,
            message: format!("Credential Manager read failed ({code})"),
        });
    }
    // CredReadW owns the returned allocation until CredFree; copy before release.
    let bytes = unsafe {
        if (*credential).CredentialBlobSize == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(
                (*credential).CredentialBlob,
                (*credential).CredentialBlobSize as usize,
            )
            .to_vec()
        }
    };
    unsafe { CredFree(credential.cast()) };
    Ok(bytes)
}

#[cfg(windows)]
pub fn set_generic_password(
    service: &str,
    account: &str,
    bytes: &[u8],
) -> Result<(), CredentialError> {
    use windows_sys::Win32::Security::Credentials::*;
    if bytes.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err(CredentialError {
            missing: false,
            message: "Device credential exceeds the OS limit".into(),
        });
    }
    let mut name = target(service, account)?;
    let mut user: Vec<u16> = account.encode_utf16().chain(Some(0)).collect();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: name.as_mut_ptr(),
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_ptr().cast_mut(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: user.as_mut_ptr(),
        ..Default::default()
    };
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(CredentialError {
            missing: false,
            message: format!(
                "Credential Manager write failed ({})",
                std::io::Error::last_os_error()
            ),
        });
    }
    Ok(())
}
