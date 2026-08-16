/**
 * Worker-side startup for background delegate runs (worker process only).
 *
 * Builds the durable {@link PostgresRunsStore}, the real {@link RunExecutor}
 * (compiles + invokes the delegate graph with a billed model + tenant backend
 * rebuilt from the run's stored context), and the BullMQ worker that drives them
 * through {@link processRun}. Gated by the same flag as the endpoint, so a
 * default deployment starts nothing.
 *
 * The store instance is shared between the executor's context resolver
 * (`getRunConfig`) and the worker's lifecycle calls (`getRun`/`transition`/
 * `saveResult`), so a run's config, status, and result all live in one place.
 */
import type { Worker } from "bullmq";
import { database } from "@sourceweft/db";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { PostgresRunsStore } from "../modules/threads/agent/async-runs/postgres-store";
import {
  ASYNC_RUNS_QUEUE,
  createRunWorker,
  type RunJobData,
} from "../modules/threads/agent/async-runs/run-queue";
import { createDelegateRunExecutor } from "../modules/threads/agent/async-runs/delegate-executor";
import { createDelegateRunContextResolver } from "../modules/threads/agent/async-runs/run-context-resolver";

export async function startAsyncRunsWorker(): Promise<Worker<RunJobData> | null> {
  if (!config.chat.agent.asyncSubagentsEnabled) {
    return null;
  }
  const store = new PostgresRunsStore(database);
  await store.ensureSchema();
  const resolver = createDelegateRunContextResolver({ store });
  const worker = createRunWorker({
    store,
    executor: createDelegateRunExecutor(resolver),
  });
  logger.info("Async-runs worker started", { queueName: ASYNC_RUNS_QUEUE });
  return worker;
}
