import type {
  ThreadChatRunJobPayload,
  ThreadChatRunJobResult,
} from "../../content/queue";
import { hasAgentToolCapability } from "@sourceweft/agent-tool-registry";
import { type MeterConsumeResponse } from "@sourceweft/contracts";
import { ContentError } from "../../content/errors";
import { sanitizeClientErrorMessage } from "../../content/model-gateway-error";
import type { MessageRenderBlock, PreparedThreadTurn } from "../turn/types";
import { createThreadStreamErrorMessage } from "../stream/error";
import { toSseData } from "../stream/helpers";
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
import { extractToolOutputField } from "../agent/turn/output-normalizer";
import {
  isSandboxExecuteToolCallIdRequiredError,
  sandboxExecuteToolCallIdRequiredContentError,
} from "../turn/sandbox-execute-error";
import {
  createMessageRecord,
  findMessageRecord,
  updateMessageRecord,
} from "../message-repository";
import { findThreadRecord } from "../thread/repository";
import { billingService } from "../../../modules/billing";
import { logger } from "../../../shared/logger";
import { durableChatRunService } from "./service";
import {
  findChatThreadRunById,
  updateChatThreadRunProgress,
} from "./repository";
import type {
  ChatRunSnapshot,
  ChatThreadRunRecord,
  ChatThreadRunStatus,
  DurableRunRequestSnapshot,
} from "./types";

type TerminalRunStatus = Extract<
  ChatThreadRunStatus,
  "completed" | "failed" | "cancelled"
>;
type DurableRunJobStatus = TerminalRunStatus | "waiting_for_approval";
type DurableChatRunServiceAppendRunEvent =
  typeof durableChatRunService.appendRunEvent;
type DurableChatRunServiceFinishRun = typeof durableChatRunService.finishRun;

const STREAM_APPEND_TEXT_DELTA_FLUSH_MS = 80;
const ASSISTANT_SNAPSHOT_FLUSH_MS = 500;
const TOOL_CONFIRMATION_FINISH_REASON = "tool_confirmation_requested";
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

function durableUserMessageIdFallback(input: {
  request: DurableRunRequestSnapshot;
  run: ChatThreadRunRecord;
}) {
  if (input.run.userMessageId) {
    return input.run.userMessageId;
  }
  if (input.request.mode !== "send" && input.request.mode !== "edit") {
    return null;
  }
  const request = input.request as DurableRunRequestSnapshot & {
    userMessageIdOverride?: unknown;
  };
  return typeof request.userMessageIdOverride === "string"
    ? request.userMessageIdOverride
    : stableDurableUserMessageId(input.run.id);
}

function toDurableRunContentError(error: unknown) {
  if (error instanceof ContentError) {
    return error;
  }
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
        record?.output && typeof record.output === "object" && !Array.isArray(record.output)
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
    return input.streamService.refreshThreadEvents(input.request, input.options);
  }
  if (input.request.mode === "edit") {
    return input.streamService.editThreadEvents(input.request, input.options);
  }
  return input.streamService.streamThreadEvents(input.request, input.options);
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

function serializeSsePayload(payload: Record<string, unknown>) {
  return toSseData(payload);
}

function isClientCancelledRun(run: ChatThreadRunRecord | null) {
  return run?.status === "cancel_requested" || run?.status === "cancelled";
}

