import type {
  CitationRecord,
  ModelReasoningSegmentRecord,
  ReasoningTraceEventRecord,
  ThinkingStepRecord,
  ToolCallRecord,
  TracePartRecord,
} from "../_components/chat-canvas";
import type { ChatMessageItem } from "./streaming-assistant-state";
import type { StreamingRenderBuffer } from "./streaming-render-buffer";
import {
  finishStreamingAssistantRun,
  resolveFinishedThreadRunStatus,
} from "./streaming-assistant-state-reducer";

type UpdateStreamingAssistantMessage = (
  updater: (message: ChatMessageItem) => ChatMessageItem,
) => void;

export type ToolCallEventPayload = {
  id?: string;
  type: string;
};

export type StreamingEventHandlerContext<
  TToolEvent extends ToolCallEventPayload = ToolCallEventPayload,
> = {
  appendReasoningChunk: (current: string | undefined, next: string) => string;
  durableRunKey: string;
  isCompletedArtifactToolCall: (
    toolCall: ToolCallRecord,
    event: TToolEvent,
  ) => boolean;
  isCompletedWorkfileWriteToolCall: (
    toolCall: ToolCallRecord,
    event: TToolEvent,
  ) => boolean;
  mergeThinkingStepRecords: (
    stepsById: Map<string, ThinkingStepRecord>,
    nextStep: ThinkingStepRecord,
  ) => void;
  mode: "send" | "refresh" | "edit" | "resume";
  normalizeCitationRecords: (value: unknown) => CitationRecord[];
  normalizeModelReasoningSegmentRecord: (
    value: unknown,
    fallbackSequence?: number,
  ) => ModelReasoningSegmentRecord | null;
  normalizeThinkingStepRecord: (value: unknown) => ThinkingStepRecord | null;
  normalizeThreadCommandRequest: (value: unknown) => unknown;
  resolveToolCallFromStreamEvent: (input: {
    event: TToolEvent;
    streamToolCallsById: Map<string, ToolCallRecord>;
  }) => ToolCallRecord;
  resolveTraceEventFromStreamEvent: (input: {
    event: TToolEvent;
    toolCall: ToolCallRecord;
  }) => ReasoningTraceEventRecord | null;
  streamRenderBuffer: StreamingRenderBuffer;
  streamThinkingStepsById: Map<string, ThinkingStepRecord>;
  streamToolCallsById: Map<string, ToolCallRecord>;
  syncStreamingCitations: (citationInput: {
    availableCitations?: CitationRecord[];
    citations: CitationRecord[];
  }) => void;
  syncStreamingThinkingSteps: () => void;
  syncStreamingToolCalls: () => void;
  toNullableString: (value: unknown) => string | null;
  toObjectRecord: (value: unknown) => Record<string, unknown> | null;
  updateChatTitle: (threadId: string, title: string) => void;
  updateStreamingAssistantMessage: UpdateStreamingAssistantMessage;
};

type ContextInput<TToolEvent extends ToolCallEventPayload> = {
  context: StreamingEventHandlerContext<TToolEvent>;
};

type HandleStreamingTextDeltaInput<TToolEvent extends ToolCallEventPayload> =
  ContextInput<TToolEvent> & {
    assistantText: string;
    delta: string;
    enqueueDelta: (delta: string) => void;
    startDeltaDrain: () => void;
  };

type HandleStreamingTextReplaceInput<TToolEvent extends ToolCallEventPayload> =
  ContextInput<TToolEvent> & {
    setAssistantText: (text: string) => void;
    setHasRenderedDelta: (hasRenderedDelta: boolean) => void;
    setLatestAssistantMessageContent: (content: string) => void;
    text: string;
  };

type HandleStreamingTextInterruptedInput<
  TToolEvent extends ToolCallEventPayload,
> = ContextInput<TToolEvent>;

type HandleStreamingToolCallEventInput<TEvent extends ToolCallEventPayload> =
  ContextInput<TEvent> & {
    drainQueuedDeltasNow: () => void;
    event: TEvent;
    refreshedArtifactToolIds: Set<string>;
    refreshedWorkfileToolIds: Set<string>;
    setArtifactsRefreshKey: (updater: (value: number) => number) => void;
    setWorkfilesRefreshKey: (updater: (value: number) => number) => void;
  };

