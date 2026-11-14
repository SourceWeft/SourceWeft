// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  localHostStatus: vi.fn(),
  installSandboxRuntime: vi.fn(),
  runSandboxPrivilegedSetup: vi.fn(),
  getTaskFolder: vi.fn(),
  chooseTaskFolder: vi.fn(),
  resetTaskFolder: vi.fn(),
}));
const localRequest = vi.hoisted(() => vi.fn());
const ensureSession = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib/desktop-bridge", () => ({
  desktopBridge: bridge,
  FOLDER_SELECTION_CANCELLED: "Folder selection cancelled or unavailable",
}));
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
import {
  button,
  buttons,
  click,
  flush,
  mountWithIntl,
  unmountAll,
} from "@/test/react";

const baseStatus = {
  protocolVersion: 2,
  platformSupported: true,
  storageInitialized: true,
  authenticatedDispatchAvailable: false,
  deviceId: null,
  connected: false,
  connectionError: null,
};

const defaultTaskFolder = {
  path: "/Users/me/SourceWeft",
  defaultPath: "/Users/me/SourceWeft",
  isDefault: true,
};
const customTaskFolder = {
  path: "/Volumes/Work/tasks",
  defaultPath: "/Users/me/SourceWeft",
  isDefault: false,
};

beforeEach(() => {
  bridge.isAvailable.mockReset().mockReturnValue(true);
  bridge.localHostStatus.mockReset();
  bridge.installSandboxRuntime.mockReset();
  bridge.getTaskFolder.mockReset().mockResolvedValue(defaultTaskFolder);
  bridge.chooseTaskFolder.mockReset();
  bridge.resetTaskFolder.mockReset();
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
  bridge.installSandboxRuntime.mockResolvedValue({
    state: "needsSetup",
    code: "installing",
    reason: "stale returned readiness",
    remedy: "none",
  });
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

test("a status with no readiness (no managed host) shows no card", async () => {
  bridge.localHostStatus.mockResolvedValue({ ...baseStatus });
  localRequest.mockResolvedValue({ devices: [] });
  const container = await render();
  assert.doesNotMatch(container.textContent ?? "", /Set up local execution/);
});

test("a poll that started before an install finished cannot overwrite the fresh status", async () => {
  vi.useFakeTimers();
  try {
    const needsSetup = {
      ...baseStatus,
      readiness: {
        state: "needsSetup",
        code: "bundleMissing",
        reason: "The sandbox runtime is not installed.",
        remedy: "downloadRuntime",
      },
    };
    bridge.localHostStatus.mockResolvedValue(needsSetup);
    localRequest.mockResolvedValue({ devices: [] });
    bridge.installSandboxRuntime.mockResolvedValue({ state: "ready" });
    const container = await render();
    // The next poll starts, then hangs on its status read until after the install completes.
    let release: (value: unknown) => void = () => {};
    bridge.localHostStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    bridge.localHostStatus.mockResolvedValue({
      ...baseStatus,
      readiness: { state: "ready" },
    });
    await click(button("Install sandbox runtime", container));
    await flush(6);
    assert.doesNotMatch(container.textContent ?? "", /Set up local execution/);
    await act(async () => release(needsSetup));
    await flush(6);
    assert.doesNotMatch(container.textContent ?? "", /Set up local execution/);
  } finally {
    vi.useRealTimers();
  }
});

test("an unsupported computer says so instead of 'Setting up'", async () => {
  bridge.localHostStatus.mockResolvedValue({
    ...baseStatus,
    platformSupported: false,
    readiness: { state: "unsupported" },
  });
  localRequest.mockResolvedValue({ devices: [] });
  const container = await render();
  const text = container.textContent ?? "";
  assert.match(text, /Local execution is not available on this computer/);
  assert.doesNotMatch(text, /Setting up this computer/);
  assert.doesNotMatch(text, /Set up local execution/);
});

const taskFolderRow = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="local-task-folder"]');
const taskFolderPath = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="local-task-folder-path"]');
const rowAlert = (container: HTMLElement) =>
  taskFolderRow(container)?.querySelector('[role="alert"]')?.textContent ??
  null;
async function renderReady() {
  bridge.localHostStatus.mockResolvedValue({
    ...baseStatus,
    readiness: { state: "ready" },
  });
  localRequest.mockResolvedValue({ devices: [] });
  return render();
}

