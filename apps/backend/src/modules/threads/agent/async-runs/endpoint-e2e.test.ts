/**
 * Endpoint E2E (Layer 1 of the async-runs E2E plan — no model): drive the full
 * wired loop against REAL Postgres + Redis with a stub executor —
 *   HTTP create-thread → create-run (token + context header) → BullMQ enqueue →
 *   worker → processRun → saveResult → HTTP getState surfaces the result.
 * Proves §A wiring (mount + enqueue + worker + result surfacing) without a model.
 * Self-skips without DATABASE_URL.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { PostgresRunsStore } from "./postgres-store";
import { createRunQueue, createRunWorker, enqueueRun } from "./run-queue";
import { registerAsyncRunsRoutes } from "../../../../api/routes/async-runs";
import {
  RUN_CONTEXT_HEADER,
  RUN_INTERNAL_TOKEN_HEADER,
  encodeRunContextHeader,
} from "./run-context-header";
import type { RunContextConfig } from "./types";
import { handleGetThreadState } from "./http-router";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresRunsStore(pool);
const TOKEN = "test-internal-token";
// Unique queue per run so a real dev worker never steals these jobs.
const QUEUE = `async-runs-e2e-${process.pid}`;
const queue = createRunQueue(QUEUE);

const createdThreads: string[] = [];

const CONTEXT: RunContextConfig = {
  teamId: "team_1",
  workspaceId: "ws_1",
  userId: "user_1",
  modelAlias: "chat-default",
  providerModel: "deepseek-chat",
  profileAlias: "default",
  gatewayConfigId: "gw_1",
  parentThreadId: "thread_parent",
};

// A stub executor standing in for the delegate graph (Layer 1 is model-free):
// returns a final state, which processRun persists (saveResult) and getState
// surfaces. The real graph executor is exercised by the resolver unit test.
const FINAL_STATE = { messages: [{ role: "assistant", content: "delegated report" }] };
const worker = createRunWorker({
  queueName: QUEUE,
  store,
  executor: async () => FINAL_STATE,
});

afterAll(async () => {
  await worker.close();
  await queue.close();
  for (const threadId of createdThreads) {
    await store.deleteThread(threadId);
  }
  await pool.end();
});

function app() {
  const hono = new Hono();
  const sub = new Hono();
  sub.use("*", async (c, next) => {
    if (c.req.header(RUN_INTERNAL_TOKEN_HEADER) !== TOKEN) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
  registerAsyncRunsRoutes(sub, store, {
    enqueue: (job) => enqueueRun(queue, job),
  });
  hono.route("/internal/async-runs", sub);
  return hono;
}

async function waitForStatus(
  threadId: string,
  runId: string,
  target: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await store.getRun(threadId, runId);
    if (run && run.status === target) return run.status;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} never reached ${target} (last: ${run?.status})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.skipIf(!process.env.DATABASE_URL)(
  "the guard rejects a request without the internal token",
  async () => {
    const res = await app().request("/internal/async-runs/threads", {
      method: "POST",
    });
    assert.equal(res.status, 403);
  },
);

test.skipIf(!process.env.DATABASE_URL)(
  "create → enqueue → worker → success → getState surfaces the delegate result",
  async () => {
    await store.ensureSchema();
    const hono = app();
    const authed = { [RUN_INTERNAL_TOKEN_HEADER]: TOKEN };

    const threadRes = await hono.request("/internal/async-runs/threads", {
      method: "POST",
      headers: authed,
    });
    assert.equal(threadRes.status, 201);
    const { thread_id: threadId } = (await threadRes.json()) as {
      thread_id: string;
    };
    createdThreads.push(threadId);

    const runRes = await hono.request(
      `/internal/async-runs/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: {
          ...authed,
          "content-type": "application/json",
          [RUN_CONTEXT_HEADER]: encodeRunContextHeader(CONTEXT),
        },
        body: JSON.stringify({
          assistant_id: "explore",
          input: { messages: [{ role: "user", content: "investigate" }] },
        }),
      },
    );
    assert.equal(runRes.status, 201);
    const { run_id: runId } = (await runRes.json()) as { run_id: string };

    // The worker drives it to success and persists the final state.
    await waitForStatus(threadId, runId, "success");

    // getState surfaces exactly what check_async_task reads.
    const state = await handleGetThreadState(store, threadId);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body, { values: FINAL_STATE });
  },
);