type HandleStreamingThinkingStepInput<TToolEvent extends ToolCallEventPayload> =
  ContextInput<TToolEvent> & {
    step: unknown;
  };

type HandleStreamingReasoningInput<TToolEvent extends ToolCallEventPayload> =
  ContextInput<TToolEvent> & {
    reasoning: string;
    segment: unknown;
  };

type HandleStreamingCitationsInput<TToolEvent extends ToolCallEventPayload> =
  ContextInput<TToolEvent> & {
    availableCitations: unknown;
    citations: unknown;
  };

type HandleStreamingThreadTitleUpdateInput<
  TToolEvent extends ToolCallEventPayload,
> = ContextInput<TToolEvent> & {
  threadId: string;
  title: string;
};

type HandleStreamingThreadTitlePendingInput = {
  eventThreadId: string;
  jobId?: string;
  setPendingTitleJobId: (jobId: string | null) => void;
  setShouldPollThreadTitle: (shouldPollThreadTitle: boolean) => void;
  threadId: string;
};

type HandleStreamingFinishInput<TToolEvent extends ToolCallEventPayload> =
  ContextInput<TToolEvent> & {
    finishReason?: string | null;
  };

type HandleStreamingAssistantMessageInput<
  TToolEvent extends ToolCallEventPayload,
> = ContextInput<TToolEvent> & {
  messageId: string;
  parentMessageId?: string | null;
  persistedUserMessageId: string | null;
  setPersistedAssistantMessageId: (messageId: string) => void;
  setStreamingAssistantMessage: (message: ChatMessageItem) => void;
  setStreamingAssistantMessageId: (messageId: string) => void;
  streamingAssistantMessage: ChatMessageItem | null;
  streamingAssistantMessageId: string;
  streamingAssistantMessageIds: Set<string>;
  userMessageId?: string | null;
};

type ErrorEventPayload = {
  code?: string;
  error?: string;
  messageId?: string;
  parentMessageId?: string | null;
  userMessageId?: string;
};

type HandleStreamingErrorInput = {
  event: ErrorEventPayload;
  markStreamingAssistantAsError: (errorInput: {
    code?: string | null;
    error: string;
    messageId?: string | null;
    parentMessageId?: string | null;
    parentMessageIdProvided?: boolean;
    serverPersisted?: boolean;
    userMessageId?: string | null;
  }) => void;
  persistedUserMessageId: string | null;
  setStreamError: (error: Error) => void;
  setSuppressErrorToast: (suppressErrorToast: boolean) => void;
};

type StartEventPayload = {
  command?: unknown;
  contentJson?: unknown;
  effectiveMentionedSourceIds?: unknown;
  effectiveSourceIds?: unknown;
  mentionedSourceIds?: unknown;
  messageId: string;
  sourceIds?: unknown;
  threadRun?: unknown;
};

type HandleStreamingStartInput<TToolEvent extends ToolCallEventPayload> =
  ContextInput<TToolEvent> & {
    event: StartEventPayload;
    setCreatedUserMessageId: (messageId: string) => void;
    setMessages: (
      updater: (messages: ChatMessageItem[]) => ChatMessageItem[],
    ) => void;
    setPersistedUserMessageId: (messageId: string) => void;
    setPreparedEffectiveSourceIds: (sourceIds: string[] | null) => void;
    tempUserId: string | null;
  };

const STREAM_TEXT_PAUSED_KEY = "isTextPaused";
const STREAM_TEXT_INTERRUPTED_KEY = "isTextInterrupted";

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null;
}

export function createStreamingEventHandlerContext<
  TToolEvent extends ToolCallEventPayload,
>(input: StreamingEventHandlerContext<TToolEvent>) {
  return input;
}

export function handleStreamingTextDelta<
  TToolEvent extends ToolCallEventPayload,
