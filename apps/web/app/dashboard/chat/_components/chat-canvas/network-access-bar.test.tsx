// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const listNetworkRequests = vi.fn();
const respondNetworkRequest = vi.fn();
const resumeProbe = vi.fn();

vi.mock("../../../../../lib/sdk", () => ({
  localDevicesClient: {
    listNetworkRequests: (...args: unknown[]) => listNetworkRequests(...args),
    respondNetworkRequest: (...args: unknown[]) =>
      respondNetworkRequest(...args),
  },
  // A network answer must never touch the tool-confirmation client.
  connectorsClient: {
    respondToConfirmation: (...args: unknown[]) => resumeProbe(...args),
  },
}));

import { NetworkAccessBar } from "./network-access-bar";
import { button, mountWithIntl, unmountAll, withIntl } from "@/test/react";

const NOW = Date.parse("2026-10-25T00:00:00.000Z");

function request(
  id: string,
  overrides: Partial<{
    host: string;
    port: number;
    suggestedBy: string | null;
    expiresAt: string;
    commandPreview: string;
  }> = {},
) {
  return {
    id,
    host: "api.example.com",
    port: 443,
    commandPreview: "curl https://api.example.com/v1",
    suggestedBy: null,
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 105_000).toISOString(),
    ...overrides,
  };
}

const run = { idempotencyKey: "k", status: "running" as const };

async function render(props: {
  activeThreadRun?: typeof run | null;
  isLocalThread?: boolean;
}) {
  const handle = await mountWithIntl(
    createElement(NetworkAccessBar, {
      activeThreadRun: "activeThreadRun" in props ? props.activeThreadRun : run,
      isLocalThread: props.isLocalThread ?? true,
      threadId: "thread-1",
      workspaceId: "ws-1",
    }),
  );
  return handle;
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  listNetworkRequests.mockReset();
  respondNetworkRequest.mockReset();
  resumeProbe.mockReset();
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

test("renders host:port, the command, the skill and the remaining time", async () => {
  listNetworkRequests.mockResolvedValue({
    requests: [request("r1", { suggestedBy: "web-research" })],
  });
  const { container } = await render({});
  const text = container.textContent ?? "";
  assert.match(text, /api\.example\.com:443/);
  assert.match(text, /Requested by skill web-research/);
  assert.match(text, /1:45/);
  assert.equal(
    container.querySelector("code")?.textContent,
    "curl https://api.example.com/v1",
  );
  assert.ok(button("Deny", container));
  assert.ok(button("Allow once", container));
  assert.ok(button("Allow for this workspace", container));
  assert.ok(container.querySelector("select"));
  await tick(1000);
  assert.match(container.textContent ?? "", /1:44/);
});

test("omits the skill line when nothing suggested the host", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  const { container } = await render({});
  assert.doesNotMatch(container.textContent ?? "", /Requested by skill/);
});

test("allow once sends allow_once and removes the card", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  respondNetworkRequest.mockResolvedValue({
    request: { id: "r1", status: "allowed", scope: "once" },
  });
  const { container } = await render({});
  await act(async () => button("Allow once", container).click());
  assert.deepEqual(respondNetworkRequest.mock.calls[0], [
    "ws-1",
    "r1",
    { decision: "allow_once" },
  ]);
  assert.equal(container.querySelector('[data-testid="network-access-card"]'), null);
  // The next poll still lists it (in flight race); it stays gone.
  await tick(1500);
  assert.equal(container.querySelector('[data-testid="network-access-card"]'), null);
  assert.equal(resumeProbe.mock.calls.length, 0);
});

test("allow for this workspace sends the chosen duration", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  respondNetworkRequest.mockResolvedValue({
    request: { id: "r1", status: "allowed", scope: "always" },
  });
  const { container } = await render({});
  const select = container.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    select.value = "7d";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Allow for this workspace", container).click());
  assert.deepEqual(respondNetworkRequest.mock.calls[0], [
    "ws-1",
    "r1",
    { decision: "allow_always", trust: { ttlSeconds: 7 * 24 * 60 * 60 } },
  ]);
});

