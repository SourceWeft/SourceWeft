import type { Job } from "bullmq";
import { isConnectorError } from "../modules/connectors/errors";
import { isContentError } from "../modules/content/errors";

type LoggableJob = Pick<
  Job<Record<string, unknown>>,
  "id" | "name" | "data" | "attemptsMade" | "opts"
>;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickSourceParsePayload(data: Record<string, unknown>) {
  return {
    sourceId: stringValue(data.sourceId),
    sourceRevisionId: stringValue(data.sourceRevisionId),
    workspaceId: stringValue(data.workspaceId),
    teamId: stringValue(data.teamId),
    userId: stringValue(data.userId),
    idempotencyKey: stringValue(data.idempotencyKey),
    forceRefresh: data.forceRefresh === true,
  };
}

function pickSourceParsePollPayload(data: Record<string, unknown>) {
  return {
    ...pickSourceParsePayload(data),
    backendId: stringValue(data.backendId),
    taskId: stringValue(data.taskId),
    mimeType: stringValue(data.mimeType),
    attempt: numberValue(data.attempt),
  };
}

function pickThreadTitlePayload(data: Record<string, unknown>) {
  return {
    threadId: stringValue(data.threadId),
    userMessageId: stringValue(data.userMessageId),
    workspaceId: stringValue(data.workspaceId),
    teamId: stringValue(data.teamId),
    profileAlias: stringValue(data.profileAlias),
    modelAlias: stringValue(data.modelAlias),
    gatewayConfigId: stringValue(data.gatewayConfigId),
  };
}

function safePayloadForJob(job: LoggableJob): Record<string, unknown> | null {
  switch (job.name) {
    case "source-parse":
      return pickSourceParsePayload(job.data);
    case "source-parse-poll":
      return pickSourceParsePollPayload(job.data);
    case "thread-title-generate":
      return pickThreadTitlePayload(job.data);
    default:
      return {
        dataKeys: Object.keys(job.data).sort(),
      };
  }
}

export function buildWorkerJobFailureLog(
  job: LoggableJob | undefined,
  error: Error,
) {
  const context: Record<string, unknown> = {
    jobId: job?.id ? String(job.id) : "unknown",
    type: job?.name || "unknown",
    attemptsMade: job?.attemptsMade ?? null,
    maxAttempts: job?.opts.attempts ?? 1,
    retrying:
      job && job.attemptsMade < (job.opts.attempts ?? 1)
        ? true
        : false,
    error: error.message,
    errorName: error.name,
    stack: error.stack,
  };

  if (job) {
    context.payload = safePayloadForJob(job);
  }

  if (isContentError(error)) {
    context.errorCode = error.code;
    context.errorStatusCode = error.statusCode;
  }

  if (isConnectorError(error)) {
    context.errorCode = error.code;
    context.errorStatusCode = error.statusCode;
  }

  return context;
}
