//! Sign in with Apple for the iOS app.
//!
//! One command, `sign_in`: it shows the system's Sign in with Apple sheet and returns the
//! identity token Apple issued for this app. The page hands that token to the backend, which
//! verifies it. On every other platform the command reports that it is unavailable.

use serde::{Deserialize, Serialize};
use tauri::{
    command,
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_apple_sign_in);

/// What the page sends: the value Apple copies into the identity token's `nonce` claim. The
/// page keeps the random nonce it derived this from and sends that one to the backend.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInRequest {
    pub hashed_nonce: String,
}

/// What the page gets back. Apple gives the name only the first time a person authorizes the
/// app, so `given_name` and `family_name` are usually absent.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInResponse {
    pub identity_token: String,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("Sign in with Apple is only available in the iOS app")]
    Unavailable,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(target_os = "ios")]
struct AppleSignIn<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[command]
async fn sign_in<R: Runtime>(
    app: AppHandle<R>,
    payload: SignInRequest,
) -> Result<SignInResponse, Error> {
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        app.state::<AppleSignIn<R>>()
            .0
            .run_mobile_plugin("signIn", payload)
            .map_err(Into::into)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, payload);
        Err(Error::Unavailable)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apple-sign-in")
        .invoke_handler(tauri::generate_handler![sign_in])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let handle = _api.register_ios_plugin(init_plugin_apple_sign_in)?;
                _app.manage(AppleSignIn(handle));
            }
            Ok(())
        })
        .build()
}
