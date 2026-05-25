import { ContentError } from "../../errors";
import { requireContentWorkspace } from "../../content-support";
import {
  enqueueThreadChatRunJob,
  type ThreadChatRunJobPayload,
} from "../../queue";
import { config } from "../../../../shared/config";
import {
  findMessageRecord,
  updateMessageRecord,
} from "../message-repository";
import { findThreadRecord } from "../thread/repository";
import type {
  EditThreadInput,
  RefreshThreadInput,
  ResumeThreadInput,
} from "../stream/types";
import type { StreamThreadEventInput, ToolCallTrace } from "../turn/types";
import {
  createChatThreadRun,
  findActiveChatThreadRun,
  findChatThreadRunById,
  findChatThreadRunByIdempotencyKey,
  listExpiredApprovalWaitingRuns,
  finishChatThreadRun,
  isActiveChatRunStatus,
  markChatThreadRunWaitingForApproval,
  markChatThreadRunQueued,
  markChatThreadRunRunning,
  requestChatThreadRunCancel,
  touchChatThreadRunHeartbeat,
  updateChatThreadRunProgress,
  updateChatThreadRunStatus,
} from "./repository";
import {
  findActionRunRecordById,
  updateActionRunRecord,
} from "../../../connectors/repository";
import {
  findMcpActionRun,
  updateMcpActionRun,
} from "../../../mcp/repository";
import {
  chatRunStreamManager,
  type ChatRunStreamEvent,
} from "./stream-manager";
import { SOURCEWEFT_WEB_RUN_STOP_SUFFIX } from "./constants";
import type {
  ChatRunSnapshot,
  ChatThreadRunMode,
  ChatThreadRunRecord,
  ChatThreadRunStatus,
  DurableRunRequestSnapshot,
} from "./types";
import type {
  EmbeddingVectorStrategy,
  MessageRecord,
  ThreadRecord,
} from "../../types";
import { preserveTraceMetadata } from "../turn/trace-metadata";
import {
  normalizeTraceParts,
  tracePartFromToolCall,
  upsertTracePart,
  type TracePart,
} from "../turn/trace-parts";
import { logger } from "../../../../shared/logger";

type RunSnapshotSource = {
  snapshotJson?: Record<string, unknown> | null;
};

const ATTACH_POLL_MS = 100;
const ATTACH_HEARTBEAT_MS = 15_000;
const RESULT_POLL_MS = 200;
const STOP_RESULT_WAIT_TIMEOUT_MS = 10_000;
const COMPLETE_RESULT_WAIT_TIMEOUT_MS = 120_000;
const ORPHANED_QUEUED_RUN_GRACE_MS = 10_000;
const STALE_ACTIVE_RUN_TIMEOUT_MS = 10 * 60_000;
const CLIENT_CANCELLED_CODE = "CLIENT_CANCELLED";
const CLIENT_CANCELLED_MESSAGE = "Chat run was cancelled";
const STALE_CHAT_RUN_CODE = "CHAT_RUN_STALE";
const TOOL_APPROVAL_EXPIRED_CODE = "TOOL_APPROVAL_EXPIRED";
const TOOL_APPROVAL_EXPIRED_MESSAGE = "Tool approval request expired";
const ACTIVE_RUN_CONSTRAINT = "chat_thread_runs_thread_active_uq";
const EXPIRED_APPROVAL_SWEEP_LIMIT = 100;

