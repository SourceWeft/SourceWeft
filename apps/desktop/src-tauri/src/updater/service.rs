use super::{
    network::{self, Failure, Journal, Operation, Policy},
    policy::{self, Channel, Result},
    preferences::Preferences,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const EVENT: &str = "sourceweft:update";
pub const SAVE_EVENT: &str = "sourceweft:update-save";
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub protocol_version: u32,
    pub revision: u64,
    pub current_version: String,
    pub status: String,
    pub preferences: Option<Preferences>,
    pub candidate_id: Option<String>,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub last_checked: Option<u64>,
    pub error: Option<String>,
    pub operation_id: Option<String>,
}
struct Candidate {
    id: String,
    identity: String,
    update: Update,
    bytes: Option<Vec<u8>>,
}
struct Inner {
    view: Snapshot,
    candidate: Option<Candidate>,
    save: Option<tokio::sync::oneshot::Sender<Result<()>>>,
}
pub struct Service {
    inner: Mutex<Inner>,
    preferences_path: PathBuf,
    journal: Journal,
    pub gate: Arc<tokio::sync::Mutex<()>>,
    pub cancel: AtomicBool,
    pub automatic_download: AtomicBool,
}
impl Service {
    fn record(&self) {
        let view = self.snapshot();
        let error_code = view
            .error
            .as_deref()
            .and_then(|e| e.split(':').next())
            .filter(|code| {
                code.len() <= 80
                    && code
                        .bytes()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
            });
        let record = json!({"time":now(),"event":"desktop_update","status":view.status,
            "currentVersion":view.current_version,"targetVersion":view.version,
            "channel":view.preferences.as_ref().map(|p|p.channel),"errorCode":error_code});
        self.journal.write(record);
    }

