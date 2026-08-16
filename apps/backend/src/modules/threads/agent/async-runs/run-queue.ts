/**
 * BullMQ transport for async runs: enqueue a run and a worker that drives it
 * through {@link processRun}. Reuses the shared ioredis `connectionOptions`, so
 * runs execute as background jobs on the same infra as the rest of the app.
 *
 * The graph execution itself is the injected {@link RunExecutor}; the real one
 * compiles + runs the delegate graph (wired with the run's billing/tenancy
 * config), which is added with the endpoint. This module owns only the
 * enqueue/dequeue plumbing.
 */
import { Queue, Worker } from "bullmq";
import { connectionOptions } from "../../../../shared/redis-connection";
import {
  processRun,
  type RunExecutor,
  type RunLifecycleStore,
} from "./run-processor";

export const ASYNC_RUNS_QUEUE = "async-runs";

export interface RunJobData {
  runId: string;
  threadId: string;
  graphId: string;
}

export function createRunQueue(
  queueName: string = ASYNC_RUNS_QUEUE,
): Queue<RunJobData> {
  return new Queue<RunJobData>(queueName, { connection: connectionOptions });
}

export async function enqueueRun(
  queue: Queue<RunJobData>,
  data: RunJobData,
): Promise<void> {
  await queue.add("run", data, {
    removeOnComplete: true,
    removeOnFail: 100,
    // Crash recovery: if a worker dies mid-run, the job is retried rather than
    // left as a run stuck in `running`. Re-running is safe — `processRun`
    // re-checks terminal status and never overwrites one, and the delegate graph
    // resumes from its checkpoint instead of restarting (so completed model
    // calls aren't repeated). Legitimate executor *errors* don't retry: the
    // processor catches them and resolves the job, so `attempts` only ever fires
    // on a true crash/stall.
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  });
}

/**
 * A worker that processes run jobs. `store` and `executor` are injected so the
 * transport is testable with a stub executor; production passes the Postgres
 * store and the delegate-graph executor.
 */
export function createRunWorker(input: {
  queueName?: string;
  store: RunLifecycleStore;
  executor: RunExecutor;
}): Worker<RunJobData> {
  return new Worker<RunJobData>(
    input.queueName ?? ASYNC_RUNS_QUEUE,
    async (job) => {
      await processRun({
        store: input.store,
        executor: input.executor,
        threadId: job.data.threadId,
        runId: job.data.runId,
      });
    },
    { connection: connectionOptions },
  );
}
