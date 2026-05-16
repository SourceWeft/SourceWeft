import { Worker, type Job } from "bullmq";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import {
  ensureModelConfigAvailable,
  syncGlobalModelGatewayConfig,
} from "../shared/model-gateway/index";
import { connectionOptions } from "../shared/redis-connection";
import { buildWorkerJobFailureLog } from "./job-failure-log";
import { processConnectorSyncJob } from "./processors/connector-sync";
import { processExampleJob } from "./processors/example-job";
import {
  processSourceParseJob,
  processSourceParsePollJob,
} from "./processors/source-parse";
import { processSyncModelPricingJob } from "./processors/sync-model-pricing";
import { processThreadTitleGenerateJob } from "./processors/thread-title";
import { processThreadChatRunJob } from "./processors/thread-chat-run";

await syncGlobalModelGatewayConfig();
await ensureModelConfigAvailable();

type JobPayload = Record<string, unknown>;

const processors: Record<string, (job: Job<JobPayload>) => Promise<unknown>> = {
  example: processExampleJob,
  "connector-sync": processConnectorSyncJob,
  "source-parse": processSourceParseJob,
  "source-parse-poll": processSourceParsePollJob,
  "sync-model-pricing": processSyncModelPricingJob,
  "thread-chat-run": processThreadChatRunJob,
  "thread-title-generate": processThreadTitleGenerateJob,
};

const defaultProcessor: (job: Job<JobPayload>) => Promise<unknown> =
  processExampleJob;

const worker = new Worker<JobPayload>(
  config.queueName,
  async (job: Job<JobPayload>) => {
    const processor = processors[job.name] ?? defaultProcessor;
    return processor(job);
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
  logger.error("Job failed", buildWorkerJobFailureLog(job, error));
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
