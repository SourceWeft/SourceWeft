use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sourceweft_desktop::local_host::{execution::Executions, LocalHost};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::secret_store;

#[cfg(target_os = "macos")]
fn computer_name() -> Result<String, String> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .map_err(|error| format!("Could not read computer name: {error}"))?;
    if !output.status.success() {
        return Err("Could not read macOS computer name".into());
    }
    let name = String::from_utf8(output.stdout)
        .map_err(|_| "Computer name is not valid UTF-8")?;
    let name = name.trim();
    if name.is_empty() {
        return Err("macOS computer name is empty".into());
    }
    Ok(name.to_owned())
}

/// Parses `PRETTY_HOSTNAME` out of `/etc/machine-info` content (systemd's
/// `hostnamectl --pretty` store: `KEY=VALUE` lines, value optionally quoted).
/// A pure function so the quoting/emptiness rules are unit-testable without
/// touching the filesystem.
#[cfg(target_os = "linux")]
fn parse_pretty_hostname(machine_info: &str) -> Option<String> {
    for line in machine_info.lines() {
        let Some(value) = line.trim().strip_prefix("PRETTY_HOSTNAME=") else {
            continue;
        };
        let value = value.trim();
        let unquoted = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value)
            .trim();
        // The key only ever appears once in a well-formed machine-info file;
        // stop here either way instead of letting a later, unrelated line
        // (or a second malformed occurrence) override this decision.
        return if unquoted.is_empty() {
            None
        } else {
            Some(unquoted.to_owned())
        };
    }
    None
}

#[cfg(target_os = "linux")]
fn computer_name() -> Result<String, String> {
    let pretty = std::fs::read_to_string("/etc/machine-info")
        .ok()
        .and_then(|contents| parse_pretty_hostname(&contents));
    let name = match pretty {
        Some(name) => name,
        None => {
            let mut buffer = vec![0u8; 256];
            // SAFETY: `buffer` is valid for `buffer.len()` bytes for the
            // duration of the call, as required by `gethostname(3)`.
            let status = unsafe {
                libc::gethostname(buffer.as_mut_ptr() as *mut libc::c_char, buffer.len())
            };
            if status != 0 {
                return Err("Could not read Linux hostname".into());
            }
            let end = buffer.iter().position(|&byte| byte == 0).unwrap_or(buffer.len());
            buffer.truncate(end);
            String::from_utf8(buffer).map_err(|_| "Computer name is not valid UTF-8")?
        }
    };
    let name = name.trim();
    if name.is_empty() {
        return Err("Linux computer name is empty".into());
    }
    Ok(name.to_owned())
}

#[derive(Clone, Deserialize, Serialize)]
struct Credentials {
    id: String,
    user_id: String,
    token: String,
    api_base: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub device_id: Option<String>,
    pub user_id: Option<String>,
    pub connected: bool,
    pub error: Option<String>,
}

pub struct RemoteHost {
    pub host: Arc<LocalHost>,
    status: Arc<Mutex<RemoteStatus>>,
    stop: Arc<AtomicBool>,
    executions: Arc<Executions>,
    generation: Arc<AtomicU64>,
    keychain_service: String,
}

