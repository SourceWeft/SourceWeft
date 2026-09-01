import type { ToolCallTrace } from "../turn/types";
import type { ThinkingStepTrace } from "../turn/types";
import {
  normalizeTraceParts,
  tracePartFromToolCall,
  upsertTracePart,
  type TracePart,
} from "../turn/trace-parts";
import { buildTerminalAssistantTraceState } from "../turn/assistant-run-terminal-state";
import type { ChatRunSnapshot, ChatThreadRunStatus } from "./types";
import type { EmbeddingVectorStrategy } from "../../content/types";
import { CLIENT_CANCELLED_CODE } from "./run-constants";
import {
  mergeCommittedArtifactRenderBlocks,
  mergeCommittedArtifactToolCalls,
} from "../render-block-projection";

export { mergeCommittedArtifactRenderBlocks } from "../render-block-projection";

export type RunSnapshotSource = {
  snapshotJson?: Record<string, unknown> | null;
};

export function getSnapshotAssistantMetadata(
  snapshot: ChatRunSnapshot,
): Record<string, unknown> {
  const metadata = snapshot.assistantMessage?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

export function getSnapshotRecord(run: RunSnapshotSource): ChatRunSnapshot {
  return run.snapshotJson && typeof run.snapshotJson === "object"
    ? (run.snapshotJson as ChatRunSnapshot)
    : {};
}

export function parseStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function getObjectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getRenderBlocks(value: unknown): unknown[] | undefined {
  const record = getObjectRecord(value);
  return Array.isArray(record?.renderBlocks) ? record.renderBlocks : undefined;
}

function getAssistantRenderBlocks(snapshot: ChatRunSnapshot) {
  return getRenderBlocks(snapshot.assistantMessage?.metadata);
}

/**
 * Merge a full runner snapshot with persisted publication facts. Incoming
 * scalar/tool/progress fields win, while committed artifact outputs survive
 * stale runner, approval, cancellation, and recovery projections.
 */
export function mergeChatRunSnapshot(input: {
  current: ChatRunSnapshot;
  incoming?: ChatRunSnapshot;
  assistantMessageMetadata?: Record<string, unknown> | null;
}): ChatRunSnapshot {
  const { protectedAgentTools: _untrustedProtectedState, ...incoming } =
    input.incoming ?? {};
  const messageBlocks = getRenderBlocks(input.assistantMessageMetadata);
  const currentAssistant = input.current.assistantMessage;
  const incomingAssistant = incoming.assistantMessage;
  const assistantMessage = incomingAssistant ?? currentAssistant;
  const currentMetadata = getObjectRecord(currentAssistant?.metadata) ?? {};
  const incomingMetadata = getObjectRecord(incomingAssistant?.metadata) ?? {};
  const renderBlocks = mergeCommittedArtifactRenderBlocks({
    incoming: Array.isArray(incoming.renderBlocks)
      ? incoming.renderBlocks
      : input.current.renderBlocks,
    authoritative: [
      input.current.renderBlocks,
      getAssistantRenderBlocks(input.current),
      messageBlocks,
      getAssistantRenderBlocks(incoming),
    ],
  });
  const messageToolCalls = Array.isArray(
    input.assistantMessageMetadata?.toolCalls,
  )
    ? input.assistantMessageMetadata.toolCalls
    : undefined;
  const toolCalls = mergeCommittedArtifactToolCalls({
    incoming: Array.isArray(incoming.toolCalls)
      ? incoming.toolCalls
      : input.current.toolCalls,
    authoritative: [
      {
        toolCalls: input.current.toolCalls,
        renderBlocks: input.current.renderBlocks,
      },
      {
        toolCalls: Array.isArray(currentMetadata.toolCalls)
          ? currentMetadata.toolCalls
          : undefined,
        renderBlocks: getRenderBlocks(currentMetadata),
      },
      { toolCalls: messageToolCalls, renderBlocks: messageBlocks },
    ],
  });
  const assistantRenderBlocks = mergeCommittedArtifactRenderBlocks({
    incoming:
      getRenderBlocks(incomingMetadata) ?? getRenderBlocks(currentMetadata),
    authoritative: [
      getRenderBlocks(currentMetadata),
      messageBlocks,
      renderBlocks,
    ],
  });
  const assistantToolCalls = mergeCommittedArtifactToolCalls({
    incoming:
      (Array.isArray(incomingMetadata.toolCalls)
        ? incomingMetadata.toolCalls
        : undefined) ??
      (Array.isArray(currentMetadata.toolCalls)
        ? currentMetadata.toolCalls
        : undefined),
    authoritative: [
      {
        toolCalls: Array.isArray(currentMetadata.toolCalls)
          ? currentMetadata.toolCalls
          : undefined,
        renderBlocks: getRenderBlocks(currentMetadata),
      },
      { toolCalls: messageToolCalls, renderBlocks: messageBlocks },
      { toolCalls, renderBlocks },
    ],
  });

  return {
    ...input.current,
    ...incoming,
    ...(input.current.protectedAgentTools
      ? { protectedAgentTools: input.current.protectedAgentTools }
      : {}),
    ...(renderBlocks ? { renderBlocks } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(assistantMessage
      ? {
          assistantMessage: {
            ...(currentAssistant ?? assistantMessage),
            ...(incomingAssistant ?? {}),
            metadata: {
              ...currentMetadata,
              ...incomingMetadata,
              ...(assistantRenderBlocks
                ? { renderBlocks: assistantRenderBlocks }
                : {}),
              ...(assistantToolCalls ? { toolCalls: assistantToolCalls } : {}),
            },
          },
        }
      : {}),
  };
}

export function getToolConfirmationStatus(
  value: unknown,
): ToolCallTrace["approvalState"] {
  const record = getObjectRecord(value);
  if (record?.status === "approved" || record?.status === "rejected") {
    return record.status;
  }
  const action = getObjectRecord(record?.action);
  return action?.status === "approved" || action?.status === "rejected"
    ? action.status
    : undefined;
}

export function replaceConfirmationInToolCalls(
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

export function hasPendingConfirmations(toolCalls: unknown[] | undefined) {
  return (toolCalls ?? []).some((toolCall) => {
    const record = getObjectRecord(toolCall);
    const output = getObjectRecord(record?.output);
    return (
      output?.type === "tool_confirmation_request" &&
      output.status === "proposed"
    );
  });
}

export function mergeToolCallTraceState(
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

export function toToolCallTrace(value: unknown): ToolCallTrace | null {
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

export function updateExistingTracePartsFromToolCalls(
  traceParts: unknown,
  toolCalls: unknown[] | undefined,
): TracePart[] | undefined {
  if (!Array.isArray(traceParts)) {
    return undefined;
  }
  return (toolCalls ?? []).reduce<TracePart[]>((parts, toolCall) => {
    const normalized = toToolCallTrace(toolCall);
    if (
      !normalized ||
      !parts.some(
        (part) => part.kind === "tool" && part.toolCallId === normalized.id,
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
  }, normalizeTraceParts(traceParts));
}

export function toThinkingStepTrace(value: unknown): ThinkingStepTrace | null {
  const record = getObjectRecord(value);
  if (!record) {
    return null;
  }
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    !Array.isArray(record.items)
  ) {
    return null;
  }
  return {
    id: record.id,
    title: record.title,
    status:
      record.status === "pending" ||
      record.status === "in_progress" ||
      record.status === "completed"
        ? record.status
        : "completed",
    items: record.items.filter(
      (item): item is string => typeof item === "string",
    ),
    sequence: typeof record.sequence === "number" ? record.sequence : 0,
    ...(record.kind === "log" ||
    record.kind === "state" ||
    record.kind === "verification" ||
    record.kind === "reasoning_summary"
      ? { kind: record.kind }
      : {}),
    ...(typeof record.description === "string" || record.description === null
      ? { description: record.description }
      : {}),
    ...(typeof record.detail === "string" || record.detail === null
      ? { detail: record.detail }
      : {}),
    ...(getObjectRecord(record.metadata)
      ? { metadata: getObjectRecord(record.metadata)! }
      : {}),
  };
}

export function finalizeTerminalSnapshotTrace(
  snapshot: ChatRunSnapshot,
): ChatRunSnapshot {
  const thinkingSteps = Array.isArray(snapshot.thinkingSteps)
    ? snapshot.thinkingSteps
        .map(toThinkingStepTrace)
        .filter((step): step is ThinkingStepTrace => step !== null)
    : undefined;
  const terminalTraceState = buildTerminalAssistantTraceState({
    mode: "error",
    runtimeThinkingSteps: thinkingSteps ?? [],
    traceParts: snapshot.traceParts,
  });
  return {
    ...snapshot,
    ...(thinkingSteps
      ? { thinkingSteps: terminalTraceState.thinkingSteps }
      : {}),
    traceParts: terminalTraceState.traceParts,
  };
}

export function resolveTerminalStatusFromFinishedSnapshot(
  snapshot: ChatRunSnapshot,
): Extract<ChatThreadRunStatus, "completed" | "failed" | "cancelled"> | null {
  const metadata = getSnapshotAssistantMetadata(snapshot);
  const finishReason =
    typeof snapshot.finishReason === "string"
      ? snapshot.finishReason
      : typeof metadata.finishReason === "string"
        ? metadata.finishReason
        : null;
  const errorCode =
    typeof snapshot.errorCode === "string"
      ? snapshot.errorCode
      : typeof metadata.errorCode === "string"
        ? metadata.errorCode
        : null;
  const errorMessage =
    typeof snapshot.errorMessage === "string"
      ? snapshot.errorMessage
      : typeof metadata.error === "string"
        ? metadata.error
        : null;

  if (errorCode === CLIENT_CANCELLED_CODE) {
    return "cancelled";
  }
  if (
    errorCode ||
    errorMessage ||
    finishReason === "command_success_criteria_failed"
  ) {
    return "failed";
  }
  if (finishReason && finishReason !== "tool_confirmation_requested") {
    return "completed";
  }
  return null;
}

function normalizeVectorStrategy(
  value: unknown,
): EmbeddingVectorStrategy | null {
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