    pub fn snapshot(&self) -> Snapshot {
        self.inner.lock().expect("update state").view.clone()
    }
    fn change(&self, app: &AppHandle, f: impl FnOnce(&mut Inner)) {
        let value = {
            let mut inner = self.inner.lock().expect("update state");
            f(&mut inner);
            inner.view.revision += 1;
            inner.view.clone()
        };
        if let Some(window) = app.get_webview_window("main") {
            if crate::authorize_desktop_window(app, &window, true).is_ok() {
                let _ = window.emit(EVENT, value);
            }
        }
    }
    fn status(&self, app: &AppHandle, status: &str) {
        self.change(app, |i| {
            i.view.status = status.into();
            i.view.error = None;
        });
        self.record();
    }
    pub fn fail(&self, app: &AppHandle, error: String) {
        self.automatic_download.store(false, Ordering::SeqCst);
        self.change(app, |i| {
            i.view.status = match error.as_str() {
                "DISTRIBUTION_PAUSED" => "distributionPaused",
                "UPDATE_WITHDRAWN" => "withdrawn",
                "UPDATE_CHANNEL_UNAVAILABLE" => "channelUnavailable",
                _ => "failed",
            }
            .into();
            i.view.error = Some(error);
            i.view.operation_id = None;
            i.save = None;
            if let Some(c) = i.candidate.as_mut() {
                c.bytes = None;
            }
        });
        self.record();
    }
    fn preferences(&self) -> Result<Preferences> {
        self.snapshot()
            .preferences
            .ok_or("UPDATE_PREFERENCES_UNAVAILABLE".into())
    }
    pub fn set_preferences(
        &self,
        app: &AppHandle,
        channel: Channel,
        auto_check: bool,
        auto_download: bool,
    ) -> Result<()> {
        let guard = self.gate.clone().try_lock_owned();
        if guard.is_err() {
            let state = self.snapshot();
            let old = self.preferences()?;
            if state.status != "downloading" || old.channel != channel {
                return Err("UPDATE_BUSY".into());
            }
        }
        let mut inner = self.inner.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
        let mut next = inner
            .view
            .preferences
            .clone()
            .ok_or("UPDATE_PREFERENCES_UNAVAILABLE")?;
        let changed_channel = channel != next.channel;
        next.channel = channel;
        next.auto_check = auto_check;
        next.auto_download = auto_download;
        if changed_channel {
            next.snoozed_candidate = None;
            next.snoozed_until = 0;
        }
        next.save(&self.preferences_path)?;
        inner.view.preferences = Some(next);
        if changed_channel {
            inner.candidate = None;
            inner.view.candidate_id = None;
            inner.view.version = None;
            inner.view.notes = None;
            inner.view.status = "idle".into();
        }
        if !auto_download && self.automatic_download.load(Ordering::SeqCst) {
            self.cancel.store(true, Ordering::SeqCst);
        }
        drop(inner);
        self.change(app, |_| {});
        Ok(())
    }
    pub fn snooze(&self, app: &AppHandle, id: &str) -> Result<()> {
        let mut i = self.inner.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
        let candidate = i
            .candidate
            .as_ref()
            .filter(|c| c.id == id)
            .ok_or("UPDATE_CANDIDATE_EXPIRED")?;
        let identity = candidate.identity.clone();
        let mut prefs = i
            .view
            .preferences
            .clone()
            .ok_or("UPDATE_PREFERENCES_UNAVAILABLE")?;
        prefs.snoozed_candidate = Some(identity);
        prefs.snoozed_until = now() + 86400;
        prefs.save(&self.preferences_path)?;
        i.view.preferences = Some(prefs);
        drop(i);
        self.change(app, |_| {});
        Ok(())
    }
    pub fn cancel_operation(&self, app: &AppHandle, id: &str) -> Result<()> {
        let inner = self.inner.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
        let state = inner.view.clone();
        if state.operation_id.as_deref() != Some(id)
            || !matches!(
                state.status.as_str(),
                "downloading" | "verifying" | "preparing" | "waitingForIdle"
            )
        {
            return Err("UPDATE_NOT_CANCELLABLE".into());
        }
        // Serialize accepted cancellation with the final install/download commit.
        self.cancel.store(true, Ordering::SeqCst);
        drop(inner);
        if matches!(state.status.as_str(), "downloading" | "verifying") {
            if let Some(candidate) = state.candidate_id {
                self.snooze(app, &candidate)?;
            }
        }
        Ok(())
    }
    pub fn acknowledge_save(&self, id: &str, error: Option<String>) -> Result<()> {
        let mut i = self.inner.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
        if i.view.operation_id.as_deref() != Some(id) {
            return Err("UPDATE_OPERATION_EXPIRED".into());
        }
        let sender = i.save.take().ok_or("UPDATE_SAVE_NOT_PENDING")?;
        sender
            .send(error.map_or(Ok(()), |e| Err(format!("UPDATE_SAVE_FAILED: {e}"))))
            .map_err(|_| "UPDATE_OPERATION_EXPIRED".into())
    }
    async fn metadata(
        &self,
        operation: &Operation,
        cancellable: bool,
    ) -> std::result::Result<Value, Failure> {
        let channel = self.preferences().map_err(Failure::terminal)?.channel;
        network::run(
            &self.journal,
            operation,
            "metadata",
            Policy::METADATA,
            cancellable.then_some(&self.cancel),
            |_| async {
                let client = reqwest::Client::builder()
                    .https_only(true)
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never())
                    .timeout(network::REQUEST_TIMEOUT)
                    .build()
                    .map_err(Failure::reqwest)?;
                let value = network::manifest(&client, &channel.endpoint()).await?;
                policy::validate(&value, channel).map_err(Failure::terminal)?;
                policy::active(&value).map_err(Failure::terminal)?;
                Ok(value)
            },
        )
        .await
    }
    async fn revalidate(
        &self,
        expected: &str,
        operation: &Operation,
        cancellable: bool,
    ) -> std::result::Result<(), Failure> {
        // Bound each control check as well as the encompassing download/install.
        let control = Operation {
            id: operation.id.clone(),
            deadline: operation
                .deadline
                .min(tokio::time::Instant::now() + network::CHECK_BUDGET),
        };
        let value = self.metadata(&control, cancellable).await?;
        policy::require_identity(
            &value,
            self.preferences().map_err(Failure::terminal)?.channel,
            policy::target().map_err(Failure::terminal)?,
            expected,
        )
        .map_err(Failure::terminal)
    }

    pub async fn check(&self, app: &AppHandle) -> Result<()> {
        if cfg!(debug_assertions) {
            return Err("UPDATE_DISABLED_IN_DEVELOPMENT".into());
        }
        let key = option_env!("SOURCEWEFT_UPDATER_PUBLIC_KEY")
            .filter(|s| !s.is_empty())
            .ok_or("UPDATE_PUBLIC_KEY_NOT_CONFIGURED")?;
        self.status(app, "checking");
        let operation = Operation::new(network::CHECK_BUDGET);
        let value = self
            .metadata(&operation, false)
            .await
            .map_err(|e| e.message())?;
        let mut prefs = self.preferences()?;
        let version = policy::validate(&value, prefs.channel)?;
        self.change(app, |i| i.view.last_checked = Some(now()));
        if version <= app.package_info().version {
            self.change(app, |i| {
                i.candidate = None;
                i.view.candidate_id = None;
                i.view.version = None;
            });
            self.status(
                app,
                if prefs.channel == Channel::Stable && !app.package_info().version.pre.is_empty() {
                    "waitingForStable"
                } else {
                    "upToDate"
                },
            );
            return Ok(());
        }
        let target = policy::target()?;
        let identity = policy::identity(&value, prefs.channel, target);
        if prefs
            .snoozed_candidate
            .as_ref()
            .is_some_and(|previous| previous != &identity)
        {
            prefs.snoozed_candidate = None;
            prefs.snoozed_until = 0;
            prefs.save(&self.preferences_path)?;
            self.change(app, |i| i.view.preferences = Some(prefs.clone()));
        }
        let existing = {
            let i = self.inner.lock().expect("update state");
            i.candidate
                .as_ref()
                .filter(|c| c.identity == identity)
                .map(|c| c.bytes.is_some())
        };
        if let Some(ready) = existing {
            self.status(app, if ready { "ready" } else { "available" });
        } else {
            let updater = app
                .updater_builder()
                .pubkey(key)
                .target(target)
                .endpoints(vec![prefs
                    .channel
                    .endpoint()
                    .parse()
                    .map_err(|e: url::ParseError| e.to_string())?])
                .map_err(|e| e.to_string())?
                .timeout(Duration::from_secs(15))
                .header("Cache-Control", "no-cache")
                .map_err(|e| e.to_string())?
                .configure_client(|client| {
                    client
                        .https_only(true)
                        .retry(updater_http::retry::never())
                        .redirect(updater_http::redirect::Policy::none())
                        .read_timeout(Duration::from_secs(60))
                })
                .build()
                .map_err(|_| "UPDATE_CLIENT_BUILD_FAILED")?;
            let update = network::run(
                &self.journal,
                &operation,
                "plugin_check",
                Policy::METADATA,
                None,
                |_| async { updater.check().await.map_err(Failure::plugin) },
            )
            .await
            .map_err(|e| e.message())?
            .ok_or("UPDATE_CANDIDATE_EXPIRED")?;
            policy::validate(&update.raw_json, prefs.channel)?;
            policy::active(&update.raw_json)?;
            if policy::identity(&update.raw_json, prefs.channel, target) != identity {
                return Err("UPDATE_CANDIDATE_EXPIRED".into());
            }
            let id = uuid::Uuid::new_v4().to_string();
            self.change(app, |i| {
                i.view.candidate_id = Some(id.clone());
                i.view.version = Some(update.version.clone());
                i.view.notes = update.body.clone();
                i.view.downloaded_bytes = 0;
                i.view.total_bytes = None;
                i.candidate = Some(Candidate {
                    id,
                    identity: identity.clone(),
                    update,
                    bytes: None,
                });
            });
            self.status(app, "available");
        }
        if self.snapshot().status == "available"
            && prefs.auto_download
            && !(prefs.snoozed_candidate.as_deref() == Some(&identity)
                && prefs.snoozed_until > now())
        {
            let id = self
                .snapshot()
                .candidate_id
                .ok_or("UPDATE_CANDIDATE_EXPIRED")?;
            self.download(app, &id, true).await?;
        }
        Ok(())
    }
    pub async fn download(&self, app: &AppHandle, id: &str, automatic: bool) -> Result<()> {
        let (mut update, identity) = {
            let i = self.inner.lock().expect("update state");
            let c = i
                .candidate
                .as_ref()
                .filter(|c| c.id == id)
                .ok_or("UPDATE_CANDIDATE_EXPIRED")?;
            (c.update.clone(), c.identity.clone())
        };
        if !automatic {
            let mut i = self.inner.lock().map_err(|_| "UPDATE_STATE_UNAVAILABLE")?;
            let mut prefs = i
                .view
                .preferences
                .clone()
                .ok_or("UPDATE_PREFERENCES_UNAVAILABLE")?;
            prefs.snoozed_candidate = None;
            prefs.snoozed_until = 0;
            prefs.save(&self.preferences_path)?;
            i.view.preferences = Some(prefs);
        }
        let operation = Operation::new(network::DOWNLOAD_BUDGET);
        self.cancel.store(false, Ordering::SeqCst);
        self.automatic_download.store(automatic, Ordering::SeqCst);
        self.change(app, |i| {
            i.view.operation_id = Some(operation.id.clone());
            i.view.downloaded_bytes = 0;
            i.view.total_bytes = None;
        });
        self.status(app, "downloading");
        update.timeout = Some(network::DOWNLOAD_BUDGET);
        let result = network::run(&self.journal, &operation, "package", Policy::DOWNLOAD, Some(&self.cancel), |_| async {
            // A retry always starts with a fresh policy check and a fresh buffer.
            // Do not multiply the three-attempt metadata policy with package retries.
            self.revalidate(&identity, &operation, true).await.map_err(|mut e| { e.retryable = false; e })?;
            self.change(app, |i| { i.view.downloaded_bytes = 0; i.view.total_bytes = None; });
            self.status(app, "downloading");
            let over_limit = AtomicBool::new(false);
            let mut last_event = Instant::now();
            let mut received = 0u64;
            let future = update.download(
                |size, total| {
                    received = received.saturating_add(size as u64);
                    if received > policy::MAX_BYTES || total.is_some_and(|v| v > policy::MAX_BYTES) {
                        over_limit.store(true, Ordering::SeqCst);
                    }
                    if last_event.elapsed() >= Duration::from_millis(200) {
                        self.change(app, |i| { i.view.downloaded_bytes = received; i.view.total_bytes = total; });
                        last_event = Instant::now();
                    }
                },
                || self.status(app, "verifying"),
            );
            tokio::pin!(future);
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            let mut last_control = Instant::now();
            let bytes = loop {
                tokio::select! {
                    result = &mut future => break result.map_err(Failure::plugin)?,
                    _ = tick.tick() => {
                        if over_limit.load(Ordering::SeqCst) { return Err(Failure::terminal("UPDATE_PACKAGE_TOO_LARGE")); }
                        if last_control.elapsed() >= Duration::from_secs(60) {
                            self.revalidate(&identity, &operation, true).await.map_err(|mut e| { e.retryable = false; e })?;
                            last_control = Instant::now();
                        }
                    }
                }
            };
            if bytes.len() as u64 > policy::MAX_BYTES { return Err(Failure::terminal("UPDATE_PACKAGE_TOO_LARGE")); }
            self.revalidate(&identity, &operation, true).await.map_err(|mut e| { e.retryable = false; e })?;
            Ok(bytes)
        }).await;
        self.automatic_download.store(false, Ordering::SeqCst);
        let bytes = match result {
            Err(e) if e.cancelled() => {
                self.status(app, "available");
                self.change(app, |i| i.view.operation_id = None);
                return Ok(());
            }
            Err(e) => return Err(e.message()),
            Ok(bytes) => bytes,
        };
        self.change(app, |i| {
            i.view.operation_id = None;
            if self.cancel.load(Ordering::SeqCst) {
                i.view.status = "available".into();
            } else {
                i.view.downloaded_bytes = bytes.len() as u64;
                if let Some(c) = i.candidate.as_mut() {
                    c.bytes = Some(bytes);
                }
                i.view.status = "ready".into();
            }
            i.view.error = None;
        });
        self.record();
        Ok(())
    }
    pub async fn install(&self, app: &AppHandle, id: &str) -> Result<()> {
        let identity = {
            let i = self.inner.lock().expect("update state");
            i.candidate
                .as_ref()
                .filter(|c| c.id == id && c.bytes.is_some())
                .ok_or("UPDATE_NOT_READY")?
                .identity
                .clone()
        };
        self.revalidate(&identity, &Operation::new(network::CHECK_BUDGET), false)
            .await
            .map_err(|e| e.message())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(format!(
                "Install SourceWeft {} and restart? Your work will be saved first.",
                self.snapshot().version.unwrap_or_default()
            ))
            .title("Software update")
            .buttons(MessageDialogButtons::OkCancel)
            .show(move |yes| {
                let _ = tx.send(yes);
            });
        if !rx.await.map_err(|_| "UPDATE_CONFIRMATION_CLOSED")? {
            return Ok(());
        }
        self.cancel.store(false, Ordering::SeqCst);
        let operation = uuid::Uuid::new_v4().to_string();
        self.change(app, |i| i.view.operation_id = Some(operation.clone()));
        self.status(app, "preparing");
        let host = app.try_state::<Arc<sourceweft_desktop::local_host::LocalHost>>();
        let _maintenance = host
            .as_ref()
            .map(|h| h.admission.drain())
            .transpose()
            .map_err(str::to_owned)?;
        let window = app
            .get_webview_window("main")
            .ok_or("UPDATE_MAIN_WINDOW_MISSING")?;
        let url = window.url().map_err(|e| e.to_string())?;
        if url.path().starts_with("/dashboard") {
            crate::authorize_desktop_window(app, &window, true)?;
            let (tx, rx) = tokio::sync::oneshot::channel();
            self.inner.lock().expect("update state").save = Some(tx);
            window
                .emit(SAVE_EVENT, json!({"operationId":operation}))
                .map_err(|e| e.to_string())?;
            let waiting = tokio::time::timeout(Duration::from_secs(10), rx);
            tokio::pin!(waiting);
            loop {
                tokio::select! {
                    result = &mut waiting => { result.map_err(|_| "UPDATE_SAVE_TIMEOUT")?.map_err(|_| "UPDATE_SAVE_UNAVAILABLE")??; break; }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if self.cancel.load(Ordering::SeqCst) {
                            self.change(app, |i| { i.save = None; i.view.operation_id = None; });
                            self.status(app, "ready"); return Ok(());
                        }
                    }
                }
            }
        } else if !crate::native_access::is_allowed_auth_url(
            &url,
            &crate::resolve_app_url(app, "/dashboard")?,
        ) {
            return Err("UPDATE_SAVE_STATE_UNKNOWN".into());
        }
        self.status(app, "waitingForIdle");
        let started = Instant::now();
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                self.status(app, "ready");
                self.change(app, |i| i.view.operation_id = None);
                return Ok(());
            }
            if _maintenance.as_ref().is_none_or(|guard| guard.idle()) {
                break;
            }
            if started.elapsed() >= Duration::from_secs(600) {
                return Err("UPDATE_LOCAL_TASKS_TIMEOUT".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if let Err(e) = self
            .revalidate(&identity, &Operation::new(network::CHECK_BUDGET), true)
            .await
        {
            if !e.cancelled() {
                return Err(e.message());
            }
        }
        if self.cancel.load(Ordering::SeqCst) {
            self.change(app, |i| i.view.operation_id = None);
            self.status(app, "ready");
            return Ok(());
        }
        let (update, bytes) = {
            let mut i = self.inner.lock().expect("update state");
            if self.cancel.load(Ordering::SeqCst) {
                i.view.status = "ready".into();
                i.view.operation_id = None;
                drop(i);
                self.change(app, |_| {});
                return Ok(());
            }
            let mut prefs = i
                .view
                .preferences
                .clone()
                .ok_or("UPDATE_PREFERENCES_UNAVAILABLE")?;
            prefs.expected_version = i.view.version.clone();
            prefs.save(&self.preferences_path)?;
            i.view.preferences = Some(prefs);
            let candidate = i.candidate.as_mut().ok_or("UPDATE_CANDIDATE_EXPIRED")?;
            let ready = (
                candidate.update.clone(),
                candidate.bytes.take().ok_or("UPDATE_NOT_READY")?,
            );
            i.view.status = "installing".into();
            i.view.error = None;
            ready
        };
        self.change(app, |_| {});
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("UPDATE_INSTALL: {e}"))?;
        app.restart();
    }
}

