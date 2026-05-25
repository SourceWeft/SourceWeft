"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import {
  isGeneratedImageArtifactToolName,
  type ToolApprovalResume,
} from "@sourceweft/sdk";
import {
  buildByokModelExecution,
  type ByokModelSelection,
} from "../../_components/byok-state";
import { buildChatToolsRequest, type ChatSendInput, type PromptThinkingSettings, type ThinkingStepRecord, type ToolCallRecord } from "../../_components/chat-canvas";
import type { ModelType, SelectedModels } from "../../_components/model-catalog-utils";
import { expandSelectedSources, type SourceItem } from "../../_components/source-types";
import { runChatStream } from "../chat-stream-runner";
import type { RequestThinkingConfig } from "../streaming-request-body";
import type { ChatMessageItem, StreamingAssistantSnapshot } from "../streaming-assistant-state";
import { createStreamingRenderBuffer } from "../streaming-render-buffer";
import {
  appendReasoningChunk,
  createDurableRunKey,
  getDisplayErrorMessage,
  isCompletedImageArtifactToolCall,
  isCompletedWorkfileWriteToolCall,
  mergeThinkingStepRecords,
  normalizeCitationRecords,
  normalizeModelReasoningSegmentRecord,
  normalizeThinkingStepRecord,
  normalizeThreadCommandRequest,
  resolveRenderBlocksFromMetadata,
  resolveThinkingStepsFromMetadata,
  resolveTracePartsFromMetadata,
  resolveTracePartToolConfirmations,
  resolveToolConfirmationCalls,
  resolveToolCallFromStreamEvent,
  resolveToolCallsFromMetadata,
  shouldRenderToolCall,
  STREAM_RENDER_KEY,
  STREAM_TEXT_INTERRUPTED_KEY,
  STREAM_TEXT_PAUSED_KEY,
  throwStreamRequestError,
  toNullableString,
  toObjectRecord,
} from "./message-normalizers";
import {
  resolveMessageEffectiveSourceIds,
  resolveMessageSourceIds,
} from "./message-groups";
import {
  resolveAttachOnlyAssistantMessage,
  resolveClientTimezone,
} from "./thread-utils";
import type { ActiveThreadRun } from "../chat-stream-runner-control";

export type ThreadStreamActionInput = {
  mode: "send" | "refresh" | "edit" | "resume";
  content?: string;
  mentionedSourceIds?: string[];
  sourceIds?: string[];
  skillIds?: string[];
  tools?: ChatSendInput["tools"];
  images?: ChatSendInput["images"];
  command?: ChatSendInput["command"];
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  thinking?: RequestThinkingConfig;
  searchEnabled?: boolean;
  byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
  durableRunKey?: string;
  attachOnly?: boolean;
  baseMessages?: ChatMessageItem[];
  resolvedConfirmationIds?: string[];
  toolApprovalResume?: ToolApprovalResume | null;
};

type UseThreadStreamActionInput = {
  catalogKindEnabled: Record<ModelType, boolean>;
  clearAttachedRunKeyIfCurrent: (durableRunKey: string) => void;
  clearEditingState: () => void;
  clearRunIfCurrent: (durableRunKey: string) => void;
  librarySources: SourceItem[];
  loadThreadMessages: () => Promise<void>;
  markRunStarted: (input: { idempotencyKey: string; status: "running"; mode?: "send" | "refresh" | "edit" | "resume" }) => void;
  markRunTerminal: (input: {
    detachedWithoutFinish: boolean;
    durableRunKey: string;
    waitingForApproval?: boolean;
  }) => void;
  messages: ChatMessageItem[];
  onToolConfirmationRequested?: () => void;
  searchEnabled: boolean;
  selectedByokModels: Partial<Record<ModelType, ByokModelSelection | null>>;
  selectedModels: SelectedModels;
  setArtifactsRefreshKey: (updater: (value: number) => number) => void;
  setComposerInitialInput: (value: string) => void;
  setComposerResetKey: (updater: (value: number) => number) => void;
  setMessages: (updater: (messages: ChatMessageItem[]) => ChatMessageItem[]) => void;
  setStreamingAssistantSnapshot: (snapshot: StreamingAssistantSnapshot | ((current: StreamingAssistantSnapshot | null) => StreamingAssistantSnapshot | null) | null) => void;
  setWorkfilesRefreshKey: (updater: (value: number) => number) => void;
  streamWithSelectedLlm: boolean;
  thinkingSettings: PromptThinkingSettings;
  threadId: string;
  updateChatSourceCount: (threadId: string, sourceCount: number) => void;
  updateChatTitle: (threadId: string, title: string) => void;
  updateActiveRunIfCurrent: (
    durableRunKey: string,
    updater: (run: ActiveThreadRun) => ActiveThreadRun,
  ) => void;
  workspaceId: string | null | undefined;
};