>({
  assistantText,
  context,
  delta,
  enqueueDelta,
  startDeltaDrain,
}: HandleStreamingTextDeltaInput<TToolEvent>) {
  const hasVisibleDelta = delta.trim().length > 0;
  const hasRunningTool = [...context.streamToolCallsById.values()].some(
    (toolCall) => toolCall.status === "running",
  );
  const hasRunningStep = [...context.streamThinkingStepsById.values()].some(
    (step) => step.status === "in_progress",
  );
  if (
    assistantText.length > 0 &&
    hasVisibleDelta &&
    !hasRunningTool &&
    !hasRunningStep
  ) {
    context.updateStreamingAssistantMessage((message) => ({
      ...message,
      metadata: {
        ...message.metadata,
        [STREAM_TEXT_PAUSED_KEY]: false,
        renderBlocks: context.streamRenderBuffer.snapshotRenderBlocks(),
      },
    }));
  }

  enqueueDelta(delta);
  startDeltaDrain();
}

export function handleStreamingTextReplace<
  TToolEvent extends ToolCallEventPayload,
>({
  context,
  setAssistantText,
  setHasRenderedDelta,
  setLatestAssistantMessageContent,
  text,
}: HandleStreamingTextReplaceInput<TToolEvent>) {
  context.streamRenderBuffer.clearQueuedDeltas();
  setAssistantText(text);
  setLatestAssistantMessageContent(text);
  setHasRenderedDelta(text.length > 0);
  context.streamRenderBuffer.replaceText(text);
  context.updateStreamingAssistantMessage((message) => ({
    ...message,
    content: text,
    metadata: {
      ...message.metadata,
      [STREAM_TEXT_PAUSED_KEY]: false,
      [STREAM_TEXT_INTERRUPTED_KEY]: false,
      renderBlocks: context.streamRenderBuffer.snapshotRenderBlocks(),
      threadRun: {
        ...(context.toObjectRecord(message.metadata.threadRun) ?? {}),
        idempotencyKey: context.durableRunKey,
        status: "running",
        mode: context.mode,
      },
    },
  }));
}

export function handleStreamingTextInterrupted<
  TToolEvent extends ToolCallEventPayload,
>({ context }: HandleStreamingTextInterruptedInput<TToolEvent>) {
  context.updateStreamingAssistantMessage((message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      [STREAM_TEXT_INTERRUPTED_KEY]: true,
      [STREAM_TEXT_PAUSED_KEY]: true,
    },
  }));
}

export function handleStreamingToolCallEvent<
  TEvent extends ToolCallEventPayload,
>({
  context,
  drainQueuedDeltasNow,
  event,
  refreshedArtifactToolIds,
  refreshedWorkfileToolIds,
  setArtifactsRefreshKey,
  setWorkfilesRefreshKey,
}: HandleStreamingToolCallEventInput<TEvent>) {
  const nextToolCall = context.resolveToolCallFromStreamEvent({
    event,
    streamToolCallsById: context.streamToolCallsById,
  });

  if (
    typeof event.id === "string" &&
    event.id.length > 0 &&
    event.id !== nextToolCall.id
  ) {
    context.streamToolCallsById.delete(event.id);
  }

  context.streamToolCallsById.set(nextToolCall.id, nextToolCall);
  if (event.type === "tool-call-start") {
    // Tool blocks are progress only. Artifact outputs arrive as explicit
    // committed result blocks after publishing succeeds.
    drainQueuedDeltasNow();
    context.streamRenderBuffer.appendToolBlock(nextToolCall.id);
  }
  const traceEvent = context.resolveTraceEventFromStreamEvent({
    event,
    toolCall: nextToolCall,
  });
  context.updateStreamingAssistantMessage((message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      traceEvents: traceEvent
        ? upsertReasoningTraceEvent(
            getReasoningTraceEvents(message.metadata),
            traceEvent,
          )
        : getReasoningTraceEvents(message.metadata),
      traceParts: upsertTracePart(
        getTraceParts(message.metadata),
        buildToolTracePart(nextToolCall),
      ),
    },
  }));
  context.syncStreamingToolCalls();
  if (
    context.isCompletedWorkfileWriteToolCall(nextToolCall, event) &&
    !refreshedWorkfileToolIds.has(nextToolCall.id)
  ) {
    refreshedWorkfileToolIds.add(nextToolCall.id);
    setWorkfilesRefreshKey((value) => value + 1);
  }
  if (
    context.isCompletedArtifactToolCall(nextToolCall, event) &&
    !refreshedArtifactToolIds.has(nextToolCall.id)
  ) {
    refreshedArtifactToolIds.add(nextToolCall.id);
    setArtifactsRefreshKey((value) => value + 1);
  }
}

