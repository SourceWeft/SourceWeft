/**
 * End-to-end transport test against REAL Redis + REAL Postgres: enqueue a run
 * and assert the BullMQ worker drives it to a terminal status via processRun.
 * Uses a dedicated test queue so it never touches the app's real queues.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import type { Queue, Worker } from "bullmq";
import { Pool } from "pg";
import { PostgresRunsStore } from "./postgres-store";
import type { AsyncRunStatus } from "./types";
import { isTerminalRunStatus } from "./run-state";
import {
  createRunQueue,
  createRunWorker,
  enqueueRun,
  type RunJobData,
} from "./run-queue";

const TEST_QUEUE = "async-runs-test";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresRunsStore(pool);
const createdThreads: string[] = [];
let queue: Queue<RunJobData> | undefined;
let worker: Worker<RunJobData> | undefined;

afterAll(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  for (const threadId of createdThreads) {
    await store.deleteThread(threadId);
  }
  await pool.end();
});

async function pollUntilTerminal(
  threadId: string,
  runId: string,
  timeoutMs = 8000,
): Promise<AsyncRunStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await store.getRun(threadId, runId);
    if (run && isTerminalRunStatus(run.status)) {
      return run.status;
    }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} did not finish; last=${run?.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("an enqueued run is processed to success by the worker", async () => {
  await store.ensureSchema();
  const thread = await store.createThread();
  createdThreads.push(thread.threadId);
  const run = await store.createRun({
    threadId: thread.threadId,
    graphId: "explore",
    multitaskStrategy: "reject",
  });

  queue = createRunQueue(TEST_QUEUE);
  worker = createRunWorker({
    queueName: TEST_QUEUE,
    store,
    executor: async () => {
      /* the delegate graph ran */
    },
  });

  await enqueueRun(queue, {
    runId: run.runId,
    threadId: thread.threadId,
    graphId: "explore",
  });

  const status = await pollUntilTerminal(thread.threadId, run.runId);
  assert.equal(status, "success");
});
