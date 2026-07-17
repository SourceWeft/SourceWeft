import { Worker, type Job } from "bullmq";
import { config } from "../shared/config";
import { buildAuditInputFromJob, recordJobAudit } from "../shared/jobs-audit";
import { logger } from "../shared/logger";
import {
  ensureModelConfigAvailable,
  syncGlobalModelGatewayConfig,
} from "../shared/model-gateway/index";
import { connectionOptions } from "../shared/redis-connection";
import { buildWorkerJobFailureLog } from "./job-failure-log";
import {
  installWorkerProcessErrorGuards,
  runWorkerJobWithIsolation,
} from "./job-isolation";
import { processConnectorSyncJob } from "./processors/connector-sync";
import { processExampleJob } from "./processors/example-job";
import {
  processSourceParseJob,
  processSourceParsePollJob,
} from "./processors/source-parse";
import { processSyncModelPricingJob } from "./processors/sync-model-pricing";
import { processThreadTitleGenerateJob } from "./processors/thread-title";
import { processVideoPresentationGenerateJob } from "./processors/video-presentation";
import {
  failThreadRunAtProcessorBoundary,
  processThreadChatRunJob,
} from "./processors/thread-chat-run";
import { agentSandboxService } from "../modules/threads";

await syncGlobalModelGatewayConfig({ syncPricing: false });
await ensureModelConfigAvailable();

type JobPayload = Record<string, unknown>;
type JobProcessor = (job: Job<JobPayload>) => Promise<unknown>;

const primaryProcessors: Record<string, JobProcessor> = {
  example: processExampleJob,
  "connector-sync": processConnectorSyncJob,
  "source-parse": processSourceParseJob,
  "source-parse-poll": processSourceParsePollJob,
  "sync-model-pricing": processSyncModelPricingJob,
  "thread-chat-run": processThreadChatRunJob,
  "thread-title-generate": processThreadTitleGenerateJob,
};

const deliverableProcessors: Record<string, JobProcessor> = {
  "video-presentation-generate": processVideoPresentationGenerateJob,
};

async function runIsolatedJob(
  job: Job<JobPayload>,
  processors: Record<string, JobProcessor>,
) {
  const processor = processors[job.name];
  if (!processor) {
    throw new Error(`Unknown job type: ${job.name}`);
  }
  return runWorkerJobWithIsolation(job, processor);
}

installWorkerProcessErrorGuards({
  persistThreadRunFailure: ({ payload, error }) =>
    failThreadRunAtProcessorBoundary({ payload, error }),
});

const primaryWorker = new Worker<JobPayload>(
  config.queueName,
  async (job: Job<JobPayload>) => runIsolatedJob(job, primaryProcessors),
  {
    connection: connectionOptions,
    concurrency: config.workerConcurrency,
  },
);

const deliverablesWorker = new Worker<JobPayload>(
  config.deliverablesQueueName,
  async (job: Job<JobPayload>) => runIsolatedJob(job, deliverableProcessors),
  {
    connection: connectionOptions,
    concurrency: config.deliverablesWorkerConcurrency,
  },
);

function registerWorkerListeners(
  worker: Worker<JobPayload>,
  queueName: string,
) {
  worker.on("active", (job: Job<JobPayload>) => {
    void recordJobAudit(
      buildAuditInputFromJob({
        jobId: String(job.id),
        jobType: job.name,
        queueName,
        data: job.data,
        status: "running",
        attempts: job.attemptsMade + 1,
        startedAt: new Date(),
      }),
    );
  });

  worker.on("completed", (job: Job<JobPayload>, returnvalue: unknown) => {
    logger.info("Job completed", {
      jobId: String(job.id),
      type: job.name,
    });
    void recordJobAudit(
      buildAuditInputFromJob({
        jobId: String(job.id),
        jobType: job.name,
        queueName,
        data: job.data,
        status: "succeeded",
        attempts: job.attemptsMade + 1,
        result: returnvalue,
        startedAt: job.processedOn ? new Date(job.processedOn) : null,
        finishedAt: new Date(),
      }),
    );
  });

  worker.on("failed", (job: Job<JobPayload> | undefined, error: Error) => {
    logger.error("Job failed", buildWorkerJobFailureLog(job, error));
    if (job) {
      void recordJobAudit(
        buildAuditInputFromJob({
          jobId: String(job.id),
          jobType: job.name,
          queueName,
          data: job.data,
          status: "failed",
          attempts: job.attemptsMade + 1,
          error,
          startedAt: job.processedOn ? new Date(job.processedOn) : null,
          finishedAt: new Date(),
        }),
      );
    }
  });

  worker.on("error", (error: Error) => {
    logger.error("Worker runtime error", {
      error: error.message,
      errorName: error.name,
      stack: error.stack,
    });
  });

  worker.on("stalled", (jobId: string) => {
    logger.warn("Job stalled", { jobId });
  });
}

registerWorkerListeners(primaryWorker, config.queueName);
registerWorkerListeners(deliverablesWorker, config.deliverablesQueueName);

logger.info("Primary worker started", {
  queueName: config.queueName,
  concurrency: config.workerConcurrency,
});
logger.info("Deliverables worker started", {
  queueName: config.deliverablesQueueName,
  concurrency: config.deliverablesWorkerConcurrency,
});
agentSandboxService.logStartupWarning("worker");

async function shutdown() {
  logger.info("Worker shutting down");
  await Promise.all([primaryWorker.close(), deliverablesWorker.close()]);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
