import { AsyncLocalStorage } from "node:async_hooks";
import type { Job } from "bullmq";
import { isConnectorError } from "../modules/connectors/errors";
import { isContentError } from "../modules/content/errors";
import type { ThreadChatRunJobPayload } from "../modules/content/queue";
import { logger } from "../shared/logger";
import { buildWorkerJobFailureLog } from "./job-failure-log";

type JobPayload = Record<string, unknown>;
type WorkerJob = Job<JobPayload>;
type WorkerJobProcessor = (job: WorkerJob) => Promise<unknown>;

export type WorkerJobContext = {
  job: WorkerJob;
  jobId: string;
  jobName: string;
};

export type PersistThreadRunFailureInput = {
  error: Error;
  payload: ThreadChatRunJobPayload;
};

export type PersistThreadRunFailure = (
  input: PersistThreadRunFailureInput,
) => Promise<unknown>;

const activeWorkerJobs = new Map<string, WorkerJobContext>();
const workerJobStorage = new AsyncLocalStorage<WorkerJobContext>();

export function normalizeWorkerRuntimeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessages(error: unknown): string[] {
  const normalized = normalizeWorkerRuntimeError(error);
  const messages = [normalized.message, normalized.name].filter(Boolean);
  const cause = (normalized as Error & { cause?: unknown }).cause;
  if (cause) {
    messages.push(...errorMessages(cause));
  }
  return messages;
}

export function isRecoverableWorkerRuntimeError(error: unknown) {
  const normalized = normalizeWorkerRuntimeError(error);
  if (isContentError(normalized) || isConnectorError(normalized)) {
    return true;
  }

  const text = errorMessages(normalized).join("\n").toLowerCase();
  return (
    normalized.name === "MiddlewareError" ||
    text.includes("middlewareerror") ||
    text.includes("error invoking tool") ||
    text.includes("sandbox_") ||
    text.includes("provider") ||
    text.includes("toolnode") ||
    text.includes("langgraph") ||
    text.includes("langchain")
  );
}

function contextForJob(job: WorkerJob): WorkerJobContext {
  return {
    job,
    jobId: job.id ? String(job.id) : "unknown",
    jobName: job.name,
  };
}

export function currentWorkerJobContext() {
  return workerJobStorage.getStore() ?? null;
}

export function activeWorkerJobContexts() {
  return Array.from(activeWorkerJobs.values());
}

function singleActiveWorkerJobContext() {
  const contexts = activeWorkerJobContexts();
  return contexts.length === 1 ? contexts[0]! : null;
}

export async function runWorkerJobWithIsolation(
  job: WorkerJob,
  processor: WorkerJobProcessor,
) {
  const context = contextForJob(job);
  activeWorkerJobs.set(context.jobId, context);
  try {
    return await workerJobStorage.run(context, () => processor(job));
  } catch (error) {
    const normalized = normalizeWorkerRuntimeError(error);
    logger.error("Job processor failed", {
      ...buildWorkerJobFailureLog(job, normalized),
      recoverableRuntimeError: isRecoverableWorkerRuntimeError(normalized),
    });
    throw normalized;
  } finally {
    activeWorkerJobs.delete(context.jobId);
  }
}

function threadChatRunPayload(data: JobPayload): ThreadChatRunJobPayload | null {
  return typeof data.runId === "string" &&
    typeof data.teamId === "string" &&
    typeof data.workspaceId === "string"
    ? (data as ThreadChatRunJobPayload)
    : null;
}

export async function handleUnhandledWorkerRuntimeError(input: {
  error: unknown;
  event: "unhandledRejection" | "uncaughtException";
  jobContext?: WorkerJobContext | null;
  persistThreadRunFailure?: PersistThreadRunFailure;
}) {
  const error = normalizeWorkerRuntimeError(input.error);
  const context =
    input.jobContext ?? currentWorkerJobContext() ?? singleActiveWorkerJobContext();
  const recoverableRuntimeError = isRecoverableWorkerRuntimeError(error);

  logger.error("Unhandled worker runtime error", {
    ...buildWorkerJobFailureLog(context?.job, error),
    processEvent: input.event,
    recoverableRuntimeError,
    activeJobCount: activeWorkerJobs.size,
  });

  if (
    context?.job.name === "thread-chat-run" &&
    input.persistThreadRunFailure
  ) {
    const payload = threadChatRunPayload(context.job.data);
    if (payload) {
      try {
        await input.persistThreadRunFailure({ payload, error });
      } catch (persistError) {
        logger.error("Failed to persist thread run after unhandled worker error", {
          jobId: context.jobId,
          type: context.jobName,
          error:
            persistError instanceof Error
              ? persistError.message
              : String(persistError),
        });
      }
    }
  }
}

export function installWorkerProcessErrorGuards(input: {
  persistThreadRunFailure?: PersistThreadRunFailure;
}) {
  const handleRejection = (reason: unknown) => {
    void handleUnhandledWorkerRuntimeError({
      error: reason,
      event: "unhandledRejection",
      persistThreadRunFailure: input.persistThreadRunFailure,
    });
  };
  const handleException = (error: Error) => {
    void handleUnhandledWorkerRuntimeError({
      error,
      event: "uncaughtException",
      persistThreadRunFailure: input.persistThreadRunFailure,
    });
  };

  process.on("unhandledRejection", handleRejection);
  process.on("uncaughtException", handleException);

  return () => {
    process.off("unhandledRejection", handleRejection);
    process.off("uncaughtException", handleException);
  };
}