export function handleStreamingThinkingStep<
  TToolEvent extends ToolCallEventPayload,
>({ context, step }: HandleStreamingThinkingStepInput<TToolEvent>) {
  const nextStep = context.normalizeThinkingStepRecord(step);
  if (!nextStep) {
    return;
  }

  context.mergeThinkingStepRecords(context.streamThinkingStepsById, nextStep);
  context.updateStreamingAssistantMessage((message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      traceEvents: upsertReasoningTraceEvent(
        getReasoningTraceEvents(message.metadata),
        buildThinkingStepTraceEvent(nextStep),
      ),
      traceParts: upsertTracePart(
        getTraceParts(message.metadata),
        buildStepTracePart(nextStep),
      ),
    },
  }));
  context.syncStreamingThinkingSteps();
}

function isSameModelReasoningSegment(
  existing: ModelReasoningSegmentRecord,
  next: ModelReasoningSegmentRecord,
) {
  return existing.id === next.id;
}

function appendUniqueModelReasoningSegment(
  segments: ModelReasoningSegmentRecord[],
  next: ModelReasoningSegmentRecord,
) {
  const usedIds = new Set(segments.map((segment) => segment.id));
  let suffix = 2;
  let nextId = `${next.id}:${suffix}`;
  while (usedIds.has(nextId)) {
    suffix += 1;
    nextId = `${next.id}:${suffix}`;
  }

  return [
    ...segments,
    {
      ...next,
      id: nextId,
    },
  ];
}

function hasSameModelReasoningSegmentContext(
  existing: ModelReasoningSegmentRecord,
  next: ModelReasoningSegmentRecord,
) {
  return (
    existing.id === next.id &&
    existing.sequence === next.sequence &&
    existing.phase === next.phase &&
    existing.toolCallId === next.toolCallId &&
    existing.tool === next.tool
  );
}

function upsertModelReasoningSegment(
  segments: ModelReasoningSegmentRecord[],
  next: ModelReasoningSegmentRecord,
) {
  const existingIndex = segments.findIndex((segment) => segment.id === next.id);
  if (existingIndex < 0) {
    return [...segments, next];
  }

  const existing = segments[existingIndex];
  if (existing && isSameModelReasoningSegment(existing, next)) {
    return segments.map((segment, index) =>
      index === existingIndex
        ? {
            ...existing,
            ...next,
            id: existing.id,
            text: next.text,
            sequence: existing.sequence ?? next.sequence,
          }
        : segment,
    );
  }

  return appendUniqueModelReasoningSegment(segments, next);
}

function buildDeltaOnlyModelReasoningSegment(input: {
  currentSegments: ModelReasoningSegmentRecord[];
  reasoning: string;
  segment: ModelReasoningSegmentRecord;
}) {
  const existing = input.currentSegments.find((segment) =>
    hasSameModelReasoningSegmentContext(segment, input.segment),
  );

  return {
    ...input.segment,
    text: existing ? `${existing.text}${input.reasoning}` : input.segment.text,
  };
}

function normalizeStreamingModelReasoningSegment<
  TToolEvent extends ToolCallEventPayload,
>(input: {
  context: StreamingEventHandlerContext<TToolEvent>;
  currentSegments: ModelReasoningSegmentRecord[];
  reasoning: string;
  segment: unknown;
}) {
  const directSegment = input.context.normalizeModelReasoningSegmentRecord(
    input.segment,
  );
  if (directSegment) {
    return directSegment;
  }

  const segmentRecord = input.context.toObjectRecord(input.segment);
  if (!segmentRecord) {
    return null;
  }

  const fallbackSegment = input.context.normalizeModelReasoningSegmentRecord({
    ...segmentRecord,
    text: input.reasoning,
  });
  if (!fallbackSegment) {
    return null;
  }

  return buildDeltaOnlyModelReasoningSegment({
    currentSegments: input.currentSegments,
    reasoning: input.reasoning,
    segment: fallbackSegment,
  });
}