function wait(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTerminalRunStatus(status: ChatThreadRunRecord["status"]) {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function getSnapshotRecord(run: RunSnapshotSource): ChatRunSnapshot {
  return run.snapshotJson && typeof run.snapshotJson === "object"
    ? (run.snapshotJson as ChatRunSnapshot)
    : {};
}

function parseStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function getObjectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getToolConfirmationStatus(value: unknown): ToolCallTrace["approvalState"] {
  const record = getObjectRecord(value);
  if (record?.status === "approved" || record?.status === "rejected") {
    return record.status;
  }
  const action = getObjectRecord(record?.action);
  return action?.status === "approved" || action?.status === "rejected"
    ? action.status
    : undefined;
}

function replaceConfirmationInToolCalls(
  toolCalls: unknown[] | undefined,
  confirmationId: string,
  confirmation: unknown,
) {
  let changed = false;
  const nextToolCalls = (toolCalls ?? []).map((toolCall) => {
    const record = getObjectRecord(toolCall);
    const output = getObjectRecord(record?.output);
    if (
      !record ||
      output?.type !== "tool_confirmation_request" ||
      output.id !== confirmationId
    ) {
      return toolCall;
    }
    changed = true;
    const approvalState = getToolConfirmationStatus(confirmation);
    return {
      ...record,
      output: confirmation,
      status: "completed",
      ...(approvalState ? { approvalState } : {}),
      approvalConfirmationId: confirmationId,
    };
  });
  return {
    changed,
    toolCalls: nextToolCalls,
  };
}

function mergeToolCallTraceState(
  existing: ToolCallTrace | undefined,
  next: ToolCallTrace,
): ToolCallTrace {
  return {
    ...(existing ?? {}),
    ...next,
    approvalState: next.approvalState ?? existing?.approvalState,
    approvalConfirmationId:
      next.approvalConfirmationId ?? existing?.approvalConfirmationId,
  };
}

function toToolCallTrace(value: unknown): ToolCallTrace | null {
  const record = getObjectRecord(value);
  if (!record) {
    return null;
  }
  const id = typeof record.id === "string" ? record.id : null;
  const tool = typeof record.tool === "string" ? record.tool : null;
  const status = record.status;
  if (
    !id ||
    !tool ||
    (status !== "running" &&
      status !== "approval_requested" &&
      status !== "completed" &&
      status !== "error")
  ) {
    return null;
  }
  return {
    id,
    tool,
    input: getObjectRecord(record.input) ?? {},
    output: record.output,
    status,
    latencyMs:
      typeof record.latencyMs === "number" || record.latencyMs === null
        ? record.latencyMs
        : null,
    error:
      typeof record.error === "string" || record.error === null
        ? record.error
        : null,
    sequence: typeof record.sequence === "number" ? record.sequence : 0,
    approvalState:
      record.approvalState === "approved" || record.approvalState === "rejected"
        ? record.approvalState
        : undefined,
    approvalConfirmationId:
      typeof record.approvalConfirmationId === "string"
        ? record.approvalConfirmationId
        : undefined,
  };
}

function updateExistingTracePartsFromToolCalls(
  traceParts: unknown,
  toolCalls: unknown[] | undefined,
): TracePart[] | undefined {
  if (!Array.isArray(traceParts)) {
    return undefined;
  }
  return (toolCalls ?? []).reduce<TracePart[]>(
    (parts, toolCall) => {
      const normalized = toToolCallTrace(toolCall);
      if (
        !normalized ||
        !parts.some(
          (part) =>
            part.kind === "tool" && part.toolCallId === normalized.id,
        )
      ) {
        return parts;
      }
      const existingToolPart = parts.find(
        (part) => part.kind === "tool" && part.toolCallId === normalized.id,
      );
      const nextToolCall = mergeToolCallTraceState(
        existingToolPart?.kind === "tool"
          ? {
              id: normalized.id,
              tool: existingToolPart.tool,
              input: existingToolPart.input,
              output: existingToolPart.output,
              status: existingToolPart.status,
              latencyMs: existingToolPart.latencyMs ?? null,
              error: existingToolPart.error ?? null,
              sequence: existingToolPart.order,
              approvalState: existingToolPart.approvalState,
              approvalConfirmationId: existingToolPart.approvalConfirmationId,
            }
          : undefined,
        normalized,
      );
      return upsertTracePart(parts, tracePartFromToolCall(nextToolCall));
    },
    normalizeTraceParts(traceParts),
  );
}

function hasPendingConfirmations(toolCalls: unknown[] | undefined) {
  return (toolCalls ?? []).some((toolCall) => {
    const record = getObjectRecord(toolCall);
    const output = getObjectRecord(record?.output);
    return (
      output?.type === "tool_confirmation_request" &&
      output.status === "proposed"
    );
  });
}

function shouldCompleteApprovalRunWithoutPendingConfirmations(
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
  const expiresAtMs = parseRunTimestamp(getRunApprovalPauseState(run).expiresAt);
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

export function isStaleActiveRun(
  run: ChatThreadRunRecord,
  nowMs = Date.now(),
) {
  if (!isActiveChatRunStatus(run.status)) {
    return false;
  }
  if (run.status === "waiting_for_approval") {
    return false;
  }

  if (run.status === "queued" && !run.jobId) {
    const createdAtMs = parseRunTimestamp(run.createdAt);
    return (
      createdAtMs !== null &&
      nowMs - createdAtMs > ORPHANED_QUEUED_RUN_GRACE_MS
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

async function failRunBeforeMessages(
  run: ChatThreadRunRecord,
  error: { code: string; message: string },
) {
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({
      type: "error",
      code: error.code,
      error: error.message,
    })}\n\n`,
  );
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({ type: "finish" })}\n\n`,
  );
  return finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "failed",
    assistantMessageId: null,
    snapshotJson: {
      ...(run.snapshotJson as ChatRunSnapshot),
      errorCode: error.code,
      errorMessage: error.message,
    },
    errorCode: error.code,
    errorMessage: error.message,
  });
}

async function cancelRunBeforeMessages(run: ChatThreadRunRecord) {
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({
      type: "error",
      code: CLIENT_CANCELLED_CODE,
      error: CLIENT_CANCELLED_MESSAGE,
    })}\n\n`,
  );
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({ type: "finish" })}\n\n`,
  );
  return finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "cancelled",
    assistantMessageId: run.assistantMessageId,
    snapshotJson: {
      ...(run.snapshotJson as ChatRunSnapshot),
      errorCode: CLIENT_CANCELLED_CODE,
      errorMessage: CLIENT_CANCELLED_MESSAGE,
    },
    errorCode: CLIENT_CANCELLED_CODE,
    errorMessage: CLIENT_CANCELLED_MESSAGE,
  });
}

function buildStoppedRunFallback(run: ChatThreadRunRecord) {
  return {
    threadRun: {
      id: run.id,
      idempotencyKey: run.idempotencyKey,
      status: run.status,
      mode: run.mode,
    },
    billing: buildEmptyBilling(run.teamId),
    retrieval: {
      embeddingProfileId: null,
      vectorStrategy: null,
      annIndexUsed: null,
      citations: [],
      availableCitations: [],
    },
  };
}

