import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { FileUIPart } from "ai";
import type { ToolApprovalResume } from "@sourceweft/sdk";
import type { PromptInputMentionSourceLoader } from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import {
  trackChatMessageSent,
  trackSkillSelected,
  trackSourceAttached,
} from "../../../../../lib/analytics-events";
import type { SourceItem } from "../source-types";
import { Composer } from "./composer";
import { EmptyState } from "./empty-state";
import { MessageList } from "./message-list";
import { getMessageImageParts, normalizeAssetUrl } from "./message-assets";
import { ToolInterventionBar } from "./tool-confirmation";
import type {
  ActiveThreadRun,
  ChatExecutionState,
} from "../../[threadId]/chat-stream-runner-control";
import {
  getLiveToolConfirmationItemsForRun,
  getPendingToolConfirmationItems,
  getToolConfirmationItemsForRun,
  shouldLockComposerForRun,
} from "./tool-confirmation-state";
import {
  activateFirstPendingToolConfirmation,
  getToolConfirmationRunKey,
  initialToolConfirmationControllerState,
  markToolConfirmationTerminal,
  settleToolConfirmationDecision,
  stopToolConfirmationRun,
  syncToolConfirmationRun,
  type ToolConfirmationControllerState,
} from "./tool-confirmation-controller";
import type {
  AssistantVersionIndexEntry,
  ArtifactPreviewRecord,
  ArtifactStatusSnapshot,
  ChatSendInput,
  ChatMessageImagePart,
  ChatSkillItem,
  ChatToolName,
  CitationRecord,
  ImageModelCapabilities,
  PromptThinkingCapabilities,
  PromptThinkingSettings,
  ToolConfirmationInterventionSignal,
  VersionedMessageGroup,
} from "./types";

type PromptImageMimeType = NonNullable<
  NonNullable<ChatSendInput["images"]>[number]["mimeType"]
>;

function normalizePromptImageMediaType(
  value: string | undefined,
): PromptImageMimeType | undefined {
  if (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif"
  ) {
    return value;
  }
  return undefined;
}

function promptFilesToImages(files: FileUIPart[] | undefined) {
  return (files ?? [])
    .filter(
      (file) =>
        file.type === "file" &&
        file.mediaType?.startsWith("image/") &&
        typeof file.url === "string" &&
        file.url.startsWith("data:"),
    )
    .map((file) => ({
      dataUrl: file.url,
      fileName: file.filename,
      mimeType: normalizePromptImageMediaType(file.mediaType),
    }));
}

function messageImagesToInitialAttachments(
  images: ChatMessageImagePart[],
): (FileUIPart & { id: string })[] {
  return images.map((image) => ({
    filename: image.fileName,
    id: image.id,
    mediaType: image.mimeType,
    type: "file" as const,
    url: normalizeAssetUrl(image.url),
  }));
}

function countSelectedTools(tools: ChatSendInput["tools"]) {
  if (!tools) {
    return 0;
  }

  return Object.values(tools).filter((value) => {
    if (!value || typeof value !== "object") {
      return Boolean(value);
    }

    if ("enabled" in value && value.enabled === false) {
      return false;
    }

    return true;
  }).length;
}

