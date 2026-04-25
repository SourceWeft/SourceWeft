import { Worker, type Job } from "bullmq";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { ensureModelConfigAvailable } from "../shared/model-gateway";
import { connectionOptions } from "../shared/redis-connection";
import { processExampleJob } from "./processors/example-job";
import {
  processSourceParseJob,
  processSourceParsePollJob,
} from "./processors/source-parse";
import { processSyncModelPricingJob } from "./processors/sync-model-pricing";

await ensureModelConfigAvailable();

type JobPayload = Record<string, unknown>;

const processors: Record<string, (job: Job<JobPayload>) => Promise<void>> = {
  example: processExampleJob,
  "source-parse": processSourceParseJob,
  "source-parse-poll": processSourceParsePollJob,
  "sync-model-pricing": processSyncModelPricingJob,
};

const defaultProcessor: (job: Job<JobPayload>) => Promise<void> =
  processExampleJob;

const worker = new Worker<JobPayload>(
  config.queueName,
  async (job: Job<JobPayload>) => {
    const processor = processors[job.name] ?? defaultProcessor;
    await processor(job);
  },
  {
    connection: connectionOptions,
    concurrency: config.workerConcurrency,
  },
);

worker.on("completed", (job: Job<JobPayload>) => {
  logger.info("Job completed", {
    jobId: String(job.id),
    type: job.name,
  });
});

worker.on("failed", (job: Job<JobPayload> | undefined, error: Error) => {
  logger.error("Job failed", {
    jobId: job?.id ? String(job.id) : "unknown",
    type: job?.name || "unknown",
    error: error.message,
  });
});

logger.info("Worker started", {
  queueName: config.queueName,
  concurrency: config.workerConcurrency,
});

async function shutdown() {
  logger.info("Worker shutting down");
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
