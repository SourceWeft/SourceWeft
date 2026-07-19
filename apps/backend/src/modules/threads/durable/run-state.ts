import { ContentError } from "../../content/errors";
import { isActiveChatRunStatus } from "./repository";
import type { ChatThreadRunRecord, ChatThreadRunStatus } from "./types";
import {
  getSnapshotRecord,
  hasPendingConfirmations,
  parseStringArray,
  type RunSnapshotSource,
} from "./snapshot";
import {
  CLIENT_CANCELLED_CODE,
  CLIENT_CANCELLED_MESSAGE,
  ORPHANED_QUEUED_RUN_GRACE_MS,
  STALE_ACTIVE_RUN_TIMEOUT_MS,
  STALE_CHAT_RUN_CODE,
} from "./run-constants";

export function isTerminalRunStatus(status: ChatThreadRunRecord["status"]) {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function shouldCompleteApprovalRunWithoutPendingConfirmations(
  run: ChatThreadRunRecord,
) {
  return (
    run.status === "waiting_for_approval" &&
    !hasPendingConfirmations(getSnapshotRecord(run).toolCalls)
  );
}

export function getRunApprovalPauseState(run: RunSnapshotSource) {
  const snapshot = getSnapshotRecord(run);
  return {
    requestedAt:
      typeof snapshot.approvalRequestedAt === "string"
        ? snapshot.approvalRequestedAt
        : null,
    expiresAt:
      typeof snapshot.approvalExpiresAt === "string"
        ? snapshot.approvalExpiresAt
        : null,
    confirmationIds: parseStringArray(snapshot.pendingConfirmationIds),
  };
}

export function isApprovalWaitingRunExpired(
  run: ChatThreadRunRecord,
  nowMs = Date.now(),
) {
  if (run.status !== "waiting_for_approval") {
    return false;
  }
  const expiresAtMs = parseRunTimestamp(
    getRunApprovalPauseState(run).expiresAt,
  );
  return expiresAtMs !== null && nowMs >= expiresAtMs;
}

export function toTerminalJobStatus(status: ChatThreadRunStatus) {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "cancelled";
}

export function toTerminalRunError(run: ChatThreadRunRecord) {
  if (run.status === "cancelled") {
    return new ContentError(
      499,
      run.errorCode ?? CLIENT_CANCELLED_CODE,
      run.errorMessage ?? CLIENT_CANCELLED_MESSAGE,
    );
  }
  if (run.status === "failed") {
    return new ContentError(
      500,
      run.errorCode ?? "CHAT_RUN_FAILED",
      run.errorMessage ?? "Chat run failed",
    );
  }
  return null;
}

function parseRunTimestamp(value: string | null) {
  if (!value) {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

export function isStaleActiveRun(run: ChatThreadRunRecord, nowMs = Date.now()) {
  if (!isActiveChatRunStatus(run.status)) {
    return false;
  }
  if (run.status === "waiting_for_approval") {
    return false;
  }

  if (run.status === "queued" && !run.jobId) {
    const createdAtMs = parseRunTimestamp(run.createdAt);
    return (
      createdAtMs !== null && nowMs - createdAtMs > ORPHANED_QUEUED_RUN_GRACE_MS
    );
  }

  const heartbeatAtMs =
    parseRunTimestamp(run.heartbeatAt) ??
    parseRunTimestamp(run.updatedAt) ??
    parseRunTimestamp(run.startedAt) ??
    parseRunTimestamp(run.createdAt);
  return (
    heartbeatAtMs !== null &&
    nowMs - heartbeatAtMs > STALE_ACTIVE_RUN_TIMEOUT_MS
  );
}

export function isUniqueConstraintError(error: unknown, constraint: string) {
  const record =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : null;
  return record?.code === "23505" && record.constraint === constraint;
}

export function parseSsePayload(
  payload: string,
): Record<string, unknown> | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("data: ")) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice("data: ".length)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export function synthesizeTerminalRunEvents(input: {
  run: ChatThreadRunRecord;
  sawErrorEvent: boolean;
}) {
  const events: string[] = [];
  const terminalError =
    input.run.errorCode === STALE_CHAT_RUN_CODE
      ? null
      : toTerminalRunError(input.run);
  if (terminalError && !input.sawErrorEvent) {
    events.push(
      `data: ${JSON.stringify({
        type: "error",
        code: terminalError.code,
        error: terminalError.message,
        ...(input.run.userMessageId
          ? { userMessageId: input.run.userMessageId }
          : {}),
        ...(input.run.assistantMessageId
          ? { messageId: input.run.assistantMessageId }
          : {}),
      })}\n\n`,
    );
  }
  events.push(`data: ${JSON.stringify({ type: "finish" })}\n\n`);
  return events;
}
