import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import {
  coerceSkillIdsSelection,
  SKILL_SELECTION_LIMIT_MESSAGE,
} from "./tool-selection";
import { MessageList } from "./message-list";
import { getMessageImageParts, normalizeAssetUrl } from "./message-assets";
import { ToolInterventionBar } from "./tool-confirmation";
import { UserQuestionInterventionBar } from "./user-question-panel";
import type {
  ActiveThreadRun,
  ChatExecutionState,
} from "../../[threadId]/chat-stream-runner-control";
import {
  deriveTerminalToolConfirmationResolutions,
  getLiveToolConfirmationItemsForRun,
  getPendingToolConfirmationItems,
  getToolConfirmationItemsForRun,
  getPendingUserQuestionItems,
  hasLiveToolConfirmationSignalForRun,
  mergeToolConfirmationResolutions,
  hasActivelyRunningToolWork,
  shouldLockComposerForApproval,
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
  CapabilityCatalog,
  CitationRecord,
  PromptThinkingCapabilities,
  PromptThinkingSettings,
  ToolConfirmationInterventionSignal,
  VersionedMessageGroup,
} from "./types";
import type { ComposerOptionsState } from "./composer-options";

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
  otherUserRunActive = false,
  typingIndicator,
  onComposerType,
  queuedSends = [],
  onCancelQueuedSend,
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
  capabilityCatalog,
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
  modelCapabilities,
  imageModelAvailable,
  imageModelAlias,
  notionConnectorId = null,
  activeConnectorIds,
  disabledToolNames = [],
  onDisabledToolNamesChange,
  composerOptions,
  onComposerOptionsChange,
}: {
  activeVersionByGroup?: Record<string, number>;
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  activeThreadRun?: ActiveThreadRun | null;
  // True when the active run on this shared thread was started by another
  // member. We follow it live but must not lock this member's composer or show
  // them a Stop button for a run they don't own.
  otherUserRunActive?: boolean;
  typingIndicator?: ReactNode;
  onComposerType?: () => void;
  // Messages the user submitted while a run was streaming, awaiting auto-send
  // when the thread frees. Rendered as a compact stack above the composer.
  queuedSends?: { id: string; preview: string }[];
  onCancelQueuedSend?: (id: string) => void;
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
    approvalThreadRunId: string | null;
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
  capabilityCatalog?: CapabilityCatalog | null;
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
  modelCapabilities?: Record<string, unknown>;
  imageModelAvailable?: boolean;
  imageModelAlias?: string | null;
  notionConnectorId?: string | null;
  activeConnectorIds?: Record<string, string | null>;
  disabledToolNames?: ChatToolName[];
  onDisabledToolNamesChange?: (toolNames: ChatToolName[]) => void;
  composerOptions?: ComposerOptionsState;
  onComposerOptionsChange?: (options: ComposerOptionsState) => void;
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
  // Question ids answered/cancelled locally this render — hides the panel the
  // instant the user acts, before the resume stream flips the run off
  // `waiting_for_approval`. Reset when the parked run changes (see below).
  const [resolvedQuestionIds, setResolvedQuestionIds] = useState<Set<string>>(
    () => new Set(),
  );
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
  const hasLiveConfirmationSignal = hasLiveToolConfirmationSignalForRun({
    activeThreadRun,
    signal: toolConfirmationInterventionSignal,
  });
  const activeConfirmationItems = hasLiveConfirmationSignal
    ? liveConfirmationItems
    : toolConfirmationLookup.items;
  const toolConfirmationRunKey = getToolConfirmationRunKey(activeThreadRun);
  const questionItems = useMemo(
    () =>
      getPendingUserQuestionItems({
        activeVersionByGroup,
        messageGroups,
      }),
    [activeVersionByGroup, messageGroups],
  );
  const pendingQuestionItems = useMemo(
    () =>
      questionItems.filter(
        (item) => !resolvedQuestionIds.has(item.question.id),
      ),
    [questionItems, resolvedQuestionIds],
  );
  // Deliberately NOT reset when the active run changes. Answering a question
  // IS what starts the next run, so keying the reset on the run key made the
  // marker erase itself the instant it was set: the panel came straight back,
  // blank, on top of an answer already on its way to the server. Question ids
  // carry the interrupt id, so they are unique per question and a stale entry
  // can never hide a later one.
  const derivedConfirmationResolutions = useMemo(
    () =>
      deriveTerminalToolConfirmationResolutions({
        activeVersionByGroup,
        messageGroups,
      }),
    [activeVersionByGroup, messageGroups],
  );
  const confirmationResolutions = useMemo(
    () =>
      mergeToolConfirmationResolutions({
        derived: derivedConfirmationResolutions,
        local: toolConfirmationState.resolutions,
      }),
    [derivedConfirmationResolutions, toolConfirmationState.resolutions],
  );
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
  const hasPendingQuestionItems = pendingQuestionItems.length > 0;
  // A pending intervention is either a tool approval or an askUser question;
  // both park the run and must block a plain send / free-send-during-wait.
  const hasPendingInterventionItems =
    hasPendingConfirmationItems || hasPendingQuestionItems;
  const hasActivelyRunningToolWorkState = useMemo(
    () =>
      hasActivelyRunningToolWork({
        artifactStatuses,
        // MessageVersion keeps toolCalls on the version object; metadata is not
        // copied onto grouped versions, so locking must use toolCalls.
        messages: messageGroups.flatMap((group) =>
          group.versions.map((version) => ({
            toolCalls: version.toolCalls,
          })),
        ),
      }),
    [artifactStatuses, messageGroups],
  );
  // A streaming run — this member's own or another member's — no longer locks
  // the composer. Sending while one is active queues the message and auto-sends
  // when the thread frees (see the controller). Only a pending tool approval or
  // background tool/artifact work still blocks composing. The Stop control is
  // still shown for one's own run via `composerStopStreaming` below.
  const isSubmitDisabledForRun =
    shouldLockComposerForApproval({
      isWaitingForApproval,
      pendingConfirmationCount: pendingConfirmationItems.length,
    }) ||
    (isWaitingForApproval && hasPendingQuestionItems) ||
    hasActivelyRunningToolWorkState;
  const composerStopStreaming =
    !otherUserRunActive &&
    (chatExecutionState === "executing" || chatExecutionState === "stopping")
      ? onStopStreaming
      : undefined;
  const isComposerStopping = chatExecutionState === "stopping";

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
    if (hasLiveConfirmationSignal) {
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
    hasLiveConfirmationSignal,
    onReloadMessages,
    toolConfirmationLookup,
  ]);

  useEffect(() => {
    if (
      !toolConfirmationInterventionSignal ||
      pendingConfirmationItems.length === 0
    ) {
      return;
    }
    if (
      toolConfirmationState.activeIntervention &&
      pendingConfirmationItems.some(
        (item) =>
          item.confirmation.id === toolConfirmationState.activeIntervention?.id,
      )
    ) {
      return;
    }
    if (
      handledInterventionSignalIdRef.current ===
      toolConfirmationInterventionSignal.id
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
    toolConfirmationState.activeIntervention,
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
      commandUsed: Boolean(input.command || input.invocation),
      hasImages: Boolean(input.images?.length),
      hasSources: sourceCount > 0,
      skillCount,
      sourceCount,
      surface: mode === "new" ? "empty_state" : "thread",
      toolCount: countSelectedTools(input.tools),
    });
    if (isWaitingForApproval && !hasPendingInterventionItems) {
      onStopStreaming?.();
    }
    onSendMessage?.(input, {
      allowWhileStreaming: isWaitingForApproval && !hasPendingInterventionItems,
    });
  }

  function handleRemoveSource(id: string) {
    lastTrackedSourceCountRef.current = Math.max(selectedSources.length - 1, 0);
    onRemoveSource?.(id);
  }

  function handleSkillSelectionChange(skillIds: string[]) {
    const { skillIds: nextSkillIds, wasLimited } =
      coerceSkillIdsSelection(skillIds);
    if (wasLimited) {
      toast.info(SKILL_SELECTION_LIMIT_MESSAGE);
    }
    if (
      nextSkillIds.length > 0 &&
      nextSkillIds.length !== lastTrackedSkillCountRef.current
    ) {
      trackSkillSelected(nextSkillIds.length);
    }
    lastTrackedSkillCountRef.current = nextSkillIds.length;
    onSkillSelectionChange?.(nextSkillIds);
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
        onStopStreaming={composerStopStreaming}
        onThinkingSettingsChange={onThinkingSettingsChange}
        submitDisabled={isSubmitDisabledForRun}
        isStopping={isComposerStopping}
        searchEnabled={searchEnabled}
        availableSkills={availableSkills}
        capabilityCatalog={capabilityCatalog}
        selectedSkillIds={selectedSkillIds}
        selectedMcpInstallIds={selectedMcpInstallIds}
        selectedMcpToolIds={selectedMcpToolIds}
        selectedSources={selectedSources}
        thinkingCapabilities={thinkingCapabilities}
        thinkingSettings={thinkingSettings}
        modelCapabilities={modelCapabilities}
        imageModelAvailable={imageModelAvailable}
        imageModelAlias={imageModelAlias}
        notionConnectorId={notionConnectorId}
        activeConnectorIds={activeConnectorIds}
        disabledToolNames={disabledToolNames}
        onDisabledToolNamesChange={onDisabledToolNamesChange}
        composerOptions={composerOptions}
        onComposerOptionsChange={onComposerOptionsChange}
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

      <UserQuestionInterventionBar
        items={pendingQuestionItems}
        onSettled={({ answer, item }) => {
          setResolvedQuestionIds((previous) =>
            new Set(previous).add(item.question.id),
          );
          if (!onResumeToolConfirmation) {
            toast.error("Tool confirmation resume handler is not available.");
            return;
          }
          // A question is not an approval: resume with an empty `decisions` and
          // the askUser answer. The contract's XOR refine requires exactly one
          // of the two to be populated.
          // Echo the interrupt id so the backend keys Command.resume to the
          // right pending interrupt (sub-agent / parallel questions).
          const interruptId = item.question.interruptId;
          const toolApprovalResume: ToolApprovalResume =
            answer.status === "answered"
              ? {
                  decisions: [],
                  askUser: {
                    status: "answered",
                    answers: answer.answers,
                    ...(interruptId ? { interruptId } : {}),
                  },
                }
              : {
                  decisions: [],
                  askUser: {
                    status: "cancelled",
                    ...(interruptId ? { interruptId } : {}),
                  },
                };
          onResumeToolConfirmation({
            approvalThreadRunId: item.threadRunId,
            assistantMessageId: item.assistantMessageId,
            resolvedConfirmationIds: [item.question.id],
            toolApprovalResume,
          });
        }}
        onStopWaiting={() => {
          setResolvedQuestionIds((previous) => {
            const next = new Set(previous);
            for (const item of pendingQuestionItems) {
              next.add(item.question.id);
            }
            return next;
          });
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
      />

      <div className="border-t border-border/60 bg-background/95 px-6 py-5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          {queuedSends.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {queuedSends.map((queued) => (
                <div
                  key={queued.id}
                  className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground"
                >
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    Queued
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {queued.preview}
                  </span>
                  {onCancelQueuedSend ? (
                    <button
                      type="button"
                      onClick={() => onCancelQueuedSend(queued.id)}
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground/70 hover:bg-muted hover:text-foreground"
                      aria-label="Cancel queued message"
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {typingIndicator}
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
            onSubmit={(
              message,
              tools,
              command,
              skillIds,
              content,
              invocation,
            ) =>
              handleSendMessage({
                content: content ?? message.text.trim(),
                images: promptFilesToImages(message.files),
                mentionedSourceIds: message.mentionedSourceIds,
                skillIds,
                tools,
                command,
                invocation,
              })
            }
            onStopStreaming={composerStopStreaming}
            onType={onComposerType}
            onThinkingSettingsChange={onThinkingSettingsChange}
            searchEnabled={searchEnabled}
            availableSkills={availableSkills}
            capabilityCatalog={capabilityCatalog}
            selectedSkillIds={selectedSkillIds}
            selectedMcpInstallIds={selectedMcpInstallIds}
            selectedMcpToolIds={selectedMcpToolIds}
            selectedSources={selectedSources}
            thinkingCapabilities={thinkingCapabilities}
            thinkingSettings={thinkingSettings}
            modelCapabilities={modelCapabilities}
            imageModelAvailable={imageModelAvailable}
            imageModelAlias={imageModelAlias}
            notionConnectorId={notionConnectorId}
            disabledToolNames={disabledToolNames}
            onDisabledToolNamesChange={onDisabledToolNamesChange}
            composerOptions={composerOptions}
            onComposerOptionsChange={onComposerOptionsChange}
          />
        </div>
      </div>
    </section>
  );
}
