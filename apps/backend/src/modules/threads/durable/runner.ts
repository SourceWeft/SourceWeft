import {
  readAgentRunStop,
  readAgentRunProgress,
  advanceAgentRunProgress,
} from "@sourceweft/contracts";
import {
  agentCheckpointFromStepStopError,
  toAgentToolBudgetContentError,
} from "../agent";
import { normalizeMcpDisplay } from "../turn/trace-parts";
import { approvalFinishPayload } from "./approval-finish";
import {
  beginReasoningRun,
  projectReasoning,
  projectSnapshotReasoning,
} from "../turn/reasoning-state";
import type {
  ThreadChatRunJobPayload,
  ThreadChatRunJobResult,
} from "../../content/queue";
import { buildErrorTurnBilling } from "../turn/error-turn-billing";
import { type MeterConsumeResponse } from "@sourceweft/contracts";
import { ContentError } from "../../content/errors";
import {
  sanitizeClientErrorMessage,
  toContentError,
} from "../../content/model-gateway-error";
import type { MessageRenderBlock, PreparedThreadTurn } from "../turn/types";
import { createThreadStreamErrorMessage } from "../stream/error";
import { toSseData } from "../stream/helpers";
import { createDeltaCoalescer } from "./sse-coalescer";
import {
  boundReasoningRenderBlocks,
  boundReasoningSegmentText,
  boundSnapshotReasoning,
  hasReasoningTruncationMarker,
} from "./reasoning-bounds";
import { ContentThreadStreamService } from "../stream/service";
import { ContentThreadTurnService } from "../turn/service";
import {
  appendAssistantContinuationContent,
  preserveAssistantMetadataForContinuation,
} from "../turn/finalizer";
import {
  tracePartFromReasoningSegment,
  tracePartFromThinkingStep,
  tracePartFromToolCall,
  upsertTracePart,
} from "../turn/trace-parts";
import type { ToolCallTrace } from "../turn/types";
import {
  isSandboxExecuteToolCallIdRequiredError,
  sandboxExecuteToolCallIdRequiredContentError,
} from "../turn/sandbox-execute-error";
import {
  createMessageRecord,
  findMessageRecord,
  persistMessageProjection,
  updateMessageRecord,
} from "../message-repository";
import { findThreadRecord } from "../thread/repository";
import { billingRuntime as billingService } from "../../../billing-host/bindings";
import { logger } from "../../../shared/logger";
import { durableChatRunService } from "./service";
import { chatRunStreamManager } from "./stream-manager";
import {
  findChatThreadRunById,
  updateChatThreadRunProgress,
} from "./repository";
import type {
  ChatRunSnapshot,
  ChatThreadRunRecord,
  ChatThreadRunStatus,
  DurableRunRequestSnapshot,
  DurableRunResultSnapshot,
} from "./types";
import { toObjectRecord } from "../../../shared/records";
import { truncateErrorText } from "../../../shared/safe-error-text";
import {
  isTerminalRunStatus,
  parseSsePayload,
  synthesizeTerminalRunEvents,
} from "./run-state";
import { WORKER_SHUTDOWN_CODE, WORKER_SHUTDOWN_MESSAGE } from "./run-constants";

type TerminalRunStatus = Extract<
  ChatThreadRunStatus,
  "completed" | "failed" | "cancelled"
>;
type DurableRunJobStatus = TerminalRunStatus | "waiting_for_approval";
type DurableChatRunServiceAppendRunEvent =
  typeof durableChatRunService.appendRunEvent;
type DurableChatRunServiceFinishRun = typeof durableChatRunService.finishRun;

const ASSISTANT_SNAPSHOT_FLUSH_MS = 500;
/** Cooldown starts after a successful write, so slow writes do not erase it. */
function createAssistantSnapshotFlushWindow(
  input: { now?: () => number } = {},
) {
  const now = input.now ?? Date.now;
  let lastAssistantSnapshotFlushAt = 0;
  return async (persist: () => Promise<void>, force = false) => {
    if (
      !force &&
      now() - lastAssistantSnapshotFlushAt < ASSISTANT_SNAPSHOT_FLUSH_MS
    )
      return;
    await persist();
    lastAssistantSnapshotFlushAt = now();
  };
}

const TOOL_CONFIRMATION_FINISH_REASON = "tool_confirmation_requested";
// Fallback cadence for detecting a cancel the pub/sub delivery may have missed
// (a Stop that landed before the worker subscribed, or a dropped message).
const CHAT_RUN_CANCEL_POLL_MS = 2000;

// Stops for the chat turns this process is running, so a worker that is shutting
// down can end them itself instead of leaving them `running` until stale
// recovery gives up on their heartbeat.
const activeTurnInterrupts = new Set<(reason: ContentError) => void>();

/**
 * Stops every chat turn this process is running (a shutting-down worker's last
 * step; see worker/shutdown.ts). Each one commits as failed
 * with WORKER_SHUTDOWN_CODE, keeping what it already streamed, and its job
 * returns. Returns how many turns were stopped.
 */
export function interruptActiveChatRuns() {
  const interrupts = [...activeTurnInterrupts];
  for (const interrupt of interrupts) {
    interrupt(
      new ContentError(503, WORKER_SHUTDOWN_CODE, WORKER_SHUTDOWN_MESSAGE),
    );
  }
  return interrupts.length;
}
function stableDurableUserMessageId(runId: string) {
  return `run-user-${runId}`;
}

function stableDurableAssistantMessageId(runId: string) {
  return `run-assistant-${runId}`;
}

function requestWithDurableMessageOverrides(input: {
  request: DurableRunRequestSnapshot;
  run: ChatThreadRunRecord;
}) {
  if (input.run.mode !== "send" && input.run.mode !== "edit") {
    return input.request;
  }
  return {
    ...input.request,
    userMessageIdOverride: stableDurableUserMessageId(input.run.id),
    assistantMessageIdOverride: stableDurableAssistantMessageId(input.run.id),
  };
}

async function resolvePersistedTerminalMessageIds(input: {
  run: ChatThreadRunRecord;
  assistantMessageId: string | null;
  findMessage?: typeof findMessageRecord;
}) {
  const findMessage = input.findMessage ?? findMessageRecord;
  const findCandidate = (messageId: string) =>
    findMessage({
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      messageId,
    });
  // Existing run references are already protected by database foreign keys.
  // Preparation can persist a user message before onPrepared binds it to the
  // run; a deterministic name is only a lookup candidate, never evidence that
  // the row exists.
  let userMessageId = input.run.userMessageId;
  if (!userMessageId && ["send", "edit"].includes(input.run.mode)) {
    const candidate = await findCandidate(
      stableDurableUserMessageId(input.run.id),
    );
    if (
      candidate?.teamId === input.run.teamId &&
      candidate.workspaceId === input.run.workspaceId &&
      candidate.threadId === input.run.threadId &&
      candidate.role === "user" &&
      candidate.createdBy === input.run.userId
    ) {
      userMessageId = candidate.id;
    }
  }
  let assistantMessageId = input.run.assistantMessageId;
  if (!assistantMessageId && input.assistantMessageId) {
    const candidate = await findCandidate(input.assistantMessageId);
    if (
      candidate?.teamId === input.run.teamId &&
      candidate.workspaceId === input.run.workspaceId &&
      candidate.threadId === input.run.threadId &&
      candidate.role === "assistant"
    ) {
      assistantMessageId = candidate.id;
    }
  }
  return { userMessageId, assistantMessageId };
}

function toDurableRunContentError(error: unknown) {
  if (error instanceof ContentError) {
    return error;
  }
  const budgetError = toAgentToolBudgetContentError(error);
  if (budgetError) return budgetError;
  const modelError = toContentError(error);
  if (modelError.code === "MODEL_CONFIGURATION_ERROR") return modelError;
  if (isSandboxExecuteToolCallIdRequiredError(error)) {
    return sandboxExecuteToolCallIdRequiredContentError();
  }
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const message =
    typeof record.message === "string" && record.message.trim().length > 0
      ? sanitizeClientErrorMessage(record.message)
      : String(error);
  const cause = record.cause;
  const causeMessage =
    cause && typeof cause === "object" && "message" in cause
      ? String((cause as { message?: unknown }).message ?? "")
      : "";
  const combined = `${String(record.name ?? "")}\n${message}\n${causeMessage}`;
  if (
    combined.includes("MiddlewareError") ||
    combined.includes("SANDBOX_") ||
    combined.includes("Error invoking tool")
  ) {
    return new ContentError(500, "CHAT_RUN_FAILED", message);
  }
  return new ContentError(
    500,
    "CHAT_RUN_FAILED",
    error instanceof Error ? error.message : String(error),
  );
}

function extractPendingConfirmationIds(toolCalls: unknown[] | undefined) {
  return (toolCalls ?? [])
    .map((toolCall) => {
      const record =
        toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)
          ? (toolCall as Record<string, unknown>)
          : null;
      const output =
        record?.output &&
        typeof record.output === "object" &&
        !Array.isArray(record.output)
          ? (record.output as Record<string, unknown>)
          : null;
      return output?.type === "tool_confirmation_request" &&
        output.status === "proposed" &&
        typeof output.id === "string"
        ? output.id
        : null;
    })
    .filter((id): id is string => Boolean(id));
}

function asRequestSnapshot(value: Record<string, unknown>) {
  return value as unknown as DurableRunRequestSnapshot;
}

function createThreadRunStream(input: {
  streamService: ContentThreadStreamService;
  request: DurableRunRequestSnapshot;
  options: Parameters<ContentThreadStreamService["streamThreadEvents"]>[1];
}) {
  if (input.request.mode === "resume") {
    return input.streamService.resumeThreadEvents(input.request, input.options);
  }
  if (input.request.mode === "refresh") {
    return input.streamService.refreshThreadEvents(
      input.request,
      input.options,
    );
  }
  if (input.request.mode === "edit") {
    return input.streamService.editThreadEvents(input.request, input.options);
  }
  return input.streamService.streamThreadEvents(input.request, input.options);
}

function serializeSsePayload(payload: Record<string, unknown>) {
  return toSseData(payload);
}

function isClientCancelledRun(run: ChatThreadRunRecord | null) {
  return run?.status === "cancel_requested" || run?.status === "cancelled";
}

function mergeToolCall(existing: unknown[], next: unknown) {
  const record =
    next && typeof next === "object" && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : null;
  const id = typeof record?.id === "string" ? record.id : null;
  if (!id) {
    return existing;
  }

  return [
    ...existing.filter((item) => {
      const itemRecord =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null;
      return itemRecord?.id !== id;
    }),
    record,
  ];
}

