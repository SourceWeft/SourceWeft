import type { ByokModelSelection } from "../_components/byok-state";
import type {
  ChatSendInput,
  CitationRecord,
  LiveToolConfirmation,
  ModelReasoningSegmentRecord,
  PromptThinkingSettings,
  ThinkingStepRecord,
  ToolCallRecord,
} from "../_components/chat-canvas";
import type { ToolApprovalResume } from "@sourceweft/sdk";
import type {
  ModelType,
  SelectedModels,
} from "../_components/model-catalog-utils";
import {
  createStreamingEventHandlerContext,
  handleStreamingAssistantMessage,
  handleStreamingCitations,
  handleStreamingError,
  handleStreamingFinish,
  handleStreamingReasoning,
  handleStreamingStart,
  handleStreamingTextDelta,
  handleStreamingTextInterrupted,
  handleStreamingTextReplace,
  handleStreamingThinkingStep,
  handleStreamingThreadTitlePending,
  handleStreamingThreadTitleUpdate,
  handleStreamingToolCallEvent,
  type ToolCallEventPayload,
} from "./streaming-event-handlers";
import {
  buildStreamingThreadRequestBody,
  type RequestThinkingConfig,
} from "./streaming-request-body";
import { parseFinishLiveConfirmations } from "./chat-stream-confirmations";
import { createStreamingEventParser } from "./streaming-event-parser";
import {
  createStreamingRenderBuffer,
  type StreamingRenderBuffer,
} from "./streaming-render-buffer";
import type { ChatMessageItem } from "./streaming-assistant-state";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

const STREAM_DELTA_MAX_BATCH_CHARS = 800;
const STREAM_TEXT_PAUSED_KEY = "isTextPaused";
const SILENT_STREAM_ERROR_CODES = new Set(["CHAT_RUN_STALE"]);
const TITLE_POLL_INTERVAL_MS = 1000;
const TITLE_POLL_TIMEOUT_MS = 60000;

export type ChatStreamEventPayload = ToolCallEventPayload & {
  availableCitations?: unknown;
  citations?: unknown;
  code?: string;
  command?: unknown;
  contentJson?: unknown;
  data?: unknown;
  delta?: string;
  effectiveMentionedSourceIds?: unknown;
  effectiveSourceIds?: unknown;
  error?: string;
  finishReason?: string | null;
  hitCount?: number;
  id?: string;
  input?: unknown;
  jobId?: string;
  latencyMs?: number;
  liveConfirmations?: unknown;
  mentionedSourceIds?: unknown;
  messageId?: string;
  output?: unknown;
  parentMessageId?: string | null;
  query?: string;
  reasoning?: string;
  segment?: unknown;
  sourceIds?: unknown;
  status?: string;
  step?: unknown;
  text?: string;
  threadRun?: unknown;
  threadId?: string;
  title?: string;
  tool?: string;
  toolCall?: unknown;
  userMessageId?: string;
};

export type ChatStreamToolCallEventType =
  | "tool-call-start"
  | "tool-call-event"
  | "tool-call-result"
  | "tool-call-error"
  | "tool-call-end";

type JobStatusResponse = {
  data?: JobStatusResponse;
  result?: unknown;
  status?: string;
};

