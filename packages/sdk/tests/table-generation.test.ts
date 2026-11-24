import assert from "node:assert/strict";
import test from "node:test";
import { ContentClient } from "../src/content-client";

function recordingClient() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = new ContentClient({
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return {};
    },
    post: async (path: string, body: unknown) => {
      calls.push({ method: "POST", path, body });
      return {};
    },
  } as never);
  return { client, calls };
}

const request = {
  threadId: "thread 1",
  sourceIds: ["src_1", "src_2"],
  columns: [{ name: "Design", type: "text" as const }],
  instruction: "trials",
};

test("table generation methods call the workspace table routes", async () => {
  const { client, calls } = recordingClient();
  await client.suggestTableColumns("ws / 1", { sourceIds: ["src_1"], language: "en" });
  await client.estimateTable("ws / 1", request);
  await client.generateTable("ws / 1", request);
  await client.regenerateTable("ws / 1", "art/1", { instruction: "events" });
  await client.regenerateTable("ws / 1", "art/1");
  await client.getTableFreshness("ws / 1", "art/1");

  assert.deepEqual(
    calls.map(({ method, path }) => `${method} ${path}`),
    [
      "POST /v1/workspaces/ws%20%2F%201/tables/columns/suggest",
      "POST /v1/workspaces/ws%20%2F%201/tables/estimate",
      "POST /v1/workspaces/ws%20%2F%201/tables/artifacts",
      "POST /v1/workspaces/ws%20%2F%201/tables/artifacts/art%2F1/regenerate",
      "POST /v1/workspaces/ws%20%2F%201/tables/artifacts/art%2F1/regenerate",
      "GET /v1/workspaces/ws%20%2F%201/tables/artifacts/art%2F1/freshness",
    ],
  );
  assert.deepEqual(calls[0]?.body, { sourceIds: ["src_1"], language: "en" });
  assert.deepEqual(calls[2]?.body, request);
  assert.deepEqual(calls[3]?.body, { instruction: "events" });
  assert.deepEqual(calls[4]?.body, {});
});