test("allow for this workspace with the default duration sends an empty trust", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  respondNetworkRequest.mockResolvedValue({
    request: { id: "r1", status: "allowed", scope: "always" },
  });
  const { container } = await render({});
  await act(async () => button("Allow for this workspace", container).click());
  assert.deepEqual(respondNetworkRequest.mock.calls[0]?.[2], {
    decision: "allow_always",
    trust: {},
  });
});

test("deny sends deny", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  respondNetworkRequest.mockResolvedValue({
    request: { id: "r1", status: "denied", scope: null },
  });
  const { container } = await render({});
  await act(async () => button("Deny", container).click());
  assert.deepEqual(respondNetworkRequest.mock.calls[0]?.[2], {
    decision: "deny",
  });
  assert.equal(container.querySelector('[data-testid="network-access-card"]'), null);
});

test("a 409 expiry removes the card without an error", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  respondNetworkRequest.mockRejectedValue(
    Object.assign(new Error("expired"), {
      status: 409,
      code: "NETWORK_REQUEST_EXPIRED",
    }),
  );
  const { container } = await render({});
  await act(async () => button("Allow once", container).click());
  assert.equal(container.querySelector('[data-testid="network-access-card"]'), null);
  assert.equal(container.querySelector('[role="alert"]'), null);
});

test("a 403 keeps the card, explains it, and allow once still works", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  respondNetworkRequest.mockRejectedValueOnce(
    Object.assign(new Error("forbidden"), {
      status: 403,
      code: "CONNECTOR_FORBIDDEN",
    }),
  );
  const { container } = await render({});
  await act(async () => button("Allow for this workspace", container).click());
  assert.ok(container.querySelector('[data-testid="network-access-card"]'));
  assert.match(
    container.querySelector('[role="alert"]')?.textContent ?? "",
    /Only workspace admins/,
  );
  assert.equal(button("Allow once", container).disabled, false);
  respondNetworkRequest.mockResolvedValueOnce({
    request: { id: "r1", status: "allowed", scope: "once" },
  });
  await act(async () => button("Allow once", container).click());
  assert.equal(respondNetworkRequest.mock.calls.length, 2);
  assert.equal(container.querySelector('[data-testid="network-access-card"]'), null);
});

test("another failure keeps the card with a retry message", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  respondNetworkRequest.mockRejectedValue(new Error("network down"));
  const { container } = await render({});
  await act(async () => button("Deny", container).click());
  assert.ok(container.querySelector('[data-testid="network-access-card"]'));
  assert.match(
    container.querySelector('[role="alert"]')?.textContent ?? "",
    /Could not send your answer/,
  );
  assert.equal(button("Deny", container).disabled, false);
});

test("a card disappears when its deadline passes", async () => {
  listNetworkRequests.mockResolvedValue({
    requests: [request("r1", { expiresAt: new Date(NOW + 2500).toISOString() })],
  });
  const { container } = await render({});
  assert.ok(container.querySelector('[data-testid="network-access-card"]'));
  await tick(3000);
  assert.equal(container.querySelector('[data-testid="network-access-card"]'), null);
});

test("renders one card per request", async () => {
  listNetworkRequests.mockResolvedValue({
    requests: [request("r1"), request("r2", { host: "other.example.org", port: 8080 })],
  });
  const { container } = await render({});
  assert.equal(
    container.querySelectorAll('[data-testid="network-access-card"]').length,
    2,
  );
  assert.match(container.textContent ?? "", /other\.example\.org:8080/);
});

test("does not poll without an active run or outside a local conversation", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  const idle = await render({ activeThreadRun: null });
  await tick(5000);
  const cloud = await render({ isLocalThread: false });
  await tick(5000);
  assert.equal(listNetworkRequests.mock.calls.length, 0);
  await idle.unmount();
  await cloud.unmount();
});

test("polling stops and the card goes away when the run ends", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  const handle = await render({});
  assert.ok(handle.container.querySelector('[data-testid="network-access-card"]'));
  await handle.render(
    withIntl(
      createElement(NetworkAccessBar, {
        activeThreadRun: null,
        isLocalThread: true,
        threadId: "thread-1",
        workspaceId: "ws-1",
      }),
    ),
  );
  assert.equal(handle.container.querySelector('[data-testid="network-access-card"]'), null);
  const calls = listNetworkRequests.mock.calls.length;
  await tick(10_000);
  assert.equal(listNetworkRequests.mock.calls.length, calls);
});