function nextTraceDisplayOrder(events: ReasoningTraceEventRecord[]) {
  return (
    events.reduce((max, event, index) => {
      const displayOrder =
        typeof event.displayOrder === "number" &&
        Number.isFinite(event.displayOrder)
          ? event.displayOrder
          : index;
      return Math.max(max, displayOrder);
    }, -1) + 1
  );
}

function upsertReasoningTraceEvent(
  events: ReasoningTraceEventRecord[],
  next: ReasoningTraceEventRecord,
) {
  const existingIndex = events.findIndex((event) => event.id === next.id);
  if (existingIndex < 0) {
    return [
      ...events,
      {
        ...next,
        displayOrder: next.displayOrder ?? nextTraceDisplayOrder(events),
      },
    ];
  }

  const existing = events[existingIndex];
  const displayOrder =
    existing?.displayOrder ?? next.displayOrder ?? existingIndex;
  return events.map((event, index) =>
    index === existingIndex
      ? {
          ...next,
          displayOrder,
        }
      : event,
  );
}

function getReasoningTraceEvents(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.traceEvents)
    ? (metadata.traceEvents.filter(
        (item): item is ReasoningTraceEventRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      ) as ReasoningTraceEventRecord[])
    : [];
}

function getTraceParts(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.traceParts)
    ? (metadata.traceParts.filter(
        (item): item is TracePartRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      ) as TracePartRecord[])
    : [];
}

function tracePartKey(part: Pick<TracePartRecord, "id" | "kind">) {
  if (part.kind === "tool" && "toolCallId" in part) {
    return `${part.kind}:${part.toolCallId}`;
  }
  return `${part.kind}:${part.id}`;
}

function nowIso() {
  return new Date().toISOString();
}

function upsertTracePart(parts: TracePartRecord[], next: TracePartDraft) {
  const existingIndex = parts.findIndex(
    (part) => tracePartKey(part) === tracePartKey(next),
  );
  const updatedAt = nowIso();
  if (existingIndex < 0) {
    return [
      ...parts,
      {
        ...next,
        order: parts.length,
        createdAt: updatedAt,
        updatedAt,
      } as TracePartRecord,
    ];
  }
  const existing = parts[existingIndex]!;
  return parts.map((part, index) =>
    index === existingIndex
      ? ({
          ...existing,
          ...next,
          id: existing.id,
          order: existing.order,
          createdAt: existing.createdAt,
          updatedAt,
        } as TracePartRecord)
      : part,
  );
}

type TracePartDraft = TracePartRecord extends infer T
  ? T extends TracePartRecord
    ? Omit<T, "order" | "createdAt" | "updatedAt">
    : never
  : never;

function buildReasoningTracePart(
  segment: ModelReasoningSegmentRecord,
): TracePartDraft {
  return {
    id: segment.id,
    kind: "reasoning",
    text: segment.text,
    phase: segment.phase,
    toolCallId: segment.toolCallId,
    tool: segment.tool,
    durationMs: segment.durationMs,
  };
}

function buildToolTracePart(toolCall: ToolCallRecord): TracePartDraft {
  return {
    id: toolCall.id,
    kind: "tool",
    toolCallId: toolCall.id,
    tool: toolCall.tool,
    status: toolCall.status,
    input: toolCall.input,
    output: toolCall.output,
    error: toolCall.error,
    latencyMs: toolCall.latencyMs,
    approvalState: toolCall.approvalState,
    approvalConfirmationId: toolCall.approvalConfirmationId,
    ...(toolCall.producer ? { producer: toolCall.producer } : {}),
  };
}

function buildStepTracePart(step: ThinkingStepRecord): TracePartDraft {
  return {
    id: step.id,
    kind: "step",
    title: step.title,
    status: step.status,
    items: step.items,
    metadata: step.metadata,
  };
}

function buildReasoningTraceEvent(input: {
  reasoning: string;
  segment: ModelReasoningSegmentRecord;
}): ReasoningTraceEventRecord {
  return {
    type: "reasoning",
    id:
      typeof input.segment.sequence === "number"
        ? `${input.segment.id}:${input.segment.sequence}`
        : input.segment.id,
    itemId: input.segment.id,
    sequence: input.segment.sequence,
    reasoning: input.reasoning,
    segment: input.segment,
  };
}

