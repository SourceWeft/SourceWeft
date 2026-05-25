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
  isCompletedImageArtifactToolCall: (
    toolCall: ToolCallRecord,
    event: TToolEvent,
  ) => boolean;
  isCompletedWorkfileWriteToolCall: (
    toolCall: ToolCallRecord,
    event: TToolEvent,
  ) => boolean;
  isGeneratedImageArtifactToolName: (toolName: string) => boolean;
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

function resolveFinishedThreadRunStatus(input: {
  existingStatus: string | null;
  finishReason?: string | null;
}) {
  if (input.existingStatus === "failed" || input.existingStatus === "cancelled") {
    return input.existingStatus;
  }
  if (input.finishReason === "tool_confirmation_requested") {
    return "waiting_for_approval";
  }
  return "completed";
}

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

type HandleStreamingToolCallEventInput<
  TEvent extends ToolCallEventPayload,
> = ContextInput<TEvent> & {
  drainQueuedDeltasNow: () => void;
  event: TEvent;
  refreshedArtifactToolIds: Set<string>;
  refreshedWorkfileToolIds: Set<string>;
  setArtifactsRefreshKey: (updater: (value: number) => number) => void;
  setWorkfilesRefreshKey: (updater: (value: number) => number) => void;
};

type HandleStreamingThinkingStepInput<
  TToolEvent extends ToolCallEventPayload,
> = ContextInput<TToolEvent> & {
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
  context.streamRenderBuffer.replaceRenderBlocks([]);
  context.updateStreamingAssistantMessage((message) => ({
    ...message,
    content: text,
    metadata: {
      ...message.metadata,
      [STREAM_TEXT_PAUSED_KEY]: false,
      renderBlocks: [],
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
  if (
    event.type === "tool-call-start" &&
    context.isGeneratedImageArtifactToolName(nextToolCall.tool)
  ) {
    drainQueuedDeltasNow();
    context.streamRenderBuffer.appendGeneratedImageBlock(nextToolCall.id);
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
    context.isCompletedImageArtifactToolCall(nextToolCall, event) &&
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
  const displayOrder = existing?.displayOrder ?? next.displayOrder ?? existingIndex;
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

function upsertTracePart(
  parts: TracePartRecord[],
  next: TracePartDraft,
) {
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

function buildToolTracePart(
  toolCall: ToolCallRecord,
): TracePartDraft {
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
  };
}

function buildStepTracePart(
  step: ThinkingStepRecord,
): TracePartDraft {
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
    id: typeof step.sequence === "number" ? `${step.id}:${step.sequence}` : step.id,
    itemId: step.id,
    sequence: step.sequence,
    step,
  };
}

export function handleStreamingReasoning<
  TToolEvent extends ToolCallEventPayload,
>({
  context,
  reasoning,
  segment,
}: HandleStreamingReasoningInput<TToolEvent>) {
  if (reasoning.length === 0) {
    return;
  }

  const nextSegment = context.normalizeModelReasoningSegmentRecord(segment);
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
          .filter(
            (item): item is ModelReasoningSegmentRecord => item !== null,
          )
      : [];
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

    return {
      ...message,
      metadata: {
        ...message.metadata,
        reasoning: currentReasoning,
        reasoningSegments,
        traceEvents: getReasoningTraceEvents(message.metadata),
        traceParts,
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

export function handleStreamingFinish<
  TToolEvent extends ToolCallEventPayload,
>({
  context,
  finishReason,
}: HandleStreamingFinishInput<TToolEvent>) {
  if (context.streamToolCallsById.size > 0) {
    for (const [toolId, toolCall] of context.streamToolCallsById.entries()) {
      if (toolCall.status === "running") {
        context.streamToolCallsById.set(toolId, {
          ...toolCall,
          status: "completed",
        });
      }
    }
    context.syncStreamingToolCalls();
  }
  if (context.streamThinkingStepsById.size > 0) {
    for (const [stepId, step] of context.streamThinkingStepsById.entries()) {
      if (step.status === "in_progress") {
        context.streamThinkingStepsById.set(stepId, {
          ...step,
          status: "completed",
        });
      }
    }
    context.syncStreamingThinkingSteps();
  }
  context.updateStreamingAssistantMessage((message) => {
    const existingRun = context.toObjectRecord(message.metadata.threadRun);
    const existingStatus = context.toNullableString(existingRun?.status);
    const nextStatus = resolveFinishedThreadRunStatus({
      existingStatus,
      finishReason,
    });
    return {
      ...message,
      metadata: {
        ...message.metadata,
        ...(finishReason ? { finishReason } : {}),
        [STREAM_TEXT_PAUSED_KEY]: false,
        renderBlocks: context.streamRenderBuffer.snapshotRenderBlocks(),
        threadRun: {
          ...(existingRun ?? {}),
          idempotencyKey: context.durableRunKey,
          status: nextStatus,
          mode: context.mode,
        },
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
      excludeFromContext: false,
      userMessageId: nextUserMessageId,
      sourceUserMessageId: nextUserMessageId,
      sourceAssistantMessageId: previousAssistantMessageId,
      [STREAM_TEXT_PAUSED_KEY]: false,
      renderBlocks: context.streamRenderBuffer.snapshotRenderBlocks(),
      threadRun: {
        ...(context.toObjectRecord(message.metadata.threadRun) ?? {}),
        idempotencyKey: context.durableRunKey,
        status: "completed",
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
  const errorMessage = event.error ?? "Model error";
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

export function handleStreamingStart<
  TToolEvent extends ToolCallEventPayload,
>({
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
  const serverMentionedSourceIds = normalizeStringArray(event.mentionedSourceIds);
  const serverEffectiveMentionedSourceIds = normalizeStringArray(
    event.effectiveMentionedSourceIds,
  );
  const serverEffectiveSourceIds = normalizeStringArray(event.effectiveSourceIds);
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