function mergeToolCallFromPayload(input: {
  existing: unknown[];
  payload: Record<string, unknown>;
}) {
  const toolCall = toObjectRecord(input.payload.toolCall);
  const fallbackId =
    typeof input.payload.id === "string" && input.payload.id.length > 0
      ? input.payload.id
      : null;
  const id =
    typeof toolCall?.id === "string" && toolCall.id.length > 0
      ? toolCall.id
      : fallbackId;
  if (!id) {
    return input.existing;
  }

  const existingRecord = input.existing
    .map(toObjectRecord)
    .find((record) => record?.id === id);
  const tool =
    typeof toolCall?.tool === "string" && toolCall.tool.length > 0
      ? toolCall.tool
      : typeof input.payload.tool === "string" && input.payload.tool.length > 0
        ? input.payload.tool
        : typeof existingRecord?.tool === "string"
          ? existingRecord.tool
          : "tool";
  const existingOutput = toObjectRecord(existingRecord?.output);
  const eventOutput =
    input.payload.type === "tool-call-event"
      ? input.payload.data
      : input.payload.type === "tool-call-result"
        ? input.payload.output
        : null;
  const eventOutputRecord = toObjectRecord(eventOutput);
  const toolCallOutput = toolCall ? toolCall.output : undefined;
  const toolCallOutputRecord = toObjectRecord(toolCallOutput);
  const output =
    existingOutput || eventOutputRecord || toolCallOutputRecord
      ? {
          ...(existingOutput ?? {}),
          ...(eventOutputRecord ?? {}),
          ...(toolCallOutputRecord ?? {}),
        }
      : (toolCallOutput ?? eventOutput ?? existingRecord?.output ?? null);
  const status =
    input.payload.type === "tool-call-error"
      ? "error"
      : input.payload.type === "tool-call-start"
        ? (toolCall?.status ?? "running")
        : input.payload.type === "tool-call-result" ||
            input.payload.type === "tool-call-end"
          ? typeof input.payload.status === "string"
            ? input.payload.status
            : (toolCall?.status ?? "completed")
          : (toolCall?.status ?? existingRecord?.status ?? "running");
  const sequence =
    getTraceSequence(toolCall) ?? getTraceSequence(existingRecord);

  return mergeToolCall(input.existing, {
    ...(existingRecord ?? {}),
    ...(toolCall ?? {}),
    id,
    tool,
    input: {
      ...(toObjectRecord(existingRecord?.input) ?? {}),
      ...(toObjectRecord(input.payload.input) ?? {}),
      ...(toObjectRecord(toolCall?.input) ?? {}),
    },
    output,
    status,
    ...(sequence !== null ? { sequence } : {}),
    latencyMs:
      typeof input.payload.latencyMs === "number"
        ? input.payload.latencyMs
        : (toolCall?.latencyMs ?? existingRecord?.latencyMs ?? null),
    error:
      input.payload.type === "tool-call-error"
        ? (input.payload.error ??
          toolCall?.error ??
          existingRecord?.error ??
          null)
        : toolCall?.error !== undefined
          ? toolCall.error
          : input.payload.error !== undefined
            ? input.payload.error
            : input.payload.type === "tool-call-start"
              ? null
              : (existingRecord?.error ?? null),
  });
}

function getToolCallIdFromPayload(payload: Record<string, unknown>) {
  const toolCall = toObjectRecord(payload.toolCall);
  return typeof payload.id === "string" && payload.id.length > 0
    ? payload.id
    : typeof toolCall?.id === "string" && toolCall.id.length > 0
      ? toolCall.id
      : null;
}

function getToolNameFromPayload(payload: Record<string, unknown>) {
  const toolCall = toObjectRecord(payload.toolCall);
  return typeof payload.tool === "string" && payload.tool.length > 0
    ? payload.tool
    : typeof toolCall?.tool === "string" && toolCall.tool.length > 0
      ? toolCall.tool
      : null;
}

function normalizeToolStatus(value: unknown): ToolCallTrace["status"] {
  return value === "approval_requested" ||
    value === "completed" ||
    value === "error" ||
    value === "running"
    ? value
    : "running";
}

function findToolCallSnapshotById(
  toolCalls: unknown[] | undefined,
  id: string,
) {
  return (toolCalls ?? [])
    .map(toObjectRecord)
    .find((record) => record?.id === id);
}

function toolCallTraceFromPayload(input: {
  payload: Record<string, unknown>;
  snapshot: ChatRunSnapshot;
}): ToolCallTrace | null {
  const payloadToolCall = toObjectRecord(input.payload.toolCall);
  const id = getToolCallIdFromPayload(input.payload);
  const tool = getToolNameFromPayload(input.payload);
  if (!id || !tool) {
    return null;
  }

  const snapshotToolCall = findToolCallSnapshotById(
    input.snapshot.toolCalls,
    id,
  );
  const mcpDisplay =
    normalizeMcpDisplay(payloadToolCall?.mcpDisplay) ??
    normalizeMcpDisplay(snapshotToolCall?.mcpDisplay);
  const output =
    input.payload.type === "tool-call-event"
      ? input.payload.data
      : input.payload.type === "tool-call-result"
        ? input.payload.output
        : input.payload.type === "tool-call-error"
          ? null
          : (payloadToolCall?.output ?? snapshotToolCall?.output ?? null);
  return {
    id,
    tool,
    ...(mcpDisplay ? { mcpDisplay } : {}),
    input: {
      ...(toObjectRecord(snapshotToolCall?.input) ?? {}),
      ...(toObjectRecord(input.payload.input) ?? {}),
      ...(toObjectRecord(payloadToolCall?.input) ?? {}),
    },
    output,
    status:
      input.payload.type === "tool-call-error"
        ? "error"
        : input.payload.type === "tool-call-result" ||
            input.payload.type === "tool-call-end"
          ? normalizeToolStatus(input.payload.status ?? payloadToolCall?.status)
          : normalizeToolStatus(
              payloadToolCall?.status ?? snapshotToolCall?.status,
            ),
    latencyMs:
      typeof input.payload.latencyMs === "number"
        ? input.payload.latencyMs
        : typeof payloadToolCall?.latencyMs === "number" ||
            payloadToolCall?.latencyMs === null
          ? payloadToolCall.latencyMs
          : typeof snapshotToolCall?.latencyMs === "number" ||
              snapshotToolCall?.latencyMs === null
            ? snapshotToolCall.latencyMs
            : null,
    error:
      input.payload.type === "tool-call-error"
        ? typeof input.payload.error === "string"
          ? input.payload.error
          : null
        : typeof payloadToolCall?.error === "string" ||
            payloadToolCall?.error === null
          ? payloadToolCall.error
          : typeof snapshotToolCall?.error === "string" ||
              snapshotToolCall?.error === null
            ? snapshotToolCall.error
            : null,
    sequence:
      getTraceSequence(payloadToolCall) ??
      getTraceSequence(snapshotToolCall) ??
      0,
  };
}

function mergeThinkingStep(existing: unknown[], next: unknown) {
  const record =
    next && typeof next === "object" && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : null;
  const id = typeof record?.id === "string" ? record.id : null;
  if (!id) {
    return existing;
  }

  return [
    ...existing.filter((item) => {
      const itemRecord =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null;
      return itemRecord?.id !== id;
    }),
    record,
  ];
}

function mergeReasoningSegment(existing: unknown[], next: unknown) {
  const record =
    next && typeof next === "object" && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : null;
  const id = typeof record?.id === "string" ? record.id : null;
  if (!id) {
    return existing;
  }

  const existingIndex = existing.findIndex((item) => {
    const itemRecord =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : null;
    return itemRecord?.id === id;
  });

  // One record per segment id, updated in place: the SSE segment carries no
  // `text` (only id, sequence, duration, phase), so any check beyond the id
  // never matched and every streamed delta appended a duplicate record. The
  // first sequence seen for an id is kept, matching
  // `stream/run-trace-state.ts` `upsertReasoningSegmentTrace`.
  if (existingIndex >= 0) {
    return existing.map((item, index) => {
      if (index !== existingIndex) {
        return item;
      }
      const existingRecord =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : {};
      return {
        ...existingRecord,
        ...record,
        id,
        ...(existingRecord.sequence !== undefined
          ? { sequence: existingRecord.sequence }
          : {}),
      };
    });
  }

  return [...existing, record];
}

function normalizeRenderBlock(value: unknown): MessageRenderBlock | null {
  const record = toObjectRecord(value);
  const id = typeof record?.id === "string" ? record.id : null;
  if (!record || !id) {
    return null;
  }
  const placement =
    record.placement === "inline" || record.placement === "terminal"
      ? record.placement
      : undefined;

  if (record.type === "text" && typeof record.text === "string") {
    return {
      id,
      ...(placement ? { placement } : {}),
      type: "text",
      text: record.text,
    };
  }

  if (record.type === "reasoning" && typeof record.text === "string") {
    const durationMs =
      typeof record.durationMs === "number" &&
      Number.isFinite(record.durationMs)
        ? record.durationMs
        : undefined;
    return {
      id,
      ...(placement ? { placement } : {}),
      type: "reasoning",
      text: record.text,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (record.type === "tool" && typeof record.toolCallId === "string") {
    return {
      id,
      ...(placement ? { placement } : {}),
      type: "tool",
      toolCallId: record.toolCallId,
    };
  }

  if (
    record.type === "artifact_output" &&
    typeof record.artifactId === "string" &&
    typeof record.artifactVersionId === "string" &&
    typeof record.sourceToolCallId === "string" &&
    typeof record.threadRunId === "string" &&
    typeof record.sequence === "number" &&
    (record.producer as { kind?: unknown } | undefined)?.kind !== undefined
  ) {
    const producer = toObjectRecord(record.producer);
    const kind = producer?.kind;
    if (kind !== "main" && kind !== "subagent") {
      return null;
    }
    const subagentType =
      typeof producer?.subagentType === "string"
        ? producer.subagentType
        : undefined;
    return {
      artifactId: record.artifactId,
      artifactVersionId: record.artifactVersionId,
      id,
      placement: "terminal",
      producer: {
        kind,
        ...(subagentType ? { subagentType } : {}),
      },
      sequence: record.sequence,
      sourceToolCallId: record.sourceToolCallId,
      threadRunId: record.threadRunId,
      type: "artifact_output",
    };
  }

  return null;
}

function normalizeRenderBlocks(blocks: unknown[] | undefined) {
  return (blocks ?? [])
    .map(normalizeRenderBlock)
    .filter((block): block is MessageRenderBlock => block !== null);
}

function appendTextRenderBlock(input: {
  blocks: unknown[] | undefined;
  text: string;
}) {
  if (!input.text) {
    return normalizeRenderBlocks(input.blocks);
  }

  const blocks = normalizeRenderBlocks(input.blocks);
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    return blocks.map((block, index) =>
      index === blocks.length - 1
        ? {
            ...last,
            text: `${last.text}${input.text}`,
          }
        : block,
    );
  }

  return [
    ...blocks,
    {
      id: `text-${blocks.length + 1}`,
      type: "text" as const,
      text: input.text,
    },
  ];
}

function replaceTextRenderBlock(input: {
  blocks: unknown[] | undefined;
  text: string;
}) {
  const blocks = normalizeRenderBlocks(input.blocks);
  if (!input.text) {
    return blocks.filter((block) => block.type !== "text");
  }

  let lastTextIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.type === "text") {
      lastTextIndex = index;
      break;
    }
  }

  if (lastTextIndex >= 0) {
    const prefix = blocks
      .slice(0, lastTextIndex)
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    const lastText = blocks[lastTextIndex];
    if (lastText?.type === "text" && input.text.startsWith(prefix)) {
      return blocks.map((block, index) =>
        index === lastTextIndex
          ? {
              ...lastText,
              text: input.text.slice(prefix.length),
            }
          : block,
      );
    }
  }

  const nonTextBlocks = blocks.filter((block) => block.type !== "text");
  return [
    ...nonTextBlocks,
    {
      id: `text-${nonTextBlocks.length + 1}`,
      type: "text" as const,
      text: input.text,
    },
  ];
}

