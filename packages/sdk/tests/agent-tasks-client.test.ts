import assert from "node:assert/strict";
import test from "node:test";
import { AgentTasksClient } from "../src/agent-tasks-client";

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
  const client = new AgentTasksClient({
    get: record("GET"),
    post: record("POST"),
    patch: record("PATCH"),
    delete: record("DELETE"),
  } as never);
  return { client, calls };
}

const rule = { kind: "daily", time: "08:00" } as const;

test("every scheduled-task route is reachable and scoped to the workspace", async () => {
  const { client, calls } = recordingClient();
  const ws = "workspace / one";
  const base = "/v1/workspaces/workspace%20%2F%20one/agent-tasks";

  await client.list(ws);
  await client.create(ws, {
    name: "Morning digest",
    prompt: "Summarize what is new",
    request: {
      sourceIds: [],
      skillIds: [],
      mcp: { installIds: [] },
      webAccess: false,
    },
    rule,
    timezone: "Asia/Shanghai",
    activate: false,
  });
  await client.get(ws, "task/1");
  await client.update(ws, "task/1", { version: 1, name: "Digest" });
  await client.delete(ws, "task/1");
  await client.pause(ws, "task/1");
  await client.resume(ws, "task/1");
  await client.activate(ws, "task/1");
  await client.runNow(ws, "task/1", { idempotencyKey: "click-1" });
  await client.listRuns(ws, "task/1");
  await client.listRuns(ws, "task/1", { limit: 5, cursor: "a + b" });
  await client.previewSchedule(ws, { rule, timezone: "UTC" });

  assert.deepEqual(
    calls.map(({ method, path }) => `${method} ${path}`),
    [
      `GET ${base}`,
      `POST ${base}`,
      `GET ${base}/task%2F1`,
      `PATCH ${base}/task%2F1`,
      `DELETE ${base}/task%2F1`,
      `POST ${base}/task%2F1/pause`,
      `POST ${base}/task%2F1/resume`,
      `POST ${base}/task%2F1/activate`,
      `POST ${base}/task%2F1/run-now`,
      `GET ${base}/task%2F1/runs`,
      `GET ${base}/task%2F1/runs?limit=5&cursor=a+%2B+b`,
      `POST ${base}/preview-schedule`,
    ],
  );
  assert.deepEqual(calls[3]!.body, { version: 1, name: "Digest" });
  assert.deepEqual(calls[8]!.body, { idempotencyKey: "click-1" });
});