export function ChatCanvas({
  activeVersionByGroup = {},
  artifactStatuses,
  composerInitialCommand = null,
  composerInitialInput,
  composerResetKey,
  editingMessageId = null,
  highlightedMessageId = null,
  hasOlderMessages = false,
  activeThreadRun = null,
  chatExecutionState,
  isEditing = false,
  isLoadingOlderMessages = false,
  isStreaming = false,
  isStopping = false,
  messageGroups = [],
  assistantVersionById,
  mode,
  sourcesVisible,
  threadTitle,
  onActiveVersionChange,
  onArtifactPreview,
  onCancelEditing,
  onCitationClick,
  onLoadOlderMessages,
  onReloadMessages,
  onSourcePreview,
  onWorkfileClick,
  onRestartFromMessage,
  onRefreshLatest,
  onResumeToolConfirmation,
  onSendMessage,
  onStopStreaming,
  allSources = [],
  sourceMentionLoader,
  selectedSources = [],
  availableSkills = [],
  selectedSkillIds = [],
  selectedMcpInstallIds = [],
  selectedMcpToolIds = [],
  onRemoveSource,
  onSkillSelectionChange,
  searchEnabled,
  onSearchEnabledChange,
  workspaceId,
  thinkingCapabilities,
  thinkingSettings,
  toolConfirmationInterventionSignal = null,
  onThinkingSettingsChange,
  imageCapabilities,
  imageModelAvailable,
  imageModelAlias,
  notionConnectorId = null,
  disabledToolNames = [],
  onDisabledToolNamesChange,
}: {
  activeVersionByGroup?: Record<string, number>;
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  activeThreadRun?: ActiveThreadRun | null;
  chatExecutionState?: ChatExecutionState;
  composerInitialCommand?: ChatSendInput["command"] | null;
  composerInitialInput?: string;
  composerResetKey?: number;
  editingMessageId?: string | null;
  highlightedMessageId?: string | null;
  hasOlderMessages?: boolean;
  isEditing?: boolean;
  isLoadingOlderMessages?: boolean;
  isStreaming?: boolean;
  isStopping?: boolean;
  messageGroups?: VersionedMessageGroup[];
  assistantVersionById?: ReadonlyMap<string, AssistantVersionIndexEntry>;
  mode: "thread" | "new";
  sourcesVisible: boolean;
  threadTitle: string;
  onActiveVersionChange?: (input: {
    groupId: string;
    branchIndex: number;
  }) => void;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  onCancelEditing?: () => void;
  onCitationClick?: (citation: CitationRecord) => void;
  onLoadOlderMessages?: () => void;
  onReloadMessages?: () => Promise<void> | void;
  onSourcePreview?: (source: SourceItem) => void;
  onWorkfileClick?: (path: string) => void;
  onRestartFromMessage?: (input: {
    groupId: string;
    messageId: string;
    message: string;
    assistantMessageId: string | null;
    branchIndex: number;
  }) => void;
  onRefreshLatest?: (input: {
    groupId: string;
    assistantMessageId: string;
    branchIndex: number;
  }) => void;
  onResumeToolConfirmation?: (input: {
    assistantMessageId: string;
    resolvedConfirmationIds: string[];
    toolApprovalResume: ToolApprovalResume;
  }) => void;
  onSendMessage?: (
    input: ChatSendInput,
    options?: { allowWhileStreaming?: boolean },
  ) => void;
  onStopStreaming?: () => void;
  allSources?: SourceItem[];
  sourceMentionLoader?: PromptInputMentionSourceLoader;
  selectedSources?: SourceItem[];
  availableSkills?: ChatSkillItem[];
  selectedSkillIds?: string[];
  selectedMcpInstallIds?: string[];
  selectedMcpToolIds?: string[];
  onRemoveSource?: (id: string) => void;
  onSkillSelectionChange?: (skillIds: string[]) => void;
  searchEnabled?: boolean;
  onSearchEnabledChange?: (enabled: boolean) => void;
  workspaceId?: string | null;
  thinkingCapabilities?: PromptThinkingCapabilities;
  thinkingSettings?: PromptThinkingSettings;
  toolConfirmationInterventionSignal?: ToolConfirmationInterventionSignal | null;
  onThinkingSettingsChange?: (settings: PromptThinkingSettings) => void;
  imageCapabilities?: ImageModelCapabilities;
  imageModelAvailable?: boolean;
  imageModelAlias?: string | null;
  notionConnectorId?: string | null;
  disabledToolNames?: ChatToolName[];
  onDisabledToolNamesChange?: (toolNames: ChatToolName[]) => void;
}) {
  void sourcesVisible;
  const lastTrackedSkillCountRef = useRef(selectedSkillIds.length);
  const lastTrackedSourceCountRef = useRef(selectedSources.length);
  const editingInitialAttachments = useMemo(() => {
    if (!isEditing || !editingMessageId) {
      return [];
    }

    for (const group of messageGroups) {
      if (group.role !== "user") {
        continue;
      }

      const matchingVersion = group.versions.find(
        (version) => version.id === editingMessageId,
      );
      if (!matchingVersion) {
        continue;
      }

      const images = getMessageImageParts(matchingVersion);
      if (images.length > 0) {
        return messageImagesToInitialAttachments(images);
      }
    }

    return [];
  }, [editingMessageId, isEditing, messageGroups]);
  const [toolConfirmationState, setToolConfirmationState] =
    useState<ToolConfirmationControllerState>(
      initialToolConfirmationControllerState,
    );
  const toolConfirmationStateRef = useRef<ToolConfirmationControllerState>(
    initialToolConfirmationControllerState,
  );
  const missingAssistantMessageRefreshKeyRef = useRef<string | null>(null);
  const reportedMissingAssistantRunKeyRef = useRef<string | null>(null);
  const handledInterventionSignalIdRef = useRef<string | null>(null);
  const toolConfirmationLookup = useMemo(
    () =>
      getToolConfirmationItemsForRun({
        activeThreadRun,
        assistantVersionById: assistantVersionById ?? new Map(),
      }),
    [activeThreadRun, assistantVersionById],
  );
  const liveConfirmationItems = useMemo(
    () =>
      getLiveToolConfirmationItemsForRun({
        activeThreadRun,
        signal: toolConfirmationInterventionSignal,
      }),
    [activeThreadRun, toolConfirmationInterventionSignal],
  );
  const activeConfirmationItems =
    liveConfirmationItems.length > 0
      ? liveConfirmationItems
      : toolConfirmationLookup.items;
  const toolConfirmationRunKey = getToolConfirmationRunKey(activeThreadRun);
  const confirmationResolutions = toolConfirmationState.resolutions;
  const activeIntervention = toolConfirmationState.activeIntervention;
  const pendingConfirmationItems = useMemo(
    () =>
      getPendingToolConfirmationItems(
        activeConfirmationItems,
        confirmationResolutions,
      ),
    [activeConfirmationItems, confirmationResolutions],
  );
  const isWaitingForApproval =
    activeThreadRun?.status === "waiting_for_approval";
  const hasPendingConfirmationItems = pendingConfirmationItems.length > 0;
  const isSubmitDisabledForRun = shouldLockComposerForRun({
    chatExecutionState,
    isStreaming,
    isWaitingForApproval,
    pendingConfirmationCount: pendingConfirmationItems.length,
  });

  const applyToolConfirmationState = useCallback(
    function applyToolConfirmationState(
      nextState: ToolConfirmationControllerState,
    ) {
      toolConfirmationStateRef.current = nextState;
      setToolConfirmationState(nextState);
      return nextState;
    },
    [],
  );

  const updateToolConfirmationState = useCallback(
    function updateToolConfirmationState(
      updater: (
        state: ToolConfirmationControllerState,
      ) => ToolConfirmationControllerState,
    ) {
      return applyToolConfirmationState(
        updater(toolConfirmationStateRef.current),
      );
    },
    [applyToolConfirmationState],
  );

  useEffect(() => {
    updateToolConfirmationState((current) =>
      syncToolConfirmationRun({
        items: activeConfirmationItems,
        runKey: toolConfirmationRunKey,
        state: current,
      }),
    );
  }, [
    activeConfirmationItems,
    toolConfirmationRunKey,
    updateToolConfirmationState,
  ]);

  useEffect(() => {
    if (liveConfirmationItems.length > 0) {
      return;
    }
    if (toolConfirmationLookup.reason === "missing_assistant_message") {
      const runKey =
        activeThreadRun?.id ?? activeThreadRun?.idempotencyKey ?? "unknown";
      if (reportedMissingAssistantRunKeyRef.current !== runKey) {
        reportedMissingAssistantRunKeyRef.current = runKey;
        console.error(
          "Confirmation run is missing assistant message.",
          activeThreadRun,
        );
      }
      if (onReloadMessages) {
        void Promise.resolve(onReloadMessages()).catch((error) => {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to reload thread messages.";
          toast.error(message);
        });
      }
      return;
    }

    if (toolConfirmationLookup.reason !== "assistant_message_not_found") {
      return;
    }

    const refreshKey = `${activeThreadRun?.id ?? activeThreadRun?.idempotencyKey ?? "unknown"}:${toolConfirmationLookup.assistantMessageId}`;
    if (missingAssistantMessageRefreshKeyRef.current === refreshKey) {
      console.error(
        "Confirmation assistant message was not found after refresh.",
        {
          activeThreadRun,
          assistantMessageId: toolConfirmationLookup.assistantMessageId,
        },
      );
      toast.error(
        "Confirmation message is missing. Refresh the thread and try again.",
      );
      return;
    }

    missingAssistantMessageRefreshKeyRef.current = refreshKey;
    if (!onReloadMessages) {
      console.error(
        "Confirmation assistant message was not found and no reload handler is available.",
        {
          activeThreadRun,
          assistantMessageId: toolConfirmationLookup.assistantMessageId,
        },
      );
      toast.error(
        "Confirmation message is missing. Refresh the thread and try again.",
      );
      return;
    }

    void Promise.resolve(onReloadMessages()).catch((error) => {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to reload thread messages.";
      toast.error(message);
    });
  }, [
    activeThreadRun,
    liveConfirmationItems.length,
    onReloadMessages,
    toolConfirmationLookup,
  ]);

  useEffect(() => {
    if (
      !toolConfirmationInterventionSignal ||
      handledInterventionSignalIdRef.current ===
        toolConfirmationInterventionSignal.id ||
      pendingConfirmationItems.length === 0
    ) {
      return;
    }
    const next = pendingConfirmationItems[0];
    if (!next) {
      return;
    }
    handledInterventionSignalIdRef.current =
      toolConfirmationInterventionSignal.id;
    updateToolConfirmationState((current) =>
      activateFirstPendingToolConfirmation({
        items: activeConfirmationItems,
        state: current,
      }),
    );
  }, [
    activeConfirmationItems,
    pendingConfirmationItems,
    toolConfirmationInterventionSignal,
    updateToolConfirmationState,
  ]);

  useEffect(() => {
    if (
      selectedSources.length > 0 &&
      selectedSources.length !== lastTrackedSourceCountRef.current
    ) {
      trackSourceAttached(selectedSources.length);
    }
    lastTrackedSourceCountRef.current = selectedSources.length;
  }, [selectedSources.length]);

  function handleSendMessage(input: ChatSendInput) {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }
    const sourceCount =
      input.mentionedSourceIds?.length ?? selectedSources.length;
    const skillCount = input.skillIds?.length ?? selectedSkillIds.length;
    trackChatMessageSent({
      commandUsed: Boolean(input.command),
      hasImages: Boolean(input.images?.length),
      hasSources: sourceCount > 0,
      skillCount,
      sourceCount,
      surface: mode === "new" ? "empty_state" : "thread",
      toolCount: countSelectedTools(input.tools),
    });
    if (isWaitingForApproval && !hasPendingConfirmationItems) {
      onStopStreaming?.();
    }
    onSendMessage?.(input, {
      allowWhileStreaming: isWaitingForApproval && !hasPendingConfirmationItems,
    });
  }

  function handleRemoveSource(id: string) {
    lastTrackedSourceCountRef.current = Math.max(selectedSources.length - 1, 0);
    onRemoveSource?.(id);
  }

  function handleSkillSelectionChange(skillIds: string[]) {
    if (
      skillIds.length > 0 &&
      skillIds.length !== lastTrackedSkillCountRef.current
    ) {
      trackSkillSelected(skillIds.length);
    }
    lastTrackedSkillCountRef.current = skillIds.length;
    onSkillSelectionChange?.(skillIds);
  }

  if (mode === "new") {
    return (
      <EmptyState
        composerInitialInput={composerInitialInput}
        composerResetKey={composerResetKey}
        allSources={allSources}
        sourceMentionLoader={sourceMentionLoader}
        onRemoveSource={handleRemoveSource}
        onSkillSelectionChange={handleSkillSelectionChange}
        onSearchEnabledChange={onSearchEnabledChange}
        onSendMessage={handleSendMessage}
        onThinkingSettingsChange={onThinkingSettingsChange}
        searchEnabled={searchEnabled}
        availableSkills={availableSkills}
        selectedSkillIds={selectedSkillIds}
        selectedMcpInstallIds={selectedMcpInstallIds}
        selectedMcpToolIds={selectedMcpToolIds}
        selectedSources={selectedSources}
        thinkingCapabilities={thinkingCapabilities}
        thinkingSettings={thinkingSettings}
        imageCapabilities={imageCapabilities}
        imageModelAvailable={imageModelAvailable}
        imageModelAlias={imageModelAlias}
        notionConnectorId={notionConnectorId}
        disabledToolNames={disabledToolNames}
        onDisabledToolNamesChange={onDisabledToolNamesChange}
      />
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background [scrollbar-gutter:stable]">
      <MessageList
        activeThreadRun={activeThreadRun}
        activeVersionByGroup={activeVersionByGroup}
        artifactStatuses={artifactStatuses}
        allSources={allSources}
        hasOlderMessages={hasOlderMessages}
        highlightedMessageId={highlightedMessageId}
        isLoadingOlderMessages={isLoadingOlderMessages}
        isStreaming={isStreaming}
        messageGroups={messageGroups}
        onActiveVersionChange={onActiveVersionChange}
        onArtifactPreview={onArtifactPreview}
        onCitationClick={onCitationClick}
        onLoadOlderMessages={onLoadOlderMessages}
        onRefreshLatest={onRefreshLatest}
        onRestartFromMessage={onRestartFromMessage}
        onSourcePreview={onSourcePreview}
        onWorkfileClick={onWorkfileClick}
        resolvedConfirmations={confirmationResolutions}
        workspaceId={workspaceId}
      />

      <ToolInterventionBar
        activeIntervention={activeIntervention}
        activeThreadRun={activeThreadRun}
        items={activeConfirmationItems}
        onInterventionSettled={({ decision, result, item }) => {
          const settled = settleToolConfirmationDecision({
            decision,
            item,
            items: activeConfirmationItems,
            resume: result.resume,
            state: toolConfirmationStateRef.current,
          });
          applyToolConfirmationState(settled.state);

          if (settled.missingResume) {
            toast.error("Confirmation response did not include resume data.");
            return;
          }

          if (!settled.resumeEffect) {
            return;
          }

          if (!onResumeToolConfirmation) {
            toast.error("Tool confirmation resume handler is not available.");
            return;
          }

          onResumeToolConfirmation(settled.resumeEffect);
        }}
        onInterventionExpired={({ item }) => {
          updateToolConfirmationState((current) =>
            markToolConfirmationTerminal({
              item,
              items: activeConfirmationItems,
              reason: "expired",
              state: current,
            }),
          );
          if (!onReloadMessages) {
            return;
          }
          void Promise.resolve(onReloadMessages()).catch((error) => {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to reload thread messages.";
            toast.error(message);
          });
        }}
        onInterventionStale={({ item }) => {
          updateToolConfirmationState((current) =>
            markToolConfirmationTerminal({
              item,
              items: activeConfirmationItems,
              reason: "stale",
              state: current,
            }),
          );
          if (!onReloadMessages) {
            return;
          }
          void Promise.resolve(onReloadMessages()).catch((error) => {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to reload thread messages.";
            toast.error(message);
          });
        }}
        onStopWaiting={() => {
          updateToolConfirmationState((current) =>
            stopToolConfirmationRun({
              items: activeConfirmationItems,
              state: current,
            }),
          );
          onStopStreaming?.();
          if (!onReloadMessages) {
            return;
          }
          void Promise.resolve(onReloadMessages()).catch((error) => {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to reload thread messages.";
            toast.error(message);
          });
        }}
        resolvedConfirmations={confirmationResolutions}
        workspaceId={workspaceId}
      />

      <div className="border-t border-border/60 bg-background/95 px-6 py-5 backdrop-blur">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <Composer
            className="w-full"
            allSources={allSources}
            sourceMentionLoader={sourceMentionLoader}
            submitDisabled={isSubmitDisabledForRun}
            isStopping={isStopping}
            initialAttachments={editingInitialAttachments}
            initialCommand={composerInitialCommand}
            initialInput={composerInitialInput}
            isEditing={isEditing}
            inputKey={threadTitle + "-" + (composerResetKey ?? 0)}
            onCancelEditing={onCancelEditing}
            onRemoveSource={handleRemoveSource}
            onSkillSelectionChange={handleSkillSelectionChange}
            onSearchEnabledChange={onSearchEnabledChange}
            onSubmit={(message, tools, command, skillIds, content) =>
              handleSendMessage({
                content: content ?? message.text.trim(),
                images: promptFilesToImages(message.files),
                mentionedSourceIds: message.mentionedSourceIds,
                skillIds,
                tools,
                command,
              })
            }
            onStopStreaming={onStopStreaming}
            onThinkingSettingsChange={onThinkingSettingsChange}
            searchEnabled={searchEnabled}
            availableSkills={availableSkills}
            selectedSkillIds={selectedSkillIds}
            selectedMcpInstallIds={selectedMcpInstallIds}
            selectedMcpToolIds={selectedMcpToolIds}
            selectedSources={selectedSources}
            thinkingCapabilities={thinkingCapabilities}
            thinkingSettings={thinkingSettings}
            imageCapabilities={imageCapabilities}
            imageModelAvailable={imageModelAvailable}
            imageModelAlias={imageModelAlias}
            notionConnectorId={notionConnectorId}
            disabledToolNames={disabledToolNames}
            onDisabledToolNamesChange={onDisabledToolNamesChange}
          />
        </div>
      </div>
    </section>
  );
}
