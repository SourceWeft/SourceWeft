import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SandboxReadiness } from "./desktop-bridge";

const native = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  localHostStatus: vi.fn(),
  installSandboxRuntime: vi.fn(),
}));
vi.mock("./desktop-bridge", () => ({ desktopBridge: native }));

import {
  installSandboxRuntime,
  installSandboxRuntimeAutomatically,
  resetSandboxInstall,
} from "./sandbox-runtime-install";

const needs = (remedy: string, code = "bundleMissing"): SandboxReadiness =>
  ({
    state: "needsSetup",
    code,
    reason: "The sandbox runtime is not installed.",
    remedy,
  }) as SandboxReadiness;
const reports = (readiness?: SandboxReadiness) =>
  native.localHostStatus.mockResolvedValue({
    deviceId: null,
    connected: false,
    ...(readiness ? { readiness } : {}),
  });
/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetSandboxInstall();
  native.isAvailable.mockReset().mockReturnValue(true);
  native.localHostStatus.mockReset();
  native.installSandboxRuntime
    .mockReset()
    .mockResolvedValue({ state: "ready" });
});

afterEach(() => {
  vi.useRealTimers();
});

test.each(["bundleMissing", "bundleStale", "bundleInvalid"])(
  "a runtime that only has to be downloaded (%s) is installed once per page load",
  async (code) => {
    reports(needs("downloadRuntime", code));
    await installSandboxRuntimeAutomatically();
    assert.equal(native.installSandboxRuntime.mock.calls.length, 1);
    // The dashboard effect runs again (account change, remount): nothing more is started.
    await installSandboxRuntimeAutomatically();
    await installSandboxRuntimeAutomatically();
    assert.equal(native.installSandboxRuntime.mock.calls.length, 1);
  },
);

test("two overlapping automatic checks start one install", async () => {
  reports(needs("downloadRuntime"));
  await Promise.all([
    installSandboxRuntimeAutomatically(),
    installSandboxRuntimeAutomatically(),
  ]);
  assert.equal(native.installSandboxRuntime.mock.calls.length, 1);
});

test.each([
  ["an app update", needs("updateApp", "bundleNewer")],
  ["a package reinstall", needs("reinstallPackage", "bwrapMissing")],
  ["a privileged command", needs("privilegedSetup", "userNamespaceRestricted")],
  ["administrator approval", needs("elevatedSetup", "windowsNotInstalled")],
  ["no remedy", needs("none", "sandboxFailed")],
  ["a remedy this web app does not know", needs("somethingNewer")],
  ["an install that is already running", needs("none", "installing")],
  [
    "an install already running that still names the download",
    needs("downloadRuntime", "installing"),
  ],
  ["a ready computer", { state: "ready" } as SandboxReadiness],
  ["an unsupported computer", { state: "unsupported" } as SandboxReadiness],
  ["a desktop build that reports no readiness", undefined],
])("nothing is installed automatically for %s", async (_case, readiness) => {
  reports(readiness);
  await installSandboxRuntimeAutomatically();
  assert.equal(native.installSandboxRuntime.mock.calls.length, 0);
});

test("a working runtime from an older app version is refreshed once", async () => {
  native.localHostStatus.mockResolvedValue({
    readiness: { state: "ready" },
    runtime: {
      appVersion: "2",
      installedAppVersion: "1",
      updateAvailable: true,
    },
  });
  await installSandboxRuntimeAutomatically();
  assert.equal(native.installSandboxRuntime.mock.calls.length, 1);
});

test("a current runtime is left alone", async () => {
  native.localHostStatus.mockResolvedValue({
    readiness: { state: "ready" },
    runtime: {
      appVersion: "2",
      installedAppVersion: "2",
      updateAvailable: false,
    },
  });
  await installSandboxRuntimeAutomatically();
  assert.equal(native.installSandboxRuntime.mock.calls.length, 0);
});

test("a browser never asks the host anything", async () => {
  native.isAvailable.mockReturnValue(false);
  await installSandboxRuntimeAutomatically();
  assert.equal(native.localHostStatus.mock.calls.length, 0);
  assert.equal(native.installSandboxRuntime.mock.calls.length, 0);
});

test("a host status that cannot be read starts nothing and does not throw", async () => {
  native.localHostStatus.mockRejectedValue(new Error("IPC unavailable"));
  await installSandboxRuntimeAutomatically();
  assert.equal(native.installSandboxRuntime.mock.calls.length, 0);
});

test("a rejected automatic install is not retried by itself and can be retried by hand", async () => {
  reports(needs("downloadRuntime"));
  native.installSandboxRuntime.mockRejectedValue(
    new Error("SANDBOX_DOWNLOAD_FAILED: the release asset returned 404"),
  );
  // The rejection is absorbed: an unhandled one would fail this test.
  await installSandboxRuntimeAutomatically();
  await installSandboxRuntimeAutomatically();
  assert.equal(native.installSandboxRuntime.mock.calls.length, 1);

  native.installSandboxRuntime.mockResolvedValue({ state: "ready" });
  assert.deepEqual(await installSandboxRuntime(), { state: "ready" });
  assert.equal(native.installSandboxRuntime.mock.calls.length, 2);
});

test("a caller that arrives during an install joins it instead of starting another", async () => {
  reports(needs("downloadRuntime"));
  const run = deferred<SandboxReadiness>();
  native.installSandboxRuntime.mockReturnValue(run.promise);
  const automatic = installSandboxRuntimeAutomatically();
  await vi.waitFor(() =>
    assert.equal(native.installSandboxRuntime.mock.calls.length, 1),
  );
  // The Settings button, pressed while the automatic install is running.
  const manual = installSandboxRuntime();
  assert.equal(native.installSandboxRuntime.mock.calls.length, 1);
  run.resolve({ state: "ready" });
  assert.deepEqual(await manual, { state: "ready" });
  await automatic;
  // Once it has finished, a new request is a new install.
  await installSandboxRuntime();
  assert.equal(native.installSandboxRuntime.mock.calls.length, 2);
});

const probing = needs("none", "sandboxFailed");
(probing as { reason: string }).reason = "Checking the sandbox runtime";

test("a host that is still probing is asked again until it answers, then the runtime is installed once", async () => {
  vi.useFakeTimers();
  native.localHostStatus
    .mockResolvedValueOnce({ readiness: probing })
    .mockResolvedValueOnce({ readiness: probing })
    .mockResolvedValue({ readiness: needs("downloadRuntime") });
  const done = installSandboxRuntimeAutomatically();
  await vi.advanceTimersByTimeAsync(5_000);
  await done;
  assert.equal(native.localHostStatus.mock.calls.length, 3);
  assert.equal(native.installSandboxRuntime.mock.calls.length, 1);
});

test("a host that never stops probing is given up on without installing anything", async () => {
  vi.useFakeTimers();
  native.localHostStatus.mockResolvedValue({ readiness: probing });
  const done = installSandboxRuntimeAutomatically();
  await vi.advanceTimersByTimeAsync(60_000);
  await done;
  assert.equal(native.localHostStatus.mock.calls.length, 20);
  assert.equal(native.installSandboxRuntime.mock.calls.length, 0);
  // No timer is left behind.
  assert.equal(vi.getTimerCount(), 0);
});
