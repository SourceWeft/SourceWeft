"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { toast } from "sonner";
import type { useDashboardChatState } from "../../../_components/dashboard-chat-state";
import {
  DASHBOARD_WORKSPACE_SHORTCUT_LIMIT,
  getDashboardWorkspaceShortcutKeys,
  useDashboardShortcuts,
  useDashboardShortcutsOpenListener,
  useDashboardShortcutPlatform,
  type DashboardShortcutDefinition,
} from "../../../_components/dashboard-shortcuts";
import type {
  ArtifactStatusSnapshot,
  ChatSendInput,
  ToolConfirmationInterventionSignal,
} from "../../_components/chat-canvas";
import {
  EMPTY_ACTIVE_CONNECTOR_TOOLS,
  resolveActiveConnectorToolState,
  type ActiveConnectorToolState,
} from "../../_components/connector-agent-tools";
import {
  desktopBridge,
  handleDesktopAuthDeepLink,
} from "../../../../../lib/desktop-bridge";
import { contentClient, connectorsClient } from "../../../../../lib/sdk";
import type { SourceConnector } from "@sourceweft/sdk";
import {
  resolveWaitingForApprovalRun,
  useChatStreamRunnerControl,
} from "../chat-stream-runner-control";
import { useThreadBootstrap } from "./use-thread-bootstrap";
import { useThreadMessages } from "./use-thread-messages";
import { useThreadModels } from "./use-thread-models";
import { useThreadPreviews } from "./use-thread-previews";
import { useThreadSources } from "./use-thread-sources";
import {
  useThreadStreamAction,
  type ThreadStreamActionInput,
} from "./use-thread-stream-action";
import { useThreadVersioning } from "./use-thread-versioning";
import {
  getDisplayErrorMessage,
  throwStreamRequestError,
} from "./message-normalizers";
import {
  collectPendingArtifacts,
} from "../../_components/chat-canvas/artifact-progress-tracker";
import {
  isArtifactSnapshotTerminal,
} from "../../_components/chat-canvas/artifact-work-state";
import { mapArtifactStatusSnapshot } from "../../_components/chat-canvas/map-artifact-status-snapshot";
import { hasActivelyRunningToolWork } from "../../_components/chat-canvas/tool-confirmation-state";
import {
  buildToolConfirmationResumeStreamInput,
  createToolConfirmationResumeQueueState,
  flushPendingToolConfirmationResume,
  resolveToolConfirmationResumeRequest,
  type ToolConfirmationResumeRequest,
  type ToolConfirmationResumeQueueState,
} from "./tool-confirmation-resume-queue";
import {
  resolveContextSourceIds,
  resolveEditSourceIds,
  resolveRefreshSourceIds,
} from "./message-groups";
import { mergeSourceIds, shouldResetThreadLocalState } from "./thread-utils";
import { resolveChatUiState } from "../../_components/chat-ui-state";
import { BREAKPOINTS, useMediaQuery } from "../../../../../lib/use-media-query";

