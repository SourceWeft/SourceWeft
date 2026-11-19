// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ trackMobileLaunch: vi.fn() }));
vi.mock("./analytics/events", () => ({
  trackMobileLaunch: state.trackMobileLaunch,
}));

import {
  SHELL_CACHE_TIMING,
  registerMobileServiceWorker,
  reportMobileLaunch,
  setMobileSessionHint,
} from "./mobile-app-shell";

function installBridge(platform: string, invoke = vi.fn()) {
  Object.defineProperty(window, "__SOURCEWEFT_NATIVE__", {
    configurable: true,
    value: {
      kind: "mobile",
      platform,
      capabilities: [],
      invoke,
      listen: vi.fn(),
    },
  });
  return invoke;
}

function installServiceWorker() {
  const register = vi.fn(async () => ({}));
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register, controller: null },
  });
  return register;
}

function navigationTiming(serverTiming: { name: string }[]) {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    { startTime: 0, responseStart: 42.4, serverTiming },
  ] as unknown as PerformanceEntryList);
  vi.spyOn(performance, "getEntriesByName").mockReturnValue([]);
}

beforeEach(() => {
  state.trackMobileLaunch.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  delete (window as { __SOURCEWEFT_NATIVE__?: unknown }).__SOURCEWEFT_NATIVE__;
  vi.restoreAllMocks();
});

describe("registerMobileServiceWorker", () => {
  test("registers the worker in the iOS app", () => {
    installBridge("ios");
    const register = installServiceWorker();
    registerMobileServiceWorker();
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  test("leaves the website and other hosts alone", () => {
    const register = installServiceWorker();
    registerMobileServiceWorker();
    installBridge("android");
    registerMobileServiceWorker();
    expect(register).not.toHaveBeenCalled();
  });
});

describe("reportMobileLaunch", () => {
  test("reports a launch served from the worker's cache once", async () => {
    const invoke = installBridge(
      "ios",
      vi.fn(async () => 830),
    );
    navigationTiming([{ name: SHELL_CACHE_TIMING }]);
    await reportMobileLaunch();
    expect(invoke).toHaveBeenCalledWith("take_launch_elapsed_ms", undefined);
    expect(state.trackMobileLaunch).toHaveBeenCalledWith({
      source: "cache",
      surface: "other",
      launchMs: 830,
      ttfbMs: 42,
    });
  });

  test("reports a network launch", async () => {
    installBridge(
      "ios",
      vi.fn(async () => 2900),
    );
    navigationTiming([]);
    await reportMobileLaunch();
    expect(state.trackMobileLaunch.mock.calls[0]?.[0]).toMatchObject({
      source: "network",
    });
  });

  test("reports nothing after the launch has been measured", async () => {
    installBridge(
      "ios",
      vi.fn(async () => null),
    );
    await reportMobileLaunch();
    expect(state.trackMobileLaunch).not.toHaveBeenCalled();
  });
});

test("tells the native app whether a session exists, and nothing outside it", () => {
  setMobileSessionHint(true);
  const invoke = installBridge(
    "ios",
    vi.fn(async () => undefined),
  );
  setMobileSessionHint(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("set_session_hint", { signedIn: true });
});
