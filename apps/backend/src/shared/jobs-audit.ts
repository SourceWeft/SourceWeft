import { randomUUID } from "node:crypto";
import { db, jobsAudit } from "@sourceweft/db";
import { logger } from "./logger";
import { config } from "./config";

export type JobAuditStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type RecordJobAuditInput = {
  teamId: string;
  workspaceId?: string | null;
  jobType: string;
  entityType?: string | null;
  entityId?: string | null;
  status: JobAuditStatus;
  attempts?: number;
  idempotencyKey?: string | null;
  payload?: Record<string, unknown>;
  queueName?: string;
  result?: Record<string, unknown>;
  error?: { name?: string; code?: string; message?: string };
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdBy?: string | null;
};

function safeErrorSummary(error: unknown) {
  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    return {
      name: error.name,
      code: typeof maybeCode === "string" ? maybeCode : undefined,
      message: error.message.split("\n", 1)[0]?.slice(0, 240) || error.name,
    };
  }

  if (error && typeof error === "object") {
    const summary = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const name = typeof summary.name === "string" ? summary.name : undefined;
    const code = typeof summary.code === "string" ? summary.code : undefined;
    const message =
      typeof summary.message === "string" ? summary.message : undefined;

    if (name || code || message) {
      return {
        name,
        code,
        message:
          message?.split("\n", 1)[0]?.slice(0, 240) || name || "Unknown error",
      };
    }
  }

  return {
    message: String(error).split("\n", 1)[0]?.slice(0, 240) ?? "Unknown error",
  };
}

const REDACTED_KEYS = new Set([
  "apiKey",
  "api_key",
  "apikey",
  "authorization",
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
]);

function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    REDACTED_KEYS.has(lower) ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("authorization")
  );
}

function redactValue(key: string, value: unknown): unknown {
  if (shouldRedactKey(key)) {
    return "[REDACTED]";
  }
  if (key.toLowerCase() === "headers" && value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return redactObject(value as Record<string, unknown>);
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => redactValue(`${key}[${idx}]`, item));
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    redacted[key] = redactValue(key, value);
  }
  return redacted;
}

function safePayloadForAudit(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value === null) {
      safe[key] = null;
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = shouldRedactKey(key) ? "[REDACTED]" : value;
      continue;
    }
    if (typeof value === "object") {
      try {
        const serialized = JSON.parse(JSON.stringify(value));
        safe[key] = redactValue(key, serialized);
      } catch {
        safe[key] = "[unserializable]";
      }
      continue;
    }
    safe[key] = String(value);
  }
  return safe;
}

function pickString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function recordJobAudit(input: RecordJobAuditInput) {
  const id = randomUUID();

  try {
    await db
      .insert(jobsAudit)
      .values({
        id,
        teamId: input.teamId,
        workspaceId: input.workspaceId ?? null,
        jobType: input.jobType,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        queueName: input.queueName ?? config.queueName,
        status: input.status,
        attempts: input.attempts ?? 0,
        idempotencyKey: input.idempotencyKey ?? null,
        payloadJson: input.payload ? safePayloadForAudit(input.payload) : {},
        resultJson: input.result ? safePayloadForAudit(input.result) : {},
        errorJson: input.error
          ? safePayloadForAudit(safeErrorSummary(input.error))
          : {},
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoUpdate({
        target: [jobsAudit.teamId, jobsAudit.idempotencyKey],
        set: {
          status: input.status,
          attempts: input.attempts ?? 0,
          resultJson: input.result ? safePayloadForAudit(input.result) : {},
          errorJson: input.error
            ? safePayloadForAudit(safeErrorSummary(input.error))
            : {},
          finishedAt: input.finishedAt ?? null,
        },
      });
  } catch (error) {
    logger.warn("Failed to record job audit", {
      jobType: input.jobType,
      status: input.status,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      error: safeErrorSummary(error),
    });
  }
}

/**
 * Build audit input from a BullMQ job's data payload.
 * Extracts teamId/workspaceId/userId/entityId from the job data.
 */
export function buildAuditInputFromJob(params: {
  jobType: string;
  queueName?: string;
  data: Record<string, unknown>;
  status: JobAuditStatus;
  attempts?: number;
  result?: unknown;
  error?: unknown;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}): RecordJobAuditInput {
  const data = params.data;
  const teamId = pickString(data, "teamId") ?? "unknown";
  const workspaceId = pickString(data, "workspaceId");

  return {
    teamId,
    workspaceId,
    jobType: params.jobType,
    queueName: params.queueName,
    entityType: pickString(data, "entityType") ?? null,
    entityId:
      pickString(data, "sourceId") ??
      pickString(data, "connectorId") ??
      pickString(data, "artifactId") ??
      pickString(data, "threadId") ??
      pickString(data, "runId") ??
      null,
    status: params.status,
    attempts: params.attempts,
    idempotencyKey:
      pickString(data, "idempotencyKey") ??
      pickString(data, "requestKey") ??
      null,
    payload: data,
    result: params.result
      ? typeof params.result === "object"
        ? (params.result as Record<string, unknown>)
        : { value: String(params.result) }
      : undefined,
    error: params.error ? safeErrorSummary(params.error) : undefined,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    createdBy: pickString(data, "userId") ?? null,
  };
}