function appendReasoningRenderBlock(input: {
  blocks: unknown[] | undefined;
  durationMs?: number;
  id: string;
  text: string;
}) {
  if (!input.text) {
    return normalizeRenderBlocks(input.blocks);
  }

  const blocks = normalizeRenderBlocks(input.blocks);
  const existing = blocks.find(
    (block) => block.type === "reasoning" && block.id === input.id,
  );
  if (existing?.type === "reasoning") {
    return blocks.map((block) =>
      block.type === "reasoning" && block.id === input.id
        ? {
            ...block,
            // One block per segment accumulates every streamed delta; keep
            // the tail so a long model call cannot grow the snapshot without
            // bound (see reasoning-bounds.ts).
            text: boundReasoningSegmentText(`${block.text}${input.text}`),
            ...(typeof input.durationMs === "number"
              ? { durationMs: input.durationMs }
              : {}),
          }
        : block,
    );
  }

  return [
    ...blocks,
    {
      id: input.id,
      type: "reasoning" as const,
      text: boundReasoningSegmentText(input.text),
      ...(typeof input.durationMs === "number"
        ? { durationMs: input.durationMs }
        : {}),
    },
  ];
}

function appendToolRenderBlock(input: {
  blocks: unknown[] | undefined;
  toolCallId: string;
}) {
  const blocks = normalizeRenderBlocks(input.blocks);
  if (
    blocks.some(
      (block) => block.type === "tool" && block.toolCallId === input.toolCallId,
    )
  ) {
    return blocks;
  }

  return [
    ...blocks,
    {
      id: `tool-${input.toolCallId}`,
      type: "tool" as const,
      toolCallId: input.toolCallId,
    },
  ];
}

/** The render block id of a reasoning segment; the only link from block to segment. */
function reasoningRenderBlockId(segmentId: string) {
  return `reasoning-${segmentId}`;
}

/**
 * The turn layer's notice that a model call failed after streaming part of
 * its output and is being retried: everything the failed attempt streamed is
 * withdrawn before the retry re-emits under new segment ids.
 */
type SegmentResetPayload = {
  reason: string;
  attempt: number | null;
  /** Reasoning segments the failed attempt produced. */
  segmentIds: string[];
  /** Tool calls whose argument chunks streamed but never completed. */
  toolCallIds: string[];
  /** Length of `assistantContent` before the failed attempt started. */
  keepTextChars: number | null;
  /** Reasoning characters the failed attempt streamed (withdrawn from the end). */
  dropReasoningChars: number | null;
  /** Length of the unbounded runtime reasoning before the failed attempt started. */
  keepReasoningChars: number | null;
};

function parseSegmentResetPayload(
  payload: Record<string, unknown>,
): SegmentResetPayload | null {
  if (payload.type !== "segment-reset") {
    return null;
  }
  const stringList = (value: unknown) =>
    Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
      : [];
  const nonNegativeInteger = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : null;
  return {
    reason: typeof payload.reason === "string" ? payload.reason : "unknown",
    attempt: nonNegativeInteger(payload.attempt),
    segmentIds: stringList(payload.segmentIds),
    toolCallIds: stringList(payload.toolCallIds),
    keepTextChars: nonNegativeInteger(payload.keepTextChars),
    dropReasoningChars: nonNegativeInteger(payload.dropReasoningChars),
    keepReasoningChars: nonNegativeInteger(payload.keepReasoningChars),
  };
}

/**
 * The run's accumulated `reasoning` after a reset.
 *
 * While the snapshot text is under its cap it is the plain concatenation of
 * every delta, exactly what the runtime holds, so the failed attempt's
 * characters are cut from the end (`dropReasoningChars`; `keepReasoningChars`
 * is the same cut expressed from the start, used only when the drop count is
 * absent). The result is what `boundSnapshotReasoning` yields for the runtime
 * text, so the finalizer's terminal write and a snapshot-sourced terminal
 * failure still agree at the same revision (the #328 "equal revision ⇒ equal
 * text" invariant). Rebuilding from render blocks would not: each block is
 * bounded on its own at the segment cap, so a surviving 70k segment would put
 * a per-segment marker into a string the runtime never produces.
 *
 * Once the snapshot text carries the snapshot marker, its prefix is already
 * gone and no cut from the end can be squared with the runtime; the survivors'
 * blocks are the best available source, in order, bounded by the snapshot rule.
 */
function resetSnapshotReasoning(input: {
  current: string;
  reset: SegmentResetPayload;
  survivingSegmentBlocks: MessageRenderBlock[];
}) {
  const { current, reset } = input;
  if (!hasReasoningTruncationMarker(current)) {
    if (reset.dropReasoningChars !== null) {
      return current.slice(
        0,
        Math.max(0, current.length - reset.dropReasoningChars),
      );
    }
    if (reset.keepReasoningChars !== null) {
      return current.slice(0, reset.keepReasoningChars);
    }
  }
  return boundSnapshotReasoning(
    input.survivingSegmentBlocks
      .map((block) => (block.type === "reasoning" ? block.text : ""))
      .join(""),
  );
}

/**
 * Drop the last `dropChars` characters of streamed text from the text render
 * blocks, walking back from the newest block. Counted from the end rather than
 * from an absolute offset: on a continuation the blocks start with the prior
 * run's text while `assistantContent` holds only this run's, so only the
 * amount to withdraw is shared between the two.
 */
function truncateTextRenderBlocks(
  blocks: MessageRenderBlock[],
  dropChars: number,
) {
  let remaining = dropChars;
  const result: MessageRenderBlock[] = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.type !== "text" || remaining <= 0) {
      result.unshift(block);
      continue;
    }
    if (block.text.length <= remaining) {
      remaining -= block.text.length;
      continue;
    }
    result.unshift({
      ...block,
      text: block.text.slice(0, block.text.length - remaining),
    });
    remaining = 0;
  }
  return result;
}

/**
 * Withdraw the output of a failed model attempt from the snapshot.
 *
 * Reasoning is removed by segment id wherever the segment left a trace: its
 * `reasoningSegments` record, its render block, its trace event (matched by
 * `itemId`, never by rebuilding the event id) and its trace part. Tool calls
 * are removed only while still `running`: a call that reached a result, an
 * error or an approval request came from a model call that succeeded, so a
 * reset naming it by mistake leaves it alone. `thinking-step` state is not
 * the model's output and is left as is, and the surviving trace events keep
 * their `displayOrder` so an attaching client sees the same order as before.
 *
 * `reasoning` loses the failed attempt's characters (see
 * `resetSnapshotReasoning`; the block fallback only reads this run's segments,
 * since continuation blocks of a prior run live in `reasoningRun.base`) and
 * the revision moves forward so the reasoningWrite CAS accepts the shorter
 * text. The turn layer opens a fresh segment at every model-call begin, so a
 * failed attempt never extends an earlier open segment: `segmentIds` describes
 * the whole withdrawal and no segment is ever partially cut.
 */
