import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryRunsStore, RunConflictError } from "./in-memory-store";

/** A deterministic store: fixed clock, counter ids. */
function store() {
  return new InMemoryRunsStore(() => "2026-01-01T00:00:00.000Z");
}

async function threadWithRun(strategy: "reject" | "interrupt" | "rollback" | "enqueue" = "interrupt") {
  const s = store();
  const thread = await s.createThread();
  const run = await s.createRun({
    threadId: thread.threadId,
    graphId: "explore",
    multitaskStrategy: strategy,
  });
  return { s, thread, run };
}

test("createRun with no active run starts running", async () => {
  const { run } = await threadWithRun();
  assert.equal(run.status, "running");
  assert.equal(run.graphId, "explore");
});

test("interrupt supersedes the active run, then starts the new one", async () => {
  const { s, thread, run: first } = await threadWithRun("interrupt");
  const second = await s.createRun({
    threadId: thread.threadId,
    graphId: "explore",
    multitaskStrategy: "interrupt",
  });

  assert.equal((await s.getRun(thread.threadId, first.runId))?.status, "interrupted");
  assert.equal(second.status, "running");
});

test("reject refuses a concurrent run", async () => {
  const { s, thread } = await threadWithRun("reject");
  await assert.rejects(
    () =>
      s.createRun({
        threadId: thread.threadId,
        graphId: "explore",
        multitaskStrategy: "reject",
      }),
    RunConflictError,
  );
});

test("rollback discards the active run", async () => {
  const { s, thread, run: first } = await threadWithRun("rollback");
  const second = await s.createRun({
    threadId: thread.threadId,
    graphId: "explore",
    multitaskStrategy: "rollback",
  });
  assert.equal((await s.getRun(thread.threadId, first.runId))?.status, "cancelled");
  assert.equal(second.status, "running");
});

test("enqueue queues the new run behind the active one", async () => {
  const { s, thread } = await threadWithRun("enqueue");
  const second = await s.createRun({
    threadId: thread.threadId,
    graphId: "explore",
    multitaskStrategy: "enqueue",
  });
  assert.equal(second.status, "pending");
});

test("a new run after the active one completes just starts", async () => {
  const { s, thread, run: first } = await threadWithRun("reject");
  s.transition(first.runId, "success");
  const second = await s.createRun({
    threadId: thread.threadId,
    graphId: "explore",
    multitaskStrategy: "reject",
  });
  assert.equal(second.status, "running");
});

test("cancelRun cancels a live run and is idempotent on terminal runs", async () => {
  const { s, thread, run } = await threadWithRun();
  const cancelled = await s.cancelRun(thread.threadId, run.runId);
  assert.equal(cancelled?.status, "cancelled");
  // idempotent
  const again = await s.cancelRun(thread.threadId, run.runId);
  assert.equal(again?.status, "cancelled");
});

test("listRuns returns all runs for the thread; getRun scopes by thread", async () => {
  const { s, thread, run } = await threadWithRun("enqueue");
  await s.createRun({
    threadId: thread.threadId,
    graphId: "plan",
    multitaskStrategy: "enqueue",
  });
  assert.equal((await s.listRuns(thread.threadId)).length, 2);
  assert.equal(await s.getRun("other_thread", run.runId), null);
});
