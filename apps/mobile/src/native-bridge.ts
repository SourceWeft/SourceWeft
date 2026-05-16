export type NativeHostKind = "desktop" | "mobile";

export type NativeCapability =
  | "deepLink"
  | "desktopAutostart"
  | "desktopWindow"
  | "externalUrl"
  | "hostInfo";

export type NativeEvent<TPayload> = {
  event: string;
  id: number;
  payload: TPayload;
};

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

declare global {
  interface Window {
    __SOURCEWEFT_NATIVE__?: SourceWeftNativeBridge;
    __SOURCEWEFT_MOBILE__?: {
      isMobile: true;
      invoke: SourceWeftNativeBridge["invoke"];
      listen: SourceWeftNativeBridge["listen"];
    };
  }
}

export function getMobileBridge() {
  const bridge =
    typeof window === "undefined" ? undefined : window.__SOURCEWEFT_NATIVE__;
  return bridge?.kind === "mobile" ? bridge : undefined;
}