function applySegmentReset(
  snapshot: ChatRunSnapshot,
  reset: SegmentResetPayload,
): ChatRunSnapshot {
  const segmentIds = new Set(reset.segmentIds);
  const removableToolCallIds = new Set(
    reset.toolCallIds.filter((id) => {
      const record = findToolCallSnapshotById(snapshot.toolCalls, id);
      return !!record && record.status === "running";
    }),
  );
  // A list that lost nothing is handed back as it was (same reference,
  // `undefined` stays `undefined`): a reset naming only unknown ids changes
  // nothing beyond the revision.
  const ifShrunk = <K extends string, T>(
    key: K,
    before: T[] | undefined,
    after: T[],
  ): Partial<Record<K, T[]>> =>
    before !== undefined && before.length !== after.length
      ? ({ [key]: after } as Record<K, T[]>)
      : {};
  const reasoningSegments = (snapshot.reasoningSegments ?? []).filter(
    (segment) => {
      const id = toObjectRecord(segment)?.id;
      return typeof id !== "string" || !segmentIds.has(id);
    },
  );
  const remainingSegmentBlockIds = new Set(
    reasoningSegments
      .map((segment) => toObjectRecord(segment)?.id)
      .filter((id): id is string => typeof id === "string")
      .map(reasoningRenderBlockId),
  );

  const assistantContent = snapshot.assistantContent ?? "";
  const dropTextChars =
    reset.keepTextChars !== null &&
    reset.keepTextChars < assistantContent.length
      ? assistantContent.length - reset.keepTextChars
      : 0;
  const removedReasoningBlockIds = new Set(
    [...segmentIds].map(reasoningRenderBlockId),
  );
  const currentBlocks = normalizeRenderBlocks(snapshot.renderBlocks);
  const survivingBlocks = currentBlocks.filter((block) =>
    block.type === "reasoning"
      ? !removedReasoningBlockIds.has(block.id)
      : block.type === "tool"
        ? !removableToolCallIds.has(block.toolCallId)
        : true,
  );
  const nextBlocks =
    survivingBlocks.length === currentBlocks.length && dropTextChars === 0
      ? currentBlocks
      : truncateTextRenderBlocks(survivingBlocks, dropTextChars);
  const renderBlocks =
    nextBlocks === currentBlocks ? snapshot.renderBlocks : nextBlocks;
  const reasoning = resetSnapshotReasoning({
    current: snapshot.reasoning ?? "",
    reset,
    survivingSegmentBlocks: nextBlocks.filter(
      (block) =>
        block.type === "reasoning" && remainingSegmentBlockIds.has(block.id),
    ),
  });

  const traceEvents = (snapshot.traceEvents ?? []).filter((event) => {
    const record = toObjectRecord(event);
    const itemId = typeof record?.itemId === "string" ? record.itemId : null;
    if (!itemId) {
      return true;
    }
    if (record?.type === "reasoning") {
      return !segmentIds.has(itemId);
    }
    if (record?.type === "tool-call") {
      return !removableToolCallIds.has(itemId);
    }
    return true;
  });
  const traceParts = (snapshot.traceParts ?? []).filter((part) => {
    const record = toObjectRecord(part);
    if (record?.kind === "reasoning") {
      return typeof record.id !== "string" || !segmentIds.has(record.id);
    }
    if (record?.kind === "tool") {
      return (
        typeof record.toolCallId !== "string" ||
        !removableToolCallIds.has(record.toolCallId)
      );
    }
    return true;
  });
  const toolCalls = (snapshot.toolCalls ?? []).filter((toolCall) => {
    const id = toObjectRecord(toolCall)?.id;
    return typeof id !== "string" || !removableToolCallIds.has(id);
  });

  return {
    ...snapshot,
    ...(dropTextChars
      ? {
          assistantContent: assistantContent.slice(
            0,
            assistantContent.length - dropTextChars,
          ),
        }
      : {}),
    ...(reasoning !== snapshot.reasoning ? { reasoning } : {}),
    reasoningRevision: (snapshot.reasoningRevision ?? 0) + 1,
    ...ifShrunk(
      "reasoningSegments",
      snapshot.reasoningSegments,
      reasoningSegments,
    ),
    ...(renderBlocks !== snapshot.renderBlocks ? { renderBlocks } : {}),
    ...ifShrunk("traceEvents", snapshot.traceEvents, traceEvents),
    ...ifShrunk("traceParts", snapshot.traceParts, traceParts),
    ...ifShrunk("toolCalls", snapshot.toolCalls, toolCalls),
  };
}

function updateSnapshotFromPayload(
  snapshot: ChatRunSnapshot,
  payload: Record<string, unknown> | null,
) {
  if (!payload || typeof payload.type !== "string") {
    return snapshot;
  }

  // A rejected late phase event must not replace the terminal marker: a
  // second event would otherwise bypass the guard after cancellation/error.
  if (
    payload.type === "agent-run-progress" &&
    (snapshot.finishReason ||
      snapshot.lastEventType === "finish" ||
      snapshot.lastEventType === "error")
  ) {
    return snapshot;
  }
  const next: ChatRunSnapshot = {
    ...snapshot,
    lastEventType:
      (snapshot.lastEventType === "finish" ||
        snapshot.lastEventType === "error") &&
      payload.type !== "finish" &&
      payload.type !== "error"
        ? snapshot.lastEventType
        : payload.type,
  };
  if (payload.type === "text-delta" && typeof payload.delta === "string") {
    next.assistantContent = `${next.assistantContent ?? ""}${payload.delta}`;
    next.renderBlocks = appendTextRenderBlock({
      blocks: next.renderBlocks,
      text: payload.delta,
    });
  }
  if (payload.type === "text-replace" && typeof payload.text === "string") {
    next.assistantContent = payload.text;
    next.renderBlocks = replaceTextRenderBlock({
      blocks: next.renderBlocks,
      text: payload.text,
    });
  }
  if (payload.type === "reasoning" && typeof payload.reasoning === "string") {
    // Bounded per revision: the text for a given revision is a pure function
    // of the delta sequence, so the reasoningWrite CAS (equal revision ⇒ equal
    // text) still holds after truncation.
    next.reasoning = boundSnapshotReasoning(
      `${next.reasoning ?? ""}${payload.reasoning}`,
    );
    next.reasoningRevision = (snapshot.reasoningRevision ?? 0) + 1;
    if (payload.segment) {
      next.reasoningSegments = mergeReasoningSegment(
        next.reasoningSegments ?? [],
        payload.segment,
      );
      const segment =
        payload.segment &&
        typeof payload.segment === "object" &&
        !Array.isArray(payload.segment)
          ? (payload.segment as Parameters<
              typeof tracePartFromReasoningSegment
            >[0])
          : null;
      if (segment) {
        next.renderBlocks = appendReasoningRenderBlock({
          blocks: next.renderBlocks,
          durationMs:
            typeof segment.durationMs === "number"
              ? segment.durationMs
              : undefined,
          id: reasoningRenderBlockId(segment.id),
          text: payload.reasoning,
        });
        next.traceParts = upsertTracePart(
          next.traceParts,
          tracePartFromReasoningSegment(segment),
        );
      }
    }
  }
  if (payload.type === "segment-reset") {
    const reset = parseSegmentResetPayload(payload);
    if (reset) {
      Object.assign(next, applySegmentReset(next, reset));
    }
  }
  if (payload.type === "thinking-step" && payload.step) {
    next.thinkingSteps = mergeThinkingStep(
      next.thinkingSteps ?? [],
      payload.step,
    );
    const step =
      payload.step &&
      typeof payload.step === "object" &&
      !Array.isArray(payload.step)
        ? (payload.step as Parameters<typeof tracePartFromThinkingStep>[0])
        : null;
    if (step) {
      next.traceParts = upsertTracePart(
        next.traceParts,
        tracePartFromThinkingStep(step),
      );
    }
  }
  if (String(payload.type).startsWith("tool-call-")) {
    next.toolCalls = mergeToolCallFromPayload({
      existing: next.toolCalls ?? [],
      payload,
    });
    const toolCall = toolCallTraceFromPayload({ payload, snapshot: next });
    if (toolCall) {
      next.traceParts = upsertTracePart(
        next.traceParts,
        tracePartFromToolCall(toolCall),
      );
    }
  }
  if (payload.type === "tool-call-start") {
    const toolCallId = getToolCallIdFromPayload(payload);
    // Uniform: every tool gets a tool block (its progress card) first. Artifact
    // tools additionally get a terminal artifact block below — no capability is
    // singled out.
    if (toolCallId) {
      next.renderBlocks = appendToolRenderBlock({
        blocks: next.renderBlocks,
        toolCallId,
      });
    }
  }
  if (
    payload.type === "agent-run-progress" &&
    !snapshot.finishReason &&
    snapshot.lastEventType !== "finish" &&
    snapshot.lastEventType !== "error"
  ) {
    next.agentRunProgress = advanceAgentRunProgress(
      snapshot.agentRunProgress,
      payload.progress,
    );
  }
  if (payload.type === "finish" || payload.type === "error") {
    if (payload.code === "CLIENT_CANCELLED") next.agentRunProgress = null;
    else if (
      payload.agentRunProgress !== undefined &&
      snapshot.lastEventType !== "finish" &&
      snapshot.lastEventType !== "error"
    )
      next.agentRunProgress = advanceAgentRunProgress(
        snapshot.agentRunProgress,
        payload.agentRunProgress,
      );
    if (payload.code === "CLIENT_CANCELLED") next.agentRunStop = null;
    else if (payload.agentRunStop !== undefined)
      next.agentRunStop = readAgentRunStop(payload.agentRunStop);
  }
  if (payload.type === "finish") {
    next.finishReason =
      typeof payload.finishReason === "string" ? payload.finishReason : null;
    if (
      payload.agentCheckpoint &&
      typeof payload.agentCheckpoint === "object" &&
      !Array.isArray(payload.agentCheckpoint)
    ) {
      next.agentCheckpoint =
        payload.agentCheckpoint as ChatRunSnapshot["agentCheckpoint"];
    }
  }
  if (payload.type === "citations") {
    if (Array.isArray(payload.citations)) {
      next.citations = payload.citations;
    }
    if (Array.isArray(payload.availableCitations)) {
      next.availableCitations = payload.availableCitations;
    } else if (Array.isArray(payload.citations)) {
      next.availableCitations = payload.citations;
    }
  }
  next.traceEvents = appendTraceEvent(
    next.traceEvents,
    traceEventFromPayload({
      payload,
      eventIndex: next.traceEvents?.length ?? 0,
    }),
  );
  return next;
}

function buildThreadRunMetadata(run: ChatThreadRunRecord) {
  return {
    threadRun: {
      id: run.id,
      idempotencyKey: run.idempotencyKey,
      status: run.status,
      mode: run.mode,
      streamKey: run.streamKey,
      ...(run.assistantMessageId
        ? { assistantMessageId: run.assistantMessageId }
        : {}),
      ...(run.startedAt && run.finishedAt
        ? {
            startedAt: run.startedAt,
            completedAt: run.finishedAt,
          }
        : {}),
    },
  };
}

function getTraceSequence(value: unknown) {
  const sequence = toObjectRecord(value)?.sequence;
  return typeof sequence === "number" && Number.isFinite(sequence)
    ? sequence
    : null;
}

function getTraceEventKey(value: unknown) {
  const record = toObjectRecord(value);
  const type = typeof record?.type === "string" ? record.type : null;
  const id = typeof record?.id === "string" ? record.id : null;
  if (!type || !id) {
    return null;
  }
  return `${type}:${id}`;
}

function buildTraceEventId(input: {
  baseId: string;
  eventIndex?: number;
  eventType?: string;
  phase?: string | null;
  sequence: number | null;
}) {
  const suffix = [input.phase, input.eventType, input.eventIndex]
    .filter((item) => item !== undefined && item !== null && item !== "")
    .join(":");
  const id =
    input.sequence === null
      ? input.baseId
      : `${input.baseId}:${input.sequence}`;
  return suffix ? `${id}:${suffix}` : id;
}

/**
 * One past the highest `displayOrder` present. Equal to the array length while
 * events are only ever appended; after a segment reset removed events, the
 * survivors keep their order and a new event must still sort after them.
 */
function nextTraceDisplayOrder(events: unknown[]) {
  let highest = -1;
  for (const event of events) {
    const displayOrder = toObjectRecord(event)?.displayOrder;
    if (typeof displayOrder === "number" && Number.isFinite(displayOrder)) {
      highest = Math.max(highest, displayOrder);
    }
  }
  return Math.max(highest + 1, events.length);
}

