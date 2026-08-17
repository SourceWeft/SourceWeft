/**
 * HTTP mount test — drives the Agent-Protocol routes through Hono's in-process
 * `app.request()` against the in-memory store. No real server; proves the SDK
 * client's calls land on the tested handlers with the right status/shapes.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { Hono } from "hono";
import { InMemoryRunsStore } from "../../modules/threads/agent/async-runs/in-memory-store";
import {
  RUN_CONTEXT_HEADER,
  encodeRunContextHeader,
} from "../../modules/threads/agent/async-runs/run-context-header";
import type { RunContextConfig } from "../../modules/threads/agent/async-runs/types";
import { registerAsyncRunsRoutes, type EnqueueRunJob } from "./async-runs";

function app() {
  const store = new InMemoryRunsStore(() => "2026-01-01T00:00:00.000Z");
  const hono = new Hono();
  registerAsyncRunsRoutes(hono, store);
  return hono;
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("create thread → create run → get → cancel round-trip over HTTP", async () => {
  const hono = app();

  const threadRes = await hono.request("/threads", { method: "POST" });
  assert.equal(threadRes.status, 201);
  const thread = (await threadRes.json()) as { thread_id: string };
  assert.match(thread.thread_id, /^thread_/);

  const runRes = await hono.request(
    `/threads/${thread.thread_id}/runs`,
    json({ assistant_id: "explore" }),
  );
  assert.equal(runRes.status, 201);
  const run = (await runRes.json()) as { run_id: string; status: string };
  assert.equal(run.status, "running");

  const getRes = await hono.request(
    `/threads/${thread.thread_id}/runs/${run.run_id}`,
  );
  assert.equal(getRes.status, 200);

  const listRes = await hono.request(`/threads/${thread.thread_id}/runs`);
  assert.equal(((await listRes.json()) as unknown[]).length, 1);

  const cancelRes = await hono.request(
    `/threads/${thread.thread_id}/runs/${run.run_id}/cancel`,
    { method: "POST" },
  );
  assert.equal(((await cancelRes.json()) as { status: string }).status, "cancelled");
});

test("reject strategy returns 409 over HTTP", async () => {
  const hono = app();
  const thread = (await (await hono.request("/threads", { method: "POST" })).json()) as {
    thread_id: string;
  };
  await hono.request(
    `/threads/${thread.thread_id}/runs`,
    json({ assistant_id: "explore", multitask_strategy: "reject" }),
  );
  const conflict = await hono.request(
    `/threads/${thread.thread_id}/runs`,
    json({ assistant_id: "explore", multitask_strategy: "reject" }),
  );
  assert.equal(conflict.status, 409);
});

test("invalid create-run body returns 400; unknown run 404", async () => {
  const hono = app();
  const thread = (await (await hono.request("/threads", { method: "POST" })).json()) as {
    thread_id: string;
  };
  const bad = await hono.request(`/threads/${thread.thread_id}/runs`, json({ nope: 1 }));
  assert.equal(bad.status, 400);
  const missing = await hono.request(`/threads/${thread.thread_id}/runs/nope`);
  assert.equal(missing.status, 404);
});

test("a started run is enqueued once, carrying the persisted input + context", async () => {
  const store = new InMemoryRunsStore(() => "2026-01-01T00:00:00.000Z");
  const hono = new Hono();
  const enqueued: EnqueueRunJob[] = [];
  registerAsyncRunsRoutes(hono, store, {
    enqueue: async (job) => {
      enqueued.push(job);
    },
  });

  const thread = (await (await hono.request("/threads", { method: "POST" })).json()) as {
    thread_id: string;
  };
  const context: RunContextConfig = {
    teamId: "team_1",
    workspaceId: "ws_1",
    userId: "user_1",
    modelAlias: "chat-default",
    providerModel: "deepseek-chat",
    profileAlias: "default",
    gatewayConfigId: "gw_1",
    parentThreadId: "thread_parent",
  };
  const runRes = await hono.request(`/threads/${thread.thread_id}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [RUN_CONTEXT_HEADER]: encodeRunContextHeader(context),
    },
    body: JSON.stringify({
      assistant_id: "explore",
      input: { messages: [{ role: "user", content: "investigate X" }] },
    }),
  });
  const run = (await runRes.json()) as { run_id: string };

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.graphId, "explore");
  assert.equal(enqueued[0]?.threadId, thread.thread_id);

  const cfg = await store.getRunConfig(run.run_id);
  assert.equal(cfg?.context.teamId, "team_1");
  assert.equal(cfg?.input.messages[0]?.content, "investigate X");
});

test("a rejected (409) create-run does not enqueue", async () => {
  const store = new InMemoryRunsStore(() => "2026-01-01T00:00:00.000Z");
  const hono = new Hono();
  let enqueues = 0;
  registerAsyncRunsRoutes(hono, store, {
    enqueue: async () => {
      enqueues += 1;
    },
  });
  const thread = (await (await hono.request("/threads", { method: "POST" })).json()) as {
    thread_id: string;
  };
  await hono.request(`/threads/${thread.thread_id}/runs`, json({ assistant_id: "explore" }));
  await hono.request(`/threads/${thread.thread_id}/runs`, json({ assistant_id: "explore" }));
  // First started + enqueued; second rejected (reject strategy) → no enqueue.
  assert.equal(enqueues, 1);
});

test("thread state endpoint returns { values }", async () => {
  const hono = app();
  const thread = (await (await hono.request("/threads", { method: "POST" })).json()) as {
    thread_id: string;
  };
  const stateRes = await hono.request(`/threads/${thread.thread_id}/state`);
  assert.deepEqual(await stateRes.json(), { values: null });
});