type RunChatStreamInput = {
  appendReasoningChunk: (current: string | undefined, next: string) => string;
  attachOnly?: boolean;
  byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
  catalogKindEnabled: Partial<Record<ModelType, boolean>>;
  command?: ChatSendInput["command"];
  invocation?: ChatSendInput["invocation"];
  content?: string;
  durableRunKey: string;
  getAssistantText: () => string;
  getPersistedUserMessageId: () => string | null;
  getStreamingAssistantMessage: () => ChatMessageItem | null;
  getStreamingAssistantMessageId: () => string;
  images?: ChatSendInput["images"];
  assistantMessageId?: string | null;
  isCompletedImageArtifactToolCall: (
    toolCall: ToolCallRecord,
    event: ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
  ) => boolean;
  isCompletedPresentationArtifactToolCall: (
    toolCall: ToolCallRecord,
    event: ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
  ) => boolean;
  isCompletedWorkfileWriteToolCall: (
    toolCall: ToolCallRecord,
    event: ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
  ) => boolean;
  isGeneratedImageArtifactToolName: (toolName: string) => boolean;
  isPresentationArtifactToolName: (toolName: string) => boolean;
  markStreamingAssistantAsError: (errorInput: {
    code?: string | null;
    error: string;
    messageId?: string | null;
    parentMessageId?: string | null;
    parentMessageIdProvided?: boolean;
    serverPersisted?: boolean;
    userMessageId?: string | null;
  }) => void;
  mergeThinkingStepRecords: (
    stepsById: Map<string, ThinkingStepRecord>,
    nextStep: ThinkingStepRecord,
  ) => void;
  mode: "send" | "refresh" | "edit" | "resume";
  mentionedSourceIds?: string[];
  toolApprovalResume?: ToolApprovalResume | null;
  normalizeCitationRecords: (value: unknown) => CitationRecord[];
  normalizeModelReasoningSegmentRecord: (
    value: unknown,
    fallbackSequence?: number,
  ) => ModelReasoningSegmentRecord | null;
  normalizeThinkingStepRecord: (value: unknown) => ThinkingStepRecord | null;
  normalizeThreadCommandRequest: (value: unknown) => unknown;
  onCreatedUserMessageId: (messageId: string) => void;
  onToolConfirmationRequested?: (input: {
    assistantMessageId?: string | null;
    liveConfirmations: LiveToolConfirmation[];
    parentMessageId?: string | null;
    userMessageId?: string | null;
  }) => void;
  onPersistedAssistantMessageId: (messageId: string) => void;
  onPersistedUserMessageId: (messageId: string) => void;
  onPreparedEffectiveSourceIds: (sourceIds: string[] | null) => void;
  onPreparedThreadRun?: (threadRun: Record<string, unknown>) => void;
  onStreamError: (error: Error) => void;
  onSuppressErrorToast: (suppressErrorToast: boolean) => void;
  onTitlePollScheduled?: () => void;
  refreshedArtifactToolIds: Set<string>;
  refreshedWorkfileToolIds: Set<string>;
  resolveToolCallFromStreamEvent: (input: {
    event: ChatStreamEventPayload & { type: ChatStreamToolCallEventType };
    streamToolCallsById: Map<string, ToolCallRecord>;
  }) => ToolCallRecord;
  searchEnabled: boolean;
  selectedByokModels: Partial<Record<ModelType, ByokModelSelection | null>>;
  selectedModels: SelectedModels;
  setArtifactsRefreshKey: (updater: (value: number) => number) => void;
  setAssistantText: (text: string) => void;
  setHasRenderedDelta: (hasRenderedDelta: boolean) => void;
  setLatestAssistantMessageContent: (content: string) => void;
  setMessages: (
    updater: (messages: ChatMessageItem[]) => ChatMessageItem[],
  ) => void;
  setStreamingAssistantMessage: (message: ChatMessageItem) => void;
  setStreamingAssistantMessageId: (messageId: string) => void;
  setWorkfilesRefreshKey: (updater: (value: number) => number) => void;
  shouldRenderToolCall: (
    toolCall: ToolCallRecord,
    thinkingSteps?: ThinkingStepRecord[],
  ) => boolean;
  skillIds?: string[];
  sourceIds?: string[];
  streamRenderBuffer?: StreamingRenderBuffer;
  streamThinkingStepsById: Map<string, ThinkingStepRecord>;
  streamToolCallsById: Map<string, ToolCallRecord>;
  streamWithSelectedLlm: boolean;
  streamingAssistantMessageIds: Set<string>;
  tempUserId: string | null;
  thinking?: RequestThinkingConfig;
  thinkingSettings: PromptThinkingSettings;
  threadId: string;
  throwStreamRequestError: (response: Response) => Promise<never>;
  timezone?: string;
  toNullableString: (value: unknown) => string | null;
  toObjectRecord: (value: unknown) => Record<string, unknown> | null;
  tools?: ChatSendInput["tools"];
  updateChatTitle: (threadId: string, title: string) => void;
  updateStreamingAssistantMessage: (
    updater: (message: ChatMessageItem) => ChatMessageItem,
  ) => void;
  userMessageId?: string | null;
  workspaceId: string;
};

export type RunChatStreamResult = {
  finishReason: string | null;
  receivedFinishEvent: boolean;
  streamRenderBuffer: StreamingRenderBuffer;
  titlePollScheduled: boolean;
};

function resolveJobStatusPayload(payload: JobStatusResponse | null) {
  return payload?.data ?? payload;
}