test("the default task folder is shown shortened, with no reset while it is the default", async () => {
  const container = await renderReady();
  const row = taskFolderRow(container)!;
  assert.match(row.textContent ?? "", /Default task folder/);
  assert.match(
    row.textContent ?? "",
    /New conversations without a chosen folder create their folder here\. Existing conversations keep their folder\./,
  );
  assert.equal(taskFolderPath(container)?.textContent, "~/SourceWeft");
  assert.equal(taskFolderPath(container)?.title, "/Users/me/SourceWeft");
  assert.equal(button("Change…", row).disabled, false);
  assert.equal(buttons("Reset to default", row).length, 0);
  assert.equal(rowAlert(container), null);
});

test("a custom task folder can be reset to the default", async () => {
  bridge.getTaskFolder.mockResolvedValue(customTaskFolder);
  bridge.resetTaskFolder.mockResolvedValue(defaultTaskFolder);
  const container = await renderReady();
  const row = taskFolderRow(container)!;
  assert.equal(taskFolderPath(container)?.textContent, "/Volumes/Work/tasks");
  await click(button("Reset to default", row));
  await flush(4);
  assert.equal(bridge.resetTaskFolder.mock.calls.length, 1);
  assert.equal(taskFolderPath(container)?.textContent, "~/SourceWeft");
  assert.equal(buttons("Reset to default", row).length, 0);
});

test("changing the task folder shows the choice; a dismissed dialog is not an error; a refusal is", async () => {
  const container = await renderReady();
  const row = taskFolderRow(container)!;
  bridge.chooseTaskFolder.mockRejectedValueOnce(
    new Error("Folder selection cancelled or unavailable"),
  );
  await click(button("Change…", row));
  await flush(4);
  assert.equal(rowAlert(container), null);
  assert.equal(taskFolderPath(container)?.textContent, "~/SourceWeft");

  bridge.chooseTaskFolder.mockRejectedValueOnce(
    new Error("TASK_FOLDER_DENIED: Choose a folder outside app storage."),
  );
  await click(button("Change…", row));
  await flush(4);
  assert.equal(
    rowAlert(container),
    "TASK_FOLDER_DENIED: Choose a folder outside app storage.",
  );
  assert.equal(taskFolderPath(container)?.textContent, "~/SourceWeft");

  bridge.chooseTaskFolder.mockResolvedValueOnce(customTaskFolder);
  await click(button("Change…", row));
  await flush(4);
  assert.equal(rowAlert(container), null);
  assert.equal(taskFolderPath(container)?.textContent, "/Volumes/Work/tasks");
  assert.ok(button("Reset to default", row));
});

test("the task folder row is absent until local execution storage is initialized", async () => {
  bridge.localHostStatus.mockResolvedValue({
    ...baseStatus,
    storageInitialized: false,
  });
  localRequest.mockResolvedValue({ devices: [] });
  const container = await render();
  assert.ok(!taskFolderRow(container));
  assert.equal(bridge.getTaskFolder.mock.calls.length, 0);
});

test("a computer with no task folder location says so and lets one be chosen", async () => {
  bridge.getTaskFolder.mockRejectedValue(
    new Error("TASK_FOLDER_UNAVAILABLE: This computer has no default location."),
  );
  bridge.chooseTaskFolder.mockResolvedValue({
    path: "/srv/tasks",
    defaultPath: null,
    isDefault: false,
  });
  const container = await renderReady();
  const row = taskFolderRow(container)!;
  assert.match(rowAlert(container) ?? "", /^TASK_FOLDER_UNAVAILABLE/);
  assert.ok(!taskFolderPath(container));
  assert.equal(button("Change…", row).disabled, false);
  await click(button("Change…", row));
  await flush(4);
  assert.equal(rowAlert(container), null);
  assert.equal(taskFolderPath(container)?.textContent, "/srv/tasks");
});

test("an app version without the task folder commands shows the reason and offers no change", async () => {
  bridge.getTaskFolder.mockRejectedValue(
    new Error("Command get_task_folder not found"),
  );
  const container = await renderReady();
  const row = taskFolderRow(container)!;
  assert.equal(rowAlert(container), "Command get_task_folder not found");
  assert.ok(!taskFolderPath(container));
  assert.equal(button("Change…", row).disabled, true);
  assert.equal(buttons("Reset to default", row).length, 0);
});
