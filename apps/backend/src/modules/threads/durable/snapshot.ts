import { isUserPausedFinishReason } from "@sourceweft/contracts";
import { toObjectRecord } from "../../../shared/records";
import type { ToolCallTrace } from "../turn/types";
import type { ThinkingStepTrace } from "../turn/types";
import {
  normalizeTraceParts,
  normalizeMcpDisplay,
  tracePartFromToolCall,
  upsertTracePart,
  type TracePart,
} from "../turn/trace-parts";
import { buildTerminalAssistantTraceState } from "../turn/assistant-run-terminal-state";
import type {
  ChatRunSnapshot,
  ChatRunSnapshotAssistantMessage,
  ChatRunSnapshotRetrieval,
  ChatThreadRunStatus,
  DurableRunResultSnapshot,
} from "./types";
import type { EmbeddingVectorStrategy } from "../../content/types";
import { CLIENT_CANCELLED_CODE } from "./run-constants";
import { ContentError } from "../../content/errors";
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

function getRenderBlocks(value: unknown): unknown[] | undefined {
  const record = toObjectRecord(value);
  return Array.isArray(record?.renderBlocks) ? record.renderBlocks : undefined;
}

function getToolCalls(value: unknown): unknown[] | undefined {
  const record = toObjectRecord(value);
  return Array.isArray(record?.toolCalls) ? record.toolCalls : undefined;
}

/** Message-record fields a run snapshot keeps for its assistant message. */
const SNAPSHOT_ASSISTANT_MESSAGE_FIELDS = [
  "id",
  "threadId",
  "role",
  "parentMessageId",
  "content",
  "contentJson",
  "model",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Metadata scalars a run snapshot keeps for its assistant message: the
 * terminal backstop (`finishReason`, `errorCode`, `error`), approval and run
 * identity (`threadRun`), and stop/trace identity. `finishReason` exists only
 * here between finalize and `finishRun`, so the stale backstop needs it.
 */
const SNAPSHOT_ASSISTANT_METADATA_FIELDS = [
  "finishReason",
  "errorCode",
  "error",
  "isError",
  "isCancelled",
  "threadRun",
  "traceId",
  "userMessageId",
  "agentRunStop",
] as const;

/**
 * The bounded copy of the assistant message a run snapshot persists.
 *
 * The messages row is the source of truth for the assistant message; the
 * snapshot used to embed the whole row (tool calls, trace, reasoning,
 * retrieval, metering), which doubled every persisted run. Fields are
 * allow-listed so a new message field cannot re-inflate the snapshot.
 */
export function slimSnapshotAssistantMessage(
  message: unknown,
): ChatRunSnapshotAssistantMessage | undefined {
  const record = toObjectRecord(message);
  if (!record) {
    return undefined;
  }
  const metadata = toObjectRecord(record.metadata) ?? {};
  const slim: Record<string, unknown> = { metadata: {} };
  for (const key of SNAPSHOT_ASSISTANT_MESSAGE_FIELDS) {
    if (record[key] !== undefined) slim[key] = record[key];
  }
  const slimMetadata = slim.metadata as Record<string, unknown>;
  for (const key of SNAPSHOT_ASSISTANT_METADATA_FIELDS) {
    if (metadata[key] !== undefined) slimMetadata[key] = metadata[key];
  }
  return slim as ChatRunSnapshotAssistantMessage;
}

/**
 * Merge a full runner snapshot with persisted publication facts. Incoming
 * scalar/tool/progress fields win, while committed artifact outputs survive
 * stale runner, approval, cancellation, and recovery projections. The output
 * always carries the slim assistant message, so rows written before the slim
 * copy shrink on their next write; their embedded render blocks and tool calls
 * still count as committed-artifact authority.
 */
export function mergeChatRunSnapshot(input: {
  current: ChatRunSnapshot;
  incoming?: ChatRunSnapshot;
  assistantMessageMetadata?: Record<string, unknown> | null;
}): ChatRunSnapshot {
  const { protectedAgentTools: _untrustedProtectedState, ...incoming } =
    input.incoming ?? {};
  const base = input.current.reasoningRun;
  if (
    base &&
    incoming.reasoningRun &&
    (base.runId !== incoming.reasoningRun.runId ||
      base.parentRunId !== incoming.reasoningRun.parentRunId ||
      base.base !== incoming.reasoningRun.base)
  ) {
    throw new ContentError(
      409,
      "REASONING_RUN_CONFLICT",
      "A running invocation cannot change its reasoning base",
    );
  }
  if (base) incoming.reasoningRun = base;
  if (
    (input.current.reasoningRevision ?? 0) > (incoming.reasoningRevision ?? 0)
  ) {
    incoming.reasoning = input.current.reasoning;
    incoming.reasoningRevision = input.current.reasoningRevision;
    incoming.reasoningSegments = input.current.reasoningSegments;
  }
  const messageBlocks = getRenderBlocks(input.assistantMessageMetadata);
  const messageToolCalls = getToolCalls(input.assistantMessageMetadata);
  const currentAssistant = input.current.assistantMessage;
  const incomingAssistant = incoming.assistantMessage;
  const assistantMessage = incomingAssistant ?? currentAssistant;
  const currentMetadata = toObjectRecord(currentAssistant?.metadata) ?? {};
  const incomingMetadata = toObjectRecord(incomingAssistant?.metadata) ?? {};
  const renderBlocks = mergeCommittedArtifactRenderBlocks({
    incoming: Array.isArray(incoming.renderBlocks)
      ? incoming.renderBlocks
      : input.current.renderBlocks,
    authoritative: [
      input.current.renderBlocks,
      getRenderBlocks(currentMetadata),
      messageBlocks,
      getRenderBlocks(incomingMetadata),
    ],
  });
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
        toolCalls: getToolCalls(currentMetadata),
        renderBlocks: getRenderBlocks(currentMetadata),
      },
      { toolCalls: messageToolCalls, renderBlocks: messageBlocks },
      {
        toolCalls: getToolCalls(incomingMetadata),
        renderBlocks: getRenderBlocks(incomingMetadata),
      },
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
          assistantMessage: slimSnapshotAssistantMessage({
            ...(currentAssistant ?? assistantMessage),
            ...(incomingAssistant ?? {}),
            metadata: { ...currentMetadata, ...incomingMetadata },
          }),
        }
      : {}),
  };
}