type DashboardChatState = ReturnType<typeof useDashboardChatState>;

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useThreadPageController({
  dashboardState,
  router,
  threadId,
}: {
  dashboardState: DashboardChatState;
  router: AppRouterInstance;
  threadId: string;
}) {
  const {
    privateChats,
    hasMorePrivateChats,
    hasWorkspaceHydrated,
    isWorkspaceHydrating,
    isLoadingPrivateChats,
    pendingWorkspaceId,
    sharedChats,
    sourcesVisible,
    switchWorkspace,
    toggleSourcesVisible,
    updateChatTitle,
    updateChatSourceCount,
    rememberChatPreferences,
    workspaceId,
    workspaceName,
    workspaces,
  } = dashboardState;

  const chatItem = [...privateChats, ...sharedChats].find(
    (chat) => chat.id === threadId,
  );
  const threadTitle = chatItem?.title ?? "Chat";

  const isPersistentLayout = useMediaQuery(BREAKPOINTS.md);
  const isDesktopPanel = useMediaQuery(BREAKPOINTS.lg);
  const handledConnectorOAuthHubRef = useRef(false);
  const [workfilesRefreshKey, setWorkfilesRefreshKey] = useState(0);
  const [artifactsRefreshKey, setArtifactsRefreshKey] = useState(0);
  const [artifactStatuses, setArtifactStatuses] = useState<
    ReadonlyMap<string, ArtifactStatusSnapshot>
  >(new Map());
  const artifactPollInFlightRef = useRef(false);
  const [composerInitialInput, setComposerInitialInput] = useState("");
  const [composerInitialCommand, setComposerInitialCommand] = useState<
    ChatSendInput["command"] | null
  >(null);
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [loadedThreadMessagesKey, setLoadedThreadMessagesKey] = useState<
    string | null
  >(null);
  const [activeConnectorTools, setActiveConnectorTools] =
    useState<ActiveConnectorToolState>(EMPTY_ACTIVE_CONNECTOR_TOOLS);
  const [
    toolConfirmationInterventionSignal,
    setToolConfirmationInterventionSignal,
  ] = useState<ToolConfirmationInterventionSignal | null>(null);
  const toolConfirmationResumeQueueRef =
    useRef<ToolConfirmationResumeQueueState>(
      createToolConfirmationResumeQueueState(),
    );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (handledConnectorOAuthHubRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("connector_oauth");
    if (oauthStatus === "success" || oauthStatus === "error") {
      handledConnectorOAuthHubRef.current = true;
      if (window.matchMedia(BREAKPOINTS.md).matches) {
        if (!sourcesVisible) {
          toggleSourcesVisible();
        }
      }
    }
  }, [sourcesVisible, toggleSourcesVisible]);

  useDashboardShortcutsOpenListener(() => setShortcutsOpen(true));

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingAssistantMessageId, setEditingAssistantMessageId] = useState<
    string | null
  >(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingBranchIndex, setEditingBranchIndex] = useState<number | null>(
    null,
  );

  const {
    activeMcpInstallIds,
    activeMcpToolIds,
    activeSkillIds,
    activeSourceIds,
    availableSkills,
    hubSkills,
    capabilityCatalog,
    disabledToolNames,
    effectiveActiveSkillIds,
    handleLibrarySourcesLoad,
    handleLibrarySourcesMerge,
    hasCachedWorkspaceSources,
    initialSourcesForWorkspace,
    librarySources,
    loadAvailableSkills,
    loadSourceMentions,
    persistActiveSourceIds,
    selectedSources,
    setActiveMcpInstallIds,
    setActiveMcpToolIds,
    setActiveSkillIds,
    handleSkillSelectionChange,
    setDisabledToolNames,
  } = useThreadSources({ threadId, workspaceId });
  const handleConnectorsChange = useCallback(
    (connectors: SourceConnector[]) => {
      setActiveConnectorTools(resolveActiveConnectorToolState(connectors));
    },
    [],
  );
  const handleMcpSelectionChange = useCallback(
    (selection: { installIds?: string[]; toolIds?: string[] }) => {
      setActiveMcpInstallIds(selection.installIds ?? []);
      setActiveMcpToolIds(selection.toolIds ?? []);
    },
    [setActiveMcpInstallIds, setActiveMcpToolIds],
  );

  const {
    availableModels,
    byokCredentials,
    byokModelConfig,
    byokModels,
    byokProviders,
    catalogKindEnabled,
    composerOptions,
    handleComposerOptionsChange,
    handleModelSelect,
    handleThreadByokSelect,
    handleThinkingSettingsChange,
    searchEnabled,
    modelCatalogStatus,
    selectedByokModels,
    selectedModels,
    setAvailableModels,
    setBaseSelectedModels,
    setByokCredentials,
    setByokModelConfig,
    setByokModels,
    setByokProviders,
    setCatalogKindEnabled,
    setComposerOptions,
    setHasSavedThinkingPreference,
    setModelSelectionSources,
    setSearchEnabled,
    setSelectedByokModels,
    setSelectedModels,
    setStreamWithSelectedLlm,
    setThinkingSettings,
    streamWithSelectedLlm,
    thinkingSettings,
  } = useThreadModels({
    availableSkills,
    effectiveActiveSkillIds,
    onChatPreferencesChange: rememberChatPreferences,
    threadId,
    workspaceId,
  });

  const {
    attachedRunKeyRef,
    activeThreadRun,
    chatExecutionState,
    clearAttachedRunKeyIfCurrent,
    clearRunIfCurrent,
    clearTerminalLocalRunState,
    isStopping,
    isStreaming,
    markRunStarted,
    markRunTerminal,
    setActiveThreadRun,
    stopStreaming: handleStopStreaming,
    updateActiveRunIfCurrent,
  } = useChatStreamRunnerControl({
    getDisplayErrorMessage,
    threadId,
    throwStreamRequestError,
    workspaceId,
  });

  const streamThreadActionRef = useRef<
    ((input: ThreadStreamActionInput) => Promise<void>) | null
  >(null);
  const {
    isLoadingOlderMessages,
    loadOlderThreadMessages,
    loadThreadMessages,
    mergeStreamingAssistantIntoMessages,
    messages,
    olderMessagesCursor,
    setMessages,
    setStreamingAssistantSnapshot,
  } = useThreadMessages({
    attachedRunKeyRef,
    clearTerminalLocalRunState,
    setActiveThreadRun,
    streamThreadActionRef,
    threadId,
    workspaceId,
  });

  const {
    activeAssistantVersion,
    assistantVersionById,
    activeVersionByGroup,
    displayedCitations,
    handleActiveVersionChange,
    messageGroups,
    pendingLatestVersionSelectionRef,
    resetVersioningState,
    setActiveVersionByGroup,
    threadCitations,
  } = useThreadVersioning({
    isStreaming,
    mergeStreamingAssistantIntoMessages,
    messages,
  });

  // Use merged messages to include the streaming snapshot for live-turn artifact
  // tracking. mergeStreamingAssistantIntoMessages is memoized on the streaming
  // snapshot, so its identity change is exactly what should recompute this.
  const mergedMessages = useMemo(
    () => mergeStreamingAssistantIntoMessages(messages),
    [messages, mergeStreamingAssistantIntoMessages],
  );

  const pendingArtifacts = useMemo(
    () => collectPendingArtifacts(mergedMessages, artifactStatuses),
    [artifactStatuses, mergedMessages],
  );

  const pendingArtifactIds = useMemo(
    () => pendingArtifacts.map((artifact) => artifact.artifactId),
    [pendingArtifacts],
  );

  const hasActivelyRunningToolWorkState = useMemo(
    () =>
      hasActivelyRunningToolWork({
        artifactStatuses,
        messages: mergedMessages,
      }),
    [artifactStatuses, mergedMessages],
  );

  // Use ref to avoid re-creating callback when pendingArtifactIds changes
  const pendingArtifactIdsRef = useRef<string[]>([]);
  pendingArtifactIdsRef.current = pendingArtifactIds;

  const refreshArtifactStatuses = useCallback(async () => {
    const artifactIds = pendingArtifactIdsRef.current;
    if (
      !workspaceId ||
      artifactIds.length === 0 ||
      artifactPollInFlightRef.current
    ) {
      return;
    }

    artifactPollInFlightRef.current = true;
    const activeWorkspaceId = workspaceId;
    try {
      const results = await Promise.allSettled(
        artifactIds.map(async (artifactId) => {
          const result = await contentClient.getArtifact(
            activeWorkspaceId,
            artifactId,
          );
          return {
            artifactId,
            snapshot: mapArtifactStatusSnapshot(result.artifact),
          };
        }),
      );

      setArtifactStatuses((current) => {
        const next = new Map(current);
        results.forEach((result) => {
          if (result.status === "fulfilled") {
            next.set(result.value.snapshot.id, result.value.snapshot);
          }
        });
        return next;
      });

      if (
        results.some(
          (result) =>
            result.status === "fulfilled" &&
            isArtifactSnapshotTerminal(result.value.snapshot),
        )
      ) {
        setArtifactsRefreshKey((value) => value + 1);
      }
    } finally {
      artifactPollInFlightRef.current = false;
    }
  }, [workspaceId]); // Only depend on workspaceId, not pendingArtifactIds

  const clearEditingState = useCallback(() => {
    setEditingMessageId(null);
    setEditingAssistantMessageId(null);
    setEditingGroupId(null);
    setEditingBranchIndex(null);
  }, []);

  const cancelEditing = useCallback(() => {
    clearEditingState();
    setComposerInitialInput("");
    setComposerInitialCommand(null);
    setComposerResetKey((value) => value + 1);
  }, [clearEditingState]);

  const {
    activeCitationIndex,
    handleArtifactPreview,
    handleCitationClick,
    handleSourceHubCitationOpen,
    handleSourcePreview,
    handleWorkfilePreview,
    highlightedMessageId,
    previewArtifact,
    previewCitation,
    previewSource,
    previewWorkfile,
    scrollToMessage,
    setPreviewArtifact,
    setPreviewCitation,
    setPreviewSource,
    setPreviewWorkfile,
  } = useThreadPreviews({
    activeAssistantVersionId: activeAssistantVersion?.id ?? null,
    displayedCitations,
    sourcesVisible,
    threadId,
    toggleSourcesVisible,
    workspaceId,
  });

  useEffect(() => {
    if (!desktopBridge.isAvailable()) {
      return;
    }

    const cleanupTask = desktopBridge.onDeepLink((payload) => {
      const url = payload.url.trim();
      if (!url) {
        return;
      }

      void handleDesktopAuthDeepLink({
        url,
        onSuccess: () => {
          router.replace("/dashboard");
          router.refresh();
        },
        onError: (message) => toast.error(message),
      }).then((handled) => {
        if (handled) {
          return;
        }
      });
    });

    return () => {
      cleanupTask.then((cleanup) => void cleanup()).catch(() => {});
    };
  }, [router]);

  useEffect(() => {
    if (!workspaceId) {
      setActiveConnectorTools(EMPTY_ACTIVE_CONNECTOR_TOOLS);
      return;
    }

    let cancelled = false;
    void connectorsClient
      .list(workspaceId)
      .then((result) => {
        if (!cancelled) {
          setActiveConnectorTools(
            resolveActiveConnectorToolState(result.items),
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActiveConnectorTools(EMPTY_ACTIVE_CONNECTOR_TOOLS);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const { streamThreadAction } = useThreadStreamAction({
    catalogKindEnabled,
    clearAttachedRunKeyIfCurrent,
    clearEditingState,
    clearRunIfCurrent,
    librarySources,
    loadThreadMessages,
    markRunStarted,
    markRunTerminal,
    messages,
    onToolConfirmationRequested: ({
      assistantMessageId,
      liveConfirmations,
      mode,
      runKey,
      threadRunId,
    }) => {
      setActiveThreadRun((current) =>
        resolveWaitingForApprovalRun({
          assistantMessageId,
          current,
          durableRunKey: runKey,
          mode,
          threadRunId,
        }),
      );
      setToolConfirmationInterventionSignal({
        id: [
          runKey,
          assistantMessageId ?? "assistant:unknown",
          ...liveConfirmations.map((item) => item.confirmation.id),
        ].join(":"),
        assistantMessageId,
        liveConfirmations,
        runKey,
        threadRunId,
      });
    },
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
  });

  const loadThreadMessagesRef = useRef(loadThreadMessages);
  const bootstrappedThreadKeyRef = useRef<string | null>(null);
  const targetThreadMessagesKey = workspaceId
    ? `${workspaceId}:${threadId}`
    : null;
  const loadThreadMessagesWithStatus = useCallback(async () => {
    const targetKey = targetThreadMessagesKey;
    await loadThreadMessages();
    setLoadedThreadMessagesKey((current) => targetKey ?? current);
  }, [loadThreadMessages, targetThreadMessagesKey]);

  useBrowserLayoutEffect(() => {
    streamThreadActionRef.current = streamThreadAction;
  }, [streamThreadAction]);

  useBrowserLayoutEffect(() => {
    loadThreadMessagesRef.current = loadThreadMessagesWithStatus;
  }, [loadThreadMessagesWithStatus]);

  useBrowserLayoutEffect(() => {
    if (
      !shouldResetThreadLocalState({
        bootstrappedThreadKey: bootstrappedThreadKeyRef.current,
        threadId,
        workspaceId,
      })
    ) {
      return;
    }
    clearEditingState();
    resetVersioningState();
    setStreamingAssistantSnapshot(null);
    setArtifactStatuses(new Map());
    setToolConfirmationInterventionSignal(null);
    toolConfirmationResumeQueueRef.current =
      createToolConfirmationResumeQueueState();
    clearTerminalLocalRunState();
  }, [
    clearEditingState,
    clearTerminalLocalRunState,
    resetVersioningState,
    setStreamingAssistantSnapshot,
    threadId,
    workspaceId,
  ]);

  useThreadBootstrap({
    bootstrappedThreadKeyRef,
    loadThreadMessagesRef,
    persistActiveSourceIds,
    setActiveSkillIds,
    setAvailableModels,
    setBaseSelectedModels,
    setCatalogKindEnabled,
    setComposerOptions,
    setHasSavedThinkingPreference,
    setModelSelectionSources,
    setSearchEnabled,
    setSelectedByokModels,
    setSelectedModels,
    setStreamWithSelectedLlm,
    setThinkingSettings,
    streamThreadAction,
    threadId,
    workspaceId,
  });

  const threadStatus = useMemo(() => {
    if (
      !workspaceId ||
      isWorkspaceHydrating ||
      !hasWorkspaceHydrated ||
      pendingWorkspaceId
    ) {
      return "loading";
    }
    if (
      !chatItem &&
      (modelCatalogStatus === "error" ||
        (!isLoadingPrivateChats && !hasMorePrivateChats))
    ) {
      return "error";
    }
    if (
      targetThreadMessagesKey &&
      loadedThreadMessagesKey !== targetThreadMessagesKey
    ) {
      return isStreaming ? "ready" : "loading";
    }
    return "ready";
  }, [
    chatItem,
    hasMorePrivateChats,
    hasWorkspaceHydrated,
    isLoadingPrivateChats,
    isStreaming,
    isWorkspaceHydrating,
    loadedThreadMessagesKey,
    modelCatalogStatus,
    pendingWorkspaceId,
    targetThreadMessagesKey,
    workspaceId,
  ]);
  const isThreadSwitching = Boolean(
    targetThreadMessagesKey &&
      loadedThreadMessagesKey &&
      loadedThreadMessagesKey !== targetThreadMessagesKey,
  );
  const resolvedModelCatalogStatus =
    threadStatus === "error" ||
    (isThreadSwitching && modelCatalogStatus === "loading")
      ? "ready"
      : modelCatalogStatus;

  const chatUiState = useMemo(
    () =>
      resolveChatUiState({
        routeKind: "thread",
        shellStatus: "ready",
        workspaceStatus:
          isWorkspaceHydrating || !hasWorkspaceHydrated || pendingWorkspaceId
            ? "loading"
            : "ready",
        modelCatalogStatus: resolvedModelCatalogStatus,
        threadStatus,
        requestedThreadId: threadId,
        activeThreadId: chatItem?.id ?? null,
        hasWorkspace: Boolean(workspaceId),
        hasThread: Boolean(chatItem),
        hasMessages: messageGroups.length > 0,
        streamingStatus: isStreaming ? "loading" : "ready",
        isWorkspaceShortcutPending:
          dashboardState.workspaceSwitchStatus === "loading",
        isThreadSwitching,
        errorKind: threadStatus === "error" ? "thread" : null,
      }),
    [
      chatItem,
      hasWorkspaceHydrated,
      isStreaming,
      isWorkspaceHydrating,
      isThreadSwitching,
      messageGroups.length,
      pendingWorkspaceId,
      resolvedModelCatalogStatus,
      threadId,
      threadStatus,
      dashboardState.workspaceSwitchStatus,
      workspaceId,
    ],
  );

  // Artifact progress streams through the single chat SSE: the
  // generate_video_presentation tool blocks until the render pipeline reaches
  // a terminal state, emitting tool-call-event progress along the way. On page
  // reload the durable-run attach flow resumes that same stream, and
  // refreshArtifactStatuses runs once (below) to reconcile any snapshot the
  // page missed while closed.
  useEffect(() => {
    if (!workspaceId || pendingArtifactIds.length === 0) {
      return;
    }
    void refreshArtifactStatuses();
    // artifactIds are read from a ref inside refreshArtifactStatuses; keying
    // on the joined ids keeps this to one reconcile per artifact set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingArtifactIds.join("\0"), refreshArtifactStatuses, workspaceId]);

  const handleSendMessage = useCallback(
    async (
      input: ChatSendInput,
      options?: { allowWhileStreaming?: boolean },
    ) => {
      const text = input.content.trim();
      const images = input.images ?? [];
      if (
        (!text && images.length === 0) ||
        (chatExecutionState !== "idle" && !options?.allowWhileStreaming) ||
        hasActivelyRunningToolWorkState
      ) {
        return;
      }
      if (modelCatalogStatus !== "ready") {
        toast.error(
          modelCatalogStatus === "error"
            ? "Model catalog failed to load. Refresh and try again."
            : "Model catalog is still loading. Try again in a moment.",
        );
        return;
      }
      if (!selectedModels.llm?.capabilities) {
        toast.error("Chat model capabilities are not loaded yet.");
        return;
      }

      const contextSourceIds = resolveContextSourceIds({
        messages,
        activeSourceIds,
      });
      const mentionedSourceIds = mergeSourceIds(input.mentionedSourceIds);
      const sendSourceIds = mergeSourceIds(contextSourceIds);
      const selectedSkillIds = input.skillIds ?? effectiveActiveSkillIds;
      const selectedMcp =
        input.tools?.mcp ??
        (activeMcpInstallIds.length > 0 || activeMcpToolIds.length > 0
          ? {
              enabled: true,
              installIds: activeMcpInstallIds,
              toolIds: activeMcpToolIds,
            }
          : undefined);
      const tools = selectedMcp
        ? { ...(input.tools ?? {}), mcp: selectedMcp }
        : input.tools;

      if (editingMessageId) {
        const editingAssistantGroup = editingAssistantMessageId
          ? messageGroups.find(
              (group) =>
                group.role === "assistant" &&
                group.versions.some(
                  (version) => version.id === editingAssistantMessageId,
                ),
            )
          : undefined;

        setActiveVersionByGroup((previous) => {
          const next = { ...previous };

          if (editingGroupId) {
            const userGroup = messageGroups.find(
              (group) => group.groupId === editingGroupId,
            );
            const nextUserBranchIndex = userGroup
              ? userGroup.versions.length
              : (editingBranchIndex ?? 0) + 1;

            next[editingGroupId] = Math.max(
              previous[editingGroupId] ?? 0,
              nextUserBranchIndex,
            );
          }

          if (editingAssistantGroup) {
            const nextAssistantBranchIndex =
              editingAssistantGroup.versions.length;
            next[editingAssistantGroup.groupId] = Math.max(
              previous[editingAssistantGroup.groupId] ?? 0,
              nextAssistantBranchIndex,
            );
          }

          return next;
        });

        pendingLatestVersionSelectionRef.current = {
          userGroupId: editingGroupId ?? undefined,
          assistantGroupId: editingAssistantGroup?.groupId,
          turnId: editingAssistantGroup?.turnId,
        };

        const editSourceIds = resolveEditSourceIds({
          activeSourceIds,
          editingMessageId,
          groups: messageGroups,
        });
        const mergedEditSourceIds = mergeSourceIds(editSourceIds);

        await streamThreadAction({
          mode: "edit",
          content: text,
          images,
          mentionedSourceIds,
          sourceIds: mergedEditSourceIds,
          skillIds: selectedSkillIds,
          tools,
          command: input.command,
          invocation: input.invocation,
          searchEnabled,
          userMessageId: editingMessageId,
          assistantMessageId: editingAssistantMessageId,
        });
        return;
      }

      await streamThreadAction({
        mode: "send",
        content: text,
        images,
        mentionedSourceIds,
        sourceIds: sendSourceIds,
        skillIds: selectedSkillIds,
        tools,
        command: input.command,
        invocation: input.invocation,
        searchEnabled,
      });
    },
    [
      editingAssistantMessageId,
      editingBranchIndex,
      editingGroupId,
      editingMessageId,
      chatExecutionState,
      hasActivelyRunningToolWorkState,
      modelCatalogStatus,
      messageGroups,
      messages,
      activeSourceIds,
      activeMcpInstallIds,
      activeMcpToolIds,
      effectiveActiveSkillIds,
      searchEnabled,
      selectedModels.llm,
      pendingLatestVersionSelectionRef,
      setActiveVersionByGroup,
      streamThreadAction,
    ],
  );

  const handleRefreshLatest = useCallback(
    async (input: {
      groupId: string;
      assistantMessageId: string;
      branchIndex: number;
    }) => {
      if (isStreaming) {
        return;
      }

      const assistantGroup = messageGroups.find(
        (group) => group.groupId === input.groupId,
      );
      const nextBranchIndex = assistantGroup
        ? assistantGroup.versions.length
        : input.branchIndex + 1;

      setActiveVersionByGroup((previous) => ({
        ...previous,
        [input.groupId]: Math.max(
          previous[input.groupId] ?? 0,
          nextBranchIndex,
        ),
      }));
      pendingLatestVersionSelectionRef.current = {
        assistantGroupId: input.groupId,
        turnId: assistantGroup?.turnId,
      };

      const refreshSourceIds = resolveRefreshSourceIds({
        activeSourceIds,
        assistantMessageId: input.assistantMessageId,
        groups: messageGroups,
      });
      const refreshUserMessageId = messageGroups
        .flatMap((group) => group.versions)
        .find((version) => version.id === input.assistantMessageId)
        ?.sourceUserMessageId;

      await streamThreadAction({
        mode: "refresh",
        sourceIds: refreshSourceIds,
        skillIds: effectiveActiveSkillIds,
        searchEnabled,
        assistantMessageId: input.assistantMessageId,
        // Bind the refresh to the user message that produced *this* assistant
        // turn. Without it, streamThreadAction falls back to the latest user
        // message, which mis-targets refreshes of non-latest turns.
        userMessageId: refreshUserMessageId,
      });
    },
    [
      activeSourceIds,
      effectiveActiveSkillIds,
      isStreaming,
      messageGroups,
      pendingLatestVersionSelectionRef,
      searchEnabled,
      setActiveVersionByGroup,
      streamThreadAction,
    ],
  );

  const runToolConfirmationResume = useCallback(
    async (input: ToolConfirmationResumeRequest) => {
      await streamThreadAction(buildToolConfirmationResumeStreamInput(input));
    },
    [streamThreadAction],
  );

  const handleResumeToolConfirmation = useCallback(
    async (input: ToolConfirmationResumeRequest) => {
      const next = resolveToolConfirmationResumeRequest({
        isStreaming,
        request: input,
        state: toolConfirmationResumeQueueRef.current,
      });
      toolConfirmationResumeQueueRef.current = next.state;
      if (!next.runnable) {
        return;
      }
      await runToolConfirmationResume(next.runnable);
    },
    [isStreaming, runToolConfirmationResume],
  );

  useEffect(() => {
    const next = flushPendingToolConfirmationResume({
      isStreaming,
      state: toolConfirmationResumeQueueRef.current,
    });
    toolConfirmationResumeQueueRef.current = next.state;
    if (!next.runnable) {
      return;
    }
    void runToolConfirmationResume(next.runnable);
  }, [isStreaming, runToolConfirmationResume]);

  const handleRestartFromMessage = useCallback(
    (input: {
      groupId: string;
      messageId: string;
      message: string;
      assistantMessageId: string | null;
      branchIndex: number;
    }) => {
      if (editingMessageId === input.messageId) {
        cancelEditing();
        return;
      }

      setEditingMessageId(input.messageId);
      setEditingAssistantMessageId(input.assistantMessageId);
      setEditingGroupId(input.groupId);
      setEditingBranchIndex(input.branchIndex);
      setComposerInitialInput(input.message);
      setComposerInitialCommand(null);
      setComposerResetKey((value) => value + 1);
    },
    [cancelEditing, editingMessageId],
  );

  const handleWorkspaceShortcut = useCallback(
    (targetWorkspaceId: string) => {
      if (targetWorkspaceId === workspaceId) {
        return;
      }

      void switchWorkspace(targetWorkspaceId).then((switched) => {
        if (switched) {
          router.push("/dashboard/chat");
        }
      });
    },
    [router, switchWorkspace, workspaceId],
  );

  const shortcutPlatform = useDashboardShortcutPlatform();
  const shortcutDefinitions = useMemo<DashboardShortcutDefinition[]>(
    () =>
      workspaces
        .slice(0, DASHBOARD_WORKSPACE_SHORTCUT_LIMIT)
        .map((workspace, index) => ({
          group: "Workspace",
          id: `workspace-${workspace.id}`,
          keys: getDashboardWorkspaceShortcutKeys(index, shortcutPlatform),
          onRun: () => handleWorkspaceShortcut(workspace.id),
          title: `Switch to ${workspace.name}`,
        })),
    [handleWorkspaceShortcut, shortcutPlatform, workspaces],
  );

  useDashboardShortcuts(shortcutDefinitions);

  return {
    activeAssistantVersion,
    assistantVersionById,
    activeThreadRun,
    chatExecutionState,
    chatUiState,
    activeCitationIndex,
    activeMcpInstallIds,
    activeMcpToolIds,
    activeSkillIds,
    activeConnectorTools,
    activeSourceIds,
    activeVersionByGroup,
    artifactStatuses,
    artifactsRefreshKey,
    availableModels,
    availableSkills,
    hubSkills,
    capabilityCatalog,
    byokCredentials,
    byokModelConfig,
    byokModels,
    byokProviders,
    cancelEditing,
    composerInitialCommand,
    composerInitialInput,
    composerResetKey,
    composerOptions,
    disabledToolNames,
    displayedCitations,
    editingGroupId,
    editingMessageId,
    handleActiveVersionChange,
    handleArtifactPreview,
    handleCitationClick,
    handleConnectorsChange,
    handleComposerOptionsChange,
    handleLibrarySourcesLoad,
    handleLibrarySourcesMerge,
    handleMcpSelectionChange,
    handleModelSelect,
    handleRefreshLatest,
    handleResumeToolConfirmation,
    handleRestartFromMessage,
    handleSendMessage,
    handleSourceHubCitationOpen,
    handleSourcePreview,
    handleThreadByokSelect,
    handleStopStreaming,
    handleThinkingSettingsChange,
    handleWorkfilePreview,
    hasCachedWorkspaceSources,
    highlightedMessageId,
    initialSourcesForWorkspace,
    isDesktopPanel,
    isLoadingOlderMessages,
    isPersistentLayout,
    isStopping,
    isStreaming,
    librarySources,
    loadAvailableSkills,
    loadOlderThreadMessages,
    loadThreadMessages: loadThreadMessagesWithStatus,
    loadSourceMentions,
    messageGroups,
    olderMessagesCursor,
    persistActiveSourceIds,
    previewArtifact,
    previewCitation,
    previewSource,
    previewWorkfile,
    searchEnabled,
    modelCatalogStatus,
    selectedByokModels,
    selectedModels,
    selectedSources,
    handleSkillSelectionChange,
    setArtifactsRefreshKey,
    setByokCredentials,
    setByokModelConfig,
    setByokModels,
    setByokProviders,
    setDisabledToolNames,
    setPreviewArtifact,
    setPreviewCitation,
    setPreviewSource,
    setPreviewWorkfile,
    setSearchEnabled,
    setSelectedModels,
    setShortcutsOpen,
    shortcutDefinitions,
    shortcutsOpen,
    scrollToMessage,
    sourcesVisible,
    threadCitations,
    threadId,
    threadTitle,
    thinkingSettings,
    toolConfirmationInterventionSignal,
    toggleSourcesVisible,
    workfilesRefreshKey,
    workspaceId,
    workspaceName,
  };
}
