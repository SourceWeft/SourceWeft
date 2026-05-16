"use client";

export type NativeHostKind = "desktop" | "mobile";

export type NativeEvent<TPayload> = {
  event: string;
  id: number;
  payload: TPayload;
};

export type NativeCapability =
  | "deepLink"
  | "desktopAutostart"
  | "desktopWindow"
  | "externalUrl"
  | "hostInfo";

export type SourceWeftNativeBridge = {
  kind: NativeHostKind;
  capabilities: NativeCapability[];
  invoke: <TResult = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<TResult>;
  listen: <TPayload>(
    event: string,
    handler: (event: NativeEvent<TPayload>) => void,
  ) => Promise<() => Promise<void>>;
};

export type TauriInternals = {
  invoke?: <TResult = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<TResult>;
  transformCallback?: <TPayload>(
    handler: (event: NativeEvent<TPayload>) => void,
  ) => number;
  unregisterCallback?: (callbackId: number) => void;
};

declare global {
  interface Window {
    __SOURCEWEFT_NATIVE__?: SourceWeftNativeBridge;
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export type NativeInfo = {
  kind: NativeHostKind;
  isNative: boolean;
  isDesktop?: boolean;
  isMobile?: boolean;
  platform: string;
  arch: string;
  appName: string;
  appVersion: string;
  tauriVersion: string;
};

export type DeepLinkPayload = {
  url: string;
};

type NativeListener<TPayload> = (payload: TPayload) => void;

function hasCapability(
  bridge: SourceWeftNativeBridge | undefined,
  capability: NativeCapability,
) {
  return Boolean(bridge?.capabilities.includes(capability));
}

export function getNativeBridge() {
  if (typeof window === "undefined") {
    return undefined;
  }

  return window.__SOURCEWEFT_NATIVE__;
}

function getTauriInvoke() {
  if (typeof window === "undefined") {
    return undefined;
  }

  return typeof window.__TAURI_INTERNALS__?.invoke === "function"
    ? window.__TAURI_INTERNALS__.invoke
    : undefined;
}

function resolveInfoKind(info: NativeInfo | undefined) {
  if (info?.kind === "mobile" || info?.isMobile === true) {
    return "mobile";
  }

  if (info?.kind === "desktop" || info?.isDesktop === true) {
    return "desktop";
  }

  return null;
}

function withTimeout<TResult>(promise: Promise<TResult>, timeoutMs: number) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error("Native host detection timed out."));
      }, timeoutMs);
    }),
  ]);
}

export async function detectNativeHostKind(): Promise<NativeHostKind | null> {
  const bridge = getNativeBridge();
  if (bridge) {
    return bridge.kind;
  }

  const invoke = getTauriInvoke();
  if (!invoke) {
    return null;
  }

  try {
    const info = await withTimeout(invoke<NativeInfo>("mobile_info"), 800);
    const kind = resolveInfoKind(info);
    if (kind === "mobile") {
      return kind;
    }
  } catch {
    // Absence of this command means this is not the mobile host.
  }

  try {
    const info = await withTimeout(invoke<NativeInfo>("desktop_info"), 800);
    const kind = resolveInfoKind(info);
    if (kind === "desktop") {
      return kind;
    }
  } catch {
    // Absence of this command means this is not the desktop host.
  }

  return null;
}

async function invokeNative<TResult>(
  command: string,
  args?: Record<string, unknown>,
) {
  const bridge = getNativeBridge();
  if (!bridge) {
    throw new Error("SourceWeft native bridge is not available.");
  }

  return bridge.invoke<TResult>(command, args);
}

async function listenNative<TPayload>(
  event: string,
  handler: NativeListener<TPayload>,
) {
  const bridge = getNativeBridge();
  if (!bridge) {
    return () => Promise.resolve();
  }

  return bridge.listen<TPayload>(event, (message) => handler(message.payload));
}

export const nativeBridge = {
  isAvailable(kind?: NativeHostKind) {
    const bridge = getNativeBridge();
    return Boolean(bridge && (!kind || bridge.kind === kind));
  },
  kind() {
    return getNativeBridge()?.kind ?? null;
  },
  hasCapability(capability: NativeCapability) {
    return hasCapability(getNativeBridge(), capability);
  },
  info() {
    const bridge = getNativeBridge();
    if (bridge?.kind === "mobile") {
      return invokeNative<NativeInfo>("mobile_info");
    }

    return invokeNative<NativeInfo>("desktop_info");
  },
  openExternalUrl(url: string) {
    return invokeNative<void>("open_external_url", { url });
  },
  onDeepLink(handler: NativeListener<DeepLinkPayload>) {
    return listenNative("sourceweft:deep-link", handler);
  },
};
