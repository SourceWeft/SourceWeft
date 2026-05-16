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

function getTauriBridgeFallback(): SourceWeftNativeBridge | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const internals = window.__TAURI_INTERNALS__;
  if (
    typeof internals?.invoke !== "function" ||
    typeof internals.transformCallback !== "function"
  ) {
    return undefined;
  }

  return {
    kind: "desktop",
    capabilities: ["deepLink", "desktopAutostart", "desktopWindow", "externalUrl", "hostInfo"],
    invoke: (command, args) => {
      if (!internals.invoke) {
        return Promise.reject(new Error("Tauri invoke is not available."));
      }

      return internals.invoke(command, args);
    },
    listen: async (event, handler) => {
      const callbackId = internals.transformCallback?.(handler);
      if (typeof callbackId !== "number") {
        throw new Error("Tauri event callback registration failed.");
      }

      if (!internals.invoke) {
        throw new Error("Tauri invoke is not available.");
      }

      const eventId = await internals.invoke("plugin:event|listen", {
        event,
        target: { kind: "Any" },
        handler: callbackId,
      });

      return async () => {
        internals.unregisterCallback?.(callbackId);
        await internals.invoke?.("plugin:event|unlisten", { event, eventId });
      };
    },
  };
}

export function getNativeBridge() {
  if (typeof window === "undefined") {
    return undefined;
  }

  return window.__SOURCEWEFT_NATIVE__ ?? getTauriBridgeFallback();
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