function isTextDeltaPayload(
  payload: Record<string, unknown> | null,
): payload is Record<string, unknown> & { type: "text-delta"; delta: string } {
  return payload?.type === "text-delta" && typeof payload.delta === "string";
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
  const toolCall = getObjectRecord(input.payload.toolCall);
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
    .map(getObjectRecord)
    .find((record) => record?.id === id);
  const tool =
    typeof toolCall?.tool === "string" && toolCall.tool.length > 0
      ? toolCall.tool
      : typeof input.payload.tool === "string" && input.payload.tool.length > 0
        ? input.payload.tool
        : typeof existingRecord?.tool === "string"
          ? existingRecord.tool
          : "tool";
  const existingOutput = getObjectRecord(existingRecord?.output);
  const eventOutput =
    input.payload.type === "tool-call-event"
      ? input.payload.data
      : input.payload.type === "tool-call-result"
        ? input.payload.output
        : null;
  const eventOutputRecord = getObjectRecord(eventOutput);
  const toolCallOutput = toolCall ? toolCall.output : undefined;
  const toolCallOutputRecord = getObjectRecord(toolCallOutput);
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
      : input.payload.type === "tool-call-result" ||
          input.payload.type === "tool-call-end"
        ? typeof input.payload.status === "string"
          ? input.payload.status
          : (toolCall?.status ?? "completed")
        : (toolCall?.status ?? existingRecord?.status ?? "running");
  const sequence = getTraceSequence(toolCall) ?? getTraceSequence(existingRecord);

  return mergeToolCall(input.existing, {
    ...(existingRecord ?? {}),
    ...(toolCall ?? {}),
    id,
    tool,
    input: {
      ...(getObjectRecord(existingRecord?.input) ?? {}),
      ...(getObjectRecord(input.payload.input) ?? {}),
      ...(getObjectRecord(toolCall?.input) ?? {}),
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
        ? input.payload.error
        : (toolCall?.error ?? existingRecord?.error ?? null),
  });
}

function getToolCallIdFromPayload(payload: Record<string, unknown>) {
  const toolCall = getObjectRecord(payload.toolCall);
  return typeof payload.id === "string" && payload.id.length > 0
    ? payload.id
    : typeof toolCall?.id === "string" && toolCall.id.length > 0
      ? toolCall.id
      : null;
}

function getToolNameFromPayload(payload: Record<string, unknown>) {
  const toolCall = getObjectRecord(payload.toolCall);
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

function findToolCallSnapshotById(toolCalls: unknown[] | undefined, id: string) {
  return (toolCalls ?? [])
    .map(getObjectRecord)
    .find((record) => record?.id === id);
}

function toolCallTraceFromPayload(input: {
  payload: Record<string, unknown>;
  snapshot: ChatRunSnapshot;
}): ToolCallTrace | null {
  const payloadToolCall = getObjectRecord(input.payload.toolCall);
  const id = getToolCallIdFromPayload(input.payload);
  const tool = getToolNameFromPayload(input.payload);
  if (!id || !tool) {
    return null;
  }

  const snapshotToolCall = findToolCallSnapshotById(input.snapshot.toolCalls, id);
  const output =
    input.payload.type === "tool-call-event"
      ? input.payload.data
      : input.payload.type === "tool-call-result"
        ? input.payload.output
        : input.payload.type === "tool-call-error"
          ? null
          : payloadToolCall?.output ?? snapshotToolCall?.output ?? null;
  return {
    id,
    tool,
    input: {
      ...(getObjectRecord(snapshotToolCall?.input) ?? {}),
      ...(getObjectRecord(input.payload.input) ?? {}),
      ...(getObjectRecord(payloadToolCall?.input) ?? {}),
    },
    output,
    status:
      input.payload.type === "tool-call-error"
        ? "error"
        : input.payload.type === "tool-call-result" ||
            input.payload.type === "tool-call-end"
          ? normalizeToolStatus(input.payload.status ?? payloadToolCall?.status)
          : normalizeToolStatus(payloadToolCall?.status ?? snapshotToolCall?.status),
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
        : typeof payloadToolCall?.error === "string" || payloadToolCall?.error === null
          ? payloadToolCall.error
          : typeof snapshotToolCall?.error === "string" ||
              snapshotToolCall?.error === null
            ? snapshotToolCall.error
            : null,
    sequence:
      getTraceSequence(payloadToolCall) ?? getTraceSequence(snapshotToolCall) ?? 0,
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

function isSameReasoningSegment(existing: unknown, next: unknown) {
  const existingRecord =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : null;
  const nextRecord =
    next && typeof next === "object" && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : null;
  if (!existingRecord || !nextRecord) {
    return false;
  }

  return (
    existingRecord.id === nextRecord.id &&
    typeof existingRecord.text === "string" &&
    typeof nextRecord.text === "string"
  );
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

  if (
    existingIndex >= 0 &&
    isSameReasoningSegment(existing[existingIndex], record)
  ) {
    return existing.map((item, index) =>
      index === existingIndex
        ? {
            ...(item && typeof item === "object" && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : {}),
            ...record,
            id,
          }
        : item,
    );
  }

  return [...existing, record];
}

function normalizeRenderBlock(value: unknown): MessageRenderBlock | null {
  const record = getObjectRecord(value);
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
      typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
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

  if (
    (record.type === "tool" ||
      record.type === "generated_image" ||
      record.type === "generated_presentation") &&
    typeof record.toolCallId === "string"
  ) {
    return {
      id,
      ...(placement ? { placement } : {}),
      type: record.type,
      toolCallId: record.toolCallId,
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
            text: `${block.text}${input.text}`,
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
      text: input.text,
      ...(typeof input.durationMs === "number"
        ? { durationMs: input.durationMs }
        : {}),
    },
  ];
}

function hasPublishedPresentationArtifact(input: {
  output: unknown;
  status: unknown;
}) {
  return (
    input.status === "completed" &&
    Boolean(
      extractToolOutputField(input.output, "artifact_url") ??
        extractToolOutputField(input.output, "pptx_url") ??
        extractToolOutputField(input.output, "artifactUrl") ??
        extractToolOutputField(input.output, "pptxUrl"),
    )
  );
}

function getRenderBlockTypeForArtifactTool(input: {
  output?: unknown;
  status?: unknown;
  toolName: string;
}) {
  const toolName = input.toolName;
  if (hasAgentToolCapability(toolName, "generated_image_artifact")) {
    return "generated_image" as const;
  }
  if (
    hasAgentToolCapability(toolName, "presentation_artifact") &&
    hasPublishedPresentationArtifact({
      output: input.output,
      status: input.status,
    })
  ) {
    return "generated_presentation" as const;
  }
  return null;
}

function getArtifactRenderBlockId(input: {
  toolCallId: string;
  type: Extract<MessageRenderBlock["type"], "generated_image" | "generated_presentation">;
}) {
  return input.type === "generated_image"
    ? `generated-image-${input.toolCallId}`
    : `generated-presentation-${input.toolCallId}`;
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

function appendArtifactRenderBlock(input: {
  blocks: unknown[] | undefined;
  toolCallId: string;
  toolName: string | null;
  output?: unknown;
  status?: unknown;
}) {
  if (!input.toolName) {
    return normalizeRenderBlocks(input.blocks);
  }

  const type = getRenderBlockTypeForArtifactTool({
    output: input.output,
    status: input.status,
    toolName: input.toolName,
  });
  if (!type) {
    return normalizeRenderBlocks(input.blocks);
  }

  const blocks = normalizeRenderBlocks(input.blocks);
  if (
    blocks.some(
      (block) => block.type === type && block.toolCallId === input.toolCallId,
    )
  ) {
    return blocks;
  }

  return [
    ...blocks,
    {
      id: getArtifactRenderBlockId({
        toolCallId: input.toolCallId,
        type,
      }),
      placement: "terminal" as const,
      type,
      toolCallId: input.toolCallId,
    },
  ];
}

function appendArtifactBlocksFromToolCalls(snapshot: ChatRunSnapshot) {
  const toolCalls = Array.isArray(snapshot.toolCalls) ? snapshot.toolCalls : [];
  return toolCalls.reduce<MessageRenderBlock[]>(
    (blocks, toolCall) => {
      const record = getObjectRecord(toolCall);
      const toolCallId = typeof record?.id === "string" ? record.id : null;
      const toolName = typeof record?.tool === "string" ? record.tool : null;
      return toolCallId
        ? appendArtifactRenderBlock({
            blocks,
            output: record?.output,
            status: record?.status,
            toolCallId,
            toolName,
          })
        : normalizeRenderBlocks(blocks);
    },
    normalizeRenderBlocks(snapshot.renderBlocks),
  );
}

function updateSnapshotFromPayload(
  snapshot: ChatRunSnapshot,
  payload: Record<string, unknown> | null,
) {
  if (!payload || typeof payload.type !== "string") {
    return snapshot;
  }

  const next: ChatRunSnapshot = {
    ...snapshot,
    lastEventType: payload.type,
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
    next.reasoning = `${next.reasoning ?? ""}${payload.reasoning}`;
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
            typeof segment.durationMs === "number" ? segment.durationMs : undefined,
          id: `reasoning-${segment.id}`,
          text: payload.reasoning,
        });
        next.traceParts = upsertTracePart(
          next.traceParts,
          tracePartFromReasoningSegment(segment),
        );
      }
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
  if (
    payload.type === "tool-call-start" ||
    payload.type === "tool-call-event" ||
    payload.type === "tool-call-result" ||
    payload.type === "tool-call-end"
  ) {
    const toolCallId = getToolCallIdFromPayload(payload);
    const toolName = getToolNameFromPayload(payload);
    const toolCall = toolCallId
      ? findToolCallSnapshotById(next.toolCalls, toolCallId)
      : null;
    if (toolCallId) {
      next.renderBlocks = appendArtifactRenderBlock({
        blocks: next.renderBlocks,
        output:
          toolCall?.output ??
          payload.output ??
          getObjectRecord(payload.toolCall)?.output,
        status:
          toolCall?.status ??
          getObjectRecord(payload.toolCall)?.status ??
          payload.status,
        toolCallId,
        toolName,
      });
    }
  }
  if (payload.type === "tool-call-start") {
    const toolCallId = getToolCallIdFromPayload(payload);
    const toolName = getToolNameFromPayload(payload);
    if (
      toolCallId &&
      toolName &&
      !hasAgentToolCapability(toolName, "generated_image_artifact") &&
      !hasAgentToolCapability(toolName, "presentation_artifact")
    ) {
      next.renderBlocks = appendToolRenderBlock({
        blocks: next.renderBlocks,
        toolCallId,
      });
    }
  }
  if (payload.type === "finish") {
    next.renderBlocks = appendArtifactBlocksFromToolCalls(next);
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
      ...(run.startedAt && run.finishedAt
        ? {
            startedAt: run.startedAt,
            completedAt: run.finishedAt,
          }
        : {}),
    },
  };
}

function getObjectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getTraceSequence(value: unknown) {
  const sequence = getObjectRecord(value)?.sequence;
  return typeof sequence === "number" && Number.isFinite(sequence)
    ? sequence
    : null;
}

function getTraceEventKey(value: unknown) {
  const record = getObjectRecord(value);
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
  const id = input.sequence === null
    ? input.baseId
    : `${input.baseId}:${input.sequence}`;
  return suffix ? `${id}:${suffix}` : id;
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
    displayOrder: current.length,
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

  const existing = getObjectRecord(current[existingIndex]);
  const displayOrder =
    typeof existing?.displayOrder === "number" &&
    Number.isFinite(existing.displayOrder)
      ? existing.displayOrder
      : existingIndex;
  return current.map((item, index) =>
    index === existingIndex
      ? {
          ...event,
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
    const segment = getObjectRecord(payload.segment);
    const segmentId = typeof segment?.id === "string" ? segment.id : null;
    if (!segment || !segmentId) {
      return null;
    }
    const sequence = getTraceSequence(segment);
    return {
      type: "reasoning",
      id: buildTraceEventId({
        baseId: segmentId,
        eventIndex,
        eventType: payload.type,
        phase: typeof segment.phase === "string" ? segment.phase : null,
        sequence,
      }),
      itemId: segmentId,
      sequence,
      segment,
      reasoning:
        typeof payload.reasoning === "string" ? payload.reasoning : undefined,
    };
  }

  if (payload.type === "thinking-step") {
    const step = getObjectRecord(payload.step);
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
    const toolCall = getObjectRecord(payload.toolCall);
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
            : typeof getObjectRecord(payload.data)?.type === "string"
              ? (getObjectRecord(payload.data)?.type as string)
              : null,
        sequence,
      }),
      itemId: eventId,
      sequence,
      eventType: payload.type,
      tool: typeof payload.tool === "string" ? payload.tool : toolCall?.tool,
      toolCall: toolCall ?? undefined,
      payload,
    };
  }

  return null;
}