function buildThinkingStepTraceEvent(
  step: ThinkingStepRecord,
): ReasoningTraceEventRecord {
  return {
    type: "thinking-step",
    id:
      typeof step.sequence === "number"
        ? `${step.id}:${step.sequence}`
        : step.id,
    itemId: step.id,
    sequence: step.sequence,
    step,
  };
}

export function handleStreamingReasoning<
  TToolEvent extends ToolCallEventPayload,
>({ context, reasoning, segment }: HandleStreamingReasoningInput<TToolEvent>) {
  if (reasoning.length === 0) {
    return;
  }

  context.updateStreamingAssistantMessage((message) => {
    const currentReasoning = context.appendReasoningChunk(
      context.toNullableString(message.metadata.reasoning) ?? undefined,
      reasoning,
    );
    const currentSegments = Array.isArray(message.metadata.reasoningSegments)
      ? message.metadata.reasoningSegments
          .map((item, index) =>
            context.normalizeModelReasoningSegmentRecord(item, index),
          )
          .filter((item): item is ModelReasoningSegmentRecord => item !== null)
      : [];
    const nextSegment = normalizeStreamingModelReasoningSegment({
      context,
      currentSegments,
      reasoning,
      segment,
    });
    const reasoningSegments = nextSegment
      ? upsertModelReasoningSegment(currentSegments, nextSegment).sort(
          (left, right) =>
            (left.sequence ?? Number.MAX_SAFE_INTEGER) -
            (right.sequence ?? Number.MAX_SAFE_INTEGER),
        )
      : currentSegments;
    const traceParts = nextSegment
      ? upsertTracePart(
          getTraceParts(message.metadata),
          buildReasoningTracePart(nextSegment),
        )
      : getTraceParts(message.metadata);
    if (nextSegment) {
      context.streamRenderBuffer.appendReasoningBlock({
        id: `stream-reasoning-${nextSegment.id}`,
        text: reasoning,
        durationMs: nextSegment.durationMs,
      });
    }

    return {
      ...message,
      metadata: {
        ...message.metadata,
        reasoning: currentReasoning,
        reasoningSegments,
        traceEvents: getReasoningTraceEvents(message.metadata),
        traceParts,
        renderBlocks: context.streamRenderBuffer.snapshotRenderBlocks(),
        threadRun: {
          ...(context.toObjectRecord(message.metadata.threadRun) ?? {}),
          idempotencyKey: context.durableRunKey,
          status: "running",
          mode: context.mode,
        },
      },
    };
  });
}

export function handleStreamingCitations<
  TToolEvent extends ToolCallEventPayload,
>({
  availableCitations,
  citations,
  context,
}: HandleStreamingCitationsInput<TToolEvent>) {
  const nextCitations = context.normalizeCitationRecords(citations);
  const nextAvailableCitations =
    context.normalizeCitationRecords(availableCitations);
  context.syncStreamingCitations({
    citations: nextCitations,
    availableCitations:
      nextAvailableCitations.length > 0
        ? nextAvailableCitations
        : nextCitations,
  });
}

export function handleStreamingThreadTitleUpdate<
  TToolEvent extends ToolCallEventPayload,
>({
  context,
  threadId,
  title,
}: HandleStreamingThreadTitleUpdateInput<TToolEvent>) {
  context.updateChatTitle(threadId, title);
}

export function handleStreamingThreadTitlePending({
  eventThreadId,
  jobId,
  setPendingTitleJobId,
  setShouldPollThreadTitle,
  threadId,
}: HandleStreamingThreadTitlePendingInput) {
  setShouldPollThreadTitle(eventThreadId === threadId);
  setPendingTitleJobId(typeof jobId === "string" ? jobId : null);
}