function appendTraceEvent(
  events: unknown[] | undefined,
  event: Record<string, unknown> | null,
) {
  if (!event) {
    return events ?? [];
  }

  const current = events ?? [];
  const key = getTraceEventKey(event);
  const nextEvent = {
    ...event,
    displayOrder: nextTraceDisplayOrder(current),
  };
  if (!key) {
    return [...current, nextEvent];
  }

  const existingIndex = current.findIndex(
    (item) => getTraceEventKey(item) === key,
  );
  if (existingIndex < 0) {
    return [...current, nextEvent];
  }

  const existing = toObjectRecord(current[existingIndex]);
  const displayOrder =
    typeof existing?.displayOrder === "number" &&
    Number.isFinite(existing.displayOrder)
      ? existing.displayOrder
      : existingIndex;
  // A reasoning segment is one event updated in place per delta; its `chars`
  // counts every delta streamed for the segment, not just the latest one.
  const chars =
    event.type === "reasoning" &&
    typeof event.chars === "number" &&
    typeof existing?.chars === "number"
      ? { chars: existing.chars + event.chars }
      : {};
  return current.map((item, index) =>
    index === existingIndex
      ? {
          ...event,
          ...chars,
          displayOrder,
        }
      : item,
  );
}

function traceEventFromPayload(input: {
  eventIndex: number;
  payload: Record<string, unknown> | null;
}) {
  const { eventIndex, payload } = input;
  if (!payload || typeof payload.type !== "string") {
    return null;
  }

  if (payload.type === "reasoning") {
    const segment = toObjectRecord(payload.segment);
    const segmentId = typeof segment?.id === "string" ? segment.id : null;
    if (!segment || !segmentId) {
      return null;
    }
    const sequence = getTraceSequence(segment);
    // Segment-level identity (no eventIndex): every streamed delta of one
    // segment upserts the same event, so a run carries one trace event per
    // reasoning segment instead of one per token. The delta text itself is
    // not kept: the client replays reasoning from renderBlocks/reasoning, and
    // per-delta copies were what inflated snapshots to megabytes.
    return {
      type: "reasoning",
      id: buildTraceEventId({
        baseId: segmentId,
        eventType: payload.type,
        phase: typeof segment.phase === "string" ? segment.phase : null,
        sequence,
      }),
      itemId: segmentId,
      sequence,
      segment,
      ...(typeof payload.reasoning === "string"
        ? { chars: payload.reasoning.length }
        : {}),
    };
  }

  if (payload.type === "thinking-step") {
    const step = toObjectRecord(payload.step);
    const stepId = typeof step?.id === "string" ? step.id : null;
    if (!step || !stepId) {
      return null;
    }
    const sequence = getTraceSequence(step);
    return {
      type: "thinking-step",
      id: buildTraceEventId({
        baseId: stepId,
        eventIndex,
        eventType: payload.type,
        sequence,
      }),
      itemId: stepId,
      sequence,
      step,
    };
  }

  if (payload.type.startsWith("tool-call-")) {
    const toolCall = toObjectRecord(payload.toolCall);
    const eventId =
      typeof payload.id === "string" && payload.id.length > 0
        ? payload.id
        : typeof toolCall?.id === "string" && toolCall.id.length > 0
          ? toolCall.id
          : null;
    if (!eventId) {
      return null;
    }
    const sequence = getTraceSequence(toolCall);
    return {
      type: "tool-call",
      id: buildTraceEventId({
        baseId: eventId,
        eventIndex,
        eventType: payload.type,
        phase:
          typeof payload.event === "string"
            ? payload.event
            : typeof toObjectRecord(payload.data)?.type === "string"
              ? (toObjectRecord(payload.data)?.type as string)
              : null,
        sequence,
      }),
      itemId: eventId,
      sequence,
      eventType: payload.type,
      tool: typeof payload.tool === "string" ? payload.tool : toolCall?.tool,
      // Identity and state only. The event used to carry the raw SSE payload
      // and the full toolCall, so one completed tool's output sat in the
      // trace three times per result event; see projectToolCallTraceEvent.
      toolCall: toolCall ? projectToolCallTraceEvent(toolCall) : undefined,
    };
  }

  return null;
}

/**
 * The bounded projection of a tool call kept on a tool-call trace event.
 *
 * Trace events exist for ordering (`id`/`sequence`, read by the preparer's
 * continuation recovery and the trace-metadata merge) and for display
 * identity (`id`/`tool`/`mcpDisplay`, read by the web normalizer). The tool's
 * `input` and `output` are deliberately absent: both can be hundreds of KB
 * (`write_file` content, search results) and are already persisted exactly
 * once in `snapshot.toolCalls[id]`, which is where every consumer of tool
 * output reads them. Fields are allow-listed rather than denied so a future
 * large field cannot re-inflate the trace by default.
 */
function projectToolCallTraceEvent(toolCall: Record<string, unknown>) {
  const projected: Record<string, unknown> = {};
  for (const key of [
    "id",
    "tool",
    "mcpDisplay",
    "status",
    "latencyMs",
    "error",
    "sequence",
    "approvalState",
    "approvalConfirmationId",
    "producer",
  ] as const) {
    if (toolCall[key] !== undefined) {
      projected[key] = toolCall[key];
    }
  }
  // `error` is a raw string of any length (a tool may echo its whole stdout);
  // the canonical copy on `toolCalls[id].error` is left intact.
  if (typeof projected.error === "string") {
    projected.error = truncateErrorText(
      projected.error,
      MAX_TOOL_TRACE_EVENT_ERROR_CHARS,
    );
  }
  return projected;
}

/** Longest `toolCall.error` a tool-call trace event carries. */
const MAX_TOOL_TRACE_EVENT_ERROR_CHARS = 2_000;

function buildSnapshotMetadata(input: {
  currentMetadata?: Record<string, unknown> | null;
  run: ChatThreadRunRecord;
  snapshot: ChatRunSnapshot;
}) {
  const nextMetadata = {
    ...(input.currentMetadata ?? {}),
    userMessageId: input.run.userMessageId,
    sourceUserMessageId: input.run.userMessageId,
    agentRunProgress:
      input.run.status === "cancelled" ||
      input.run.status === "cancel_requested"
        ? undefined
        : (readAgentRunProgress(input.snapshot.agentRunProgress) ?? undefined),
    agentRunStop:
      input.run.status === "cancelled" ||
      input.run.status === "cancel_requested"
        ? undefined
        : (readAgentRunStop(input.snapshot.agentRunStop) ?? undefined),
    toolCalls: input.snapshot.toolCalls ?? [],
    thinkingSteps: input.snapshot.thinkingSteps ?? [],
    ...projectSnapshotReasoning(input.snapshot, input.run.status !== "running"),
    reasoningSegments: input.snapshot.reasoningSegments ?? [],
    traceEvents: input.snapshot.traceEvents ?? [],
    traceParts: input.snapshot.traceParts ?? [],
    renderBlocks: input.snapshot.renderBlocks ?? [],
    // Progress does not own accounting. In particular, an absent or stale
    // snapshot must not clear the finalizer's already-committed call facts.
    ...(input.snapshot.finishReason !== undefined
      ? { finishReason: input.snapshot.finishReason }
      : {}),
    ...(input.snapshot.agentCheckpoint !== undefined
      ? { agentCheckpoint: input.snapshot.agentCheckpoint }
      : {}),
    retrieval: {
      citations: input.snapshot.citations ?? [],
      availableCitations:
        input.snapshot.availableCitations ?? input.snapshot.citations ?? [],
    },
    ...buildThreadRunMetadata(input.run),
  };
  return preserveAssistantMetadataForContinuation({
    existingMetadata: input.currentMetadata,
    nextMetadata,
  });
}

function snapshotWithFinalizedResult(
  snapshot: ChatRunSnapshot,
  result: Required<Pick<DurableRunResultSnapshot, "assistantMessage">> &
    Pick<DurableRunResultSnapshot, "retrieval" | "billing">,
): ChatRunSnapshot {
  const metadata = result.assistantMessage.metadata ?? {};
  // Only the committed finalizer result supplies these fields. Assign missing
  // values as undefined too, so a different run's facts cannot be inherited.
  return {
    ...snapshot,
    ...result,
    agentRunProgress:
      metadata.isCancelled === true
        ? null
        : readAgentRunProgress(metadata.agentRunProgress),
    agentRunStop:
      metadata.isCancelled === true
        ? null
        : readAgentRunStop(metadata.agentRunStop),
    meteredLlmCalls: Array.isArray(metadata.meteredLlmCalls)
      ? (metadata.meteredLlmCalls as NonNullable<
          ChatRunSnapshot["meteredLlmCalls"]
        >)
      : undefined,
    meteredLlmCreditsConsumed:
      typeof metadata.meteredLlmCreditsConsumed === "number"
        ? metadata.meteredLlmCreditsConsumed
        : undefined,
    usage: (toObjectRecord(metadata.usage) ??
      undefined) as ChatRunSnapshot["usage"],
  };
}

function resolveFinalRunAfterFinish(input: {
  finished: ChatThreadRunRecord | null;
  latest: ChatThreadRunRecord | null;
  run: ChatThreadRunRecord;
}) {
  return input.finished ?? input.latest ?? input.run;
}

function resolvePreparedAssistantMessageId(input: {
  prepared: Pick<
    PreparedThreadTurn,
    "assistantMessageId" | "assistantMessageIdOverride"
  >;
  placeholderId: string;
}) {
  return input.prepared.assistantMessageId ?? input.placeholderId;
}

