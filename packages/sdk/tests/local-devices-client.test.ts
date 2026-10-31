import assert from "node:assert/strict";
import test from "node:test";
import { LocalDevicesClient } from "../src/local-devices-client";

function recording() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const http = {
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return {};
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: "POST", path, body });
      return {};
    },
    patch: async (path: string, body?: unknown) => {
      calls.push({ method: "PATCH", path, body });
      return {};
    },
  };
  return { client: new LocalDevicesClient(http as never), calls };
}

test("network approval calls encode every path segment", async () => {
  const { client, calls } = recording();
  await client.listNetworkRequests("w / 1", "t/2");
  await client.respondNetworkRequest("w / 1", "r?3", {
    decision: "allow_always",
    trust: { ttlSeconds: 3600 },
  });
  await client.updateNetworkMode("pc/1", { networkMode: "strict" });
  assert.deepEqual(calls, [
    {
      method: "GET",
      path: "/v1/workspaces/w%20%2F%201/threads/t%2F2/network-requests",
    },
    {
      method: "POST",
      path: "/v1/workspaces/w%20%2F%201/local-network-requests/r%3F3/respond",
      body: { decision: "allow_always", trust: { ttlSeconds: 3600 } },
    },
    {
      method: "PATCH",
      path: "/v1/local-devices/pc%2F1",
      body: { networkMode: "strict" },
    },
  ]);
});
