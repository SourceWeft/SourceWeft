import type {
  ThreadChatRunJobPayload,
  ThreadChatRunJobResult,
} from "../../queue";
import type { MeterConsumeResponse } from "@sourceweft/contracts";
import { ContentError } from "../../errors";
import type { PreparedThreadTurn } from "../turn/types";
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
import {
  createMessageRecord,
  findMessageRecord,
  updateMessageRecord,
} from "../message-repository";
import { findThreadRecord } from "../thread/repository";
import { billingService } from "../../../../modules/billing";
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
  }
  if (payload.type === "text-replace" && typeof payload.text === "string") {
    next.assistantContent = payload.text;
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
  if (String(payload.type).startsWith("tool-call-") && payload.toolCall) {
    next.toolCalls = mergeToolCall(next.toolCalls ?? [], payload.toolCall);
    const toolCall =
      payload.toolCall &&
      typeof payload.toolCall === "object" &&
      !Array.isArray(payload.toolCall)
        ? (payload.toolCall as Parameters<typeof tracePartFromToolCall>[0])
        : null;
    if (toolCall) {
      next.traceParts = upsertTracePart(
        next.traceParts,
        tracePartFromToolCall(toolCall),
      );
    }
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
    traceEventFromPayload(payload),
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
  sequence: number | null;
}) {
  return input.sequence === null
    ? input.baseId
    : `${input.baseId}:${input.sequence}`;
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

function traceEventFromPayload(payload: Record<string, unknown> | null) {
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
  prepared: Pick<PreparedThreadTurn, "assistantMessageId">;
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

  const assistantMessage = await createMessageRecord({
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
  assistantMessageId: string | null;
  snapshot: ChatRunSnapshot;
  contentError: ContentError;
  appendRunEvent: DurableChatRunServiceAppendRunEvent;
  finishRun: DurableChatRunServiceFinishRun;
}) {
  const terminalRun = {
    ...input.run,
    status: input.status,
    assistantMessageId: input.assistantMessageId,
  };
  const snapshot = input.snapshot.assistantMessage
    ? {
        ...input.snapshot,
        assistantMessage: {
          ...input.snapshot.assistantMessage,
          metadata: {
            ...input.snapshot.assistantMessage.metadata,
            ...buildThreadRunMetadata(terminalRun),
          },
        },
      }
    : input.snapshot;
  const errorPayload = toSseData({
    type: "error",
    code: input.contentError.code,
    error: input.contentError.message,
    ...(input.run.userMessageId ? { userMessageId: input.run.userMessageId } : {}),
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
  return (
    (await input.finishRun({
      run: input.run,
      status: input.status,
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
  const request = asRequestSnapshot(run.requestJson);
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
          snapshot = {
            ...snapshot,
            thread: prepared.thread,
            userMessage: prepared.userMessage,
            assistantMessage: placeholder,
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
    await flushPendingTextDelta();
    await maybeFlushAssistantSnapshot(true);
    const contentError =
      error instanceof ContentError
        ? error
        : new ContentError(
            500,
            "CHAT_RUN_FAILED",
            error instanceof Error ? error.message : String(error),
          );
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
  resolveFinalRunAfterFinish,
  resolvePreparedAssistantMessageId,
  updateSnapshotFromPayload,
};
