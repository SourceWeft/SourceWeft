//! Narrow discovery bridge for the existing Web UI. No separate native pages.
//! Workspace/file operations stay internal until authenticated dispatch is wired.
use serde::Serialize;
use sourceweft_desktop::local_host::{bundle_install::RuntimeInfo, readiness::SandboxReadiness};
use tauri::{AppHandle, Manager, WebviewWindow};

/// What a local command reports when no local host is managed: the platform has no local
/// execution, or (Linux, Windows) the host's storage could not be opened at startup, which the
/// desktop app logs to its standard error stream.
const LOCAL_EXECUTION_UNAVAILABLE: &str = "UNSUPPORTED_PLATFORM: Local execution is unavailable: it requires macOS, Linux or Windows and a usable local host storage.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHostStatus {
    protocol_version: u32,
    platform_supported: bool,
    storage_initialized: bool,
    authenticated_dispatch_available: bool,
    device_id: Option<String>,
    connected: bool,
    connection_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    readiness: Option<SandboxReadiness>,
    /// The installed sandbox runtime next to this app's version, so the Web UI can refresh a
    /// runtime that predates the app. Absent when no local host is managed; older builds never
    /// send it.
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<RuntimeInfo>,
}

#[tauri::command]
pub async fn authenticate_local_host(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = app
        .try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM")?;
    let _lease = host.host.admission.enter().map_err(str::to_owned)?;
    host.authenticate(ticket, user_id).await
}

/// Async, so Tauri runs it on its async runtime instead of the main thread: on macOS, Linux and Windows,
/// the first call (and every recheck while setup is needed) starts a sidecar, round-trips
/// `init` + `probe` through the OS sandbox and spawns a login shell, which would otherwise stall
/// the UI for seconds. The probing itself is blocking I/O, so it runs on the blocking pool rather
/// than an async worker.
#[tauri::command]
pub async fn local_host_status(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<LocalHostStatus, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let remote = app
        .try_state::<crate::remote_host::RemoteHost>()
        .map(|host| host.status())
        .unwrap_or_default();
    let host = app
        .try_state::<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>>()
        .map(|host| host.inner().clone());
    let storage_initialized = host.is_some();
    // macOS, Linux and Windows are supported only once a readiness probe on the managed
    // LocalHost reports something other than Unsupported; every other platform is unsupported.
    let (readiness, runtime) = match host {
        Some(host) => {
            let (readiness, runtime) = tauri::async_runtime::spawn_blocking(move || {
                (host.sandbox_readiness(), host.sandbox_runtime_info())
            })
            .await
            .map_err(|error| format!("Sandbox readiness check failed: {error}"))?;
            (Some(readiness), Some(runtime))
        }
        None => (None, None),
    };
    let platform_supported =
        matches!(readiness, Some(ref r) if !matches!(r, SandboxReadiness::Unsupported));
    Ok(LocalHostStatus {
        protocol_version: 2,
        platform_supported,
        storage_initialized,
        authenticated_dispatch_available: remote.connected,
        device_id: remote.device_id,
        connected: remote.connected,
        connection_error: remote.error,
        readiness,
        runtime,
    })
}

/// Linux (AppImage): runs the one-time privileged sandbox setup through `pkexec`, which shows
/// the system authentication dialog; the app never sees a password. Windows: stages the sandbox
/// helper under Program Files and installs the sandbox account and network rules through one
/// elevated PowerShell, behind Windows' own UAC prompt (a dismissed prompt is the error
/// `Authorization was cancelled or denied.`). The script is a constant embedded in the app,
/// nothing from the caller reaches it. Cached readiness is invalidated afterwards, whatever the
/// outcome, so the next status poll probes again. macOS has no such setup.
#[tauri::command]
pub async fn run_sandbox_privileged_setup(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    #[cfg(target_os = "linux")]
    {
        let host = app
            .try_state::<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>>()
            .map(|host| host.inner().clone())
            .ok_or("UNSUPPORTED_PLATFORM")?;
        let result = tauri::async_runtime::spawn_blocking(
            sourceweft_desktop::local_host::privileged_setup::run_privileged_setup,
        )
        .await
        .map_err(|error| format!("Sandbox setup failed: {error}"))?;
        host.invalidate_sandbox_readiness();
        result
    }
    #[cfg(windows)]
    {
        let host = app
            .try_state::<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>>()
            .map(|host| host.inner().clone())
            .ok_or("UNSUPPORTED_PLATFORM")?;
        // The elevated setup blocks until the user answers the UAC prompt and the script
        // finishes; it runs on the blocking pool and invalidates readiness itself.
        tauri::async_runtime::spawn_blocking(move || host.run_elevated_setup())
            .await
            .map_err(|error| format!("Sandbox setup failed: {error}"))?
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    Err("UNSUPPORTED_PLATFORM".to_string())
}

/// Downloads, verifies and installs the sandbox runtime for this app version. The web UI calls
/// it without a click when the signed-in app opens and the runtime is missing, out of date or
/// damaged, and again when the user retries. Holds an admission lease like the
/// other local commands, so a pending app update waits for it. Returns the readiness after the
/// install. Errors are strings starting with a stable code (`SANDBOX_DOWNLOAD_FAILED`,
/// `SANDBOX_SIGNATURE_INVALID`, `SANDBOX_BUNDLE_INVALID`, `SANDBOX_UNVERIFIABLE_BUILD`,
/// `SANDBOX_PLATFORM_UNSUPPORTED`, ...) followed by the reason.
#[tauri::command]
pub async fn install_sandbox_runtime(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<SandboxReadiness, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = app
        .try_state::<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>>()
        .map(|host| host.inner().clone())
        .ok_or("UNSUPPORTED_PLATFORM")?;
    let _lease = host.admission.enter().map_err(str::to_owned)?;
    #[cfg(any(unix, windows))]
    {
        // Blocking work (download, hashing, a sidecar probe), on the blocking pool; the HTTP
        // client is created there too.
        tauri::async_runtime::spawn_blocking(move || host.install_sandbox_runtime())
            .await
            .map_err(|error| format!("SANDBOX_INSTALL_FAILED: {error}"))?
            .map_err(|error| error.to_string())
    }
    #[cfg(not(any(unix, windows)))]
    Err("SANDBOX_PLATFORM_UNSUPPORTED: No sandbox runtime is published for this platform.".to_string())
}

#[tauri::command]
pub async fn enable_local_host(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
) -> Result<crate::remote_host::RemoteStatus, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = app
        .try_state::<crate::remote_host::RemoteHost>()
        .ok_or(LOCAL_EXECUTION_UNAVAILABLE)?;
    let _lease = host.host.admission.enter().map_err(str::to_owned)?;
    host.enroll(ticket).await
}

