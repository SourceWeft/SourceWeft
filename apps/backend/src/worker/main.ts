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
import { processVideoPresentationRenderJob } from "./processors/video-presentation-render";
import {
  VIDEO_PRESENTATION_RENDER_JOB,
  type VideoPresentationRenderJobPayload,
} from "../modules/content/queue";
import {
  findArtifactRecord,
  markArtifactFailed,
} from "../modules/content/artifacts/repository";
import { logSandboxStartupWarning } from "../modules/content/agent/sandbox/startup-log";

await syncGlobalModelGatewayConfig({ syncPricing: false });
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
  "video-presentation-render": processVideoPresentationRenderJob,
};

const defaultProcessor: (job: Job<JobPayload>) => Promise<unknown> =
  processExampleJob;

function isVideoPresentationRenderPayload(
  value: unknown,
): value is VideoPresentationRenderJobPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.artifactId === "string" &&
    typeof record.teamId === "string" &&
    typeof record.workspaceId === "string"
  );
}

function buildExternalVideoFailurePayload(input: {
  currentPayload: Record<string, unknown>;
  errorCode: string;
  errorMessage: string;
  jobId: string;
}) {
  return {
    ...input.currentPayload,
    jobId: input.currentPayload.jobId ?? input.jobId,
    generation: {
      status: "failed",
      stage: "project_failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    },
  };
}

async function markVideoPresentationJobFailedFromWorkerEvent(input: {
  job: Job<JobPayload> | undefined;
  error: Error;
}) {
  const job = input.job;
  if (!job || job.name !== VIDEO_PRESENTATION_RENDER_JOB) {
    return;
  }
  if (!isVideoPresentationRenderPayload(job.data)) {
    return;
  }
  const payload = job.data;
  const artifact = await findArtifactRecord({
    artifactId: payload.artifactId,
    teamId: payload.teamId,
    workspaceId: payload.workspaceId,
  }).catch((error) => {
    logger.error("Video presentation failed-event artifact lookup failed", {
      artifactId: payload.artifactId,
      jobId: String(job.id ?? job.name),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (!artifact || artifact.status === "ready" || artifact.status === "failed") {
    return;
  }
  const errorCode = "VIDEO_PRESENTATION_RENDER_FAILED";
  const errorMessage =
    input.error.message.split("\n", 1)[0]?.slice(0, 500) ||
    "Video presentation render job failed.";
  const currentPayload =
    artifact.payloadJson && typeof artifact.payloadJson === "object"
      ? (artifact.payloadJson as Record<string, unknown>)
      : {};
  await markArtifactFailed({
    artifactId: payload.artifactId,
    teamId: payload.teamId,
    workspaceId: payload.workspaceId,
    expectedStatuses: ["pending", "running"],
    errorCode,
    errorMessage,
    payload: buildExternalVideoFailurePayload({
      currentPayload,
      errorCode,
      errorMessage,
      jobId: String(job.id ?? job.name),
    }),
  }).catch((error) => {
    logger.error("Video presentation failed-event artifact update failed", {
      artifactId: payload.artifactId,
      jobId: String(job.id ?? job.name),
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function runIsolatedJob(job: Job<JobPayload>) {
  const processor = processors[job.name] ?? defaultProcessor;
  try {
    return await processor(job);
  } catch (error) {
    logger.error(
      "Job processor failed",
      buildWorkerJobFailureLog(
        job,
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    throw error;
  }
}

const worker = new Worker<JobPayload>(
  config.queueName,
  async (job: Job<JobPayload>) => runIsolatedJob(job),
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
  void markVideoPresentationJobFailedFromWorkerEvent({ job, error });
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

logger.info("Worker started", {
  queueName: config.queueName,
  concurrency: config.workerConcurrency,
});
logSandboxStartupWarning("worker");

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