async function createAssistantPlaceholder(input: {
  run: ChatThreadRunRecord;
  prepared: PreparedThreadTurn;
}) {
  if (input.prepared.assistantMessageId) {
    const existingAssistantMessage = await findMessageRecord({
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      messageId: input.prepared.assistantMessageId,
    });
    if (!existingAssistantMessage) {
      throw new ContentError(
        404,
        "ASSISTANT_MESSAGE_NOT_FOUND",
        "Assistant message not found for continuation",
      );
    }

    const assistantMessage = await updateMessageRecord({
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      threadId: input.run.threadId,
      messageId: input.prepared.assistantMessageId,
      metadata: {
        ...existingAssistantMessage.metadata,
        ...buildThreadRunMetadata(input.run),
        ...(existingAssistantMessage.metadata.reasoningWrite &&
        (existingAssistantMessage.metadata.reasoningWrite as { runId: string })
          .runId === input.run.id
          ? {}
          : projectReasoning({
              run: input.prepared.reasoningRun,
              text: undefined,
            })),
      },
    });

    return assistantMessage ?? existingAssistantMessage;
  }

  const overrideId = input.prepared.assistantMessageIdOverride ?? undefined;
  const existingOverrideMessage = overrideId
    ? await findMessageRecord({
        teamId: input.run.teamId,
        workspaceId: input.run.workspaceId,
        messageId: overrideId,
      })
    : null;

  if (existingOverrideMessage) {
    if (
      existingOverrideMessage.threadId !== input.run.threadId ||
      existingOverrideMessage.role !== "assistant"
    ) {
      throw new ContentError(
        409,
        "MESSAGE_ID_OVERRIDE_CONFLICT",
        "Assistant message id override is already used by another message.",
      );
    }
    const assistantMessage = await updateMessageRecord({
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      threadId: input.run.threadId,
      messageId: existingOverrideMessage.id,
      metadata: preserveAssistantMetadataForContinuation({
        existingMetadata: existingOverrideMessage.metadata,
        nextMetadata: {
          ...existingOverrideMessage.metadata,
          ...buildThreadRunMetadata(input.run),
          ...(existingOverrideMessage.metadata.reasoningWrite &&
          (existingOverrideMessage.metadata.reasoningWrite as { runId: string })
            .runId === input.run.id
            ? {}
            : projectReasoning({
                run: input.prepared.reasoningRun,
                text: undefined,
              })),
        },
      }),
    });
    return assistantMessage ?? existingOverrideMessage;
  }

  const assistantMessage = await createMessageRecord({
    ...(overrideId ? { id: overrideId } : {}),
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    parentMessageId: input.prepared.assistantMessageParentId,
    role: "assistant",
    content: "",
    createdBy: null,
    model: input.prepared.modelAlias,
    creditsConsumed: null,
    metadata: {
      userMessageId: input.prepared.userMessage.id,
      sourceUserMessageId: input.prepared.userMessage.id,
      traceId:
        input.prepared.traceContext?.traceId ?? input.prepared.runTraceId,
      modelAlias: input.prepared.modelAlias,
      profileAlias: input.prepared.profileAlias,
      versionOf: input.prepared.assistantMessageParentId,
      toolCalls: [],
      thinkingSteps: input.prepared.preflightThinkingSteps,
      traceParts: [],
      renderBlocks: [],
      ...projectReasoning({
        run: input.prepared.reasoningRun,
        text: undefined,
      }),
      ...buildThreadRunMetadata(input.run),
    },
  });

  return assistantMessage;
}

async function updateAssistantSnapshot(input: {
  run: ChatThreadRunRecord;
  assistantMessageId: string;
  snapshot: ChatRunSnapshot;
}) {
  await persistMessageProjection({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    messageId: input.assistantMessageId,
    project: (currentMessage) => ({
      content: appendAssistantContinuationContent({
        existingContent:
          input.snapshot.assistantMessage?.content ?? currentMessage.content,
        nextContent: input.snapshot.assistantContent ?? "",
      }),
      metadata: buildSnapshotMetadata({
        currentMetadata: currentMessage.metadata,
        run: input.run,
        snapshot: input.snapshot,
      }),
    }),
  });
}

async function createDurableErrorMessage(input: {
  run: ChatThreadRunRecord;
  assistantMessageId: string | null;
  snapshot: ChatRunSnapshot;
  createErrorInput: Parameters<typeof createThreadStreamErrorMessage>[0];
}) {
  if (!input.assistantMessageId) {
    return createThreadStreamErrorMessage(input.createErrorInput);
  }

  const isClientCancelled =
    input.createErrorInput.contentError.code === "CLIENT_CANCELLED";
  const meteredLlmCalls =
    input.createErrorInput.partialState?.meteredLlmCalls ??
    input.snapshot.meteredLlmCalls ??
    [];
  const errorBilling = buildErrorTurnBilling({
    meteredLlmCalls,
    preflightBilling: input.createErrorInput.prepared.preflightBilling,
  });
  const assistantContent = appendAssistantContinuationContent({
    existingContent: input.snapshot.assistantMessage?.content,
    nextContent:
      input.createErrorInput.partialAssistantContent?.trimEnd() ??
      input.createErrorInput.contentError.message,
  });
  const message = await updateMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    messageId: input.assistantMessageId,
    content: assistantContent,
    model: input.createErrorInput.prepared.modelAlias,
    creditsConsumed: errorBilling.creditsConsumed,
    metadata: {
      isError: !isClientCancelled,
      isCancelled: isClientCancelled,
      excludeFromContext: true,
      error: input.createErrorInput.contentError.message,
      errorCode: input.createErrorInput.contentError.code,
      agentRunStop: isClientCancelled
        ? undefined
        : (readAgentRunStop(
            toObjectRecord(input.createErrorInput.contentError.details)
              ?.agentRunStop,
          ) ?? undefined),
      agentCheckpoint: isClientCancelled
        ? undefined
        : (agentCheckpointFromStepStopError(
            input.createErrorInput.contentError,
          ) ?? undefined),
      userMessageId: input.createErrorInput.prepared.userMessage.id,
      sourceUserMessageId: input.createErrorInput.prepared.userMessage.id,
      traceId:
        input.createErrorInput.prepared.traceContext?.traceId ??
        input.createErrorInput.prepared.userMessage.id,
      modelAlias: input.createErrorInput.prepared.modelAlias,
      profileAlias: input.createErrorInput.prepared.profileAlias,
      agentMode: input.createErrorInput.prepared.agentMode,
      versionOf: input.createErrorInput.prepared.assistantMessageParentId,
      ...errorBilling.metadata,
      // The runtime partial state is unbounded; project it through the same
      // bound as the snapshot so every terminal writer of this revision
      // produces the identical string the reasoningWrite CAS compares.
      ...projectReasoning({
        run: input.snapshot.reasoningRun,
        text: boundSnapshotReasoning(
          input.createErrorInput.partialState?.reasoning ??
            input.snapshot.reasoning,
        ),
        terminal: true,
      }),
      reasoningSegments: input.snapshot.reasoningSegments ?? [],
      traceParts: input.snapshot.traceParts ?? [],
      toolCalls: input.snapshot.toolCalls ?? [],
      renderBlocks: boundReasoningRenderBlocks(
        input.snapshot.renderBlocks ?? [],
      ),
      thinkingSteps: input.snapshot.thinkingSteps ?? [],
      retrieval: {
        citations: input.snapshot.citations ?? [],
        availableCitations:
          input.snapshot.availableCitations ?? input.snapshot.citations ?? [],
      },
      ...buildThreadRunMetadata({
        ...input.run,
        status:
          input.createErrorInput.contentError.code === "CLIENT_CANCELLED"
            ? "cancelled"
            : "failed",
      }),
    },
  });

  return message;
}

export async function persistTerminalFailure(input: {
  run: ChatThreadRunRecord;
  status: Extract<TerminalRunStatus, "failed" | "cancelled">;
  assistantMessageId: string | null;
  snapshot: ChatRunSnapshot;
  contentError: ContentError;
  appendRunEvent: DurableChatRunServiceAppendRunEvent;
  finishRun: DurableChatRunServiceFinishRun;
  findRunById?: typeof findChatThreadRunById;
  findMessage?: typeof findMessageRecord;
}) {
  const findRun = input.findRunById ?? findChatThreadRunById;
  const readCurrent = () =>
    findRun({
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
    });
  let finished: ChatThreadRunRecord | null = null;
  try {
    const current = await readCurrent();
    if (current && isTerminalRunStatus(current.status)) return current;
    const run = current ?? input.run;
    const messageIds = await resolvePersistedTerminalMessageIds({
      run,
      assistantMessageId: input.assistantMessageId,
      findMessage: input.findMessage,
    });
    const terminalRun = {
      ...run,
      status: input.status,
      ...messageIds,
    };
    const stoppedSnapshot = {
      ...input.snapshot,
      ...(input.status !== "cancelled" &&
      agentCheckpointFromStepStopError(input.contentError)
        ? {
            agentCheckpoint: agentCheckpointFromStepStopError(
              input.contentError,
            )!,
          }
        : {}),
      agentRunStop:
        input.status === "cancelled"
          ? null
          : readAgentRunStop(
              toObjectRecord(input.contentError.details)?.agentRunStop,
            ),
    };
    const snapshot = stoppedSnapshot.assistantMessage
      ? {
          ...stoppedSnapshot,
          assistantMessage: {
            ...stoppedSnapshot.assistantMessage,
            metadata: {
              ...stoppedSnapshot.assistantMessage.metadata,
              isError: input.status === "failed",
              isCancelled: input.status === "cancelled",
              error: input.contentError.message,
              errorCode: input.contentError.code,
              agentRunStop:
                readAgentRunStop(stoppedSnapshot.agentRunStop) ?? undefined,
              ...(stoppedSnapshot.agentCheckpoint
                ? { agentCheckpoint: stoppedSnapshot.agentCheckpoint }
                : {}),
              ...buildThreadRunMetadata(terminalRun),
            },
          },
        }
      : stoppedSnapshot;
    const clientErrorMessage = sanitizeClientErrorMessage(
      input.contentError.message,
    );
    finished = await input.finishRun({
      run,
      status: input.status,
      userMessageId: terminalRun.userMessageId,
      assistantMessageId: messageIds.assistantMessageId,
      snapshot,
      errorCode: input.contentError.code,
      errorMessage: input.contentError.message,
    });
    if (!finished) {
      return (await readCurrent()) ?? run;
    }
    const errorPayload = toSseData({
      type: "error",
      ...(stoppedSnapshot.agentRunStop
        ? { agentRunStop: stoppedSnapshot.agentRunStop }
        : {}),
      code: input.contentError.code,
      error: clientErrorMessage,
      ...(terminalRun.userMessageId
        ? { userMessageId: terminalRun.userMessageId }
        : {}),
      ...(messageIds.assistantMessageId
        ? { messageId: messageIds.assistantMessageId }
        : {}),
    });
    if (messageIds.assistantMessageId) {
      const currentMessage = await findMessageRecord({
        teamId: input.run.teamId,
        workspaceId: input.run.workspaceId,
        messageId: messageIds.assistantMessageId,
      });
      await updateMessageRecord({
        teamId: input.run.teamId,
        workspaceId: input.run.workspaceId,
        threadId: input.run.threadId,
        messageId: messageIds.assistantMessageId,
        content: appendAssistantContinuationContent({
          existingContent:
            snapshot.assistantMessage?.content ?? currentMessage?.content,
          nextContent:
            typeof snapshot.assistantContent === "string"
              ? snapshot.assistantContent
              : clientErrorMessage,
        }),
        metadata: {
          ...(currentMessage?.metadata ??
            snapshot.assistantMessage?.metadata ??
            {}),
          ...projectSnapshotReasoning(snapshot, true),
          isError: input.status === "failed",
          isCancelled: input.status === "cancelled",
          error: input.contentError.message,
          errorCode: input.contentError.code,
          agentRunStop:
            readAgentRunStop(stoppedSnapshot.agentRunStop) ?? undefined,
          ...(stoppedSnapshot.agentCheckpoint
            ? { agentCheckpoint: stoppedSnapshot.agentCheckpoint }
            : {}),
          ...buildThreadRunMetadata(terminalRun),
        },
      });
    }
    await input.appendRunEvent({
      run: finished,
      payload: errorPayload,
      snapshot,
    });
    await input.appendRunEvent({
      run: finished,
      payload: toSseData({ type: "finish" }),
      snapshot,
    });
    return finished;
  } catch (terminalError) {
    logger.error("Failed to persist or deliver terminal chat run failure", {
      runId: input.run.id,
      originalErrorCode: input.contentError.code,
      originalError: input.contentError.message,
      error:
        terminalError instanceof Error
          ? terminalError.message
          : String(terminalError),
    });
    // A failed notification (or lease release after commit) must not replace
    // the committed outcome. Attach reconstructs its terminal events from DB.
    if (finished) return finished;
    try {
      const current = await readCurrent();
      if (current && isTerminalRunStatus(current.status)) return current;
    } catch (readError) {
      logger.error("Failed to read chat run after terminal persistence error", {
        runId: input.run.id,
        error:
          readError instanceof Error ? readError.message : String(readError),
      });
    }
    // The processor boundary can retry the same terminal operation; it must
    // receive the original failure, never a SQL/Redis wrapper in its place.
    throw input.contentError;
  }
}

