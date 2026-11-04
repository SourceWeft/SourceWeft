// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";

const listNetworkRequests = vi.fn();

vi.mock("../../../../../lib/sdk", () => ({
  localDevicesClient: {
    listNetworkRequests: (...args: unknown[]) => listNetworkRequests(...args),
  },
}));

import { useNetworkRequests } from "./use-network-requests";
import { mount, unmountAll } from "@/test/react";

const request = (id: string) => ({
  id,
  host: "example.com",
  port: 443,
  commandPreview: "curl https://example.com",
  suggestedBy: null,
  createdAt: "2026-10-25T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
});

let latest: ReturnType<typeof useNetworkRequests>;
function Probe(props: { enabled: boolean }) {
  latest = useNetworkRequests({
    workspaceId: "ws-1",
    threadId: "thread-1",
    enabled: props.enabled,
  });
  return createElement("span", null, latest.requests.map((r) => r.id).join(","));
}

beforeEach(() => {
  vi.useFakeTimers();
  listNetworkRequests.mockReset();
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

test("polls immediately and then every 1.5 s while enabled", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  const handle = await mount(createElement(Probe, { enabled: true }));
  assert.equal(listNetworkRequests.mock.calls.length, 1);
  assert.deepEqual(listNetworkRequests.mock.calls[0], ["ws-1", "thread-1"]);
  assert.equal(handle.container.textContent, "r1");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  assert.equal(listNetworkRequests.mock.calls.length, 2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  assert.equal(listNetworkRequests.mock.calls.length, 4);
});

test("stops polling and drops the list when the run ends", async () => {
  listNetworkRequests.mockResolvedValue({ requests: [request("r1")] });
  const handle = await mount(createElement(Probe, { enabled: true }));
  await handle.render(createElement(Probe, { enabled: false }));
  assert.equal(handle.container.textContent, "");
  const calls = listNetworkRequests.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  assert.equal(listNetworkRequests.mock.calls.length, calls);
});

test("never polls while disabled", async () => {
  await mount(createElement(Probe, { enabled: false }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  assert.equal(listNetworkRequests.mock.calls.length, 0);
});

test("a failed poll keeps the last list and an answered id is not resurrected", async () => {
  listNetworkRequests.mockResolvedValueOnce({
    requests: [request("r1"), request("r2")],
  });
  const handle = await mount(createElement(Probe, { enabled: true }));
  assert.equal(handle.container.textContent, "r1,r2");
  listNetworkRequests.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  assert.equal(handle.container.textContent, "r1,r2");
  act(() => latest.remove("r1"));
  assert.equal(handle.container.textContent, "r2");
  // A poll that was already in flight still lists r1.
  listNetworkRequests.mockResolvedValue({
    requests: [request("r1"), request("r2")],
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  assert.equal(handle.container.textContent, "r2");
});
