import type {
  CitationRecord,
  ModelReasoningSegmentRecord,
  ThinkingStepRecord,
  ToolCallRecord,
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
  mode: "send" | "refresh" | "edit";
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
  context.syncStreamingThinkingSteps();
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
      ? [
          ...currentSegments.filter((segment) => segment.id !== nextSegment.id),
          nextSegment,
        ].sort(
          (left, right) =>
            (left.sequence ?? Number.MAX_SAFE_INTEGER) -
            (right.sequence ?? Number.MAX_SAFE_INTEGER),
        )
      : currentSegments;

    return {
      ...message,
      metadata: {
        ...message.metadata,
        reasoning: currentReasoning,
        reasoningSegments,
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
    const nextStatus =
      existingStatus === "failed" || existingStatus === "cancelled"
        ? existingStatus
        : "completed";
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
  handleStreamingAssistantMessage,
  handleStreamingFinish,
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
        idempotencyKey: context.durableRunKey,
        status: "running",
        mode: context.mode,
      },
    },
  }));
}
