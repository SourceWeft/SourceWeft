// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const localRequest = vi.fn();
const localHostStatus = vi.fn();

vi.mock("../../../../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user-1" } } }) },
}));
vi.mock("../../../../lib/desktop-bridge", () => ({
  desktopBridge: {
    isAvailable: () => true,
    localHostStatus: () => localHostStatus(),
  },
}));
vi.mock("../../../../lib/local-execution", () => ({
  localRequest: (...args: unknown[]) => localRequest(...args),
}));
vi.mock("../../../../lib/local-host-session", () => ({
  ensureLocalHostSession: async () => ({ deviceId: "device-1" }),
}));

import { LocalHostPanel } from "./local-host-panel";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

function device(networkMode?: string) {
  return {
    id: "device-1",
    name: "Mac",
    online: true,
    remoteEnabled: false,
    connected: true,
    ...(networkMode ? { networkMode } : {}),
  };
}

function route(networkMode?: string) {
  localRequest.mockImplementation(async (path: string, body?: unknown) => {
    if (path === "/v1/local-devices") return { devices: [device(networkMode)] };
    if (path.endsWith("/folders")) return { folders: [] };
    if (path === "/v1/local-devices/device-1" && body)
      return { id: "device-1", networkMode: (body as { networkMode: string }).networkMode };
    throw new Error(`unexpected ${path}`);
  });
}

async function render() {
  const { container } = await mountWithIntl(createElement(LocalHostPanel));
  await flush(8);
  return container;
}

function modeSelect(container: HTMLElement) {
  return container.querySelector(
    'select[aria-label="Network access mode"]',
  ) as HTMLSelectElement;
}

beforeEach(() => {
  localRequest.mockReset();
  localHostStatus.mockReset();
  // The sandbox reports readiness (Linux): the policy is enforced.
  localHostStatus.mockResolvedValue({
    connected: true,
    deviceId: "device-1",
    readiness: { state: "ready" },
  });
});
afterEach(unmountAll);

test("shows the device's mode and the three options", async () => {
  route("strict");
  const container = await render();
  const select = modeSelect(container);
  assert.equal(select.value, "strict");
  assert.deepEqual(
    [...select.options].map((o) => [o.value, o.textContent]),
    [
      ["ask", "Ask each time"],
      ["open", "Allow all public hosts"],
      ["strict", "Only allowed hosts"],
    ],
  );
});

test("defaults to Ask each time when the device reports no mode", async () => {
  route();
  assert.equal(modeSelect(await render()).value, "ask");
});

test("changing the mode PATCHes the device with the native proof", async () => {
  route("ask");
  const container = await render();
  const select = modeSelect(container);
  await act(async () => {
    select.value = "open";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(4);
  const call = localRequest.mock.calls.find(
    ([path, body]) => path === "/v1/local-devices/device-1" && body,
  );
  assert.deepEqual(call, [
    "/v1/local-devices/device-1",
    { networkMode: "open" },
    { localProof: true, method: "PATCH" },
  ]);
  assert.equal(modeSelect(container).value, "open");
});

test("a failed change keeps the old mode and shows the error", async () => {
  route("ask");
  const container = await render();
  localRequest.mockImplementation(async (path: string, body?: unknown) => {
    if (body && path === "/v1/local-devices/device-1")
      throw new Error("This setting can only be changed on that computer.");
    if (path === "/v1/local-devices") return { devices: [device("ask")] };
    return { folders: [] };
  });
  const select = modeSelect(container);
  await act(async () => {
    select.value = "strict";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(4);
  assert.match(
    container.querySelector('[role="alert"]')?.textContent ?? "",
    /only be changed on that computer/,
  );
  assert.equal(modeSelect(container).value, "ask");
});

test("without sandbox readiness the select stays visible but disabled, with the stored mode", async () => {
  localHostStatus.mockResolvedValue({ connected: true, deviceId: "device-1" });
  route("strict");
  const container = await render();
  const select = modeSelect(container);
  assert.equal(select.disabled, true);
  assert.equal(select.value, "strict");
  assert.match(
    container.textContent ?? "",
    /not enforced on this computer yet/,
  );
  assert.doesNotMatch(container.textContent ?? "", /Enforced by the sandbox/);
});

test("a disabled select never PATCHes the device", async () => {
  localHostStatus.mockResolvedValue({ connected: true, deviceId: "device-1" });
  route("ask");
  const container = await render();
  const select = modeSelect(container);
  await act(async () => {
    select.value = "strict";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(4);
  assert.equal(
    localRequest.mock.calls.some(([, body]) => Boolean(body) && (body as { networkMode?: string }).networkMode),
    false,
  );
});

test("with sandbox readiness the select is enabled and says it is enforced", async () => {
  route("ask");
  const container = await render();
  assert.equal(modeSelect(container).disabled, false);
  assert.match(container.textContent ?? "", /Enforced by the sandbox on this computer/);
  assert.doesNotMatch(container.textContent ?? "", /not enforced/);
});

test("a computer whose sandbox needs setup or is unsupported offers no network mode", async () => {
  for (const readiness of [
    {
      state: "needsSetup",
      code: "bundleMissing",
      reason: "The sandbox runtime is not installed.",
      remedy: "downloadRuntime",
    },
    { state: "unsupported" },
  ]) {
    localHostStatus.mockResolvedValue({
      connected: false,
      deviceId: "device-1",
      readiness,
    });
    route("strict");
    const container = await render();
    assert.equal(modeSelect(container).disabled, true, readiness.state);
    assert.equal(modeSelect(container).value, "strict");
    assert.match(container.textContent ?? "", /not enforced on this computer yet/);
    await unmountAll();
  }
});