function appendResumeContinuationSeparator(content: string) {
  return content.length > 0 && !content.endsWith("\n")
    ? `${content}\n`
    : content;
}

export function useThreadStreamAction({
  catalogKindEnabled,
  clearAttachedRunKeyIfCurrent,
  clearEditingState,
  clearRunIfCurrent,
  librarySources,
  loadThreadMessages,
  markRunStarted,
  markRunTerminal,
  messages,
  onToolConfirmationRequested,
  searchEnabled,
  selectedByokModels,
  selectedModels,
  setArtifactsRefreshKey,
  setComposerInitialInput,
  setComposerResetKey,
  setMessages,
  setStreamingAssistantSnapshot,
  setWorkfilesRefreshKey,
  streamWithSelectedLlm,
  thinkingSettings,
  threadId,
  updateActiveRunIfCurrent,
  updateChatSourceCount,
  updateChatTitle,
  workspaceId,
}: UseThreadStreamActionInput) {
  const streamThreadAction = useCallback(
    async (input: {
      mode: "send" | "refresh" | "edit" | "resume";
      content?: string;
      mentionedSourceIds?: string[];
      sourceIds?: string[];
      skillIds?: string[];
      tools?: ChatSendInput["tools"];
      images?: ChatSendInput["images"];
      command?: ChatSendInput["command"];
      userMessageId?: string | null;
      assistantMessageId?: string | null;
      thinking?: RequestThinkingConfig;
      searchEnabled?: boolean;
      byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
      durableRunKey?: string;
      attachOnly?: boolean;
      baseMessages?: ChatMessageItem[];
      toolApprovalResume?: ToolApprovalResume | null;
      resolvedConfirmationIds?: string[];
    }) => {
      if (!workspaceId) {
        return;
      }

      const durableRunKey = input.durableRunKey ?? createDurableRunKey();
      markRunStarted({
        idempotencyKey: durableRunKey,
        status: "running",
        mode: input.mode,
      });
      clearEditingState();

      const now = Date.now();
      const messageSnapshot = input.baseMessages ?? messages;
      const latestUserMessage = [...messageSnapshot]
        .reverse()
        .find((message) => message.role === "user");
      const latestAssistantMessage = [...messageSnapshot]
        .reverse()
        .find((message) => message.role === "assistant");
      const attachOnlyAssistantMessage = input.attachOnly
        ? resolveAttachOnlyAssistantMessage({
            assistantMessageId: input.assistantMessageId,
            messages: messageSnapshot,
          })
        : null;

      const temporaryMessages: ChatMessageItem[] = [];
      let tempUserId: string | null = null;
      const temporaryImageParts =
        input.images?.map((image, index) => ({
          type: "image" as const,
          id: `temp-image-${now}-${index}`,
          fileName: image.fileName ?? `image-${index + 1}`,
          mimeType: image.mimeType ?? "image/png",
          sizeBytes: image.sizeBytes ?? 0,
          width: image.width ?? null,
          height: image.height ?? null,
          url: image.dataUrl,
        })) ?? [];

      if (
        !input.attachOnly &&
        (input.mode === "send" || input.mode === "edit")
      ) {
        tempUserId = `temp-user-${now}`;
        const localEffectiveSourceIds = expandSelectedSources(
          librarySources,
          input.sourceIds ?? [],
        ).map((source) => source.id);
        temporaryMessages.push({
          id: tempUserId,
          role: "user",
          content: input.content ?? "",
          contentJson: {
            version: 1,
            parts: [
              ...(input.content?.trim()
                ? [{ type: "text" as const, text: input.content }]
                : []),
              ...temporaryImageParts,
            ],
          },
          parentMessageId:
            input.mode === "edit"
              ? (input.userMessageId ?? latestUserMessage?.id ?? null)
              : null,
          metadata: {
            ...(input.mentionedSourceIds && input.mentionedSourceIds.length > 0
              ? { mentionedSourceIds: input.mentionedSourceIds }
              : {}),
            ...(input.mentionedSourceIds && input.mentionedSourceIds.length > 0
              ? { effectiveMentionedSourceIds: input.mentionedSourceIds }
              : {}),
            ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
            ...(localEffectiveSourceIds.length > 0
              ? { effectiveSourceIds: localEffectiveSourceIds }
              : {}),
            skillIds: input.skillIds ?? [],
            tools: buildChatToolsRequest({
              imageExecution:
                selectedByokModels.image?.mode === "byok"
                  ? buildByokModelExecution({
                      selection: selectedByokModels.image,
                    })
                  : null,
              invokedSkillIds: input.tools?.invokedSkillIds,
              skillIds: input.skillIds ?? [],
              searchEnabled: input.searchEnabled ?? searchEnabled,
              tools: input.tools,
            }),
            ...(input.command ? { command: input.command } : {}),
            versionOf:
              input.mode === "edit"
                ? (input.userMessageId ?? latestUserMessage?.id ?? null)
                : null,
          },
          createdAt: new Date(now).toISOString(),
        });
      }

      const tempAssistantId = `temp-assistant-${now + 1}`;
      const tempAssistantRenderKey = tempAssistantId;
      if (!input.attachOnly) {
        temporaryMessages.push({
          id: tempAssistantId,
          role: "assistant",
          content: "",
          contentJson: {},
          parentMessageId:
            input.mode === "send"
              ? null
              : (input.assistantMessageId ??
                latestAssistantMessage?.id ??
                null),
          metadata: {
            userMessageId:
              tempUserId ??
              input.userMessageId ??
              latestUserMessage?.id ??
              null,
            versionOf:
              input.mode === "send"
                ? null
                : (input.assistantMessageId ??
                  latestAssistantMessage?.id ??
                  null),
            toolCalls: [],
            thinkingSteps: [],
            renderBlocks: [],
            threadRun: {
              idempotencyKey: durableRunKey,
              status: "running",
              mode: input.mode,
            },
            [STREAM_RENDER_KEY]: tempAssistantRenderKey,
          },
          createdAt: new Date(now + 1).toISOString(),
        });
      }

      if (temporaryMessages.length > 0) {
        setMessages((previous) => [...previous, ...temporaryMessages]);
      }

      if (!input.attachOnly && input.mode !== "refresh") {
        setComposerInitialInput("");
        setComposerResetKey((value) => value + 1);
      }

      let persistedUserMessageId = tempUserId ?? input.userMessageId ?? null;
      let createdUserMessageId: string | null = tempUserId;
      let persistedAssistantMessageId: string | null = null;
      let hasServerPersistedAssistantMessage = false;
      const streamToolCallsById = new Map<string, ToolCallRecord>();
      const streamThinkingStepsById = new Map<string, ThinkingStepRecord>();
      const streamRenderBuffer = createStreamingRenderBuffer({
        maxDeltaBatchChars: 800,
      });
      const refreshedWorkfileToolIds = new Set<string>();
      const refreshedArtifactToolIds = new Set<string>();
      let streamingAssistantMessageId = input.attachOnly
        ? (attachOnlyAssistantMessage?.id ??
          input.assistantMessageId ??
          tempAssistantId)
        : tempAssistantId;
      const streamingAssistantMessageIds = new Set<string>([
        streamingAssistantMessageId,
      ]);
      let preparedEffectiveSourceIds: string[] | null = null;
      let assistantText = "";
      let latestAssistantMessageContent = "";
      let streamError: Error | null = null;
      let receivedFinishEvent = false;
      let waitingForApproval = false;
      let detachedWithoutFinish = false;
      let suppressErrorToast = false;
      let streamingAssistantMessage =
        messageSnapshot.find(
          (message) => message.id === streamingAssistantMessageId,
        ) ??
        temporaryMessages.find(
          (message) => message.id === streamingAssistantMessageId,
        ) ??
        attachOnlyAssistantMessage ??
        null;

      if (input.attachOnly && attachOnlyAssistantMessage) {
        const shouldSeedAttachContent = input.mode === "resume";
        const seededAttachContent = shouldSeedAttachContent
          ? appendResumeContinuationSeparator(attachOnlyAssistantMessage.content)
          : "";
        assistantText = shouldSeedAttachContent
          ? seededAttachContent
          : "";
        latestAssistantMessageContent = shouldSeedAttachContent
          ? seededAttachContent
          : attachOnlyAssistantMessage.content;
        resolveToolConfirmationCalls(
          resolveToolCallsFromMetadata(attachOnlyAssistantMessage.metadata),
          input.resolvedConfirmationIds,
          input.toolApprovalResume,
        ).forEach((toolCall) => {
            streamToolCallsById.set(toolCall.id, toolCall);
          });
        const traceParts = resolveTracePartToolConfirmations(
          resolveTracePartsFromMetadata(attachOnlyAssistantMessage.metadata),
          input.resolvedConfirmationIds,
          input.toolApprovalResume,
        );
        resolveThinkingStepsFromMetadata(
          attachOnlyAssistantMessage.metadata,
        ).forEach((step) => {
          streamThinkingStepsById.set(step.id, step);
        });
        const existingRenderBlocks = resolveRenderBlocksFromMetadata(
          attachOnlyAssistantMessage.metadata,
        );
        streamRenderBuffer.replaceRenderBlocks(
          existingRenderBlocks.length > 0
            ? existingRenderBlocks
            : shouldSeedAttachContent &&
                seededAttachContent.length > 0
              ? [
                  {
                    id: `stream-text-${attachOnlyAssistantMessage.id}`,
                    type: "text" as const,
                    text: seededAttachContent,
                  },
                ]
              : [],
        );
        if (
          existingRenderBlocks.length > 0 &&
          seededAttachContent.length > attachOnlyAssistantMessage.content.length
        ) {
          streamRenderBuffer.appendText(
            seededAttachContent.slice(attachOnlyAssistantMessage.content.length),
          );
        }
        if (shouldSeedAttachContent || traceParts.length > 0) {
          const nextMetadata = { ...attachOnlyAssistantMessage.metadata };
          if (shouldSeedAttachContent) {
            nextMetadata.renderBlocks = streamRenderBuffer.snapshotRenderBlocks();
          }
          if (traceParts.length > 0) {
            nextMetadata.traceParts = traceParts;
            nextMetadata.toolCalls = [...streamToolCallsById.values()].filter(
              (toolCall) =>
                shouldRenderToolCall(toolCall, [
                  ...streamThinkingStepsById.values(),
                ]),
            );
          }
          streamingAssistantMessage = {
            ...attachOnlyAssistantMessage,
            content: shouldSeedAttachContent
              ? seededAttachContent
              : attachOnlyAssistantMessage.content,
            metadata: nextMetadata,
          };
        }
      }

      if (streamingAssistantMessage) {
        setStreamingAssistantSnapshot({
          message: streamingAssistantMessage,
          messageId: streamingAssistantMessage.id,
          messageIds: Array.from(streamingAssistantMessageIds),
          renderVersion: 0,
        });
      }

      const updateStreamingAssistantMessage = (
        updater: (message: ChatMessageItem) => ChatMessageItem,
      ) => {
        if (!streamingAssistantMessage) {
          return;
        }
        streamingAssistantMessage = updater(streamingAssistantMessage);
        setStreamingAssistantSnapshot((current) => ({
          message: streamingAssistantMessage as ChatMessageItem,
          messageId: streamingAssistantMessageId,
          messageIds: Array.from(streamingAssistantMessageIds),
          renderVersion: (current?.renderVersion ?? 0) + 1,
        }));
      };

      const commitStreamingAssistantMessage = () => {
        const committedMessage = streamingAssistantMessage;
        if (!committedMessage) {
          setStreamingAssistantSnapshot(null);
          return;
        }
        streamingAssistantMessageIds.add(streamingAssistantMessageId);
        streamingAssistantMessageIds.add(committedMessage.id);
        setMessages((previous) => {
          let found = false;
          let inserted = false;
          const next: ChatMessageItem[] = [];
          for (const message of previous) {
            if (!streamingAssistantMessageIds.has(message.id)) {
              next.push(message);
              continue;
            }
            found = true;
            if (!inserted) {
              next.push(committedMessage);
              inserted = true;
            }
          }
          return found ? next : [...next, committedMessage];
        });
        setStreamingAssistantSnapshot(null);
      };

      const drainQueuedDeltasNow = () => {
        if (!streamRenderBuffer.hasQueuedDeltas()) {
          latestAssistantMessageContent =
            streamingAssistantMessage?.content ?? assistantText;
          return;
        }

        const nextDelta = streamRenderBuffer.drainQueuedDeltas();
        assistantText += nextDelta;
        streamRenderBuffer.appendText(nextDelta);
        latestAssistantMessageContent = assistantText;
        updateStreamingAssistantMessage((message) => ({
          ...message,
          content: assistantText,
          metadata: {
            ...message.metadata,
            renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
            threadRun: {
              ...(toObjectRecord(message.metadata.threadRun) ?? {}),
              idempotencyKey: durableRunKey,
              status: "running",
              mode: input.mode,
            },
          },
        }));
      };

      const markStreamingAssistantAsError = (errorInput: {
        code?: string | null;
        error: string;
        messageId?: string | null;
        parentMessageId?: string | null;
        parentMessageIdProvided?: boolean;
        serverPersisted?: boolean;
        userMessageId?: string | null;
      }) => {
        drainQueuedDeltasNow();
        if (streamToolCallsById.size > 0) {
          for (const [toolId, toolCall] of streamToolCallsById.entries()) {
            if (
              toolCall.status === "running" ||
              toolCall.status === "approval_requested"
            ) {
              streamToolCallsById.set(toolId, {
                ...toolCall,
                status: "error",
                error: toolCall.error ?? "Tool execution failed.",
              });
            }
          }
        }
        if (streamThinkingStepsById.size > 0) {
          for (const [stepId, step] of streamThinkingStepsById.entries()) {
            if (step.status === "in_progress") {
              streamThinkingStepsById.set(stepId, {
                ...step,
                status: "completed",
              });
            }
          }
        }

        const previousAssistantMessageId = streamingAssistantMessageId;
        const messageId = errorInput.messageId || previousAssistantMessageId;
        streamingAssistantMessageIds.add(previousAssistantMessageId);
        streamingAssistantMessageIds.add(messageId);
        const userMessageId =
          errorInput.userMessageId ?? persistedUserMessageId;
        const isClientCancelled = errorInput.code === "CLIENT_CANCELLED";
        persistedAssistantMessageId = messageId;
        hasServerPersistedAssistantMessage =
          errorInput.serverPersisted === true;
        streamingAssistantMessageId = messageId;
        if (
          streamingAssistantMessage &&
          streamingAssistantMessage.id !== previousAssistantMessageId
        ) {
          streamingAssistantMessage = {
            ...streamingAssistantMessage,
            id: previousAssistantMessageId,
          };
        }
        updateStreamingAssistantMessage((message) => ({
          ...message,
          id: messageId,
          content: latestAssistantMessageContent,
          parentMessageId:
            errorInput.parentMessageIdProvided === true
              ? (errorInput.parentMessageId ?? null)
              : message.parentMessageId,
          metadata: {
            ...message.metadata,
            isError: !isClientCancelled,
            isCancelled: isClientCancelled,
            excludeFromContext: true,
            error: errorInput.error,
            errorCode: errorInput.code ?? null,
            userMessageId,
            sourceUserMessageId: userMessageId,
            [STREAM_TEXT_PAUSED_KEY]: false,
            [STREAM_TEXT_INTERRUPTED_KEY]: false,
            toolCalls: [...streamToolCallsById.values()].filter((toolCall) =>
              shouldRenderToolCall(toolCall, [
                ...streamThinkingStepsById.values(),
              ]),
            ),
            thinkingSteps: [...streamThinkingStepsById.values()],
            renderBlocks: streamRenderBuffer.snapshotRenderBlocks(),
            threadRun: {
              ...(toObjectRecord(message.metadata.threadRun) ?? {}),
              idempotencyKey: durableRunKey,
              status: isClientCancelled ? "cancelled" : "failed",
              mode: input.mode,
            },
          },
        }));
        commitStreamingAssistantMessage();
      };

      try {
        const streamResult = await runChatStream({
          appendReasoningChunk,
          attachOnly: input.attachOnly,
          byokSelections: input.byokSelections,
          catalogKindEnabled,
          command: input.command,
          content: input.content,
          durableRunKey,
          getAssistantText: () => assistantText,
          getPersistedUserMessageId: () => persistedUserMessageId,
          getStreamingAssistantMessage: () => streamingAssistantMessage,
          getStreamingAssistantMessageId: () => streamingAssistantMessageId,
          images: input.images,
          assistantMessageId: input.assistantMessageId,
          isCompletedImageArtifactToolCall,
          isCompletedWorkfileWriteToolCall,
          isGeneratedImageArtifactToolName,
          markStreamingAssistantAsError,
          mergeThinkingStepRecords,
          mode: input.mode,
          mentionedSourceIds: input.mentionedSourceIds,
          normalizeCitationRecords,
          normalizeModelReasoningSegmentRecord,
          normalizeThinkingStepRecord,
          normalizeThreadCommandRequest,
          onCreatedUserMessageId: (messageId) => {
            if (createdUserMessageId === tempUserId) {
              createdUserMessageId = messageId;
            }
          },
          onToolConfirmationRequested,
          onPersistedAssistantMessageId: (messageId) => {
            persistedAssistantMessageId = messageId;
            updateActiveRunIfCurrent(durableRunKey, (run) => ({
              ...run,
              assistantMessageId: messageId,
            }));
          },
          onPersistedUserMessageId: (messageId) => {
            persistedUserMessageId = messageId;
            updateActiveRunIfCurrent(durableRunKey, (run) => ({
              ...run,
              userMessageId: messageId,
            }));
          },
          onPreparedEffectiveSourceIds: (sourceIds) => {
            preparedEffectiveSourceIds = sourceIds;
          },
          onPreparedThreadRun: (threadRun) => {
            updateActiveRunIfCurrent(durableRunKey, (run) => ({
              ...run,
              id: toNullableString(threadRun.id) ?? run.id,
              mode:
                threadRun.mode === "send" ||
                threadRun.mode === "refresh" ||
                threadRun.mode === "edit" ||
                threadRun.mode === "resume"
                  ? threadRun.mode
                  : run.mode,
              approvalRequestedAt:
                toNullableString(threadRun.approvalRequestedAt) ??
                run.approvalRequestedAt,
              approvalExpiresAt:
                toNullableString(threadRun.approvalExpiresAt) ??
                run.approvalExpiresAt,
            }));
          },
          onStreamError: (error) => {
            streamError = error;
          },
          onSuppressErrorToast: (nextSuppressErrorToast) => {
            suppressErrorToast = nextSuppressErrorToast;
          },
          refreshedArtifactToolIds,
          refreshedWorkfileToolIds,
          resolveToolCallFromStreamEvent,
          searchEnabled: input.searchEnabled ?? searchEnabled,
          selectedByokModels,
          selectedModels,
          setArtifactsRefreshKey,
          setAssistantText: (text) => {
            assistantText = text;
          },
          setHasRenderedDelta: () => {},
          setLatestAssistantMessageContent: (content) => {
            latestAssistantMessageContent = content;
          },
          setMessages,
          setStreamingAssistantMessage: (message) => {
            streamingAssistantMessage = message;
          },
          setStreamingAssistantMessageId: (messageId) => {
            streamingAssistantMessageId = messageId;
          },
          setWorkfilesRefreshKey,
          shouldRenderToolCall,
          skillIds: input.skillIds,
          sourceIds: input.sourceIds,
          streamRenderBuffer,
          streamThinkingStepsById,
          streamToolCallsById,
          streamWithSelectedLlm,
          streamingAssistantMessageIds,
          tempUserId,
          thinking: input.thinking,
          toolApprovalResume: input.toolApprovalResume,
          thinkingSettings,
          threadId,
          throwStreamRequestError,
          timezone: resolveClientTimezone(),
          toNullableString,
          toObjectRecord,
          tools: input.tools,
          updateChatTitle,
          updateStreamingAssistantMessage,
          userMessageId: input.userMessageId,
          workspaceId,
        });
        receivedFinishEvent = streamResult.receivedFinishEvent;
        waitingForApproval =
          streamResult.finishReason === "tool_confirmation_requested";

        commitStreamingAssistantMessage();

        if (streamError) {
          throw streamError;
        }
        if (!receivedFinishEvent) {
          detachedWithoutFinish = true;
          return;
        }

        if (waitingForApproval) {
          if (persistedAssistantMessageId) {
            updateActiveRunIfCurrent(durableRunKey, (run) => ({
              ...run,
              assistantMessageId: persistedAssistantMessageId,
              status: "waiting_for_approval",
            }));
          }
          clearAttachedRunKeyIfCurrent(durableRunKey);
          return;
        }

        const usedSourceIds = new Set(input.sourceIds ?? []);
        messages.forEach((message) => {
          const messageSourceIds =
            resolveMessageEffectiveSourceIds(message) ??
            expandSelectedSources(
              librarySources,
              resolveMessageSourceIds(message),
            ).map((source) => source.id);
          messageSourceIds.forEach((sourceId) => {
            usedSourceIds.add(sourceId);
          });
        });
        const currentEffectiveSourceIds =
          preparedEffectiveSourceIds ??
          expandSelectedSources(librarySources, input.sourceIds ?? []).map(
            (source) => source.id,
          );
        currentEffectiveSourceIds.forEach((sourceId) => {
          usedSourceIds.add(sourceId);
        });
        updateChatSourceCount(threadId, usedSourceIds.size);

        setWorkfilesRefreshKey((value) => value + 1);
        if (refreshedArtifactToolIds.size > 0) {
          setArtifactsRefreshKey((value) => value + 1);
        }
        clearRunIfCurrent(durableRunKey);
        clearAttachedRunKeyIfCurrent(durableRunKey);
      } catch (error) {
        const errorMessage = getDisplayErrorMessage(error);
        const hadServerPersistedAssistantMessage =
          hasServerPersistedAssistantMessage;
        const existingPersistedAssistantMessageId = persistedAssistantMessageId;
        const hasServerUserMessage =
          persistedUserMessageId !== null &&
          !persistedUserMessageId.startsWith("temp-user-");

        if (
          !existingPersistedAssistantMessageId &&
          (hasServerUserMessage || input.attachOnly)
        ) {
          markStreamingAssistantAsError({
            error: errorMessage,
            userMessageId: persistedUserMessageId,
          });
        }

        if (!existingPersistedAssistantMessageId) {
          if (hasServerUserMessage) {
            window.setTimeout(() => {
              void loadThreadMessages();
            }, 750);
          } else {
            setMessages((previous) => {
              const withoutFailedTemporaryMessages = previous.filter(
                (message) =>
                  !streamingAssistantMessageIds.has(message.id) &&
                  message.id !== streamingAssistantMessage?.id &&
                  (!createdUserMessageId ||
                    message.id !== createdUserMessageId),
              );
              return withoutFailedTemporaryMessages;
            });
            setStreamingAssistantSnapshot(null);
            if (
              !input.attachOnly &&
              input.mode === "send" &&
              typeof input.content === "string"
            ) {
              setComposerInitialInput(input.content);
              setComposerResetKey((value) => value + 1);
            }
          }
        } else if (hadServerPersistedAssistantMessage) {
          window.setTimeout(() => {
            void loadThreadMessages();
          }, 0);
        }

        if (!suppressErrorToast) {
          toast.error(errorMessage);
        }
      } finally {
        markRunTerminal({
          detachedWithoutFinish,
          durableRunKey,
          waitingForApproval,
        });
      }
    },
    [
      catalogKindEnabled,
      clearAttachedRunKeyIfCurrent,
      clearEditingState,
      clearRunIfCurrent,
      librarySources,
      loadThreadMessages,
      markRunStarted,
      markRunTerminal,
      messages,
      onToolConfirmationRequested,
      searchEnabled,
      selectedByokModels,
      selectedModels,
      setArtifactsRefreshKey,
      setComposerInitialInput,
      setComposerResetKey,
      setMessages,
      setStreamingAssistantSnapshot,
      setWorkfilesRefreshKey,
      streamWithSelectedLlm,
      threadId,
      thinkingSettings,
      updateChatSourceCount,
      updateChatTitle,
      updateActiveRunIfCurrent,
      workspaceId,
    ],
  );



  return { streamThreadAction };
}