export function handleStreamingFinish<TToolEvent extends ToolCallEventPayload>({
  context,
  finishReason,
}: HandleStreamingFinishInput<TToolEvent>) {
  const renderBlocks = context.streamRenderBuffer.snapshotRenderBlocks();
  const terminalRecords = finishStreamingAssistantRun({
    durableRunKey: context.durableRunKey,
    existingRun: null,
    existingStatus: null,
    finishReason,
    mode: context.mode,
    renderBlocks,
    thinkingSteps: [...context.streamThinkingStepsById.values()],
    toolCalls: [...context.streamToolCallsById.values()],
  });
  context.streamThinkingStepsById.clear();
  for (const step of terminalRecords.metadata.thinkingSteps) {
    context.streamThinkingStepsById.set(step.id, step);
  }
  context.streamToolCallsById.clear();
  for (const toolCall of terminalRecords.metadata.toolCalls) {
    context.streamToolCallsById.set(toolCall.id, toolCall);
  }
  if (terminalRecords.metadata.toolCalls.length > 0) {
    context.syncStreamingToolCalls();
  }
  if (terminalRecords.metadata.thinkingSteps.length > 0) {
    context.syncStreamingThinkingSteps();
  }

  context.updateStreamingAssistantMessage((message) => {
    const existingRun = context.toObjectRecord(message.metadata.threadRun);
    const existingStatus = context.toNullableString(existingRun?.status);
    const terminalState = finishStreamingAssistantRun({
      durableRunKey: context.durableRunKey,
      existingRun,
      existingStatus,
      finishReason,
      mode: context.mode,
      renderBlocks,
      thinkingSteps: terminalRecords.metadata.thinkingSteps,
      toolCalls: terminalRecords.metadata.toolCalls,
    });

    return {
      ...message,
      metadata: {
        ...message.metadata,
        ...terminalState.metadata,
        [STREAM_TEXT_PAUSED_KEY]: false,
      },
    };
  });

  return {
    receivedFinishEvent: true,
    streamEnded: true,
  };
}

export const testExports = {
  buildReasoningTraceEvent,
  buildThinkingStepTraceEvent,
  handleStreamingAssistantMessage,
  handleStreamingError,
  handleStreamingFinish,
  handleStreamingReasoning,
  handleStreamingThinkingStep,
  handleStreamingToolCallEvent,
  resolveFinishedThreadRunStatus,
  upsertReasoningTraceEvent,
};

export function handleStreamingAssistantMessage<
  TToolEvent extends ToolCallEventPayload,
>({
  context,
  messageId,
  parentMessageId,
  persistedUserMessageId,
  setPersistedAssistantMessageId,
  setStreamingAssistantMessage,
  setStreamingAssistantMessageId,
  streamingAssistantMessage,
  streamingAssistantMessageId,
  streamingAssistantMessageIds,
  userMessageId,
}: HandleStreamingAssistantMessageInput<TToolEvent>) {
  setPersistedAssistantMessageId(messageId);
  const nextUserMessageId = userMessageId ?? persistedUserMessageId;
  const previousAssistantMessageId = streamingAssistantMessageId;
  const nextParentMessageId =
    parentMessageId === undefined
      ? context.mode === "refresh"
        ? (streamingAssistantMessage?.parentMessageId ?? null)
        : undefined
      : parentMessageId;
  streamingAssistantMessageIds.add(previousAssistantMessageId);
  streamingAssistantMessageIds.add(messageId);
  setStreamingAssistantMessageId(messageId);
  if (
    streamingAssistantMessage &&
    streamingAssistantMessage.id !== previousAssistantMessageId
  ) {
    setStreamingAssistantMessage({
      ...streamingAssistantMessage,
      id: previousAssistantMessageId,
    });
  }
  context.updateStreamingAssistantMessage((message) => ({
    ...message,
    id: messageId,
    content: message.content,
    parentMessageId:
      nextParentMessageId === undefined
        ? message.parentMessageId
        : nextParentMessageId,
    metadata: {
      ...message.metadata,
      isError: false,
      // Clear the persisted failure alongside isError so a restarted run does
      // not inherit a stale "failed" status (resolveAssistantStatus keys off
      // errorCode too) or flash the previous error banner before content lands.
      error: null,
      errorCode: null,
      excludeFromContext: false,
      userMessageId: nextUserMessageId,
      sourceUserMessageId: nextUserMessageId,
      sourceAssistantMessageId: previousAssistantMessageId,
      [STREAM_TEXT_PAUSED_KEY]: false,
      renderBlocks: context.streamRenderBuffer.snapshotRenderBlocks(),
      threadRun: {
        ...(context.toObjectRecord(message.metadata.threadRun) ?? {}),
        assistantMessageId: messageId,
        idempotencyKey: context.durableRunKey,
        status: "running",
        mode: context.mode,
      },
    },
  }));
}

