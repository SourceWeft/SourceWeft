"use client";

import {
  getNativeBridge,
  nativeBridge,
  type DeepLinkPayload,
  type NativeEvent,
} from "./native-bridge";

type SourceWeftDesktopBridge = {
  isDesktop: true;
  invoke: <TResult = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<TResult>;
  listen: <TPayload>(
    event: string,
    handler: (event: NativeEvent<TPayload>) => void,
  ) => Promise<() => Promise<void>>;
};

declare global {
  interface Window {
    __SOURCEWEFT_DESKTOP__?: SourceWeftDesktopBridge;
    __SOURCEWEFT_TITLEBAR_OVERLAY__?: boolean;
  }
}

export type DesktopInfo = {
  kind?: "desktop";
  isNative?: boolean;
  isDesktop: boolean;
  platform: string;
  arch: string;
  appName: string;
  appVersion: string;
  tauriVersion: string;
  updaterProtocolVersion?: number;
};

export type AutostartState = {
  enabled: boolean;
  requested: boolean;
  supported: boolean;
  reason?: string | null;
};

/** Native capability discovery only; does not authorize local execution. */
export type LocalHostStatus = {
  protocolVersion: number;
  platformSupported: boolean;
  storageInitialized: boolean;
  authenticatedDispatchAvailable: boolean;
  deviceId: string | null;
  connected: boolean;
  connectionError: string | null;
};

type DesktopListener<TPayload> = (payload: TPayload) => void;

function getBridge() {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (window.__SOURCEWEFT_DESKTOP__) {
    return window.__SOURCEWEFT_DESKTOP__;
  }

  const native = getNativeBridge();
  if (native?.kind !== "desktop") {
    return undefined;
  }

  return {
    isDesktop: true,
    invoke: native.invoke,
    listen: native.listen,
  } satisfies SourceWeftDesktopBridge;
}

async function invokeDesktop<TResult>(
  command: string,
  args?: Record<string, unknown>,
) {
  const bridge = getBridge();
  if (!bridge) {
    throw new Error("SourceWeft desktop bridge is not available.");
  }

  try {
    return await bridge.invoke<TResult>(command, args);
  } catch (error) {
    // Tauri rejects Rust Result errors and IPC denials as strings.
    // Preserve that diagnosis instead of losing it at Error-only UI boundaries.
    if (typeof error === "string") throw new Error(error);
    throw error;
  }
}

async function listenDesktop<TPayload>(
  event: string,
  handler: DesktopListener<TPayload>,
) {
  const bridge = getBridge();
  if (!bridge) {
    return () => Promise.resolve();
  }

  return bridge.listen<TPayload>(event, (message) => handler(message.payload));
}

export const desktopBridge = {
  isAvailable() {
    return Boolean(
      (typeof window !== "undefined" && window.__SOURCEWEFT_DESKTOP__) ||
      nativeBridge.isAvailable("desktop"),
    );
  },
  info() {
    return invokeDesktop<DesktopInfo>("desktop_info");
  },
  titlebarAction(action: "drag" | "toggleMaximize") {
    return invokeDesktop<void>("desktop_titlebar_action", { action });
  },
  chooseLocalFolder(ticket: string, userId: string) {
    return invokeDesktop<{ id: string; name: string }>("choose_local_folder", {
      ticket,
      userId,
    });
  },
  localHostStatus() {
    return invokeDesktop<LocalHostStatus>("local_host_status");
  },
  authenticateLocalHost(ticket: string, userId: string) {
    return invokeDesktop<{
      needsProof?: boolean;
      deviceId?: string;
      proof?: string;
      expiresAt?: string;
      remoteEnabled?: boolean;
    }>("authenticate_local_host", { ticket, userId });
  },
  enableLocalHost(ticket: string) {
    return invokeDesktop<{
      deviceId: string | null;
      connected: boolean;
      error: string | null;
    }>("enable_local_host", { ticket });
  },
  chooseWorkingDirectory(ticket: string, userId: string) {
    return invokeDesktop<{ id: string; path: string; name: string }>(
      "choose_working_directory",
      { ticket, userId },
    );
  },
  disconnectLocalHost() {
    return invokeDesktop<void>("disconnect_local_host");
  },
  showMainWindow() {
    return invokeDesktop<void>("show_main_window");
  },
  getAutostart() {
    return invokeDesktop<AutostartState>("get_autostart");
  },
  setAutostart(enabled: boolean) {
    return invokeDesktop<AutostartState>("set_autostart", {
      input: { enabled },
    });
  },
  openExternalUrl(url: string) {
    return invokeDesktop<void>("open_external_url", { url });
  },
  /** Keeps the system tray's menu text in the locale the dashboard is
   * actually rendering (see `apps/desktop/src-tauri/src/tray_locale.rs`). */
  syncTrayLocale(locale: string) {
    return invokeDesktop<void>("sync_tray_locale", { locale });
  },
  onDeepLink(handler: DesktopListener<DeepLinkPayload>) {
    return listenDesktop("sourceweft:deep-link", handler);
  },
};