export async function processThreadChatRunJob(
  payload: ThreadChatRunJobPayload,
): Promise<ThreadChatRunJobResult> {
  const preparedRun = await durableChatRunService.processRunJob(payload);
  if (preparedRun && "runId" in preparedRun) {
    return preparedRun as ThreadChatRunJobResult;
  }

  const activeRun = preparedRun;
  if (!activeRun) {
    throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
  }

  let run: ChatThreadRunRecord = activeRun;
  const request = requestWithDurableMessageOverrides({
    run,
    request: asRequestSnapshot(run.requestJson),
  });
  const streamService = new ContentThreadStreamService(
    new ContentThreadTurnService(billingService),
    undefined,
    undefined,
    undefined,
    billingService,
  );
  let snapshot: ChatRunSnapshot = {
    reasoningRun: (run.snapshotJson as ChatRunSnapshot).reasoningRun,
    reasoningRevision:
      (run.snapshotJson as ChatRunSnapshot).reasoningRevision ?? 0,
  };
  let assistantMessageId: string | null = run.assistantMessageId;
  let finalRun = run;
  let runBilling: MeterConsumeResponse | null = null;
  let terminalStatus: DurableRunJobStatus = "completed";
  let terminalErrorCode: string | null = null;
  let terminalErrorMessage: string | null = null;
  let assistantMessagePersisted = false;
  const flushAssistantSnapshot = createAssistantSnapshotFlushWindow();

  const maybeFlushAssistantSnapshot = async (force = false) => {
    if (
      !assistantMessageId ||
      assistantMessagePersisted ||
      terminalStatus !== "completed" ||
      snapshot.assistantContent === undefined
    ) {
      return;
    }

    const messageId = assistantMessageId;
    await flushAssistantSnapshot(
      () =>
        updateAssistantSnapshot({
          run,
          assistantMessageId: messageId,
          snapshot,
        }),
      force,
    );
  };

  const applyRunProgress = async (
    updated:
      | ChatThreadRunRecord
      | Awaited<ReturnType<typeof durableChatRunService.heartbeat>>,
  ) => {
    if (!updated || updated.status !== "running") {
      const reason =
        (await durableChatRunService.getRunStopError(run)) ??
        new ContentError(
          409,
          "CHAT_RUN_OWNERSHIP_LOST",
          "The worker no longer owns a running chat run",
        );
      abortTurn(reason);
      throw reason;
    }
    // Heartbeats return only control/timestamp fields; preparation progress
    // still returns the full record. Preserve the local run identity/payloads.
    run = { ...run, ...updated };
  };
  const heartbeat = async () =>
    applyRunProgress(await durableChatRunService.heartbeat(run));

  // Streamed text and reasoning deltas are persisted in windows, not one round
  // trip per token: every appended event rewrites the run snapshot, and a
  // reasoning model emits over a thousand deltas in seconds.
  const deltaCoalescer = createDeltaCoalescer({
    flush: async (payload) => {
      await heartbeat();
      await durableChatRunService.appendRunEvent({
        run,
        payload: serializeSsePayload(payload),
        snapshot,
      });
    },
  });
  const flushPendingDelta = () => deltaCoalescer.flush();

  const appendEventWithDeltaCoalescing = async (
    event: string,
    payload: Record<string, unknown> | null,
  ) => {
    if (await deltaCoalescer.push(payload)) {
      return;
    }
    await heartbeat();
    await durableChatRunService.appendRunEvent({
      run,
      payload: event,
      snapshot,
    });
  };

  // Interrupt the in-flight turn the moment a cancel arrives, rather than only
  // refusing its output afterward. Two triggers feed one controller: the pub/sub
  // channel (prompt, cross-process) and a low-frequency status poll (covers a
  // Stop that raced our subscribe, or a dropped message). The poll runs on its
  // own timer so it still fires while a long tool blocks the event loop.
  const abortController = new AbortController();
  let stopLocalMonitor: () => void = () => {};
  const abortTurn = (reason: ContentError) => {
    if (abortController.signal.aborted) {
      return;
    }
    logger.info("Stopping chat run worker", {
      runId: run.id,
      reason: reason.code,
    });
    stopLocalMonitor();
    abortController.abort(reason);
  };
  // Set once this worker starts committing its own terminal state. From then on
  // the run is expected to leave `running`, so the cancel monitors must not read
  // that as lost ownership and abort the commit's tail; a cancel racing the
  // commit is settled by the commit's compare-and-set instead.
  let terminalCommitStarted = false;
  // A shutdown stop leaves a turn that is already committing to finish it.
  const interruptTurn = (reason: ContentError) => {
    if (!terminalCommitStarted) {
      abortTurn(reason);
    }
  };
  activeTurnInterrupts.add(interruptTurn);
  const checkRunOwnership = async () => {
    const error = await durableChatRunService.getRunStopError(run);
    if (error && !terminalCommitStarted) {
      abortTurn(error);
      throw error;
    }
  };
  // The subscription is an optimization over the poll below; a Redis hiccup at
  // subscribe time must not fail the run, so degrade to poll-only.
  let unsubscribeCancel: () => Promise<void> = async () => {};
  try {
    unsubscribeCancel = await chatRunStreamManager.subscribeCancel(
      run.id,
      () => {
        void checkRunOwnership().catch((error) =>
          abortTurn(toDurableRunContentError(error)),
        );
      },
    );
  } catch (error) {
    logger.warn("Chat run cancel subscription failed; relying on status poll", {
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const cancelPoll = setInterval(() => {
    void checkRunOwnership().catch((error) =>
      abortTurn(toDurableRunContentError(error)),
    );
  }, CHAT_RUN_CANCEL_POLL_MS);
  cancelPoll.unref?.();

  try {
    await checkRunOwnership();
    const stream = createThreadRunStream({
      streamService,
      request,
      options: {
        shouldCancel: () => durableChatRunService.shouldCancel(run),
        abortSignal: abortController.signal,
        onPrepared: async (prepared) => {
          await checkRunOwnership();
          if (prepared.thread.executionTarget?.kind === "local") {
            const { watchLocalConversationAvailability } =
              await import("../../devices/availability-monitor");
            const { requireLocalConversationReady } =
              await import("../../devices/availability");
            abortController.signal.throwIfAborted();
            stopLocalMonitor();
            stopLocalMonitor = watchLocalConversationAvailability(
              () => requireLocalConversationReady(request),
              (error) => abortTurn(toDurableRunContentError(error)),
            );
          }
          prepared.threadRunId = run.id;
          if (!prepared.reasoningRun) {
            throw new ContentError(
              409,
              "REASONING_RUN_CONFLICT",
              "Prepared turn is missing its reasoning base",
            );
          }
          if (
            !snapshot.reasoningRun &&
            prepared.reasoningRun.parentRunId === run.id
          ) {
            throw new ContentError(
              409,
              "REASONING_RUN_CONFLICT",
              "Retry is missing its persisted reasoning base",
            );
          }
          prepared.reasoningRun = beginReasoningRun({
            runId: run.id,
            continuation: Boolean(prepared.assistantMessageId),
            // A retry uses its persisted base, never the partially written message.
            restored: snapshot.reasoningRun ?? {
              ...prepared.reasoningRun,
              runId: run.id,
            },
          });
          snapshot = { ...snapshot, reasoningRun: prepared.reasoningRun };
          await applyRunProgress(
            await updateChatThreadRunProgress({
              runId: run.id,
              teamId: run.teamId,
              workspaceId: run.workspaceId,
              userMessageId: prepared.userMessage.id,
              snapshotJson: snapshot,
            }),
          );
          const placeholder = await createAssistantPlaceholder({
            run,
            prepared,
          });
          assistantMessageId = placeholder.id;
          const existingRenderBlocks = Array.isArray(
            placeholder.metadata?.renderBlocks,
          )
            ? (placeholder.metadata.renderBlocks as unknown[])
            : [];
          snapshot = {
            ...snapshot,
            thread: prepared.thread,
            userMessage: prepared.userMessage,
            assistantMessage: placeholder,
            renderBlocks: existingRenderBlocks,
          };
          await applyRunProgress(
            await updateChatThreadRunProgress({
              runId: run.id,
              teamId: run.teamId,
              workspaceId: run.workspaceId,
              userMessageId: prepared.userMessage.id,
              assistantMessageId: resolvePreparedAssistantMessageId({
                prepared,
                placeholderId: placeholder.id,
              }),
              snapshotJson: snapshot,
            }),
          );
          return {
            assistantMessageId: placeholder.id,
            assistantMetadata: buildThreadRunMetadata(run),
          };
        },
        createErrorMessage: async (input) => {
          const errorMessage = await createDurableErrorMessage({
            run,
            assistantMessageId,
            snapshot,
            createErrorInput: input,
          });
          if (errorMessage) {
            assistantMessageId = errorMessage.id;
            assistantMessagePersisted = true;
            snapshot = {
              ...snapshot,
              assistantMessage: errorMessage,
            };
          }
          return errorMessage;
        },
        onFinalized: async (result) => {
          runBilling = result.billing ?? null;
          snapshot = snapshotWithFinalizedResult(snapshot, result);
        },
      },
    });

    for await (const event of stream) {
      abortController.signal.throwIfAborted();
      const payload = parseSsePayload(event);
      snapshot = updateSnapshotFromPayload(snapshot, payload);
      if (payload?.type === "error") {
        terminalErrorCode =
          typeof payload.code === "string" ? payload.code : "CHAT_RUN_FAILED";
        terminalErrorMessage =
          typeof payload.error === "string" ? payload.error : "Chat run failed";
        terminalStatus =
          terminalErrorCode === "CLIENT_CANCELLED" ? "cancelled" : "failed";
      }
      if (payload?.type === "assistant-message") {
        await maybeFlushAssistantSnapshot(true);
        assistantMessagePersisted = true;
      }
      // SSE terminal events describe a committed durable outcome. Hold them
      // until the terminal CAS below; a concurrent cancellation may win it.
      if (payload?.type === "finish" || payload?.type === "error") continue;
      await appendEventWithDeltaCoalescing(event, payload);
      await maybeFlushAssistantSnapshot(false);
    }
    await flushPendingDelta();
    await maybeFlushAssistantSnapshot(true);

    const thread =
      snapshot.thread ??
      (await findThreadRecord({
        threadId: run.threadId,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      })) ??
      undefined;
    const assistantMessage = assistantMessageId
      ? await findMessageRecord({
          teamId: run.teamId,
          workspaceId: run.workspaceId,
          messageId: assistantMessageId,
        })
      : null;
    snapshot = {
      ...snapshot,
      ...(thread ? { thread } : {}),
      ...(assistantMessage ? { assistantMessage } : {}),
      ...(runBilling ? { billing: runBilling } : {}),
    };
    const finalSnapshot = {
      ...snapshot,
      ...(terminalErrorCode ? { errorCode: terminalErrorCode } : {}),
      ...(terminalErrorMessage ? { errorMessage: terminalErrorMessage } : {}),
    };
    const persistedFinishReason =
      typeof finalSnapshot.assistantMessage?.metadata === "object" &&
      finalSnapshot.assistantMessage?.metadata !== null &&
      !Array.isArray(finalSnapshot.assistantMessage.metadata)
        ? (finalSnapshot.assistantMessage.metadata as Record<string, unknown>)
            .finishReason
        : undefined;
    const finishReason =
      typeof finalSnapshot.finishReason === "string"
        ? finalSnapshot.finishReason
        : persistedFinishReason;
    const isWaitingForApproval =
      terminalStatus === "completed" &&
      finishReason === TOOL_CONFIRMATION_FINISH_REASON;
    terminalCommitStarted = true;
    clearInterval(cancelPoll);
    const finished = isWaitingForApproval
      ? await durableChatRunService.markWaitingForApproval({
          run,
          assistantMessageId,
          snapshot: finalSnapshot,
          confirmationIds: extractPendingConfirmationIds(
            finalSnapshot.toolCalls,
          ),
        })
      : await durableChatRunService.finishRun({
          run,
          status: terminalStatus,
          assistantMessageId,
          snapshot: finalSnapshot,
          errorCode: terminalErrorCode,
          errorMessage: terminalErrorMessage,
        });
    if (isWaitingForApproval && finished) {
      terminalStatus = "waiting_for_approval";
    }
    if (!finished) {
      const latest = await findChatThreadRunById({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      });
      if (
        (terminalStatus === "completed" || isWaitingForApproval) &&
        isClientCancelledRun(latest)
      ) {
        const contentError = new ContentError(
          499,
          "CLIENT_CANCELLED",
          "Chat run was cancelled",
        );
        finalRun = await persistTerminalFailure({
          run: latest ?? run,
          status: "cancelled",
          assistantMessageId,
          snapshot: {
            ...finalSnapshot,
            errorCode: contentError.code,
            errorMessage: contentError.message,
          },
          contentError,
          appendRunEvent: durableChatRunService.appendRunEvent.bind(
            durableChatRunService,
          ),
          finishRun: durableChatRunService.finishRun.bind(
            durableChatRunService,
          ),
        });
        terminalStatus = "cancelled";
        terminalErrorCode = contentError.code;
        terminalErrorMessage = contentError.message;
      } else {
        finalRun = resolveFinalRunAfterFinish({
          finished,
          latest,
          run,
        });
      }
    } else {
      finalRun = resolveFinalRunAfterFinish({
        finished,
        latest: null,
        run,
      });
    }

    // A stale-recovery/publication/cancellation winner owns the final status.
    // Never report this worker's speculative completed status after losing CAS.
    if (isTerminalRunStatus(finalRun.status)) {
      terminalStatus = finalRun.status as TerminalRunStatus;
      terminalErrorCode = finalRun.errorCode;
      terminalErrorMessage = finalRun.errorMessage;
    }
    if (finished) {
      const terminalEvents = isWaitingForApproval
        ? [
            toSseData(
              approvalFinishPayload({
                snapshot: finalSnapshot as Record<string, unknown>,
                assistantMessageId,
                userMessageId: finished.userMessageId,
              }),
            ),
          ]
        : synthesizeTerminalRunEvents({ run: finished, sawErrorEvent: false });
      for (const event of terminalEvents)
        await durableChatRunService.appendRunEvent({
          run: finished,
          payload: event,
        });
    }

    if (assistantMessageId) {
      const finalMessage = await findMessageRecord({
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        messageId: assistantMessageId,
      });
      await updateMessageRecord({
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        messageId: assistantMessageId,
        metadata:
          terminalStatus === "waiting_for_approval"
            ? buildSnapshotMetadata({
                currentMetadata:
                  finalMessage?.metadata ??
                  finalSnapshot.assistantMessage?.metadata,
                run: finalRun,
                snapshot: finalSnapshot,
              })
            : {
                ...(finalMessage?.metadata ??
                  snapshot.assistantMessage?.metadata ??
                  {}),
                ...buildThreadRunMetadata(finalRun),
                threadRun: {
                  ...buildThreadRunMetadata(finalRun).threadRun,
                  ...(finalMessage?.metadata &&
                  typeof finalMessage.metadata === "object" &&
                  !Array.isArray(finalMessage.metadata) &&
                  finalMessage.metadata.threadRun &&
                  typeof finalMessage.metadata.threadRun === "object" &&
                  !Array.isArray(finalMessage.metadata.threadRun) &&
                  "durationMs" in finalMessage.metadata.threadRun
                    ? {
                        durationMs: (
                          finalMessage.metadata.threadRun as Record<
                            string,
                            unknown
                          >
                        ).durationMs,
                      }
                    : {}),
                },
              },
      });
    }

    return {
      status: terminalStatus,
      runId: run.id,
      assistantMessageId,
      ...(terminalErrorCode ? { errorCode: terminalErrorCode } : {}),
      ...(terminalErrorMessage ? { errorMessage: terminalErrorMessage } : {}),
    };
  } catch (error) {
    const contentError = toDurableRunContentError(
      abortController.signal.aborted ? abortController.signal.reason : error,
    );
    let current: ChatThreadRunRecord | null;
    try {
      current = await findChatThreadRunById({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      });
    } catch (readError) {
      logger.error("Failed to read chat run while handling worker failure", {
        runId: run.id,
        originalErrorCode: contentError.code,
        originalError: contentError.message,
        error:
          readError instanceof Error ? readError.message : String(readError),
      });
      throw contentError;
    }
    if (current && isTerminalRunStatus(current.status)) {
      // Another transaction (or our commit followed by failed Redis delivery)
      // already decided the outcome. Attach reconstructs terminal SSE from DB.
      logger.warn("Chat worker stopped after durable terminal commit", {
        runId: current.id,
        status: current.status,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: current.status as TerminalRunStatus,
        runId: current.id,
        assistantMessageId: current.assistantMessageId,
        ...(current.errorCode ? { errorCode: current.errorCode } : {}),
        ...(current.errorMessage ? { errorMessage: current.errorMessage } : {}),
      };
    }
    if (
      !current ||
      (current.status !== "running" && current.status !== "cancel_requested")
    ) {
      return {
        status:
          current?.status === "waiting_for_approval"
            ? "waiting_for_approval"
            : "skipped",
        runId: run.id,
        assistantMessageId: current?.assistantMessageId ?? assistantMessageId,
      };
    }
    await flushPendingDelta().catch((flushError: unknown) => {
      logger.warn("Failed to flush pending thread run delta after error", {
        runId: run.id,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        error:
          flushError instanceof Error ? flushError.message : String(flushError),
      });
    });
    await maybeFlushAssistantSnapshot(true).catch((snapshotError: unknown) => {
      logger.warn("Failed to flush assistant snapshot after thread run error", {
        runId: run.id,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        error:
          snapshotError instanceof Error
            ? snapshotError.message
            : String(snapshotError),
      });
    });
    const status =
      contentError.code === "CLIENT_CANCELLED" ? "cancelled" : "failed";
    snapshot = {
      ...snapshot,
      errorCode: contentError.code,
      errorMessage: contentError.message,
    };
    finalRun = await persistTerminalFailure({
      run,
      status,
      assistantMessageId,
      snapshot,
      contentError,
      appendRunEvent: durableChatRunService.appendRunEvent.bind(
        durableChatRunService,
      ),
      finishRun: durableChatRunService.finishRun.bind(durableChatRunService),
    });
    return {
      status: isTerminalRunStatus(finalRun.status)
        ? (finalRun.status as TerminalRunStatus)
        : status,
      runId: run.id,
      assistantMessageId: finalRun.assistantMessageId,
      ...(finalRun.errorCode ? { errorCode: finalRun.errorCode } : {}),
      ...(finalRun.errorMessage ? { errorMessage: finalRun.errorMessage } : {}),
    };
  } finally {
    activeTurnInterrupts.delete(interruptTurn);
    clearInterval(cancelPoll);
    stopLocalMonitor();
    await unsubscribeCancel().catch(() => {});
  }
}

export const testExports = {
  createAssistantSnapshotFlushWindow,
  snapshotWithFinalizedResult,
  buildSnapshotMetadata,
  resolvePersistedTerminalMessageIds,
  requestWithDurableMessageOverrides,
  resolveFinalRunAfterFinish,
  resolvePreparedAssistantMessageId,
  stableDurableAssistantMessageId,
  stableDurableUserMessageId,
  toDurableRunContentError,
  updateSnapshotFromPayload,
};