#[cfg(target_os = "macos")]
async fn pick_folder(_app: &tauri::AppHandle) -> Result<String, String> {
    let output = tauri::async_runtime::spawn_blocking(|| {
        std::process::Command::new("/usr/bin/osascript")
            .args([
                "-e",
                "POSIX path of (choose folder with prompt \"Choose a working directory\")",
            ])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Folder selection cancelled or unavailable".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "Invalid folder path".into())
}

#[cfg(target_os = "linux")]
async fn pick_folder(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match app.dialog().file().blocking_pick_folder() {
            Some(FilePath::Path(path)) => path
                .into_os_string()
                .into_string()
                .map_err(|_| "Invalid folder path".to_string()),
            // `blocking_pick_folder` runs on Linux's own GTK/XDG-portal event
            // loop, not ours, so it can only yield `None` (dialog dismissed)
            // or a `FilePath::Url` (never produced for a folder picker); both
            // are treated the same way the macOS cancel path is.
            Some(FilePath::Url(_)) | None => {
                Err("Folder selection cancelled or unavailable".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The exact message `choose_folder` surfaces when the stored device
/// credential is missing. On macOS this must byte-match what the raw
/// Keychain lookup used to return before `secret_store` existed (see
/// `secret_store::not_found_message`); `choose_folder` never existed on
/// Linux before this port, so it gets a plain, friendlier message instead.
#[cfg(target_os = "macos")]
fn missing_device_credential_error() -> String {
    secret_store::not_found_message()
}

#[cfg(target_os = "linux")]
fn missing_device_credential_error() -> String {
    "Authenticate this computer before choosing a folder".to_string()
}

/// `enroll`'s credential-store write used to be wrapped in this prefix only
/// on macOS (there was no Linux path before this port). Linux's
/// `secret_store::set` error is already the exact user-facing text (e.g.
/// the no-keyring message), so it must pass through unprefixed.
#[cfg(target_os = "macos")]
fn enrollment_store_error(error: String) -> String {
    format!("Keychain enrollment failed: {error}")
}

#[cfg(target_os = "linux")]
fn enrollment_store_error(error: String) -> String {
    error
}

/// `authenticate`'s direct/legacy credential lookup used to wrap a real
/// (non-not-found) error in this prefix only on macOS. On Linux, the error
/// coming out of `secret_store::get` may already be the exact required
/// no-keyring message, so it must not be re-wrapped.
#[cfg(target_os = "macos")]
fn keychain_lookup_error(error: String) -> String {
    format!("Keychain access failed: {error}")
}

#[cfg(target_os = "linux")]
fn keychain_lookup_error(error: String) -> String {
    error
}

impl RemoteHost {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub async fn choose_folder(
        &self,
        app: &tauri::AppHandle,
        ticket: String,
        user_id: String,
    ) -> Result<Value, String> {
        let owner = user_id.clone();
        let authenticated = self.authenticate(ticket, user_id).await?;
        if authenticated["needsProof"] == true || self.status().user_id.as_deref() != Some(&owner) {
            return Err("Authenticate the current account before choosing a folder".into());
        }
        let folder_generation = self.generation.load(Ordering::SeqCst);
        let account = format!(
            "local-device:{}",
            self.status()
                .user_id
                .ok_or("Authenticate this account first")?
        );
        let bytes = match secret_store::get(&self.keychain_service, &account)? {
            Some(bytes) => bytes,
            None => return Err(missing_device_credential_error()),
        };
        let credential: Credentials =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid device credentials")?;
        if self.status().device_id.as_deref() != Some(&credential.id) {
            return Err("Authenticate this computer before choosing a folder".into());
        }
        let path = pick_folder(app).await?;
        if self.generation.load(Ordering::SeqCst) != folder_generation
            || self.status().user_id.as_deref() != Some(&owner)
        {
            return Err("Folder selection was cancelled after account change".into());
        }
        let grant = self
            .host
            .register_folder(&credential.user_id, std::path::Path::new(path.trim()))
            .map_err(|e| e.to_string())?;
        let response = reqwest::Client::new()
            .post(format!(
                "{}/v1/local-devices/folders/register",
                credential.api_base.trim_end_matches('/')
            ))
            .bearer_auth(&credential.token)
            .json(&grant)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Folder registration failed: {}", response.status()));
        }
        response.json().await.map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub async fn choose_folder(
        &self,
        _app: &tauri::AppHandle,
        _ticket: String,
        _user_id: String,
    ) -> Result<Value, String> {
        Err("UNSUPPORTED_PLATFORM".into())
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub async fn authenticate(&self, ticket: String, user_id: String) -> Result<Value, String> {
        if self.status().device_id.is_some() && self.status().user_id.as_deref() != Some(&user_id) {
            self.disconnect();
        }
        let auth_generation = self.generation.load(Ordering::SeqCst);
        let account = format!("local-device:{user_id}");
        let direct = secret_store::get(&self.keychain_service, &account);
        // Adopt only this account's pre-release credential; never another user's.
        // Any real (non-not-found) error, from either lookup, surfaces below
        // with the same "Keychain access failed:" wording this call site
        // always used — bare from `secret_store` itself, since `choose_folder`
        // needs its own `get` call to stay unprefixed.
        let saved = match direct {
            Ok(Some(bytes)) => Ok(Some(bytes)),
            Ok(None) => match secret_store::get(&self.keychain_service, "local-device") {
                Ok(Some(bytes)) => {
                    let legacy: Credentials = serde_json::from_slice(&bytes)
                        .map_err(|_| "Invalid saved legacy credentials")?;
                    Ok(if legacy.user_id == user_id {
                        Some(bytes)
                    } else {
                        None
                    })
                }
                Ok(None) => Ok(None),
                Err(legacy_error) => Err(legacy_error),
            },
            Err(direct_error) => Err(direct_error),
        };
        let bytes = match saved {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                self.enroll(ticket).await?;
                return Ok(json!({"needsProof":true}));
            }
            Err(error) => return Err(keychain_lookup_error(error)),
        };
        let credentials: Credentials =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid saved device credentials")?;
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?
            .post(format!(
                "{}/v1/local-devices/native-session",
                credentials.api_base.trim_end_matches('/')
            ))
            .bearer_auth(&credentials.token)
            .json(&json!({"ticket":ticket,"workspaceBase":self.host.workspace_base(),"name":computer_name()?}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            self.disconnect();
            return Err(format!("Native identity rejected: {}", response.status()));
        }
        let proof: Value = response.json().await.map_err(|e| e.to_string())?;
        secret_store::set(
            &self.keychain_service,
            &format!("local-device:{}", credentials.user_id),
            &bytes,
        )?;
        if self.generation.load(Ordering::SeqCst) != auth_generation {
            return Err("Local authentication was cancelled".into());
        }
        if self.status().device_id.is_none() {
            self.start(credentials);
        }
        Ok(proof)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub async fn authenticate(&self, _ticket: String, _user_id: String) -> Result<Value, String> {
        Err("UNSUPPORTED_PLATFORM: Local execution currently requires macOS or Linux.".into())
    }
    pub fn new(host: Arc<LocalHost>, service: String) -> Result<Self, String> {
        host.initialize_invocation_journal()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            host,
            status: Arc::new(Mutex::new(RemoteStatus::default())),
            stop: Arc::new(AtomicBool::new(false)),
            executions: Arc::new(Executions::default()),
            generation: Arc::new(AtomicU64::new(0)),
            keychain_service: service,
        })
    }
    pub fn status(&self) -> RemoteStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }
    pub fn disconnect(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.stop.store(true, Ordering::SeqCst);
        self.executions.cancel_all();
        if let Ok(mut status) = self.status.lock() {
            status.connected = false;
            status.device_id = None;
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub async fn enroll(&self, _ticket: String) -> Result<RemoteStatus, String> {
        Err("UNSUPPORTED_PLATFORM: Local execution currently requires macOS or Linux.".into())
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub async fn enroll(&self, ticket: String) -> Result<RemoteStatus, String> {
        if self.status().device_id.is_some() {
            return Err("A local host is already enrolled in this application session.".into());
        }
        let enroll_generation = self.generation.load(Ordering::SeqCst);
        let api_base = std::env::var("SOURCEWEFT_API_BASE_URL").unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "http://localhost:3001".into()
            } else {
                "https://api.sourceweft.com".into()
            }
        });
        let url = url::Url::parse(&api_base).map_err(|e| e.to_string())?;
        if url.scheme() != "https"
            && !(cfg!(debug_assertions)
                && url.scheme() == "http"
                && url.host_str() == Some("localhost"))
        {
            return Err("Local host requires HTTPS (localhost HTTP is development-only).".into());
        }
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?
            .post(format!(
                "{}/v1/local-devices/claim",
                api_base.trim_end_matches('/')
            ))
            .json(&json!({"ticket":ticket,"name":computer_name()?}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Device enrollment rejected: {}", response.status()));
        }
        let value: Value = response.json().await.map_err(|e| e.to_string())?;
        let credential = Credentials {
            id: value["id"].as_str().ok_or("Missing device ID")?.into(),
            user_id: value["userId"].as_str().ok_or("Missing owner")?.into(),
            token: value["token"].as_str().ok_or("Missing credential")?.into(),
            api_base,
        };
        secret_store::set(
            &self.keychain_service,
            &format!("local-device:{}", credential.user_id),
            &serde_json::to_vec(&credential).map_err(|e| e.to_string())?,
        )
        .map_err(enrollment_store_error)?;
        if self.generation.load(Ordering::SeqCst) != enroll_generation {
            return Err("Device enrollment was cancelled".into());
        }
        self.start(credential);
        Ok(self.status())
    }

    fn start(&self, credential: Credentials) {
        let host = self.host.clone();
        let status = self.status.clone();
        let stop = self.stop.clone();
        let executions = self.executions.clone();
        let generation = self.generation.clone();
        let current = generation.fetch_add(1, Ordering::SeqCst) + 1;
        stop.store(false, Ordering::SeqCst);
        if let Ok(mut state) = status.lock() {
            state.device_id = Some(credential.id.clone());
            state.user_id = Some(credential.user_id.clone());
        }
        tauri::async_runtime::spawn(async move {
            while !stop.load(Ordering::SeqCst) && generation.load(Ordering::SeqCst) == current {
                let outcome = connection(
                    &host,
                    &executions,
                    &credential,
                    &status,
                    &stop,
                    &generation,
                    current,
                )
                .await;
                if generation.load(Ordering::SeqCst) != current {
                    break;
                }
                executions.cancel_all();
                if let Ok(mut state) = status.lock() {
                    state.connected = false;
                    state.error = outcome.err();
                }
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
    }
}

/// Applies a `network.decision` frame: `{type, askId, allow, reason?}` that arrived on `lease`'s
/// connection. Anything but an explicit `allow: true` denies. A decision for an ask nobody is
/// waiting on (late, repeated because the backend delivers at least once, already denied by
/// cancellation, or belonging to another connection) is ignored.
fn resolve_network_decision(
    lease: &sourceweft_desktop::local_host::network::OutboundLease,
    frame: &Value,
) -> Result<(), String> {
    let ask_id = frame["askId"].as_str().ok_or("Missing network ask ID")?;
    let allow = frame["allow"].as_bool() == Some(true);
    let reason = frame["reason"].as_str().map(str::to_owned);
    lease.resolve(ask_id, allow, reason);
    Ok(())
}

async fn connection(
    host: &Arc<LocalHost>,
    executions: &Arc<Executions>,
    credential: &Credentials,
    status: &Arc<Mutex<RemoteStatus>>,
    stop: &Arc<AtomicBool>,
    generation: &Arc<AtomicU64>,
    current: u64,
) -> Result<(), String> {
    let mut url = url::Url::parse(&credential.api_base).map_err(|e| e.to_string())?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|_| "Invalid WebSocket URL")?;
    url.set_path("/v1/local-devices/socket");
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", credential.token)
            .parse()
            .map_err(|_| "Invalid device token")?,
    );
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    let (mut sender, mut receiver) = socket.split();
    let (events, mut results) = tokio::sync::mpsc::channel::<(Value, Arc<sourceweft_desktop::local_host::maintenance::Lease>)>(32);
    // Sandbox network asks raised while a command runs leave through this channel for the
    // lifetime of this connection. The lease owns the slot: when this future exits (however it
    // does), it denies the asks sent over this connection and clears the slot only if no newer
    // connection has replaced it.
    let (network_out, mut network_frames) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let network_lease = host.network.attach(network_out);
    let serial = Arc::new(tokio::sync::Semaphore::new(1));
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let mut last_received = tokio::time::Instant::now();
    loop {
        tokio::select! {
            _=heartbeat.tick()=>{
                if stop.load(Ordering::SeqCst)||generation.load(Ordering::SeqCst)!=current {let _=sender.close().await;return Ok(());}
                // The server confirms heartbeats; silent half-open connections stop work.
                if last_received.elapsed()>Duration::from_secs(30){return Err("Device connection lease expired".into());}
                sender.send(Message::Text(json!({"type":"heartbeat"}).to_string().into())).await.map_err(|e|e.to_string())?;
            },
            Some((result, _lease))=results.recv()=>{sender.send(Message::Text(result.to_string().into())).await.map_err(|e|e.to_string())?;},
            Some(frame)=network_frames.recv()=>{sender.send(Message::Text(frame.to_string().into())).await.map_err(|e|e.to_string())?;},
            incoming=receiver.next()=>{
                let message=incoming.ok_or("Device connection closed")?.map_err(|e|e.to_string())?;
                last_received=tokio::time::Instant::now();
                if let Message::Text(text)=message {
                    let value:Value=serde_json::from_str(&text).map_err(|_|"Invalid server message")?;
                    match value["type"].as_str(){
                        Some("connected")=>{if value["deviceId"]!=credential.id||value["userId"]!=credential.user_id{return Err("Device identity mismatch".into());}if let Ok(mut state)=status.lock(){state.connected=true;state.error=None;}},
                        Some("heartbeat")=>{},
                        Some("network.decision")=>{resolve_network_decision(&network_lease,&value)?;},
                        Some("cancel")=>{if let Some(id)=value["id"].as_str(){executions.cancel(id);}},
                        Some("call")=>{
                            if value["userId"]!=credential.user_id{return Err("Call owner mismatch".into());}
                            let id=value["id"].as_str().ok_or("Missing invocation ID")?.to_owned();
                            let thread=value["threadId"].as_str().ok_or("Missing conversation")?.to_owned();
                            let action=value["action"].as_str().ok_or("Missing action")?.to_owned();
                            let deadline=value["deadline"].as_u64().ok_or("Missing deadline")?;
                            let payload=value["payload"].clone();
                            let lease=match host.admission.enter(){Ok(lease)=>Arc::new(lease),Err(code)=>{sender.send(Message::Text(json!({"type":"result","id":id,"ok":false,"error":code}).to_string().into())).await.map_err(|e|e.to_string())?;continue;}};
                            let owner=credential.user_id.clone();let host=host.clone();let calls=executions.clone();let events=events.clone();let serial=serial.clone();let stop=stop.clone();let generation=generation.clone();
                            sender.send(Message::Text(json!({"type":"accepted","id":id}).to_string().into())).await.map_err(|e|e.to_string())?;
                            tokio::spawn(async move{
                                let _permit=if action == "workspace.check" { None } else { Some(serial.acquire_owned().await) };
                                let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d|d.as_millis() as u64).unwrap_or(u64::MAX);
                                if now>=deadline||stop.load(Ordering::SeqCst)||generation.load(Ordering::SeqCst)!=current||calls.is_cancelled(&id){let _=events.send((json!({"type":"result","id":id,"ok":false,"error":"CALL_EXPIRED"}),lease)).await;return;}
                                let result_id=id.clone();
                                let work_lease=lease.clone();
                                let result=tauri::async_runtime::spawn_blocking(move||host.dispatch_admitted(&work_lease,&calls,&id,&owner,&thread,&action,payload)).await;
                                let reply=match result{Ok(Ok(result))=>json!({"type":"result","id":result_id,"ok":true,"result":result}),Ok(Err(error))=>json!({"type":"result","id":result_id,"ok":false,"error":error.to_string(),"errorCode":error.code}),Err(_)=>json!({"type":"result","id":result_id,"ok":false,"error":"LOCAL_EXECUTION_JOIN_FAILED"})};
                                let _=events.send((reply,lease)).await;
                            });
                        },
                        _=>return Err("Unsupported server message".into()),
                    }
                }else if message.is_close(){return Ok(());}
            }
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_computer_name_tests {
    use super::parse_pretty_hostname;

    #[test]
    fn reads_unquoted_pretty_hostname() {
        let machine_info = "CHASSIS=vm\nPRETTY_HOSTNAME=Dev Box\n";
        assert_eq!(
            parse_pretty_hostname(machine_info),
            Some("Dev Box".to_owned())
        );
    }

    #[test]
    fn strips_double_quotes() {
        let machine_info = "PRETTY_HOSTNAME=\"Dev Box\"\n";
        assert_eq!(
            parse_pretty_hostname(machine_info),
            Some("Dev Box".to_owned())
        );
    }

    #[test]
    fn strips_single_quotes() {
        let machine_info = "PRETTY_HOSTNAME='Dev Box'\n";
        assert_eq!(
            parse_pretty_hostname(machine_info),
            Some("Dev Box".to_owned())
        );
    }

    #[test]
    fn missing_key_is_none() {
        let machine_info = "CHASSIS=vm\nDEPLOYMENT=production\n";
        assert_eq!(parse_pretty_hostname(machine_info), None);
    }

    #[test]
    fn empty_value_is_none() {
        let machine_info = "PRETTY_HOSTNAME=\n";
        assert_eq!(parse_pretty_hostname(machine_info), None);
    }

    #[test]
    fn empty_quoted_value_is_none() {
        let machine_info = "PRETTY_HOSTNAME=\"\"\n";
        assert_eq!(parse_pretty_hostname(machine_info), None);
    }

    #[test]
    fn whitespace_only_value_is_none() {
        let machine_info = "PRETTY_HOSTNAME=   \n";
        assert_eq!(parse_pretty_hostname(machine_info), None);
    }

    #[test]
    fn empty_file_is_none() {
        assert_eq!(parse_pretty_hostname(""), None);
    }
}

#[cfg(test)]
mod network_decision_tests {
    use super::resolve_network_decision;
    use serde_json::json;
    use sourceweft_desktop::local_host::network::{AskEvent, Decision, NetworkBridge, OutboundLease};
    use std::{sync::Arc, time::Duration};

    fn pending_ask(bridge: &NetworkBridge) -> (OutboundLease, String, std::thread::JoinHandle<Decision>) {
        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
        let lease = bridge.attach(sender);
        let active = bridge.begin("inv", Arc::default());
        active.set_command_id("c");
        let waiting = {
            let bridge = bridge.clone();
            std::thread::spawn(move || {
                let _active = active;
                bridge.decide(&AskEvent {
                    ask_id: "a".into(),
                    command_id: "c".into(),
                    host: "example.com".into(),
                    port: 443,
                    suggested_by: None,
                    kind: None,
                    method: None,
                    path: None,
                })
            })
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let frame = loop {
            if let Ok(frame) = frames.try_recv() {
                break frame;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        };
        (lease, frame["askId"].as_str().unwrap().to_string(), waiting)
    }

    #[test]
    fn an_explicit_allow_resolves_the_ask() {
        let bridge = NetworkBridge::default();
        let (lease, ask_id, waiting) = pending_ask(&bridge);
        resolve_network_decision(&lease, &json!({"type":"network.decision","askId":ask_id,"allow":true})).unwrap();
        assert!(waiting.join().unwrap().allow);
    }

    #[test]
    fn anything_but_a_boolean_true_denies_and_carries_the_reason() {
        for allow in [json!(false), json!("true"), json!(1), json!(null)] {
            let bridge = NetworkBridge::default();
            let (lease, ask_id, waiting) = pending_ask(&bridge);
            resolve_network_decision(
                &lease,
                &json!({"type":"network.decision","askId":ask_id,"allow":allow,"reason":"expired"}),
            )
            .unwrap();
            let decision = waiting.join().unwrap();
            assert!(!decision.allow);
            assert_eq!(decision.reason.as_deref(), Some("expired"));
        }
    }

    #[test]
    fn a_decision_without_an_ask_id_is_an_error_and_unknown_or_repeated_ones_are_ignored() {
        let bridge = NetworkBridge::default();
        let (sender, _frames) = tokio::sync::mpsc::unbounded_channel();
        let lease = bridge.attach(sender);
        assert!(resolve_network_decision(&lease, &json!({"type":"network.decision","allow":true})).is_err());
        assert!(resolve_network_decision(&lease, &json!({"askId":"nobody","allow":true})).is_ok());
        let (lease, ask_id, waiting) = pending_ask(&bridge);
        let frame = json!({"askId":ask_id,"allow":true});
        resolve_network_decision(&lease, &frame).unwrap();
        // The backend delivers at least once: the repeat is a harmless no-op.
        resolve_network_decision(&lease, &json!({"askId":ask_id,"allow":false})).unwrap();
        assert!(waiting.join().unwrap().allow);
    }
}
