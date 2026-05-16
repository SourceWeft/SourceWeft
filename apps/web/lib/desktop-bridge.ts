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
};

export type AutostartState = {
  enabled: boolean;
  requested: boolean;
  supported: boolean;
  reason?: string | null;
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

  return bridge.invoke<TResult>(command, args);
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
  onDeepLink(handler: DesktopListener<DeepLinkPayload>) {
    return listenDesktop("sourceweft:deep-link", handler);
  },
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
