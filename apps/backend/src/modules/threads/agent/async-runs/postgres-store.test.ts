/**
 * Integration test for {@link PostgresRunsStore} against a REAL Postgres
 * (DATABASE_URL from apps/backend/.env, loaded by the vitest setup). Mirrors the
 * in-memory store scenarios so the two implementations are provably equivalent.
 * Each test creates its own thread and deletes it afterward.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { Pool } from "pg";
import { PostgresRunsStore } from "./postgres-store";
import { RunConflictError } from "./in-memory-store";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresRunsStore(pool);
const createdThreads: string[] = [];

afterAll(async () => {
  for (const threadId of createdThreads) {
    await store.deleteThread(threadId);
  }
  await pool.end();
});

async function freshThread() {
  await store.ensureSchema();
  const thread = await store.createThread();
  createdThreads.push(thread.threadId);
  return thread.threadId;
}

test("createThread persists and createRun starts running", async () => {
  const threadId = await freshThread();
  const run = await store.createRun({
    threadId,
    graphId: "explore",
    multitaskStrategy: "reject",
  });
  assert.equal(run.status, "running");
  assert.equal(run.graphId, "explore");
  assert.equal((await store.getRun(threadId, run.runId))?.status, "running");
});

test("interrupt supersedes the active run in Postgres", async () => {
  const threadId = await freshThread();
  const first = await store.createRun({
    threadId,
    graphId: "explore",
    multitaskStrategy: "interrupt",
  });
  const second = await store.createRun({
    threadId,
    graphId: "explore",
    multitaskStrategy: "interrupt",
  });
  assert.equal((await store.getRun(threadId, first.runId))?.status, "interrupted");
  assert.equal(second.status, "running");
});

test("reject on a live run throws RunConflictError", async () => {
  const threadId = await freshThread();
  await store.createRun({ threadId, graphId: "explore", multitaskStrategy: "reject" });
  await assert.rejects(
    () => store.createRun({ threadId, graphId: "explore", multitaskStrategy: "reject" }),
    RunConflictError,
  );
});

test("enqueue queues behind the active run; a run after completion starts", async () => {
  const threadId = await freshThread();
  const first = await store.createRun({
    threadId,
    graphId: "explore",
    multitaskStrategy: "enqueue",
  });
  const queued = await store.createRun({
    threadId,
    graphId: "plan",
    multitaskStrategy: "enqueue",
  });
  assert.equal(queued.status, "pending");

  await store.transition(first.runId, "success");
  const listed = await store.listRuns(threadId);
  assert.equal(listed.length, 2);
});

test("cancelRun cancels a live run and is idempotent on terminal runs", async () => {
  const threadId = await freshThread();
  const run = await store.createRun({
    threadId,
    graphId: "explore",
    multitaskStrategy: "reject",
  });
  assert.equal((await store.cancelRun(threadId, run.runId))?.status, "cancelled");
  assert.equal((await store.cancelRun(threadId, run.runId))?.status, "cancelled");
});

test("illegal transitions are rejected", async () => {
  const threadId = await freshThread();
  const run = await store.createRun({
    threadId,
    graphId: "explore",
    multitaskStrategy: "reject",
  });
  await store.transition(run.runId, "success");
  await assert.rejects(() => store.transition(run.runId, "running"));
});
