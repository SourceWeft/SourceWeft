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

impl RemoteHost {
    #[cfg(target_os = "macos")]
    pub async fn choose_folder(&self, ticket: String, user_id: String) -> Result<Value, String> {
        let owner = user_id.clone();
        let authenticated = self.authenticate(ticket, user_id).await?;
        if authenticated["needsProof"] == true || self.status().user_id.as_deref() != Some(&owner) {
            return Err("Authenticate the current account before choosing a folder".into());
        }
        let folder_generation = self.generation.load(Ordering::SeqCst);
        let bytes = security_framework::passwords::get_generic_password(
            &self.keychain_service,
            &format!(
                "local-device:{}",
                self.status()
                    .user_id
                    .ok_or("Authenticate this account first")?
            ),
        )
        .map_err(|e| e.to_string())?;
        let credential: Credentials =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid device credentials")?;
        if self.status().device_id.as_deref() != Some(&credential.id) {
            return Err("Authenticate this computer before choosing a folder".into());
        }
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
        let path = String::from_utf8(output.stdout).map_err(|_| "Invalid folder path")?;
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
    #[cfg(not(target_os = "macos"))]
    pub async fn choose_folder(&self, _ticket: String, _user_id: String) -> Result<Value, String> {
        Err("UNSUPPORTED_PLATFORM".into())
    }

    #[cfg(target_os = "macos")]
    pub async fn authenticate(&self, ticket: String, user_id: String) -> Result<Value, String> {
        if self.status().device_id.is_some() && self.status().user_id.as_deref() != Some(&user_id) {
            self.disconnect();
        }
        let auth_generation = self.generation.load(Ordering::SeqCst);
        let account = format!("local-device:{user_id}");
        let saved =
            security_framework::passwords::get_generic_password(&self.keychain_service, &account);
        // Adopt only this account's pre-release credential; never another user's.
        let saved = match saved {
            Err(error) if error.code() == -25300 => {
                match security_framework::passwords::get_generic_password(
                    &self.keychain_service,
                    "local-device",
                ) {
                    Ok(bytes) => {
                        let legacy: Credentials = serde_json::from_slice(&bytes)
                            .map_err(|_| "Invalid saved legacy credentials")?;
                        if legacy.user_id == user_id {
                            Ok(bytes)
                        } else {
                            Err(error)
                        }
                    }
                    Err(legacy_error) if legacy_error.code() != -25300 => Err(legacy_error),
                    Err(_) => Err(error),
                }
            }
            other => other,
        };
        let bytes = match saved {
            Ok(bytes) => bytes,
            Err(error) if error.code() == -25300 => {
                self.enroll(ticket).await?;
                return Ok(json!({"needsProof":true}));
            }
            Err(error) => return Err(format!("Keychain access failed: {error}")),
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
            .json(&json!({"ticket":ticket,"workspaceBase":self.host.workspace_base()}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            self.disconnect();
            return Err(format!("Native identity rejected: {}", response.status()));
        }
        let proof: Value = response.json().await.map_err(|e| e.to_string())?;
        security_framework::passwords::set_generic_password(
            &self.keychain_service,
            &format!("local-device:{}", credentials.user_id),
            &bytes,
        )
        .map_err(|e| e.to_string())?;
        if self.generation.load(Ordering::SeqCst) != auth_generation {
            return Err("Local authentication was cancelled".into());
        }
        if self.status().device_id.is_none() {
            self.start(credentials);
        }
        Ok(proof)
    }

    #[cfg(not(target_os = "macos"))]
    pub async fn authenticate(&self, _ticket: String, _user_id: String) -> Result<Value, String> {
        Err("UNSUPPORTED_PLATFORM: Local execution currently requires macOS.".into())
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
    #[cfg(not(target_os = "macos"))]
    pub async fn enroll(&self, _ticket: String) -> Result<RemoteStatus, String> {
        Err("UNSUPPORTED_PLATFORM: Local execution currently requires macOS.".into())
    }

    #[cfg(target_os = "macos")]
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
            .json(&json!({"ticket":ticket,"name":"My Mac"}))
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
        security_framework::passwords::set_generic_password(
            &self.keychain_service,
            &format!("local-device:{}", credential.user_id),
            &serde_json::to_vec(&credential).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Keychain enrollment failed: {e}"))?;
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
    let (events, mut results) = tokio::sync::mpsc::channel::<Value>(32);
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
            Some(result)=results.recv()=>{sender.send(Message::Text(result.to_string().into())).await.map_err(|e|e.to_string())?;},
            incoming=receiver.next()=>{
                let message=incoming.ok_or("Device connection closed")?.map_err(|e|e.to_string())?;
                last_received=tokio::time::Instant::now();
                if let Message::Text(text)=message {
                    let value:Value=serde_json::from_str(&text).map_err(|_|"Invalid server message")?;
                    match value["type"].as_str(){
                        Some("connected")=>{if value["deviceId"]!=credential.id||value["userId"]!=credential.user_id{return Err("Device identity mismatch".into());}if let Ok(mut state)=status.lock(){state.connected=true;state.error=None;}},
                        Some("heartbeat")=>{},
                        Some("cancel")=>{if let Some(id)=value["id"].as_str(){executions.cancel(id);}},
                        Some("call")=>{
                            if value["userId"]!=credential.user_id{return Err("Call owner mismatch".into());}
                            let id=value["id"].as_str().ok_or("Missing invocation ID")?.to_owned();
                            let thread=value["threadId"].as_str().ok_or("Missing conversation")?.to_owned();
                            let action=value["action"].as_str().ok_or("Missing action")?.to_owned();
                            let deadline=value["deadline"].as_u64().ok_or("Missing deadline")?;
                            let payload=value["payload"].clone();
                            let owner=credential.user_id.clone();let host=host.clone();let calls=executions.clone();let events=events.clone();let serial=serial.clone();let stop=stop.clone();let generation=generation.clone();
                            sender.send(Message::Text(json!({"type":"accepted","id":id}).to_string().into())).await.map_err(|e|e.to_string())?;
                            tokio::spawn(async move{
                                let _permit=serial.acquire_owned().await;
                                let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d|d.as_millis() as u64).unwrap_or(u64::MAX);
                                if now>=deadline||stop.load(Ordering::SeqCst)||generation.load(Ordering::SeqCst)!=current||calls.is_cancelled(&id){let _=events.send(json!({"type":"result","id":id,"ok":false,"error":"CALL_EXPIRED"})).await;return;}
                                let result_id=id.clone();
                                let result=tauri::async_runtime::spawn_blocking(move||host.dispatch(&calls,&id,&owner,&thread,&action,payload)).await;
                                let reply=match result{Ok(Ok(result))=>json!({"type":"result","id":result_id,"ok":true,"result":result}),Ok(Err(error))=>json!({"type":"result","id":result_id,"ok":false,"error":error.to_string()}),Err(_)=>json!({"type":"result","id":result_id,"ok":false,"error":"LOCAL_EXECUTION_JOIN_FAILED"})};
                                let _=events.send(reply).await;
                            });
                        },
                        _=>return Err("Unsupported server message".into()),
                    }
                }else if message.is_close(){return Ok(());}
            }
        }
    }
}
