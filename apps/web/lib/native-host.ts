"use client";

import { useSyncExternalStore } from "react";

import {
  findHostNativeBridge,
  type NativeInfo,
  type SourceWeftNativeBridge,
} from "./native-bridge";

/**
 * Where this page is shown.
 *
 * - `unknown`: not determined yet. Only the server render and the first client
 *   render are in this state; a browser tab is `web` right after.
 * - `mobile` with `platform: null`: a mobile app that has not told us its
 *   operating system yet (an app build from before the bridge named it).
 */
export type NativeHost =
  | { kind: "unknown" }
  | { kind: "web" }
  | { kind: "desktop" }
  | { kind: "mobile"; platform: string | null };

const UNKNOWN: NativeHost = { kind: "unknown" };
const WEB: NativeHost = { kind: "web" };
const DESKTOP: NativeHost = { kind: "desktop" };

/**
 * Whether anything may be sold or offered for sale here.
 *
 * The iOS app may not: the App Store allows digital purchases only through
 * in-app purchase, and forbids pointing people to another way to pay. A mobile
 * app whose platform is not known yet is treated the same, so no purchase
 * surface can appear and then be taken away. The server render and browsers
 * are unaffected.
 */
export function purchasesAllowedIn(host: NativeHost): boolean {
  if (host.kind !== "mobile") {
    return true;
  }
  return host.platform !== null && host.platform !== "ios";
}

/**
 * Whether Google Tag Manager, and with it Google Analytics and Microsoft
 * Clarity, may load here.
 *
 * Not in the iOS app: Clarity records the screen and both tools set
 * identifiers their vendors also use for advertising, which the App Store
 * counts as tracking and would require the system tracking prompt. A mobile
 * app whose platform is not known yet is treated the same. A host that is not
 * determined yet gets the same answer, unlike purchases: a script that has
 * loaded cannot be taken back.
 */
export function thirdPartyTagsAllowedIn(host: NativeHost): boolean {
  if (host.kind === "unknown") {
    return false;
  }
  if (host.kind !== "mobile") {
    return true;
  }
  return host.platform !== null && host.platform !== "ios";
}

/** True in the iOS app only. */
export function isIosApp(host: NativeHost): boolean {
  return host.kind === "mobile" && host.platform === "ios";
}

function hostFromBridge(
  bridge: SourceWeftNativeBridge | undefined,
): NativeHost {
  if (!bridge) {
    return WEB;
  }
  if (bridge.kind === "desktop") {
    return DESKTOP;
  }
  const platform =
    typeof bridge.platform === "string" && bridge.platform.trim()
      ? bridge.platform.trim().toLowerCase()
      : null;
  return { kind: "mobile", platform };
}

let current: NativeHost | null = null;
const listeners = new Set<() => void>();

function publish(host: NativeHost) {
  current = host;
  for (const listener of listeners) {
    listener();
  }
}

/** Asks an app build whose bridge does not name its platform. */
async function resolveMobilePlatform(bridge: SourceWeftNativeBridge) {
  try {
    const info = await bridge.invoke<NativeInfo>("mobile_info");
    const platform =
      typeof info?.platform === "string" && info.platform.trim()
        ? info.platform.trim().toLowerCase()
        : null;
    if (platform) {
      publish({ kind: "mobile", platform });
    }
  } catch {
    // Stay on "platform unknown": nothing is offered for sale.
  }
}

function readHost(): NativeHost {
  if (current) {
    return current;
  }
  const bridge = findHostNativeBridge();
  current = hostFromBridge(bridge);
  if (bridge && current.kind === "mobile" && current.platform === null) {
    void resolveMobilePlatform(bridge);
  }
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The host this page is shown in. `unknown` during the server render. */
export function useNativeHost(): NativeHost {
  return useSyncExternalStore(subscribe, readHost, () => UNKNOWN);
}

export function usePurchasesAllowed(): boolean {
  return purchasesAllowedIn(useNativeHost());
}

/** For tests: forget what was detected. */
export function resetNativeHostForTests() {
  current = null;
  listeners.clear();
}