export function handleStreamingError({
  event,
  markStreamingAssistantAsError,
  persistedUserMessageId,
  setStreamError,
  setSuppressErrorToast,
}: HandleStreamingErrorInput) {
  const errorMessage = sanitizeClientErrorMessage(event.error) ?? "Model error";
  setSuppressErrorToast(event.code === "CLIENT_CANCELLED");
  markStreamingAssistantAsError({
    code: event.code ?? null,
    error: errorMessage,
    messageId: typeof event.messageId === "string" ? event.messageId : null,
    parentMessageId:
      event.parentMessageId === undefined ? null : event.parentMessageId,
    parentMessageIdProvided: event.parentMessageId !== undefined,
    serverPersisted: typeof event.messageId === "string",
    userMessageId: event.userMessageId ?? persistedUserMessageId,
  });
  setStreamError(new Error(errorMessage));
}

function sanitizeClientErrorMessage(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  if (
    /Error invoking tool/i.test(text) ||
    /Received tool input did not match expected schema/i.test(text) ||
    /\bkwargs\b/i.test(text) ||
    /Invalid input: expected .*received/i.test(text)
  ) {
    const toolName =
      text.match(/tool ['"]([^'"]+)['"]/i)?.[1] ??
      text.match(/\btool[=:]\s*([A-Za-z0-9_-]+)/i)?.[1];
    return toolName
      ? `${toolName} failed because the generated tool arguments were invalid. Please retry.`
      : "The generated tool arguments were invalid. Please retry.";
  }
  return text.length > 600 ? `${text.slice(0, 597).trimEnd()}...` : text;
}

export function handleStreamingStart<TToolEvent extends ToolCallEventPayload>({
  context,
  event,
  setCreatedUserMessageId,
  setMessages,
  setPersistedUserMessageId,
  setPreparedEffectiveSourceIds,
  tempUserId,
}: HandleStreamingStartInput<TToolEvent>) {
  const previousUserMessageId = tempUserId;
  const serverUserMessageId = event.messageId;
  const serverSourceIds = normalizeStringArray(event.sourceIds);
  const serverMentionedSourceIds = normalizeStringArray(
    event.mentionedSourceIds,
  );
  const serverEffectiveMentionedSourceIds = normalizeStringArray(
    event.effectiveMentionedSourceIds,
  );
  const serverEffectiveSourceIds = normalizeStringArray(
    event.effectiveSourceIds,
  );
  const serverContentJson = context.toObjectRecord(event.contentJson);
  const serverCommand = context.normalizeThreadCommandRequest(event.command);
  const serverThreadRun = context.toObjectRecord(event.threadRun);

  setPreparedEffectiveSourceIds(serverEffectiveSourceIds);
  setPersistedUserMessageId(serverUserMessageId);
  if (tempUserId) {
    setCreatedUserMessageId(serverUserMessageId);
  }
  setMessages((previous) =>
    previous.map((message) =>
      previousUserMessageId && message.id === previousUserMessageId
        ? {
            ...message,
            id: serverUserMessageId,
            contentJson: serverContentJson
              ? serverContentJson
              : message.contentJson,
            metadata: {
              ...message.metadata,
              ...(serverCommand ? { command: serverCommand } : {}),
              ...(serverSourceIds ? { sourceIds: serverSourceIds } : {}),
              ...(serverMentionedSourceIds
                ? { mentionedSourceIds: serverMentionedSourceIds }
                : {}),
              ...(serverEffectiveSourceIds
                ? { effectiveSourceIds: serverEffectiveSourceIds }
                : {}),
              ...(serverEffectiveMentionedSourceIds
                ? {
                    effectiveMentionedSourceIds:
                      serverEffectiveMentionedSourceIds,
                  }
                : {}),
            },
          }
        : message,
    ),
  );
  context.updateStreamingAssistantMessage((message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      userMessageId: serverUserMessageId,
      sourceUserMessageId: serverUserMessageId,
      threadRun: {
        ...(context.toObjectRecord(message.metadata.threadRun) ?? {}),
        ...(serverThreadRun ?? {}),
        idempotencyKey: context.durableRunKey,
        status: "running",
        mode: context.mode,
      },
    },
  }));
}
