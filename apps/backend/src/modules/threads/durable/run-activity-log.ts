import { logger } from "../../../shared/logger";
import { shortId } from "../../../shared/log-ids";
import { metrics } from "../../../shared/metrics";
import type { ChatThreadRunRecord } from "./types";

/**
 * Production activity lines for chat runs: one when a worker wins the
 * queued→running CAS, one when the run reaches a terminal status. Ids are
 * truncated; no request or message content is ever included.
 */
export function logChatRunStarted(
  run: Pick<ChatThreadRunRecord, "id" | "threadId" | "teamId" | "workspaceId">,
) {
  logger.info("chat_run.started", {
    runId: shortId(run.id),
    threadId: shortId(run.threadId),
    teamId: shortId(run.teamId),
    workspaceId: shortId(run.workspaceId),
  });
}

function toTime(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Milliseconds from the run's start (or creation) to its finish; null when unknown. */
export function chatRunDurationMs(
  run: Pick<ChatThreadRunRecord, "startedAt" | "finishedAt" | "createdAt">,
): number | null {
  const finishedAt = toTime(run.finishedAt);
  const startedAt = toTime(run.startedAt) ?? toTime(run.createdAt);
  if (finishedAt === null || startedAt === null) {
    return null;
  }
  return Math.max(0, finishedAt - startedAt);
}

export function logChatRunFinished(
  run: Pick<
    ChatThreadRunRecord,
    | "id"
    | "threadId"
    | "teamId"
    | "workspaceId"
    | "status"
    | "errorCode"
    | "startedAt"
    | "finishedAt"
    | "createdAt"
  >,
) {
  const durationMs = chatRunDurationMs(run);
  logger.info("chat_run.finished", {
    runId: shortId(run.id),
    threadId: shortId(run.threadId),
    teamId: shortId(run.teamId),
    workspaceId: shortId(run.workspaceId),
    status: run.status,
    durationMs,
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
  });
  metrics.inc("chat_run.finished", { status: run.status });
  if (durationMs !== null) {
    metrics.observe("chat_run.duration_ms", durationMs, { status: run.status });
  }
}