async function forceCancelStoppedRun(
  run: ChatThreadRunRecord,
  dependencies: {
    appendEvent?: typeof chatRunStreamManager.appendEvent;
    findRunById?: typeof findChatThreadRunById;
    finishRun?: typeof finishChatThreadRun;
    updateAssistantMetadata?: typeof updateAssistantMessageThreadRunMetadata;
  } = {},
) {
  if (isTerminalRunStatus(run.status)) {
    return run;
  }

  const appendEvent =
    dependencies.appendEvent ??
    chatRunStreamManager.appendEvent.bind(chatRunStreamManager);
  const finishRun = dependencies.finishRun ?? finishChatThreadRun;
  const findRunById = dependencies.findRunById ?? findChatThreadRunById;
  const updateAssistantMetadata =
    dependencies.updateAssistantMetadata ??
    updateAssistantMessageThreadRunMetadata;
  const latestBeforeCancel = await findRunById({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
  });
  if (isTerminalRunStatus(latestBeforeCancel?.status ?? run.status)) {
    return latestBeforeCancel ?? run;
  }
  const activeRun = latestBeforeCancel ?? run;
  const cancelledRun = {
    ...activeRun,
    status: "cancelled" as const,
    errorCode: CLIENT_CANCELLED_CODE,
    errorMessage: CLIENT_CANCELLED_MESSAGE,
  };
  const snapshot = withAssistantThreadRunMetadata(
    {
      ...getSnapshotRecord(activeRun),
      errorCode: CLIENT_CANCELLED_CODE,
      errorMessage: CLIENT_CANCELLED_MESSAGE,
    },
    cancelledRun,
  );

  await appendEvent(
    activeRun.streamKey,
    `data: ${JSON.stringify({
      type: "error",
      code: CLIENT_CANCELLED_CODE,
      error: CLIENT_CANCELLED_MESSAGE,
      ...(activeRun.userMessageId ? { userMessageId: activeRun.userMessageId } : {}),
      ...(activeRun.assistantMessageId
        ? { messageId: activeRun.assistantMessageId }
        : {}),
    })}\n\n`,
  );
  await appendEvent(
    activeRun.streamKey,
    `data: ${JSON.stringify({ type: "finish" })}\n\n`,
  );

  const finished =
    (await finishRun({
      runId: activeRun.id,
      teamId: activeRun.teamId,
      workspaceId: activeRun.workspaceId,
      status: "cancelled",
      assistantMessageId: activeRun.assistantMessageId,
      snapshotJson: snapshot,
      errorCode: CLIENT_CANCELLED_CODE,
      errorMessage: CLIENT_CANCELLED_MESSAGE,
    })) ?? cancelledRun;
  const latestAfterCancel =
    (await findRunById({
      runId: activeRun.id,
      teamId: activeRun.teamId,
      workspaceId: activeRun.workspaceId,
    })) ?? finished;
  if (latestAfterCancel.status === "cancelled") {
    await updateAssistantMetadata({
      run: latestAfterCancel,
      metadata: {
        isCancelled: true,
        error: CLIENT_CANCELLED_MESSAGE,
        errorCode: CLIENT_CANCELLED_CODE,
      },
    });
  }
  return latestAfterCancel;
}