function buildSnapshotMetadata(input: {
  currentMetadata?: Record<string, unknown> | null;
  run: ChatThreadRunRecord;
  snapshot: ChatRunSnapshot;
}) {
  const nextMetadata = {
    ...(input.currentMetadata ?? {}),
    userMessageId: input.run.userMessageId,
    sourceUserMessageId: input.run.userMessageId,
    toolCalls: input.snapshot.toolCalls ?? [],
    thinkingSteps: input.snapshot.thinkingSteps ?? [],
    reasoning: input.snapshot.reasoning,
    reasoningSegments: input.snapshot.reasoningSegments ?? [],
    traceEvents: input.snapshot.traceEvents ?? [],
    traceParts: input.snapshot.traceParts ?? [],
    renderBlocks: input.snapshot.renderBlocks ?? [],
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
      traceId: input.prepared.traceContext?.traceId ?? input.prepared.runTraceId,
      modelAlias: input.prepared.modelAlias,
      profileAlias: input.prepared.profileAlias,
      versionOf: input.prepared.assistantMessageParentId,
      toolCalls: [],
      thinkingSteps: input.prepared.preflightThinkingSteps,
      traceParts: [],
      renderBlocks: [],
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
  const currentMessage = await findMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    messageId: input.assistantMessageId,
  });
  await updateMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    messageId: input.assistantMessageId,
    content: appendAssistantContinuationContent({
      existingContent:
        input.snapshot.assistantMessage?.content ?? currentMessage?.content,
      nextContent: input.snapshot.assistantContent ?? "",
    }),
    metadata: buildSnapshotMetadata({
      currentMetadata: currentMessage?.metadata,
      run: input.run,
      snapshot: input.snapshot,
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
    creditsConsumed: input.createErrorInput.prepared.preflightBilling.reduce(
      (sum, item) => sum + item.consumedCredits,
      0,
    ),
    metadata: {
      isError: !isClientCancelled,
      isCancelled: isClientCancelled,
      excludeFromContext: true,
      error: input.createErrorInput.contentError.message,
      errorCode: input.createErrorInput.contentError.code,
      userMessageId: input.createErrorInput.prepared.userMessage.id,
      sourceUserMessageId: input.createErrorInput.prepared.userMessage.id,
      traceId:
        input.createErrorInput.prepared.traceContext?.traceId ??
        input.createErrorInput.prepared.userMessage.id,
      modelAlias: input.createErrorInput.prepared.modelAlias,
      profileAlias: input.createErrorInput.prepared.profileAlias,
      agentMode: input.createErrorInput.prepared.agentMode,
      versionOf: input.createErrorInput.prepared.assistantMessageParentId,
      billingSkipped: true,
      billingSkipReason: "model_error",
      preflightBilling: input.createErrorInput.prepared.preflightBilling,
      preflightCreditsConsumed:
        input.createErrorInput.prepared.preflightBilling.reduce(
          (sum, item) => sum + item.consumedCredits,
          0,
        ),
      reasoning: input.snapshot.reasoning,
      reasoningSegments: input.snapshot.reasoningSegments ?? [],
      traceParts: input.snapshot.traceParts ?? [],
      toolCalls: input.snapshot.toolCalls ?? [],
      renderBlocks: input.snapshot.renderBlocks ?? [],
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
  userMessageId?: string | null;
  assistantMessageId: string | null;
  snapshot: ChatRunSnapshot;
  contentError: ContentError;
  appendRunEvent: DurableChatRunServiceAppendRunEvent;
  finishRun: DurableChatRunServiceFinishRun;
}) {
  const terminalRun = {
    ...input.run,
    status: input.status,
    userMessageId: input.userMessageId ?? input.run.userMessageId,
    assistantMessageId: input.assistantMessageId,
  };
  const snapshot = input.snapshot.assistantMessage
    ? {
        ...input.snapshot,
        assistantMessage: {
          ...input.snapshot.assistantMessage,
          metadata: {
            ...input.snapshot.assistantMessage.metadata,
            isError: input.status === "failed",
            isCancelled: input.status === "cancelled",
            error: input.contentError.message,
            errorCode: input.contentError.code,
            ...buildThreadRunMetadata(terminalRun),
          },
        },
      }
    : input.snapshot;
  const clientErrorMessage = sanitizeClientErrorMessage(
    input.contentError.message,
  );
  const errorPayload = toSseData({
    type: "error",
    code: input.contentError.code,
    error: clientErrorMessage,
    ...(terminalRun.userMessageId
      ? { userMessageId: terminalRun.userMessageId }
      : {}),
    ...(input.assistantMessageId ? { messageId: input.assistantMessageId } : {}),
  });
  await input.appendRunEvent({
    run: input.run,
    payload: errorPayload,
    snapshot,
  });
  await input.appendRunEvent({
    run: input.run,
    payload: toSseData({ type: "finish" }),
    snapshot,
  });
  if (input.assistantMessageId) {
    const currentMessage = await findMessageRecord({
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      messageId: input.assistantMessageId,
    });
    await updateMessageRecord({
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      threadId: input.run.threadId,
      messageId: input.assistantMessageId,
      content: appendAssistantContinuationContent({
        existingContent:
          snapshot.assistantMessage?.content ?? currentMessage?.content,
        nextContent:
          typeof snapshot.assistantContent === "string"
            ? snapshot.assistantContent
            : clientErrorMessage,
      }),
      metadata: {
        ...(currentMessage?.metadata ?? snapshot.assistantMessage?.metadata ?? {}),
        isError: input.status === "failed",
        isCancelled: input.status === "cancelled",
        error: input.contentError.message,
        errorCode: input.contentError.code,
        ...buildThreadRunMetadata(terminalRun),
      },
    });
  }
  return (
    (await input.finishRun({
      run: input.run,
      status: input.status,
      userMessageId: terminalRun.userMessageId,
      assistantMessageId: input.assistantMessageId,
      snapshot,
      errorCode: input.contentError.code,
      errorMessage: input.contentError.message,
    })) ?? input.run
  );
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
  let snapshot: ChatRunSnapshot = {};
  let assistantMessageId: string | null = run.assistantMessageId;
  let finalRun = run;
  let runBilling: MeterConsumeResponse | null = null;
  let terminalStatus: DurableRunJobStatus = "completed";
  let terminalErrorCode: string | null = null;
  let terminalErrorMessage: string | null = null;
  let assistantMessagePersisted = false;
  let lastAssistantSnapshotFlushAt = 0;
  let pendingTextDeltaPayload: Record<string, unknown> | null = null;
  let pendingTextDeltaStartedAt = 0;

  const maybeFlushAssistantSnapshot = async (force = false) => {
    if (
      !assistantMessageId ||
      assistantMessagePersisted ||
      terminalStatus !== "completed" ||
      snapshot.assistantContent === undefined
    ) {
      return;
    }

    const now = Date.now();
    if (
      !force &&
      now - lastAssistantSnapshotFlushAt < ASSISTANT_SNAPSHOT_FLUSH_MS
    ) {
      return;
    }

    lastAssistantSnapshotFlushAt = now;
    await updateAssistantSnapshot({
      run,
      assistantMessageId,
      snapshot,
    });
  };

  const heartbeat = async () => {
    run = (await durableChatRunService.heartbeat(run)) ?? run;
  };

  const flushPendingTextDelta = async () => {
    if (!pendingTextDeltaPayload) {
      return;
    }

    await durableChatRunService.appendRunEvent({
      run,
      payload: serializeSsePayload(pendingTextDeltaPayload),
      snapshot,
    });
    await heartbeat();
    pendingTextDeltaPayload = null;
    pendingTextDeltaStartedAt = 0;
  };

  const appendEventWithTextDeltaCoalescing = async (
    event: string,
    payload: Record<string, unknown> | null,
  ) => {
    if (isTextDeltaPayload(payload)) {
      const now = Date.now();
      const delta = payload.delta;
      if (!pendingTextDeltaPayload) {
        pendingTextDeltaPayload = { ...payload };
        pendingTextDeltaStartedAt = now;
        return;
      }

      pendingTextDeltaPayload = {
        ...pendingTextDeltaPayload,
        delta: `${pendingTextDeltaPayload.delta ?? ""}${delta}`,
      };
      if (
        now - pendingTextDeltaStartedAt < STREAM_APPEND_TEXT_DELTA_FLUSH_MS
      ) {
        return;
      }
      await flushPendingTextDelta();
      return;
    }

    await flushPendingTextDelta();
    await durableChatRunService.appendRunEvent({
      run,
      payload: event,
      snapshot,
    });
    await heartbeat();
  };

  try {
    const stream = createThreadRunStream({
      streamService,
      request,
      options: {
        shouldCancel: () => durableChatRunService.shouldCancel(run),
        onPrepared: async (prepared) => {
          run =
            (await updateChatThreadRunProgress({
              runId: run.id,
              teamId: run.teamId,
              workspaceId: run.workspaceId,
              userMessageId: prepared.userMessage.id,
            })) ?? run;
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
          run =
            (await updateChatThreadRunProgress({
              runId: run.id,
              teamId: run.teamId,
              workspaceId: run.workspaceId,
              userMessageId: prepared.userMessage.id,
              assistantMessageId: resolvePreparedAssistantMessageId({
                prepared,
                placeholderId: placeholder.id,
              }),
              snapshotJson: snapshot,
            })) ?? run;
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
          runBilling = result.billing;
          snapshot = {
            ...snapshot,
            assistantMessage: result.assistantMessage,
            billing: result.billing,
            retrieval: result.retrieval,
          };
        },
      },
    });

    for await (const event of stream) {
      const payload = parseSsePayload(event);
      snapshot = updateSnapshotFromPayload(snapshot, payload);
      if (payload?.type === "error") {
        terminalErrorCode =
          typeof payload.code === "string" ? payload.code : "CHAT_RUN_FAILED";
        terminalErrorMessage =
          typeof payload.error === "string"
            ? payload.error
            : "Chat run failed";
        terminalStatus =
          terminalErrorCode === "CLIENT_CANCELLED" ? "cancelled" : "failed";
      }
      if (payload?.type === "assistant-message") {
        await maybeFlushAssistantSnapshot(true);
        assistantMessagePersisted = true;
      }
      await appendEventWithTextDeltaCoalescing(event, payload);
      await maybeFlushAssistantSnapshot(false);
    }
    await flushPendingTextDelta();
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
    const finished = isWaitingForApproval
      ? await durableChatRunService.markWaitingForApproval({
          run,
          assistantMessageId,
          snapshot: finalSnapshot,
          confirmationIds: extractPendingConfirmationIds(finalSnapshot.toolCalls),
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
          userMessageId: durableUserMessageIdFallback({ run, request }),
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
          finishRun: durableChatRunService.finishRun.bind(durableChatRunService),
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
        metadata: terminalStatus === "waiting_for_approval"
          ? buildSnapshotMetadata({
              currentMetadata:
                finalMessage?.metadata ?? finalSnapshot.assistantMessage?.metadata,
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
    await flushPendingTextDelta().catch((flushError: unknown) => {
      logger.warn("Failed to flush pending thread run text delta after error", {
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
    const contentError = toDurableRunContentError(error);
    const status =
      contentError.code === "CLIENT_CANCELLED" ? "cancelled" : "failed";
    snapshot = {
      ...snapshot,
      errorCode: contentError.code,
      errorMessage: contentError.message,
    };
    finalRun =
      await persistTerminalFailure({
        run,
        status,
        userMessageId: durableUserMessageIdFallback({ run, request }),
        assistantMessageId,
        snapshot,
        contentError,
        appendRunEvent: durableChatRunService.appendRunEvent.bind(
          durableChatRunService,
        ),
        finishRun: durableChatRunService.finishRun.bind(durableChatRunService),
      });
    return {
      status,
      runId: run.id,
      assistantMessageId,
      errorCode: contentError.code,
      errorMessage: contentError.message,
    };
  }
}

export const testExports = {
  buildSnapshotMetadata,
  durableUserMessageIdFallback,
  requestWithDurableMessageOverrides,
  resolveFinalRunAfterFinish,
  resolvePreparedAssistantMessageId,
  stableDurableAssistantMessageId,
  stableDurableUserMessageId,
  toDurableRunContentError,
  updateSnapshotFromPayload,
};
