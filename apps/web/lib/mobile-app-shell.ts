"use client";

import { trackMobileLaunch } from "./analytics/events";
import { nativeBridge } from "./native-bridge";

/** Name the service worker adds to `Server-Timing` on a response it served from its cache. */
export const SHELL_CACHE_TIMING = "sw-shell-cache";

function isIosApp() {
  if (typeof window === "undefined") return false;
  const bridge = window.__SOURCEWEFT_NATIVE__;
  return bridge?.kind === "mobile" && bridge.platform === "ios";
}

/**
 * Registers the service worker that keeps the app shell on the device, so a
 * launch shows the page without waiting for the network. Only the iOS app
 * registers it: the website and other hosts keep their plain network loads.
 */
export function registerMobileServiceWorker() {
  if (!isIosApp()) return;
  if (!("serviceWorker" in navigator)) {
    console.info("[launch] service workers are not available in this WebView");
    return;
  }
  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .catch((error) =>
      console.warn("[launch] service worker registration failed", error),
    );
}

/** Tells the native app whether a session exists; a failure only costs the next launch a redirect. */
export function setMobileSessionHint(signedIn: boolean) {
  if (!nativeBridge.isAvailable("mobile")) return;
  void nativeBridge.setSessionHint(signedIn).catch(() => undefined);
}

function launchSurface(pathname: string) {
  if (pathname.startsWith("/dashboard")) return "dashboard" as const;
  if (pathname.startsWith("/auth/")) return "sign_in" as const;
  return "other" as const;
}

export type LaunchPhases = {
  /** Native process start until this page's navigation started (app, web view, splash). */
  startMs: number;
  /** Navigation start until the page's HTML had fully arrived. */
  pageMs: number;
  /** HTML arrived until the last of the build's scripts had loaded. */
  scriptsMs: number;
  /** Last script loaded until the page hydrated: running the scripts and React. */
  runMs: number;
};

const BUILD_SCRIPT = /\/_next\/static\/.+\.js(\?|$)/;

/**
 * Splits a launch into consecutive phases that add up to `launchMs`, so a slow
 * launch shows whether it waited on the app, the page, loading the scripts or
 * running them. Times on the page are relative to its navigation start.
 */
export function launchPhases(
  launchMs: number,
  hydratedAt: number,
  navigation: PerformanceNavigationTiming | undefined,
  resources: PerformanceResourceTiming[],
): LaunchPhases | Record<string, never> {
  if (!navigation || !(navigation.responseEnd > 0)) return {};
  const pageEnd = navigation.responseEnd;
  const scriptsEnd = resources
    .filter(
      (entry) =>
        BUILD_SCRIPT.test(entry.name) && entry.responseEnd <= hydratedAt,
    )
    .reduce((latest, entry) => Math.max(latest, entry.responseEnd), pageEnd);
  return {
    startMs: Math.max(0, Math.round(launchMs - hydratedAt)),
    pageMs: Math.round(pageEnd - navigation.startTime),
    scriptsMs: Math.round(scriptsEnd - pageEnd),
    runMs: Math.max(0, Math.round(hydratedAt - scriptsEnd)),
  };
}

/**
 * Reports how long the launch took, once per app start: native start to this
 * hydrated page, and where the page came from. Logged for the simulator and
 * Web Inspector, and sent as the `mobile_launch` analytics event.
 */
export async function reportMobileLaunch() {
  if (!nativeBridge.isAvailable("mobile")) return;
  // Taken before asking the native side, so both clocks stop at about the same time.
  const hydratedAt = performance.now();
  const launchMs = await nativeBridge.takeLaunchElapsedMs().catch(() => null);
  if (typeof launchMs !== "number") return;

  const navigation = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  const resources = performance.getEntriesByType(
    "resource",
  ) as PerformanceResourceTiming[];
  const fromCache = Boolean(
    navigation?.serverTiming?.some(
      (entry) => entry.name === SHELL_CACHE_TIMING,
    ),
  );
  const ttfbMs = navigation
    ? Math.round(navigation.responseStart - navigation.startTime)
    : undefined;
  const firstPaint = performance
    .getEntriesByName("first-contentful-paint")
    .at(0)?.startTime;
  const report = {
    source: fromCache ? ("cache" as const) : ("network" as const),
    surface: launchSurface(window.location.pathname),
    launchMs,
    ttfbMs,
    ...launchPhases(launchMs, hydratedAt, navigation, resources),
  };
  console.info("[launch]", {
    ...report,
    firstContentfulPaintMs:
      firstPaint === undefined ? undefined : Math.round(firstPaint),
    serviceWorker: Boolean(navigator.serviceWorker?.controller),
  });
  trackMobileLaunch(report);
}