#[tauri::command]
pub fn disconnect_local_host(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    app.try_state::<crate::remote_host::RemoteHost>()
        .ok_or(LOCAL_EXECUTION_UNAVAILABLE)?
        .disconnect();
    Ok(())
}

#[tauri::command]
pub async fn choose_local_folder(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = app
        .try_state::<crate::remote_host::RemoteHost>()
        .ok_or("UNSUPPORTED_PLATFORM")?;
    let _lease = host.host.admission.enter().map_err(str::to_owned)?;
    host.choose_folder(&app, ticket, user_id).await
}

/// Compatibility entry point; all folder selection uses account-bound authorization.
#[tauri::command]
pub async fn choose_working_directory(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    user_id: String,
) -> Result<serde_json::Value, String> {
    choose_local_folder(app, window, ticket, user_id).await
}

fn local_host(app: &AppHandle) -> Result<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>, String> {
    app.try_state::<std::sync::Arc<sourceweft_desktop::local_host::LocalHost>>()
        .map(|host| host.inner().clone())
        .ok_or_else(|| LOCAL_EXECUTION_UNAVAILABLE.to_string())
}

/// Where new automatic task folders are created on this computer.
#[tauri::command]
pub async fn get_task_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<sourceweft_desktop::local_host::TaskFolder, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    local_host(&app)?.task_folder().map_err(|e| e.to_string())
}

/// Opens the native folder dialog and makes the chosen directory the place new automatic task
/// folders are created in. The page supplies no path: the choice comes from the dialog alone.
/// Existing conversations keep their folder.
#[tauri::command]
pub async fn choose_task_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<sourceweft_desktop::local_host::TaskFolder, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = local_host(&app)?;
    let _lease = host.admission.enter().map_err(str::to_owned)?;
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    {
        use crate::remote_host::{pick_folder, picked_folder, FolderPurpose};
        let picked = pick_folder(&app, FolderPurpose::TaskFolderLocation).await?;
        let folder = picked_folder(&picked)?;
        host.set_task_folder(&folder).map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    Err(LOCAL_EXECUTION_UNAVAILABLE.to_string())
}

/// Returns to the default task folder location. Existing conversations keep their folder.
#[tauri::command]
pub async fn reset_task_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<sourceweft_desktop::local_host::TaskFolder, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = local_host(&app)?;
    let _lease = host.admission.enter().map_err(str::to_owned)?;
    host.reset_task_folder().map_err(|e| e.to_string())
}

/// Shows a directory in the system file manager. Only a directory this host works in (the task
/// folder location, a conversation's working directory, a directory granted through the native
/// dialog) is accepted, so the page cannot open arbitrary locations.
#[tauri::command]
pub async fn reveal_local_directory(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<(), String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    let host = local_host(&app)?;
    #[cfg(windows)]
    let directory = sourceweft_desktop::local_host::winpath::from_wire(&path)
        .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let directory = std::path::PathBuf::from(&path);
    if !host
        .is_known_directory(&directory)
        .map_err(|e| e.to_string())?
    {
        return Err("DIRECTORY_DENIED: Only a working directory of this app can be shown.".into());
    }
    let is_directory = directory
        .symlink_metadata()
        .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink());
    if !is_directory {
        return Err("WORKSPACE_MISSING: The directory does not exist yet or was replaced.".into());
    }
    tauri_plugin_opener::open_path(directory, None::<&str>).map_err(|error| error.to_string())
}
