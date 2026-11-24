import assert from "node:assert/strict";
import test from "node:test";
import { ContentClient } from "../src/content-client";

function recordingClient() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = new ContentClient({
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return { share: null };
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: "POST", path, body });
      return { share: {} };
    },
    patch: async (path: string, body?: unknown) => {
      calls.push({ method: "PATCH", path, body });
      return { share: {} };
    },
    delete: async (path: string) => {
      calls.push({ method: "DELETE", path });
      return { revoked: true };
    },
  } as never);
  return { client, calls };
}

test("getThreadShare GETs the chat's share path", async () => {
  const { client, calls } = recordingClient();

  await client.getThreadShare("workspace / one", "thread / one");

  assert.deepEqual(calls, [
    {
      method: "GET",
      path: "/v1/workspaces/workspace%20%2F%20one/threads/thread%20%2F%20one/share",
    },
  ]);
});

test("shareThread POSTs with the given body, defaulting to {}", async () => {
  const { client, calls } = recordingClient();

  await client.shareThread("ws", "t-1", { noindex: false });
  await client.shareThread("ws", "t-1");

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/v1/workspaces/ws/threads/t-1/share",
      body: { noindex: false },
    },
    {
      method: "POST",
      path: "/v1/workspaces/ws/threads/t-1/share",
      body: {},
    },
  ]);
});

test("updateThreadShare PATCHes the share with the request body", async () => {
  const { client, calls } = recordingClient();

  await client.updateThreadShare("ws", "t-1", { noindex: true });

  assert.deepEqual(calls, [
    {
      method: "PATCH",
      path: "/v1/workspaces/ws/threads/t-1/share",
      body: { noindex: true },
    },
  ]);
});

test("revokeThreadShare DELETEs the share path", async () => {
  const { client, calls } = recordingClient();

  await client.revokeThreadShare("ws", "t-1");

  assert.deepEqual(calls, [
    { method: "DELETE", path: "/v1/workspaces/ws/threads/t-1/share" },
  ]);
});