pub fn setup(app: &AppHandle) -> Result<()> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("updater-preferences.json");
    let loaded = Preferences::load(&path, &app.package_info().version);
    let (mut prefs, mut error) = match loaded {
        Ok(p) => (Some(p), None),
        Err(e) => (None, Some(e)),
    };
    if let Some(expected) = prefs.as_ref().and_then(|p| p.expected_version.as_ref()) {
        if expected != &app.package_info().version.to_string() {
            error = Some(format!("UPDATE_NOT_APPLIED: expected {expected}"));
        } else if let Some(p) = prefs.as_mut() {
            p.expected_version = None;
            if let Err(e) = p.save(&path) {
                error = Some(e);
            }
        }
    }
    let service = Arc::new(Service {
        inner: Mutex::new(Inner {
            view: Snapshot {
                protocol_version: 1,
                revision: 0,
                current_version: app.package_info().version.to_string(),
                status: if error.is_some() { "failed" } else { "idle" }.into(),
                preferences: prefs,
                candidate_id: None,
                version: None,
                notes: None,
                downloaded_bytes: 0,
                total_bytes: None,
                last_checked: None,
                error,
                operation_id: None,
            },
            candidate: None,
            save: None,
        }),
        journal: Journal::new(path.with_file_name("updater.log")),
        preferences_path: path,
        gate: Arc::new(tokio::sync::Mutex::new(())),
        cancel: AtomicBool::new(false),
        automatic_download: AtomicBool::new(false),
    });
    app.manage(service.clone());
    if !cfg!(debug_assertions) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]);
            tokio::time::sleep(Duration::from_secs(30 + jitter % 31)).await;
            loop {
                if service.preferences().is_ok_and(|p| p.auto_check) {
                    if let Ok(_guard) = service.gate.clone().try_lock_owned() {
                        if let Err(e) = service.check(&app).await {
                            service.fail(&app, e);
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(21600 + jitter * 3)).await;
            }
        });
    }
    Ok(())
}