function getTitleFromJobResult(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const result = value as Record<string, unknown>;
  return result.status === "applied" && typeof result.title === "string"
    ? result.title.trim()
    : null;
}

function isToolCallEventType(
  value: string,
): value is ChatStreamToolCallEventType {
  return (
    value === "tool-call-start" ||
    value === "tool-call-event" ||
    value === "tool-call-result" ||
    value === "tool-call-error" ||
    value === "tool-call-end"
  );
}

function isToolCallEvent(
  value: ChatStreamEventPayload,
): value is ChatStreamEventPayload & { type: ChatStreamToolCallEventType } {
  return isToolCallEventType(value.type);
}

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export async function runChatStream(
  input: RunChatStreamInput,
): Promise<RunChatStreamResult> {
  const requestBody = buildStreamingThreadRequestBody({
    mode: input.mode,
    mentionedSourceIds: input.mentionedSourceIds,
    sourceIds: input.sourceIds,
    timezone: input.timezone,
    durableRunKey: input.durableRunKey,
    command: input.command,
    invocation: input.invocation,
    skillIds: input.skillIds,
    searchEnabled: input.searchEnabled,
    tools: input.tools,
    thinking: input.thinking,
    byokSelections: input.byokSelections,
    selectedByokModels: input.selectedByokModels,
    selectedModels: input.selectedModels,
    catalogKindEnabled: input.catalogKindEnabled,
    streamWithSelectedLlm: input.streamWithSelectedLlm,
    thinkingSettings: input.thinkingSettings,
    attachOnly: input.attachOnly,
    content: input.content,
    images: input.images,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    toolApprovalResume: input.toolApprovalResume,
  });

  const response = await fetch(
    `${apiBaseUrl}/v1/workspaces/${input.workspaceId}/threads/${input.threadId}/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(requestBody),
    },
  );

  if (!response.ok) {
    await input.throwStreamRequestError(response);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const streamRenderBuffer =
    input.streamRenderBuffer ??
    createStreamingRenderBuffer({
      maxDeltaBatchChars: STREAM_DELTA_MAX_BATCH_CHARS,
    });
  const streamEventParser = createStreamingEventParser<ChatStreamEventPayload>({
    parseEvent: (eventInput) => eventInput as ChatStreamEventPayload,
  });
  let drainPromise: Promise<void> | null = null;
  let streamEnded = false;
  let receivedFinishEvent = false;
  let finishReason: string | null = null;
  let pendingTitleJobId: string | null = null;
  let sawStreamError = false;
  let shouldPollThreadTitle = false;
  let titlePollScheduled = false;

  const pollThreadTitleJob = async (jobId: string) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < TITLE_POLL_TIMEOUT_MS) {
      await new Promise((resolve) =>
        window.setTimeout(resolve, TITLE_POLL_INTERVAL_MS),
      );
      const titleResponse = await fetch(
        `${apiBaseUrl}/v1/workspaces/${input.workspaceId}/threads/${input.threadId}/title-job/${encodeURIComponent(jobId)}`,
        { credentials: "include" },
      ).catch(() => null);
      if (!titleResponse?.ok) {
        continue;
      }

      const payload = (await titleResponse
        .json()
        .catch(() => null)) as JobStatusResponse | null;
      const jobStatus = resolveJobStatusPayload(payload);
      const status = jobStatus?.status;
      const title = getTitleFromJobResult(jobStatus?.result);
      if (title) {
        input.updateChatTitle(input.threadId, title);
        return;
      }
      if (status === "failed" || status === "cancelled") {
        return;
      }
    }
  };

  const enqueueDelta = (delta: string) => {
    if (!delta) {
      return;
    }

    streamRenderBuffer.enqueueDelta(delta);
  };

  const startDeltaDrain = () => {
    if (drainPromise) {
      return;
    }

    drainPromise = (async () => {
      while (!streamEnded || streamRenderBuffer.hasQueuedDeltas()) {
        if (!streamRenderBuffer.hasQueuedDeltas()) {
          await waitForAnimationFrame();
          continue;
        }

        const nextDeltaBatch = streamRenderBuffer.consumeQueuedDeltaBatch();
        if (!nextDeltaBatch) {
          continue;
        }

        const nextText = input.getAssistantText() + nextDeltaBatch;
        input.setAssistantText(nextText);
        streamRenderBuffer.appendText(nextDeltaBatch);
        input.setLatestAssistantMessageContent(nextText);
        input.updateStreamingAssistantMessage((message) => ({
          ...message,
          content: nextText,
          metadata: {
            ...message.metadata,
            renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
            threadRun: {
              ...(input.toObjectRecord(message.metadata.threadRun) ?? {}),
              idempotencyKey: input.durableRunKey,
              status: "running",
              mode: input.mode,
            },
          },
        }));

        if (nextText.length > 0) {
          input.setHasRenderedDelta(true);
        }

        await waitForAnimationFrame();
      }
    })();
  };

  const drainQueuedDeltasNow = () => {
    if (!streamRenderBuffer.hasQueuedDeltas()) {
      const latestContent =
        input.getStreamingAssistantMessage()?.content ??
        input.getAssistantText();
      input.setLatestAssistantMessageContent(latestContent);
      return;
    }

    const nextDelta = streamRenderBuffer.drainQueuedDeltas();
    const nextText = input.getAssistantText() + nextDelta;
    input.setAssistantText(nextText);
    streamRenderBuffer.appendText(nextDelta);
    input.setLatestAssistantMessageContent(nextText);
    input.updateStreamingAssistantMessage((message) => ({
      ...message,
      content: nextText,
      metadata: {
        ...message.metadata,
        renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
        threadRun: {
          ...(input.toObjectRecord(message.metadata.threadRun) ?? {}),
          idempotencyKey: input.durableRunKey,
          status: "running",
          mode: input.mode,
        },
      },
    }));
  };

  const syncStreamingToolCalls = () => {
    const thinkingSteps = [...input.streamThinkingStepsById.values()];
    const toolCalls = [...input.streamToolCallsById.values()].filter(
      (toolCall) => input.shouldRenderToolCall(toolCall, thinkingSteps),
    );
    const shouldShowTextPause =
      input.getAssistantText().length > 0 &&
      toolCalls.some(
        (toolCall) =>
          toolCall.status === "running" ||
          toolCall.status === "approval_requested",
      );
    input.updateStreamingAssistantMessage((message) => ({
      ...message,
      metadata: {
        ...message.metadata,
        [STREAM_TEXT_PAUSED_KEY]: shouldShowTextPause,
        toolCalls,
        renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
        threadRun: {
          ...(input.toObjectRecord(message.metadata.threadRun) ?? {}),
          idempotencyKey: input.durableRunKey,
          status: "running",
          mode: input.mode,
        },
      },
    }));
  };

  const syncStreamingThinkingSteps = () => {
    const thinkingSteps = [...input.streamThinkingStepsById.values()];
    const toolCalls = [...input.streamToolCallsById.values()].filter(
      (toolCall) => input.shouldRenderToolCall(toolCall, thinkingSteps),
    );
    const shouldShowTextPause =
      input.getAssistantText().length > 0 &&
      (toolCalls.some(
        (toolCall) =>
          toolCall.status === "running" ||
          toolCall.status === "approval_requested",
      ) ||
        thinkingSteps.some((step) => step.status === "in_progress"));
    input.updateStreamingAssistantMessage((message) => ({
      ...message,
      metadata: {
        ...message.metadata,
        [STREAM_TEXT_PAUSED_KEY]: shouldShowTextPause,
        thinkingSteps,
        toolCalls,
        renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
        threadRun: {
          ...(input.toObjectRecord(message.metadata.threadRun) ?? {}),
          idempotencyKey: input.durableRunKey,
          status: "running",
          mode: input.mode,
        },
      },
    }));
  };

  const syncStreamingCitations = (citationInput: {
    citations: CitationRecord[];
    availableCitations?: CitationRecord[];
  }) => {
    input.updateStreamingAssistantMessage((message) => ({
      ...message,
      metadata: {
        ...message.metadata,
        retrieval: {
          ...(input.toObjectRecord(message.metadata.retrieval) ?? {}),
          citations: citationInput.citations,
          availableCitations:
            citationInput.availableCitations ?? citationInput.citations,
        },
        threadRun: {
          ...(input.toObjectRecord(message.metadata.threadRun) ?? {}),
          idempotencyKey: input.durableRunKey,
          status: "running",
          mode: input.mode,
        },
      },
    }));
  };

  const streamingEventHandlerContext = createStreamingEventHandlerContext({
    appendReasoningChunk: input.appendReasoningChunk,
    durableRunKey: input.durableRunKey,
    isCompletedImageArtifactToolCall: (toolCall, event) =>
      input.isCompletedImageArtifactToolCall(
        toolCall,
        event as ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
      ),
    isCompletedPresentationArtifactToolCall: (toolCall, event) =>
      input.isCompletedPresentationArtifactToolCall(
        toolCall,
        event as ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
      ),
    isCompletedWorkfileWriteToolCall: (toolCall, event) =>
      input.isCompletedWorkfileWriteToolCall(
        toolCall,
        event as ChatStreamEventPayload & { type: ChatStreamToolCallEventType },
      ),
    isGeneratedImageArtifactToolName: input.isGeneratedImageArtifactToolName,
    isPresentationArtifactToolName: input.isPresentationArtifactToolName,
    mergeThinkingStepRecords: input.mergeThinkingStepRecords,
    mode: input.mode,
    normalizeCitationRecords: input.normalizeCitationRecords,
    normalizeModelReasoningSegmentRecord:
      input.normalizeModelReasoningSegmentRecord,
    normalizeThinkingStepRecord: input.normalizeThinkingStepRecord,
    normalizeThreadCommandRequest: input.normalizeThreadCommandRequest,
    resolveToolCallFromStreamEvent: ({ event, streamToolCallsById }) =>
      input.resolveToolCallFromStreamEvent({
        event: event as ChatStreamEventPayload & {
          type: ChatStreamToolCallEventType;
        },
        streamToolCallsById,
      }),
    resolveTraceEventFromStreamEvent: ({ event, toolCall }) => {
      if (!event.type.startsWith("tool-call-")) {
        return null;
      }
      return {
        type: "tool-call",
        id:
          typeof toolCall.sequence === "number"
            ? `${toolCall.id}:${toolCall.sequence}`
            : toolCall.id,
        itemId: toolCall.id,
        sequence: toolCall.sequence,
        eventType: event.type,
        tool: toolCall.tool,
        toolCall,
        payload: event as Record<string, unknown>,
      };
    },
    streamRenderBuffer,
    streamThinkingStepsById: input.streamThinkingStepsById,
    streamToolCallsById: input.streamToolCallsById,
    syncStreamingCitations,
    syncStreamingThinkingSteps,
    syncStreamingToolCalls,
    toNullableString: input.toNullableString,
    toObjectRecord: input.toObjectRecord,
    updateChatTitle: input.updateChatTitle,
    updateStreamingAssistantMessage: input.updateStreamingAssistantMessage,
  });

  readLoop: while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    for (const data of streamEventParser.parseChunk(value)) {
      if (data.type === "start" && typeof data.messageId === "string") {
        handleStreamingStart({
          context: streamingEventHandlerContext,
          event: {
            ...data,
            messageId: data.messageId,
          },
          tempUserId: input.tempUserId,
          setMessages: input.setMessages,
          setPreparedEffectiveSourceIds: input.onPreparedEffectiveSourceIds,
          setPersistedUserMessageId: input.onPersistedUserMessageId,
          setCreatedUserMessageId: input.onCreatedUserMessageId,
        });
        if (data.threadRun && typeof data.threadRun === "object") {
          input.onPreparedThreadRun?.(
            data.threadRun as Record<string, unknown>,
          );
        }
      } else if (data.type === "text-delta" && typeof data.delta === "string") {
        handleStreamingTextDelta({
          context: streamingEventHandlerContext,
          assistantText: input.getAssistantText(),
          delta: data.delta,
          enqueueDelta,
          startDeltaDrain,
        });
      } else if (
        data.type === "text-replace" &&
        typeof data.text === "string"
      ) {
        handleStreamingTextReplace({
          context: streamingEventHandlerContext,
          text: data.text,
          setAssistantText: input.setAssistantText,
          setLatestAssistantMessageContent:
            input.setLatestAssistantMessageContent,
          setHasRenderedDelta: input.setHasRenderedDelta,
        });
      } else if (data.type === "text-interrupted") {
        handleStreamingTextInterrupted({
          context: streamingEventHandlerContext,
        });
      } else if (isToolCallEvent(data)) {
        handleStreamingToolCallEvent({
          context: streamingEventHandlerContext,
          event: data,
          drainQueuedDeltasNow,
          refreshedArtifactToolIds: input.refreshedArtifactToolIds,
          refreshedWorkfileToolIds: input.refreshedWorkfileToolIds,
          setArtifactsRefreshKey: input.setArtifactsRefreshKey,
          setWorkfilesRefreshKey: input.setWorkfilesRefreshKey,
        });
      } else if (data.type === "thinking-step") {
        handleStreamingThinkingStep({
          context: streamingEventHandlerContext,
          step: data.step,
        });
      } else if (
        data.type === "reasoning" &&
        typeof data.reasoning === "string"
      ) {
        handleStreamingReasoning({
          context: streamingEventHandlerContext,
          reasoning: data.reasoning,
          segment: data.segment,
        });
      } else if (data.type === "citations") {
        handleStreamingCitations({
          context: streamingEventHandlerContext,
          citations: data.citations,
          availableCitations: data.availableCitations,
        });
      } else if (
        data.type === "thread-title-update" &&
        typeof data.threadId === "string" &&
        typeof data.title === "string"
      ) {
        handleStreamingThreadTitleUpdate({
          context: streamingEventHandlerContext,
          threadId: data.threadId,
          title: data.title,
        });
        shouldPollThreadTitle = false;
      } else if (
        data.type === "thread-title-pending" &&
        typeof data.threadId === "string"
      ) {
        handleStreamingThreadTitlePending({
          eventThreadId: data.threadId,
          jobId: data.jobId,
          threadId: input.threadId,
          setShouldPollThreadTitle: (shouldPoll) => {
            shouldPollThreadTitle = shouldPoll;
          },
          setPendingTitleJobId: (jobId) => {
            pendingTitleJobId = jobId;
          },
        });
      } else if (data.type === "error") {
        if (data.code && SILENT_STREAM_ERROR_CODES.has(data.code)) {
          continue;
        }
        sawStreamError = true;
        handleStreamingError({
          event: data,
          persistedUserMessageId: input.getPersistedUserMessageId(),
          markStreamingAssistantAsError: input.markStreamingAssistantAsError,
          setSuppressErrorToast: input.onSuppressErrorToast,
          setStreamError: input.onStreamError,
        });
      } else if (
        data.type === "assistant-message" &&
        typeof data.messageId === "string"
      ) {
        handleStreamingAssistantMessage({
          context: streamingEventHandlerContext,
          messageId: data.messageId,
          parentMessageId: data.parentMessageId,
          userMessageId: data.userMessageId,
          persistedUserMessageId: input.getPersistedUserMessageId(),
          streamingAssistantMessage: input.getStreamingAssistantMessage(),
          streamingAssistantMessageId: input.getStreamingAssistantMessageId(),
          streamingAssistantMessageIds: input.streamingAssistantMessageIds,
          setPersistedAssistantMessageId: input.onPersistedAssistantMessageId,
          setStreamingAssistantMessageId: input.setStreamingAssistantMessageId,
          setStreamingAssistantMessage: input.setStreamingAssistantMessage,
        });
      } else if (data.type === "finish") {
        finishReason = data.finishReason ?? null;
        drainQueuedDeltasNow();
        const finishState = handleStreamingFinish({
          context: streamingEventHandlerContext,
          finishReason,
        });
        receivedFinishEvent = finishState.receivedFinishEvent;
        streamEnded = finishState.streamEnded;
        if (data.finishReason === "tool_confirmation_requested") {
          const liveConfirmations = parseFinishLiveConfirmations(
            data.liveConfirmations,
          );
          input.onToolConfirmationRequested?.({
            assistantMessageId:
              typeof data.messageId === "string" ? data.messageId : null,
            liveConfirmations,
            parentMessageId:
              typeof data.parentMessageId === "string" ||
              data.parentMessageId === null
                ? data.parentMessageId
                : null,
            userMessageId:
              typeof data.userMessageId === "string"
                ? data.userMessageId
                : null,
          });
        }
        break readLoop;
      }
    }
  }

  streamEnded = true;
  if (drainPromise) {
    await drainPromise;
  }
  if (
    receivedFinishEvent &&
    !sawStreamError &&
    shouldPollThreadTitle &&
    pendingTitleJobId
  ) {
    titlePollScheduled = true;
    void pollThreadTitleJob(pendingTitleJobId);
    input.onTitlePollScheduled?.();
  }

  return {
    finishReason,
    receivedFinishEvent,
    streamRenderBuffer,
    titlePollScheduled,
  };
}
