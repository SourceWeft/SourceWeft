import assert from "node:assert/strict";
import test from "node:test";
import { AssistantClient } from "../src/assistant-client";

function recordingClient() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const record =
    (method: string) =>
    async (path: string, body?: unknown): Promise<unknown> => {
      calls.push(
        body === undefined ? { method, path } : { method, path, body },
      );
      return {};
    };
  const client = new AssistantClient({
    get: record("GET"),
    post: record("POST"),
    patch: record("PATCH"),
    delete: record("DELETE"),
  } as never);
  return { client, calls };
}

test("every assistant route is reachable and the workspace id is encoded", async () => {
  const { client, calls } = recordingClient();
  const ws = "workspace / one";
  const base = "/v1/workspaces/workspace%20%2F%20one/assistant";

  await client.get(ws);
  await client.enable(ws);
  await client.update(ws, { version: 1, action: "pause" });
  await client.listFeed(ws);
  await client.listFeed(ws, { before: "item/1", limit: 10 });
  await client.postMessage(ws, { text: "hi", idempotencyKey: "key-1" });
  await client.listTickets(ws);
  await client.listTickets(ws, { stage: "queued" });
  await client.closeTicket(ws, "ticket/1", { idempotencyKey: "key-2" });
  await client.retryTicket(ws, "ticket/1", { idempotencyKey: "key-3" });

  assert.deepEqual(
    calls.map(({ method, path }) => `${method} ${path}`),
    [
      `GET ${base}`,
      `POST ${base}`,
      `PATCH ${base}`,
      `GET ${base}/feed`,
      `GET ${base}/feed?before=item%2F1&limit=10`,
      `POST ${base}/messages`,
      `GET ${base}/tickets`,
      `GET ${base}/tickets?stage=queued`,
      `POST ${base}/tickets/ticket%2F1/close`,
      `POST ${base}/tickets/ticket%2F1/retry`,
    ],
  );
  assert.deepEqual(calls[2]!.body, { version: 1, action: "pause" });
  assert.deepEqual(calls[5]!.body, { text: "hi", idempotencyKey: "key-1" });
  assert.deepEqual(calls[8]!.body, { idempotencyKey: "key-2" });
  assert.deepEqual(calls[9]!.body, { idempotencyKey: "key-3" });
});

test("update, postMessage, closeTicket and retryTicket send no query string", async () => {
  const { client, calls } = recordingClient();
  await client.listFeed("ws1", {});
  assert.equal(calls[0]!.path, "/v1/workspaces/ws1/assistant/feed");
});