export function getToolConfirmationStatus(
  value: unknown,
): ToolCallTrace["approvalState"] {
  const record = toObjectRecord(value);
  if (record?.status === "approved" || record?.status === "rejected") {
    return record.status;
  }
  const action = toObjectRecord(record?.action);
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
    const record = toObjectRecord(toolCall);
    const output = toObjectRecord(record?.output);
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
    const record = toObjectRecord(toolCall);
    const output = toObjectRecord(record?.output);
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
    mcpDisplay: next.mcpDisplay ?? existing?.mcpDisplay,
    approvalState: next.approvalState ?? existing?.approvalState,
    approvalConfirmationId:
      next.approvalConfirmationId ?? existing?.approvalConfirmationId,
  };
}

export function toToolCallTrace(value: unknown): ToolCallTrace | null {
  const record = toObjectRecord(value);
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
    input: toObjectRecord(record.input) ?? {},
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
    ...(normalizeMcpDisplay(record.mcpDisplay)
      ? { mcpDisplay: normalizeMcpDisplay(record.mcpDisplay) }
      : {}),
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
            // Trace parts carry neither input nor output; the incoming tool
            // call's canonical copies win in mergeToolCallTraceState anyway.
            input: {},
            output: undefined,
            status: existingToolPart.status,
            latencyMs: existingToolPart.latencyMs ?? null,
            error: existingToolPart.error ?? null,
            sequence: existingToolPart.order,
            mcpDisplay: existingToolPart.mcpDisplay,
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
  const record = toObjectRecord(value);
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
    ...(toObjectRecord(record.metadata)
      ? { metadata: toObjectRecord(record.metadata)! }
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
  // A turn parked on the user is NOT finished, and neither pause reason may be
  // read as terminal here. This is a backstop for runs whose worker died, so it
  // judges a run by the snapshot it inherited — and a resume run inherits the
  // parked turn's snapshot, finish reason included. Counting
  // `user_question_requested` as terminal therefore completed the resume run
  // within a third of a second of creating it, before its worker had run a
  // single step: the SSE stream saw a terminal run, synthesized `finish`, and
  // the browser stopped listening. The worker went on to write the real answer,
  // which is why the turn only appeared after a manual reload.
  if (finishReason && !isUserPausedFinishReason(finishReason)) {
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
): DurableRunResultSnapshot["retrieval"] {
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

function arrayOrUndefined(value: unknown) {
  return Array.isArray(value) ? value : undefined;
}

/**
 * The run's retrieval in the messages-row shape. New snapshots keep it in one
 * place, `snapshot.retrieval`; rows written before that also carry top-level
 * `citations` / `availableCitations` from `citations` events, read as a
 * fallback. Profile fields are copied only when present.
 */
export function readSnapshotRetrieval(
  snapshot: ChatRunSnapshot,
): ChatRunSnapshotRetrieval | undefined {
  const retrieval = toObjectRecord(snapshot.retrieval);
  const citations =
    arrayOrUndefined(retrieval?.citations) ??
    arrayOrUndefined(snapshot.citations);
  const availableCitations =
    arrayOrUndefined(retrieval?.availableCitations) ??
    arrayOrUndefined(snapshot.availableCitations) ??
    citations;
  if (!retrieval && !citations && !availableCitations) {
    return undefined;
  }
  const stringOrNull = (value: unknown) =>
    typeof value === "string" ? value : null;
  return {
    ...(retrieval?.embeddingProfileId !== undefined
      ? { embeddingProfileId: stringOrNull(retrieval.embeddingProfileId) }
      : {}),
    ...(retrieval?.vectorStrategy !== undefined
      ? { vectorStrategy: normalizeVectorStrategy(retrieval.vectorStrategy) }
      : {}),
    ...(retrieval?.annIndexUsed !== undefined
      ? { annIndexUsed: stringOrNull(retrieval.annIndexUsed) }
      : {}),
    citations: citations ?? [],
    availableCitations: availableCitations ?? [],
  };
}