export type UpdatePreferences = {
  schemaVersion: number;
  channel: "stable" | "preview";
  autoCheck: boolean;
  autoDownload: boolean;
  snoozedUntil?: number;
};
export type DesktopUpdateState = {
  protocolVersion: number;
  revision: number;
  currentVersion: string;
  status: string;
  preferences: UpdatePreferences | null;
  candidateId: string | null;
  version: string | null;
  notes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  lastChecked: number | null;
  error: string | null;
  operationId: string | null;
};
export const desktopUpdates = {
  state: () => invokeDesktop<DesktopUpdateState>("get_update_state"),
  check: () => invokeDesktop<void>("check_for_updates"),
  download: (candidateId: string) =>
    invokeDesktop<void>("download_update", { candidateId }),
  install: (candidateId: string) =>
    invokeDesktop<void>("install_update", { candidateId }),
  cancelDownload: (operationId: string) =>
    invokeDesktop<void>("cancel_update_download", { operationId }),
  cancelInstall: (operationId: string) =>
    invokeDesktop<void>("cancel_update_install", { operationId }),
  preferences: (
    value: Pick<UpdatePreferences, "channel" | "autoCheck" | "autoDownload">,
  ) => invokeDesktop<void>("set_update_preferences", value),
  snooze: (candidateId: string) =>
    invokeDesktop<void>("snooze_update", { candidateId }),
  saved: (operationId: string, error: string | null) =>
    invokeDesktop<void>("acknowledge_update_save", { operationId, error }),
  onState: (handler: DesktopListener<DesktopUpdateState>) =>
    listenDesktop("sourceweft:update", handler),
  onSave: (handler: DesktopListener<{ operationId: string }>) =>
    listenDesktop("sourceweft:update-save", handler),
};

export async function handleDesktopAuthDeepLink(input: {
  url: string;
  onSuccess?: () => void;
  onError?: (message: string) => void;
}) {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return false;
  }

  if (
    parsed.protocol !== "sourceweft:" ||
    parsed.hostname !== "auth" ||
    parsed.pathname !== "/complete"
  ) {
    return false;
  }

  const token = parsed.searchParams.get("ott");
  if (!token) {
    input.onError?.("Desktop sign-in link did not include a token.");
    return true;
  }

  const state = parsed.searchParams.get("state");
  const {
    clearPendingDesktopAuth,
    getPendingDesktopAuth,
    isPendingDesktopAuthState,
  } = await import("./desktop-auth");
  if (!isPendingDesktopAuthState(state)) {
    return true;
  }

  const pendingAuth = getPendingDesktopAuth();
  if (!state || !pendingAuth.state || state !== pendingAuth.state) {
    return true;
  }

  const { authClient } = await import("./auth-client");
  const result = await authClient.oneTimeToken.verify({ token });
  if (result.error) {
    input.onError?.(result.error.message || "Desktop sign-in failed.");
    return true;
  }

  clearPendingDesktopAuth(state);
  input.onSuccess?.();
  return true;
}