pub fn menu(app: &AppHandle) {
    let service = app.state::<Arc<Service>>().inner().clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(_guard) = service.gate.clone().try_lock_owned() else {
            app.dialog()
                .message("An update operation is already running.")
                .show(|_| {});
            return;
        };
        let result = async {
            service.check(&app).await?;
            let state = service.snapshot();
            if state.status == "available" {
                let (tx, rx) = tokio::sync::oneshot::channel();
                app.dialog()
                    .message(format!(
                        "Download SourceWeft {}?",
                        state.version.unwrap_or_default()
                    ))
                    .buttons(MessageDialogButtons::OkCancel)
                    .show(move |yes| {
                        let _ = tx.send(yes);
                    });
                if rx.await.unwrap_or(false) {
                    service
                        .download(
                            &app,
                            state
                                .candidate_id
                                .as_deref()
                                .ok_or("UPDATE_CANDIDATE_EXPIRED")?,
                            false,
                        )
                        .await?;
                }
            }
            let state = service.snapshot();
            if state.status == "ready" {
                service
                    .install(
                        &app,
                        state
                            .candidate_id
                            .as_deref()
                            .ok_or("UPDATE_CANDIDATE_EXPIRED")?,
                    )
                    .await?;
            } else if state.status == "upToDate" {
                app.dialog()
                    .message("SourceWeft is up to date.")
                    .show(|_| {});
            } else if state.status == "waitingForStable" {
                app.dialog().message("Waiting for a newer stable release. Your current preview version will not be downgraded.").show(|_| {});
            }
            Ok::<_, String>(())
        }
        .await;
        if let Err(e) = result {
            service.fail(&app, e.clone());
            app.dialog()
                .message(e)
                .title("Software update")
                .show(|_| {});
        }
    });
}
