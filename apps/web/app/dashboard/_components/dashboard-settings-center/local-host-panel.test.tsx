// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  localHostStatus: vi.fn(),
  installSandboxRuntime: vi.fn(),
  runSandboxPrivilegedSetup: vi.fn(),
}));
const localRequest = vi.hoisted(() => vi.fn());
const ensureSession = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib/desktop-bridge", () => ({ desktopBridge: bridge }));
vi.mock("../../../../lib/local-execution", () => ({
  localRequest: (...args: unknown[]) => localRequest(...args),
}));
vi.mock("../../../../lib/local-host-session", () => ({
  ensureLocalHostSession: (...args: unknown[]) => ensureSession(...args),
}));
vi.mock("../../../../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user" } } }) },
}));

import { LocalHostPanel } from "./local-host-panel";
import { button, click, flush, mountWithIntl, unmountAll } from "@/test/react";

const baseStatus = {
  protocolVersion: 2,
  platformSupported: true,
  storageInitialized: true,
  authenticatedDispatchAvailable: false,
  deviceId: null,
  connected: false,
  connectionError: null,
};

beforeEach(() => {
  bridge.isAvailable.mockReset().mockReturnValue(true);
  bridge.localHostStatus.mockReset();
  bridge.installSandboxRuntime.mockReset();
  localRequest.mockReset();
  ensureSession.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await unmountAll();
});

async function render() {
  const { container } = await mountWithIntl(createElement(LocalHostPanel));
  await flush(6);
  return container;
}

test("a Linux computer that needs setup shows the setup card even when the device list is unavailable", async () => {
  bridge.localHostStatus.mockResolvedValue({
    ...baseStatus,
    readiness: {
      state: "needsSetup",
      code: "bundleMissing",
      reason: "The sandbox runtime is not installed.",
      remedy: "downloadRuntime",
    },
  });
  localRequest.mockRejectedValue(new Error("offline"));
  const container = await render();
  const text = container.textContent ?? "";
  assert.match(text, /Set up local execution/);
  assert.match(text, /The sandbox runtime is not installed\./);
  assert.match(text, /needs one-time setup/);
  assert.ok(button("Install sandbox runtime", container));
});

test("installing from the card applies the returned readiness and hides the card", async () => {
  bridge.localHostStatus.mockResolvedValue({
    ...baseStatus,
    readiness: {
      state: "needsSetup",
      code: "bundleMissing",
      reason: "The sandbox runtime is not installed.",
      remedy: "downloadRuntime",
    },
  });
  localRequest.mockResolvedValue({ devices: [] });
  bridge.installSandboxRuntime.mockResolvedValue({ state: "ready" });
  const container = await render();
  bridge.localHostStatus.mockResolvedValue({
    ...baseStatus,
    readiness: { state: "ready" },
  });
  await click(button("Install sandbox runtime", container));
  await flush(6);
  assert.equal(bridge.installSandboxRuntime.mock.calls.length, 1);
  assert.doesNotMatch(container.textContent ?? "", /Set up local execution/);
});

test("a ready device shows its system and shell; no card appears", async () => {
  ensureSession.mockResolvedValue({ deviceId: "dev-1" });
  bridge.localHostStatus.mockResolvedValue({
    ...baseStatus,
    deviceId: "dev-1",
    connected: true,
    readiness: { state: "ready", toolchainPath: "loginShell" },
  });
  localRequest.mockImplementation(async (path: string) =>
    path === "/v1/local-devices"
      ? {
          devices: [
            {
              id: "dev-1",
              name: "box",
              online: true,
              remoteEnabled: false,
              connected: true,
              platform: "linux",
              arch: "x64",
              shell: "bash",
            },
          ],
        }
      : { folders: [] },
  );
  const container = await render();
  const text = container.textContent ?? "";
  assert.match(text, /System: Linux x64 · Shell: bash/);
  assert.doesNotMatch(text, /Set up local execution/);
  assert.match(text, /This computer is online/);
});

test("a macOS-style status with no readiness shows no card", async () => {
  bridge.localHostStatus.mockResolvedValue({ ...baseStatus });
  localRequest.mockResolvedValue({ devices: [] });
  const container = await render();
  assert.doesNotMatch(container.textContent ?? "", /Set up local execution/);
});
