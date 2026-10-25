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
  localHostStatus.mockResolvedValue({ connected: true, deviceId: "device-1" });
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

test("the helper line is platform-neutral without sandbox readiness", async () => {
  route("ask");
  const container = await render();
  assert.match(container.textContent ?? "", /macOS support arrives with the sandbox update/);
});

test("the helper line says it is enforced when the sandbox reports readiness", async () => {
  localHostStatus.mockResolvedValue({
    connected: true,
    deviceId: "device-1",
    readiness: { state: "ready" },
  });
  route("ask");
  const container = await render();
  assert.match(container.textContent ?? "", /Enforced by the sandbox on this computer/);
  assert.doesNotMatch(container.textContent ?? "", /macOS support arrives/);
});
