// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  trackMobileLaunch: vi.fn(),
  reloadForStaleBuild: vi.fn(),
}));
vi.mock("./analytics/events", () => ({
  trackMobileLaunch: state.trackMobileLaunch,
}));
vi.mock("./stale-build-reload", () => ({
  reloadForStaleBuild: state.reloadForStaleBuild,
}));

import {
  SHELL_CACHE_TIMING,
  launchPhases,
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

type WorkerMessage = {
  data: unknown;
  ports?: { postMessage: (data: unknown) => void }[];
};
let workerMessage: ((event: WorkerMessage) => void) | undefined;

function installServiceWorker() {
  const register = vi.fn(async () => ({}));
  workerMessage = undefined;
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register,
      controller: null,
      addEventListener: (
        type: string,
        listener: (event: WorkerMessage) => void,
      ) => {
        if (type === "message") workerMessage = listener;
      },
    },
  });
  return register;
}

function navigationTiming(
  serverTiming: { name: string }[],
  resources: { name: string; responseEnd: number }[] = [],
) {
  vi.spyOn(performance, "getEntriesByType").mockImplementation(
    (type) =>
      (type === "navigation"
        ? [{ startTime: 0, responseStart: 42.4, responseEnd: 60, serverTiming }]
        : resources) as unknown as PerformanceEntryList,
  );
  vi.spyOn(performance, "getEntriesByName").mockReturnValue([]);
}

beforeEach(() => {
  state.trackMobileLaunch.mockReset();
  state.reloadForStaleBuild.mockReset();
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

  test("reloads when the worker reports that the page on screen is from before a deploy", () => {
    installBridge("ios");
    installServiceWorker();
    registerMobileServiceWorker();
    workerMessage?.({ data: { type: "something-else" } });
    workerMessage?.({ data: null });
    expect(state.reloadForStaleBuild).not.toHaveBeenCalled();
    workerMessage?.({ data: { type: "sourceweft-shell-stale" } });
    expect(state.reloadForStaleBuild).toHaveBeenCalledTimes(1);
  });

  test("tells the worker which address the page is on now, without reloading", () => {
    installBridge("ios");
    installServiceWorker();
    registerMobileServiceWorker();
    window.history.replaceState(null, "", "/dashboard/chat/thread-1");
    const reply = vi.fn();
    workerMessage?.({
      data: { type: "sourceweft-shell-address" },
      ports: [{ postMessage: reply }],
    });
    expect(reply).toHaveBeenCalledExactlyOnceWith(window.location.href);
    expect(window.location.pathname).toBe("/dashboard/chat/thread-1");
    expect(state.reloadForStaleBuild).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/");
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
    navigationTiming(
      [{ name: SHELL_CACHE_TIMING }],
      [
        {
          name: "https://sourceweft.com/_next/static/chunks/a.js",
          responseEnd: 210,
        },
      ],
    );
    vi.spyOn(performance, "now").mockReturnValue(500);
    await reportMobileLaunch();
    expect(invoke).toHaveBeenCalledWith("take_launch_elapsed_ms", undefined);
    expect(state.trackMobileLaunch).toHaveBeenCalledWith({
      source: "cache",
      surface: "other",
      launchMs: 830,
      ttfbMs: 42,
      startMs: 330,
      pageMs: 60,
      scriptsMs: 150,
      runMs: 290,
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

describe("launchPhases", () => {
  const navigation = {
    startTime: 0,
    responseEnd: 100,
  } as PerformanceNavigationTiming;
  const resource = (name: string, responseEnd: number) =>
    ({ name, responseEnd }) as PerformanceResourceTiming;

  test("splits the launch into phases that add up to it", () => {
    const phases = launchPhases(2000, 1500, navigation, [
      resource("https://sourceweft.com/_next/static/chunks/a.js", 300),
      resource("https://sourceweft.com/_next/static/chunks/b.js", 900),
      resource("https://sourceweft.com/_next/static/chunks/c.css", 1200),
      resource("https://api.sourceweft.com/v1/me", 1400),
      // Loaded after hydration: not part of the launch.
      resource("https://sourceweft.com/_next/static/chunks/late.js", 1800),
    ]);
    expect(phases).toEqual({
      startMs: 500,
      pageMs: 100,
      scriptsMs: 800,
      runMs: 600,
    });
  });

  test("counts no script time when every script arrived with the page", () => {
    expect(launchPhases(900, 400, navigation, [])).toMatchObject({
      scriptsMs: 0,
      runMs: 300,
    });
  });

  test("reports no phases without the page's timing", () => {
    expect(launchPhases(900, 400, undefined, [])).toEqual({});
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
