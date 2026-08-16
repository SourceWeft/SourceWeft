/**
 * Run-processor lifecycle tests against a REAL Postgres store, with injected
 * executors (no agent assembly). Covers success / failure / cancel / concurrent
 * interrupt.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { Pool } from "pg";
import { PostgresRunsStore } from "./postgres-store";
import { processRun } from "./run-processor";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresRunsStore(pool);
const createdThreads: string[] = [];

afterAll(async () => {
  for (const threadId of createdThreads) {
    await store.deleteThread(threadId);
  }
  await pool.end();
});

async function runningRun() {
  await store.ensureSchema();
  const thread = await store.createThread();
  createdThreads.push(thread.threadId);
  const run = await store.createRun({
    threadId: thread.threadId,
    graphId: "explore",
    multitaskStrategy: "reject",
  });
  return { threadId: thread.threadId, runId: run.runId };
}

test("a successful executor drives the run to success", async () => {
  const { threadId, runId } = await runningRun();
  const status = await processRun({
    store,
    threadId,
    runId,
    executor: async () => {
      /* did the work */
    },
  });
  assert.equal(status, "success");
  assert.equal((await store.getRun(threadId, runId))?.status, "success");
});

test("a throwing executor drives the run to error", async () => {
  const { threadId, runId } = await runningRun();
  const status = await processRun({
    store,
    threadId,
    runId,
    executor: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(status, "error");
});

test("an aborted signal cancels before executing", async () => {
  const { threadId, runId } = await runningRun();
  const controller = new AbortController();
  controller.abort();
  const status = await processRun({
    store,
    threadId,
    runId,
    signal: controller.signal,
    executor: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(status, "cancelled");
});

test("a successful run's final state is persisted and surfaced via getThreadState", async () => {
  const { threadId, runId } = await runningRun();
  const finalState = { messages: [{ role: "assistant", content: "the report" }] };
  const status = await processRun({
    store,
    threadId,
    runId,
    executor: async () => finalState,
  });
  assert.equal(status, "success");
  // This is exactly what deepagents' check_async_task reads: `.values.messages`.
  assert.deepEqual(await store.getThreadState(threadId), finalState);
});

test("getRunConfig round-trips the persisted input + tenancy context", async () => {
  await store.ensureSchema();
  const thread = await store.createThread();
  createdThreads.push(thread.threadId);
  const run = await store.createRun({
    threadId: thread.threadId,
    graphId: "explore",
    multitaskStrategy: "reject",
    input: { messages: [{ role: "user", content: "investigate X" }] },
    context: {
      teamId: "team_1",
      workspaceId: "ws_1",
      userId: "user_1",
      modelAlias: "chat-default",
      providerModel: "deepseek-chat",
      profileAlias: "default",
      gatewayConfigId: "gw_1",
      parentThreadId: "thread_parent",
    },
  });
  const cfg = await store.getRunConfig(run.runId);
  assert.equal(cfg?.context.teamId, "team_1");
  assert.equal(cfg?.input.messages[0]?.content, "investigate X");
});

test("a concurrent interrupt is not overwritten by a late success", async () => {
  const { threadId, runId } = await runningRun();
  const status = await processRun({
    store,
    threadId,
    runId,
    // Simulate a newer run superseding this one mid-execution.
    executor: async (run) => {
      await store.transition(run.runId, "interrupted");
    },
  });
  assert.equal(status, "interrupted");
  assert.equal((await store.getRun(threadId, runId))?.status, "interrupted");
});