async function failStaleActiveRun(run: ChatThreadRunRecord) {
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({ type: "finish" })}\n\n`,
  );
  return finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "failed",
    assistantMessageId: run.assistantMessageId,
    snapshotJson: {
      ...(run.snapshotJson as ChatRunSnapshot),
      errorCode: STALE_CHAT_RUN_CODE,
    },
    errorCode: STALE_CHAT_RUN_CODE,
    errorMessage: null,
  });
}

async function cancelProposedConfirmationActions(
  run: ChatThreadRunRecord,
  error: { code: string; message: string },
) {
  const confirmationIds = getRunApprovalPauseState(run).confirmationIds;
  if (confirmationIds.length === 0) {
    return;
  }

  const results = await Promise.allSettled(
    confirmationIds.map(async (confirmationId) => {
      const connectorAction = await findActionRunRecordById({
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        actionRunId: confirmationId,
      });
      if (connectorAction) {
        if (connectorAction.status === "proposed") {
          await updateActionRunRecord({
            teamId: run.teamId,
            workspaceId: run.workspaceId,
            connectorId: connectorAction.connectorId,
            actionRunId: confirmationId,
            status: "canceled",
            errorCode: error.code,
            errorMessage: error.message,
          });
        }
        return;
      }

      const mcpAction = await findMcpActionRun({
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        actionRunId: confirmationId,
      });
      if (mcpAction?.status === "proposed") {
        await updateMcpActionRun({
          teamId: run.teamId,
          workspaceId: run.workspaceId,
          actionRunId: confirmationId,
          status: "canceled",
          errorCode: error.code,
          errorMessage: error.message,
        });
      }
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    logger.warn("Failed to cancel proposed confirmation actions", {
      runId: run.id,
      confirmationCount: confirmationIds.length,
      failureCount: failures.length,
    });
  }
}

export async function expireApprovalWaitingRun(run: ChatThreadRunRecord) {
  const expiredRun = {
    ...run,
    status: "cancelled" as const,
    errorCode: TOOL_APPROVAL_EXPIRED_CODE,
    errorMessage: TOOL_APPROVAL_EXPIRED_MESSAGE,
  };
  const snapshot = withAssistantThreadRunMetadata(
    {
      ...getSnapshotRecord(run),
      errorCode: TOOL_APPROVAL_EXPIRED_CODE,
      errorMessage: TOOL_APPROVAL_EXPIRED_MESSAGE,
    },
    expiredRun,
  );
  await cancelProposedConfirmationActions(run, {
    code: TOOL_APPROVAL_EXPIRED_CODE,
    message: TOOL_APPROVAL_EXPIRED_MESSAGE,
  });
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({
      type: "error",
      code: TOOL_APPROVAL_EXPIRED_CODE,
      error: TOOL_APPROVAL_EXPIRED_MESSAGE,
      ...(run.userMessageId ? { userMessageId: run.userMessageId } : {}),
      ...(run.assistantMessageId ? { messageId: run.assistantMessageId } : {}),
    })}\n\n`,
  );
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({ type: "finish" })}\n\n`,
  );
  const finished =
    (await finishChatThreadRun({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
      status: "cancelled",
      assistantMessageId: run.assistantMessageId,
      snapshotJson: snapshot,
      errorCode: TOOL_APPROVAL_EXPIRED_CODE,
      errorMessage: TOOL_APPROVAL_EXPIRED_MESSAGE,
    })) ?? expiredRun;
  await updateAssistantMessageThreadRunMetadata({
    run: finished,
    metadata: {
      isCancelled: true,
      error: TOOL_APPROVAL_EXPIRED_MESSAGE,
      errorCode: TOOL_APPROVAL_EXPIRED_CODE,
    },
  });
  return (
    (await findChatThreadRunById({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    })) ?? finished
  );
}

async function expireRunIfApprovalExpired(run: ChatThreadRunRecord) {
  if (!isApprovalWaitingRunExpired(run)) {
    return run;
  }
  return expireApprovalWaitingRun(run);
}

async function completeApprovalRunIfNoPendingConfirmations(
  run: ChatThreadRunRecord,
) {
  if (!shouldCompleteApprovalRunWithoutPendingConfirmations(run)) {
    return run;
  }
  const snapshot = getSnapshotRecord(run);
  const completedRun = {
    ...run,
    status: "completed" as const,
  };
  const finished =
    (await finishChatThreadRun({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
      status: "completed",
      assistantMessageId: run.assistantMessageId,
      snapshotJson: withAssistantThreadRunMetadata(snapshot, completedRun),
    })) ?? completedRun;
  await updateAssistantMessageThreadRunMetadata({
    run: finished,
  });
  return (
    (await findChatThreadRunById({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    })) ?? finished
  );
}

async function failRunIfStale(run: ChatThreadRunRecord) {
  run = await expireRunIfApprovalExpired(run);
  run = await completeApprovalRunIfNoPendingConfirmations(run);
  if (!isStaleActiveRun(run)) {
    return run;
  }

  if (run.status === "queued" && !run.jobId) {
    return (
      (await failRunBeforeMessages(run, {
        code: "CHAT_RUN_START_FAILED",
        message: "Previous chat run failed before it started.",
      })) ?? run
    );
  }

  return (await failStaleActiveRun(run)) ?? run;
}

function isUniqueConstraintError(error: unknown, constraint: string) {
  const record =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : null;
  return record?.code === "23505" && record.constraint === constraint;
}

function parseSsePayload(payload: string): Record<string, unknown> | null {
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

function buildEmptyBilling(teamId: string) {
  return {
    teamId,
    consumedCredits: 0,
    availableCredits: 0,
    consumedThisCycle: 0,
    idempotencyReplayed: false,
  };
}

function buildThreadRunMetadata(run: ChatThreadRunRecord) {
  return {
    threadRun: {
      id: run.id,
      idempotencyKey: run.idempotencyKey,
      status: run.status,
      mode: run.mode,
      streamKey: run.streamKey,
    },
  };
}

function withAssistantThreadRunMetadata(
  snapshot: ChatRunSnapshot,
  run: ChatThreadRunRecord,
) {
  if (!snapshot.assistantMessage) {
    return snapshot;
  }
  return {
    ...snapshot,
    assistantMessage: {
      ...snapshot.assistantMessage,
      metadata: {
        ...snapshot.assistantMessage.metadata,
        ...buildThreadRunMetadata(run),
      },
    },
  };
}

async function updateAssistantMessageThreadRunMetadata(input: {
  run: ChatThreadRunRecord;
  metadata?: Record<string, unknown>;
}) {
  if (!input.run.assistantMessageId) {
    return null;
  }
  const current = await findMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    messageId: input.run.assistantMessageId,
  });
  if (!current) {
    return null;
  }
  const extraThreadRun = getObjectRecord(input.metadata?.threadRun);
  return updateMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    messageId: input.run.assistantMessageId,
    metadata: {
      ...current.metadata,
      ...(input.metadata ?? {}),
      threadRun: {
        ...buildThreadRunMetadata(input.run).threadRun,
        ...(extraThreadRun ?? {}),
      },
    },
  });
}

async function updateAssistantMessageConfirmationMetadata(input: {
  run: ChatThreadRunRecord;
  snapshot: ChatRunSnapshot;
}) {
  if (!input.run.assistantMessageId) {
    return null;
  }
  const current = await findMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    messageId: input.run.assistantMessageId,
  });
  if (!current) {
    return null;
  }
  return updateMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    messageId: input.run.assistantMessageId,
    metadata: buildAssistantMessageConfirmationMetadata({
      currentMetadata: current.metadata,
      run: input.run,
      snapshot: input.snapshot,
    }),
  });
}

function buildAssistantMessageConfirmationMetadata(input: {
  currentMetadata: Record<string, unknown>;
  run: ChatThreadRunRecord;
  snapshot: ChatRunSnapshot;
}) {
  const currentThreadRun = getObjectRecord(input.currentMetadata.threadRun);
  const threadRun = buildThreadRunMetadata(input.run).threadRun;
  const approvalRequestedAt =
    input.snapshot.approvalRequestedAt ?? currentThreadRun?.approvalRequestedAt;
  const approvalExpiresAt =
    input.snapshot.approvalExpiresAt ?? currentThreadRun?.approvalExpiresAt;
  const nextMetadata = {
    ...(input.snapshot.reasoning !== undefined
      ? { reasoning: input.snapshot.reasoning }
      : {}),
    ...(input.snapshot.reasoningSegments !== undefined
      ? { reasoningSegments: input.snapshot.reasoningSegments }
      : {}),
    ...(input.snapshot.thinkingSteps !== undefined
      ? { thinkingSteps: input.snapshot.thinkingSteps }
      : {}),
    ...(input.snapshot.traceEvents !== undefined
      ? { traceEvents: input.snapshot.traceEvents }
      : {}),
    ...(input.snapshot.traceParts !== undefined
      ? { traceParts: input.snapshot.traceParts }
      : {}),
    ...(input.snapshot.renderBlocks !== undefined
      ? { renderBlocks: input.snapshot.renderBlocks }
      : {}),
    ...(input.snapshot.agentCheckpoint !== undefined
      ? { agentCheckpoint: input.snapshot.agentCheckpoint }
      : {}),
    ...(input.snapshot.retrieval !== undefined
      ? { retrieval: input.snapshot.retrieval }
      : {}),
    threadRun:
      input.run.status === "waiting_for_approval"
        ? {
            ...threadRun,
            ...(typeof approvalRequestedAt === "string"
              ? { approvalRequestedAt }
              : {}),
            ...(typeof approvalExpiresAt === "string"
              ? { approvalExpiresAt }
              : {}),
          }
        : threadRun,
    toolCalls:
      input.snapshot.toolCalls ??
      (Array.isArray(input.currentMetadata.toolCalls)
        ? input.currentMetadata.toolCalls
        : []),
    finishReason:
      input.snapshot.finishReason ?? input.currentMetadata.finishReason,
  };
  return preserveTraceMetadata({
    existingMetadata: input.currentMetadata,
    nextMetadata,
  });
}

function normalizeVectorStrategy(value: unknown): EmbeddingVectorStrategy | null {
  return value === "ann_hnsw" ||
    value === "exact_vector" ||
    value === "bm25_only"
    ? value
    : null;
}

export function normalizeRetrievalSnapshot(
  value: unknown,
): ChatRunSnapshot["retrieval"] {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!record) {
    return undefined;
  }

  return {
    embeddingProfileId:
      typeof record.embeddingProfileId === "string"
        ? record.embeddingProfileId
        : null,
    vectorStrategy: normalizeVectorStrategy(record.vectorStrategy),
    annIndexUsed:
      typeof record.annIndexUsed === "string" ? record.annIndexUsed : null,
    citations: Array.isArray(record.citations) ? record.citations : [],
    availableCitations: Array.isArray(record.availableCitations)
      ? record.availableCitations
      : Array.isArray(record.citations)
        ? record.citations
        : [],
  };
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

async function getRunResult(run: ChatThreadRunRecord) {
  const snapshot = run.snapshotJson as ChatRunSnapshot;
  const thread =
    snapshot.thread ??
    (await findThreadRecord({
      threadId: run.threadId,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    }));
  const userMessage =
    snapshot.userMessage ??
    (run.userMessageId
      ? await findMessageRecord({
          teamId: run.teamId,
          workspaceId: run.workspaceId,
          messageId: run.userMessageId,
        })
      : null);
  const assistantMessage =
    snapshot.assistantMessage ??
    (run.assistantMessageId
      ? await findMessageRecord({
          teamId: run.teamId,
          workspaceId: run.workspaceId,
          messageId: run.assistantMessageId,
        })
      : null);

  if (!thread || !userMessage || !assistantMessage) {
    throw new ContentError(
      409,
      "CHAT_RUN_RESULT_NOT_READY",
      "Chat run result is not ready",
    );
  }

  return {
    thread: thread as ThreadRecord,
    userMessage: userMessage as MessageRecord,
    assistantMessage: assistantMessage as MessageRecord,
    billing: snapshot.billing ?? buildEmptyBilling(run.teamId),
    retrieval: normalizeRetrievalSnapshot(snapshot.retrieval) ?? {
      embeddingProfileId: null,
      vectorStrategy: null,
      annIndexUsed: null,
      citations: [],
      availableCitations: [],
    },
  };
}

async function resolveOwnedRun(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  idempotencyKey: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const run = await findChatThreadRunByIdempotencyKey({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    idempotencyKey: input.idempotencyKey,
  });
  if (!run || run.threadId !== input.threadId || run.userId !== input.userId) {
    throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
  }
  return run;
}

async function findOwnedRun(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  idempotencyKey: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const run = await findChatThreadRunByIdempotencyKey({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    idempotencyKey: input.idempotencyKey,
  });
  if (!run || run.threadId !== input.threadId || run.userId !== input.userId) {
    return null;
  }
  return run;
}

async function waitForRunResult(input: {
  run: ChatThreadRunRecord;
  timeoutMs: number;
  requireTerminal: boolean;
  throwTerminalErrors?: boolean;
  failStaleRun?: (run: ChatThreadRunRecord) => Promise<ChatThreadRunRecord>;
  findRunById?: typeof findChatThreadRunById;
}) {
  const startedAt = Date.now();
  let run = input.run;
  let lastReadinessError: ContentError | null = null;

  while (true) {
    if (!isTerminalRunStatus(run.status)) {
      run = await (input.failStaleRun ?? failRunIfStale)(run);
    }

    if (input.throwTerminalErrors) {
      const terminalError = toTerminalRunError(run);
      if (terminalError) {
        throw terminalError;
      }
    }

    try {
      if (!input.requireTerminal || isTerminalRunStatus(run.status)) {
        return await getRunResult(run);
      }
    } catch (error) {
      if (error instanceof ContentError) {
        lastReadinessError = error;
      } else {
        throw error;
      }
    }

    if (Date.now() - startedAt >= input.timeoutMs) {
      throw (
        lastReadinessError ??
        new ContentError(
          408,
          "CHAT_RUN_RESULT_TIMEOUT",
          "Timed out waiting for chat run result",
        )
      );
    }

    await wait(RESULT_POLL_MS);
    run =
      (await (input.findRunById ?? findChatThreadRunById)({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      })) ?? run;
  }
}

async function resolveAttachRunState(input: {
  run: ChatThreadRunRecord;
  offset: number;
  sawErrorEvent: boolean;
  findRunById?: typeof findChatThreadRunById;
  failStaleRun?: (run: ChatThreadRunRecord) => Promise<ChatThreadRunRecord>;
  getEvents?: (
    streamKey: string,
    offset: number,
  ) => Promise<{ events: ChatRunStreamEvent[]; nextOffset: number }>;
}) {
  let run =
    (await (input.findRunById ?? findChatThreadRunById)({
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
    })) ?? input.run;
  run = await (input.failStaleRun ?? failRunIfStale)(run);
  if (!isTerminalRunStatus(run.status)) {
    return {
      run,
      sawErrorEvent: input.sawErrorEvent,
      terminalEvents: null,
    };
  }

  const remaining = await (input.getEvents ??
    chatRunStreamManager.getEvents.bind(chatRunStreamManager))(
    run.streamKey,
    input.offset,
  );
  let sawErrorEvent = input.sawErrorEvent;
  const terminalEvents: string[] = [];
  for (const event of remaining.events) {
    if (event.kind === "sse" && event.payload) {
      terminalEvents.push(event.payload);
      const payload = parseSsePayload(event.payload);
      if (payload?.type === "error") {
        sawErrorEvent = true;
      }
      if (payload?.type === "finish") {
        return {
          run,
          sawErrorEvent,
          terminalEvents,
        };
      }
    }
  }
  terminalEvents.push(
    ...synthesizeTerminalRunEvents({
      run,
      sawErrorEvent,
    }),
  );
  return {
    run,
    sawErrorEvent,
    terminalEvents,
  };
}

export class DurableChatRunService {
  async findRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    return findOwnedRun(input);
  }

  async findActiveRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    const run = await findActiveChatThreadRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
    });
    if (!run || run.userId !== input.userId) {
      return null;
    }
    const current = await failRunIfStale(run);
    return isActiveChatRunStatus(current.status) ? current : null;
  }

  async getOrCreateRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
    mode: ChatThreadRunMode;
    request:
      | StreamThreadEventInput
      | RefreshThreadInput
      | ResumeThreadInput
      | EditThreadInput;
  }) {
    const workspace = await requireContentWorkspace(input);
    const existing = await findChatThreadRunByIdempotencyKey({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      if (existing.threadId !== input.threadId || existing.userId !== input.userId) {
        throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
      }
      return { run: existing, created: false };
    }

    const active = await findActiveChatThreadRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
    });
    if (active) {
      const currentActive = await failRunIfStale(active);
      if (isActiveChatRunStatus(currentActive.status)) {
        throw new ContentError(
          409,
          "CHAT_RUN_ALREADY_ACTIVE",
          "A chat run is already active for this thread",
        );
      }
      // A stale or completed approval pause has been terminalized; a new run may start.
    }

    const remainingActive = await findActiveChatThreadRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
    });
    if (remainingActive) {
      throw new ContentError(
        409,
        "CHAT_RUN_ALREADY_ACTIVE",
        "A chat run is already active for this thread",
      );
    }

    const requestJson = {
      ...input.request,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
    } as DurableRunRequestSnapshot;
    let run = await createChatThreadRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      mode: input.mode,
      requestJson,
    }).catch(async (error: unknown) => {
      if (isUniqueConstraintError(error, ACTIVE_RUN_CONSTRAINT)) {
        throw new ContentError(
          409,
          "CHAT_RUN_ALREADY_ACTIVE",
          "A chat run is already active for this thread",
        );
      }
      throw error;
    });
    if (!run) {
      const existingRun = await findChatThreadRunByIdempotencyKey({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        idempotencyKey: input.idempotencyKey,
      });
      if (
        !existingRun ||
        existingRun.threadId !== input.threadId ||
        existingRun.userId !== input.userId
      ) {
        throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
      }
      return { run: existingRun, created: false };
    }
    let job: Awaited<ReturnType<typeof enqueueThreadChatRunJob>>;
    try {
      job = await enqueueThreadChatRunJob({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        userId: run.userId,
      });
    } catch (error) {
      await failRunBeforeMessages(run, {
        code: "CHAT_RUN_START_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Failed to start chat run.",
      });
      throw error;
    }
    const queuedRun = await markChatThreadRunQueued({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
      jobId: String(job.id),
    });

    return { run: queuedRun ?? run, created: true };
  }

  async stopRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    const run = await resolveOwnedRun(input);
    if (!isTerminalRunStatus(run.status)) {
      await chatRunStreamManager.appendStop(run.streamKey);
      if (run.status === "waiting_for_approval") {
        await cancelProposedConfirmationActions(run, {
          code: CLIENT_CANCELLED_CODE,
          message: CLIENT_CANCELLED_MESSAGE,
        });
        return forceCancelStoppedRun(run);
      }
      const updated =
        (await requestChatThreadRunCancel({
          runId: run.id,
          teamId: run.teamId,
          workspaceId: run.workspaceId,
        })) ?? run;
      return forceCancelStoppedRun(updated);
    }
    return run;
  }

  async stopRunAndReturn(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKeyWithStopSuffix: string;
  }) {
    const idempotencyKey = input.idempotencyKeyWithStopSuffix.slice(
      0,
      -SOURCEWEFT_WEB_RUN_STOP_SUFFIX.length,
    );
    const stopped = await this.stopRun({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      idempotencyKey,
    });
    if (stopped.status === "cancelled") {
      try {
        return await getRunResult(stopped);
      } catch (error) {
        if (error instanceof ContentError) {
          return buildStoppedRunFallback(stopped);
        }
        throw error;
      }
    }
    return waitForRunResult({
      run: stopped,
      timeoutMs: STOP_RESULT_WAIT_TIMEOUT_MS,
      requireTerminal: true,
      throwTerminalErrors: false,
    }).catch((error) => {
      if (error instanceof ContentError) {
        return findChatThreadRunById({
          runId: stopped.id,
          teamId: stopped.teamId,
          workspaceId: stopped.workspaceId,
        }).then(async (latest) => {
          const stoppedRun = isTerminalRunStatus(latest?.status ?? stopped.status)
            ? (latest ?? stopped)
            : await forceCancelStoppedRun(latest ?? stopped);
          return buildStoppedRunFallback(stoppedRun);
        });
      }
      throw error;
    });
  }

  async getRunResult(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    const run = await resolveOwnedRun(input);
    return waitForRunResult({
      run,
      timeoutMs: COMPLETE_RESULT_WAIT_TIMEOUT_MS,
      requireTerminal: true,
      throwTerminalErrors: true,
    });
  }

  async *attachRunEvents(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }): AsyncGenerator<string> {
    let run = await resolveOwnedRun(input);
    let offset = 0;
    let lastHeartbeatAt = Date.now();
    let sawErrorEvent = false;
    while (true) {
      const result = await chatRunStreamManager.getEvents(
        run.streamKey,
        offset,
      );
      offset = result.nextOffset;

      for (const event of result.events) {
        if (event.kind === "sse" && event.payload) {
          yield event.payload;
          const payload = parseSsePayload(event.payload);
          if (payload?.type === "error") {
            sawErrorEvent = true;
          }
          if (payload?.type === "finish") {
            return;
          }
        }
      }

      if (result.events.length > 0) {
        lastHeartbeatAt = Date.now();
      }

      const attachState = await resolveAttachRunState({
        run,
        offset,
        sawErrorEvent,
      });
      run = attachState.run;
      sawErrorEvent = attachState.sawErrorEvent;
      if (attachState.terminalEvents) {
        for (const event of attachState.terminalEvents) {
          yield event;
        }
        return;
      }

      if (Date.now() - lastHeartbeatAt >= ATTACH_HEARTBEAT_MS) {
        lastHeartbeatAt = Date.now();
        yield ": heartbeat\n\n";
      }

      await wait(ATTACH_POLL_MS);
    }
  }

  async appendRunEvent(input: {
    run: ChatThreadRunRecord;
    payload: string;
    snapshot?: ChatRunSnapshot;
  }) {
    const offset = await chatRunStreamManager.appendEvent(
      input.run.streamKey,
      input.payload,
    );
    await updateChatThreadRunProgress({
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      eventOffset: offset,
      snapshotJson: input.snapshot,
    });
  }

  async shouldCancel(run: ChatThreadRunRecord) {
    const current = await findChatThreadRunById({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    });
    return current?.status === "cancel_requested" || current?.status === "cancelled";
  }

  async heartbeat(run: ChatThreadRunRecord) {
    return touchChatThreadRunHeartbeat({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    });
  }

  async processRunJob(payload: ThreadChatRunJobPayload) {
    const run = await findChatThreadRunById({
      runId: payload.runId,
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
    });
    if (!run) {
      throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
    }
    if (!isActiveChatRunStatus(run.status)) {
      return {
        status: toTerminalJobStatus(run.status),
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
      };
    }

    if (run.status === "cancel_requested") {
      const cancelledRun = (await cancelRunBeforeMessages(run)) ?? run;
      return {
        status: "cancelled" as const,
        runId: cancelledRun.id,
        assistantMessageId: cancelledRun.assistantMessageId,
        errorCode: CLIENT_CANCELLED_CODE,
        errorMessage: CLIENT_CANCELLED_MESSAGE,
      };
    }
    if (run.status === "waiting_for_approval") {
      return {
        status: "waiting_for_approval" as const,
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
      };
    }
    if (run.status === "running") {
      return run;
    }

    const running = await markChatThreadRunRunning({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    });
    if (!running) {
      const latest =
        (await findChatThreadRunById({
          runId: run.id,
          teamId: run.teamId,
          workspaceId: run.workspaceId,
        })) ?? run;
      if (!isActiveChatRunStatus(latest.status)) {
        return {
          status: toTerminalJobStatus(latest.status),
          runId: latest.id,
          assistantMessageId: latest.assistantMessageId,
          ...(latest.errorCode ? { errorCode: latest.errorCode } : {}),
          ...(latest.errorMessage ? { errorMessage: latest.errorMessage } : {}),
        };
      }
      if (latest.status !== "cancel_requested") {
        return latest;
      }
      const cancelledRun = (await cancelRunBeforeMessages(latest)) ?? latest;
      return {
        status: "cancelled" as const,
        runId: cancelledRun.id,
        assistantMessageId: cancelledRun.assistantMessageId,
        errorCode: CLIENT_CANCELLED_CODE,
        errorMessage: CLIENT_CANCELLED_MESSAGE,
      };
    }
    return running;
  }

  async finishRun(input: {
    run: ChatThreadRunRecord;
    status: "completed" | "failed" | "cancelled";
    assistantMessageId?: string | null;
    snapshot?: ChatRunSnapshot;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) {
    return finishChatThreadRun({
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      status: input.status,
      assistantMessageId: input.assistantMessageId,
      snapshotJson: input.snapshot,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
  }

  async markWaitingForApproval(input: {
    run: ChatThreadRunRecord;
    assistantMessageId?: string | null;
    snapshot: ChatRunSnapshot;
    confirmationIds?: string[];
    requestedAt?: Date;
    expiresAt?: Date;
  }) {
    const requestedAt = input.requestedAt ?? new Date();
    const expiresAt =
      input.expiresAt ??
      new Date(requestedAt.getTime() + config.chat.toolApprovalTtlMs);
    const approvalRequestedAt = requestedAt.toISOString();
    const approvalExpiresAt = expiresAt.toISOString();
    const waitingRun = {
      ...input.run,
      status: "waiting_for_approval" as const,
      assistantMessageId:
        input.assistantMessageId ?? input.run.assistantMessageId,
    };
    const snapshot = withAssistantThreadRunMetadata(
      {
        ...input.snapshot,
        approvalRequestedAt,
        approvalExpiresAt,
        pendingConfirmationIds: input.confirmationIds ?? [],
      },
      waitingRun,
    );
    if (snapshot.assistantMessage) {
      snapshot.assistantMessage = {
        ...snapshot.assistantMessage,
        metadata: {
          ...snapshot.assistantMessage.metadata,
          threadRun: {
            ...(getObjectRecord(snapshot.assistantMessage.metadata.threadRun) ??
              {}),
            approvalRequestedAt,
            approvalExpiresAt,
          },
        },
      };
    }
    const updated = await markChatThreadRunWaitingForApproval({
      assistantMessageId: waitingRun.assistantMessageId,
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      snapshotJson: snapshot,
    });
    if (!updated) {
      return null;
    }
    await updateAssistantMessageConfirmationMetadata({
      run: updated,
      snapshot,
    });
    return {
      ...updated,
      snapshotJson: {
        ...updated.snapshotJson,
        approvalRequestedAt,
        approvalExpiresAt,
        pendingConfirmationIds: input.confirmationIds ?? [],
      },
    };
  }

  async validateConfirmationResponse(input: {
    workspaceId: string;
    userId: string;
    confirmationId: string;
    threadRunId?: string;
    assistantMessageId?: string;
  }) {
    if (!input.threadRunId) {
      throw new ContentError(
        400,
        "CONFIRMATION_THREAD_RUN_REQUIRED",
        "Confirmation response requires the active chat run id",
      );
    }
    const workspace = await requireContentWorkspace(input);
    const run = await findChatThreadRunById({
      runId: input.threadRunId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });
    if (!run || run.userId !== input.userId) {
      throw new ContentError(409, "CHAT_RUN_NOT_ACTIVE", "Chat run is not active");
    }
    const current = await expireRunIfApprovalExpired(run);
    if (current.status !== "waiting_for_approval") {
      throw new ContentError(
        409,
        current.errorCode === TOOL_APPROVAL_EXPIRED_CODE
          ? TOOL_APPROVAL_EXPIRED_CODE
          : "CHAT_RUN_NOT_WAITING_FOR_APPROVAL",
        current.errorMessage ?? "Chat run is not waiting for approval",
      );
    }
    if (
      input.assistantMessageId &&
      current.assistantMessageId &&
      input.assistantMessageId !== current.assistantMessageId
    ) {
      throw new ContentError(
        409,
        "CONFIRMATION_ASSISTANT_MESSAGE_MISMATCH",
        "Confirmation does not belong to this assistant message",
      );
    }
    const approval = getRunApprovalPauseState(current);
    if (
      approval.confirmationIds.length > 0 &&
      !approval.confirmationIds.includes(input.confirmationId)
    ) {
      throw new ContentError(
        409,
        "CONFIRMATION_NOT_ACTIVE",
        "Confirmation is no longer active",
      );
    }
    return current;
  }

  async recordConfirmationResponse(input: {
    run: ChatThreadRunRecord;
    confirmationId: string;
    confirmation: unknown;
  }) {
    if (input.run.status !== "waiting_for_approval") {
      return input.run;
    }
    const snapshot = getSnapshotRecord(input.run);
    const replaced = replaceConfirmationInToolCalls(
      snapshot.toolCalls,
      input.confirmationId,
      input.confirmation,
    );
    if (!replaced.changed) {
      return input.run;
    }
    const traceParts = updateExistingTracePartsFromToolCalls(
      snapshot.traceParts,
      replaced.toolCalls,
    );
    if (!hasPendingConfirmations(replaced.toolCalls)) {
      const completedRun = {
        ...input.run,
        status: "completed" as const,
      };
      const completedSnapshot = withAssistantThreadRunMetadata(
        {
          ...snapshot,
          toolCalls: replaced.toolCalls,
          ...(traceParts !== undefined ? { traceParts } : {}),
          pendingConfirmationIds: [],
        },
        completedRun,
      );
      const finished =
        (await finishChatThreadRun({
          runId: input.run.id,
          teamId: input.run.teamId,
          workspaceId: input.run.workspaceId,
          status: "completed",
          assistantMessageId: input.run.assistantMessageId,
          snapshotJson: completedSnapshot,
        })) ?? completedRun;
      await updateAssistantMessageConfirmationMetadata({
        run: finished,
        snapshot: completedSnapshot,
      });
      await updateAssistantMessageThreadRunMetadata({
        run: finished,
      });
      return (
        (await findChatThreadRunById({
          runId: input.run.id,
          teamId: input.run.teamId,
          workspaceId: input.run.workspaceId,
        })) ?? finished
      );
    }
    const nextSnapshot: ChatRunSnapshot = {
      ...snapshot,
      toolCalls: replaced.toolCalls,
      ...(traceParts !== undefined ? { traceParts } : {}),
      pendingConfirmationIds: getRunApprovalPauseState(input.run)
        .confirmationIds.filter((id) => id !== input.confirmationId),
    };
    const updated =
      (await updateChatThreadRunStatus({
        runId: input.run.id,
        teamId: input.run.teamId,
        workspaceId: input.run.workspaceId,
        status: "waiting_for_approval",
        snapshotJson: nextSnapshot,
      })) ?? input.run;
    await updateAssistantMessageConfirmationMetadata({
      run: updated,
      snapshot: nextSnapshot,
    });
    return updated;
  }

  async expireWaitingApprovals(input: { limit?: number } = {}) {
    const runs = await listExpiredApprovalWaitingRuns({
      limit: input.limit ?? EXPIRED_APPROVAL_SWEEP_LIMIT,
    });
    const results = await Promise.allSettled(
      runs.map((run) => expireApprovalWaitingRun(run)),
    );
    const expired = results.filter(
      (result) => result.status === "fulfilled" && result.value.status === "cancelled",
    ).length;
    const failed = results.length - expired;
    if (failed > 0) {
      logger.warn("Failed to expire some waiting approval chat runs", {
        attempted: results.length,
        expired,
        failed,
      });
    }
    return { attempted: runs.length, expired, failed };
  }
}

export const durableChatRunService = new DurableChatRunService();

export const testExports = {
  buildAssistantMessageConfirmationMetadata,
  completeApprovalRunIfNoPendingConfirmations,
  failRunIfStale,
  forceCancelStoppedRun,
  resolveAttachRunState,
  shouldCompleteApprovalRunWithoutPendingConfirmations,
  waitForRunResult,
};
