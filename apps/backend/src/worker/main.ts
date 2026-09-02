import { Worker, type Job } from "bullmq";
import { config } from "../shared/config";
import { buildAuditInputFromJob, recordJobAudit } from "../shared/jobs-audit";
import { logger } from "../shared/logger";
import {
  ensureModelConfigAvailable,
  modelCatalog,
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
import { processProviderCostReconciliationJob } from "./processors/provider-cost-reconciliation";
import { processThreadTitleGenerateJob } from "./processors/thread-title";
import { handleDeliverableJobFailure } from "./deliverable-host/job-failure-boundary";
import { buildDeliverableProcessorMap } from "./deliverable-host/registry";
import {
  failThreadRunAtProcessorBoundary,
  processThreadChatRunJob,
} from "./processors/thread-chat-run";
import { agentSandboxService } from "../modules/threads";
import { connectorAdaptersReady } from "../modules/connectors";

await syncGlobalModelGatewayConfig({ syncPricing: false });
modelCatalog.startAutoRefresh(config.modelCatalogRefreshIntervalMs);
await ensureModelConfigAvailable();
// Connectors are contributed by capabilities, so registering them reads
// manifests. Await it before serving so the registry is never consulted empty.
await connectorAdaptersReady();

type JobPayload = Record<string, unknown>;
type JobProcessor = (job: Job<JobPayload>) => Promise<unknown>;

const primaryProcessors: Record<string, JobProcessor> = {
  example: processExampleJob,
  "connector-sync": processConnectorSyncJob,
  "source-parse": processSourceParseJob,
  "source-parse-poll": processSourceParsePollJob,
  "sync-model-pricing": processSyncModelPricingJob,
  "reconcile-provider-cost": processProviderCostReconciliationJob,
  "thread-chat-run": processThreadChatRunJob,
  "thread-title-generate": processThreadTitleGenerateJob,
};

// Deliverable pipelines are capability-owned: the registry discovers them
// from capability manifests (falling back to the builtin module map inside
// the registry). main.ts stays capability-agnostic.
const deliverableRegistry = await buildDeliverableProcessorMap();
const deliverableProcessors: Record<string, JobProcessor> =
  deliverableRegistry.processors;
const deliverableFailureCodes = deliverableRegistry.failureCodes;
logger.info("Registered deliverable pipelines", {
  jobNames: Object.keys(deliverableProcessors),
  source: deliverableRegistry.source,
});

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

// How long a job's Redis lock stays valid without renewal before BullMQ
// declares it stalled and redelivers it. Both workers share this process, so
// CPU-heavy deliverable work can starve the event loop past the 30s default
// and get live jobs mass-redelivered as "stalled". Must
// stay below STALE_ACTIVE_RUN_TIMEOUT_MS (10min) so redelivery happens while
// the run-level heartbeat check can still tell a live execution from a dead
// one.
const WORKER_LOCK_DURATION_MS = 5 * 60_000;

const primaryWorker = new Worker<JobPayload>(
  config.queueName,
  async (job: Job<JobPayload>) => runIsolatedJob(job, primaryProcessors),
  {
    connection: connectionOptions,
    concurrency: config.workerConcurrency,
    lockDuration: WORKER_LOCK_DURATION_MS,
  },
);

const deliverablesWorker = new Worker<JobPayload>(
  config.deliverablesQueueName,
  async (job: Job<JobPayload>) => runIsolatedJob(job, deliverableProcessors),
  {
    connection: connectionOptions,
    concurrency: config.deliverablesWorkerConcurrency,
    lockDuration: WORKER_LOCK_DURATION_MS,
  },
);

function registerWorkerListeners(
  worker: Worker<JobPayload>,
  queueName: string,
) {
  worker.on("active", (job: Job<JobPayload>) => {
    void recordJobAudit(
      buildAuditInputFromJob({
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

// Deliverable jobs that die outside the processor (stalled on worker
// restart/crash, BullMQ-level failures) never reach the host's catch block —
// mark their artifacts failed so they don't stay "running" forever.
deliverablesWorker.on(
  "failed",
  (job: Job<JobPayload> | undefined, error: Error) => {
    if (!job) {
      return;
    }
    void (async () => {
      const [{ failArtifact }, { ArtifactError }] = await Promise.all([
        import("../modules/artifacts/publish"),
        import("@sourceweft/contracts/artifact-errors"),
      ]);
      await handleDeliverableJobFailure({
        jobName: job.name,
        attemptsMade: job.attemptsMade ?? 0,
        maxAttempts: job.opts?.attempts ?? 1,
        data: job.data,
        error,
        failureCodes: deliverableFailureCodes,
        // Same door the in-processor failure path uses. Team/workspace come out
        // of an untyped job payload here and may be absent, which is why the
        // writer's tenancy scoping is optional.
        markFailed: (input) =>
          failArtifact({
            artifactId: input.artifactId,
            context: {
              ...(input.teamId ? { teamId: input.teamId } : {}),
              ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            },
            error: new ArtifactError({
              code: input.errorCode,
              message: input.errorMessage,
            }),
            ...(input.expectedStatuses
              ? { expectedStatuses: input.expectedStatuses }
              : {}),
          }),
      });
    })();
  },
);

logger.info("Primary worker started", {
  queueName: config.queueName,
  concurrency: config.workerConcurrency,
});
logger.info("Deliverables worker started", {
  queueName: config.deliverablesQueueName,
  concurrency: config.deliverablesWorkerConcurrency,
});
void agentSandboxService.logStartupWarning("worker");

async function shutdown() {
  logger.info("Worker shutting down");
  await Promise.all([
    primaryWorker.close(),
    deliverablesWorker.close(),
  ]);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
