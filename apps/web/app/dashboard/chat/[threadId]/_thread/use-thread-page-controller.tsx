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
import { useChatStreamRunnerControl } from "../chat-stream-runner-control";
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
  collectPendingVideoPresentationArtifactIds,
  mapArtifactStatusSnapshot,
} from "./video-presentation-artifacts";
import {
  buildToolConfirmationResumeStreamInput,
  flushPendingToolConfirmationResume,
  resolveToolConfirmationResumeRequest,
  type ToolConfirmationResumeRequest,
} from "./tool-confirmation-resume-queue";
import {
  resolveContextSourceIds,
  resolveEditSourceIds,
  resolveRefreshSourceIds,
} from "./message-groups";
import { mergeSourceIds } from "./thread-utils";
import { resolveChatUiState } from "../../_components/chat-ui-state";

type DashboardChatState = ReturnType<typeof useDashboardChatState>;

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
const VIDEO_PRESENTATION_MAX_CONSECUTIVE_POLL_FAILURES = 3;

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

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
    workspaceId,
    workspaceName,
    workspaces,
  } = dashboardState;

  const chatItem = [...privateChats, ...sharedChats].find(
    (chat) => chat.id === threadId,
  );
  const threadTitle = chatItem?.title ?? "Chat";

  const isPersistentLayout = useMediaQuery("(min-width: 768px)");
  const isDesktopPanel = useMediaQuery("(min-width: 1024px)");
  const handledConnectorOAuthHubRef = useRef(false);
  const [workfilesRefreshKey, setWorkfilesRefreshKey] = useState(0);
  const [artifactsRefreshKey, setArtifactsRefreshKey] = useState(0);
  const [artifactStatuses, setArtifactStatuses] = useState<
    ReadonlyMap<string, ArtifactStatusSnapshot>
  >(new Map());
  const videoPresentationPollFailuresRef = useRef(new Map<string, number>());
  const [composerInitialInput, setComposerInitialInput] = useState("");
  const [composerInitialCommand, setComposerInitialCommand] = useState<
    ChatSendInput["command"] | null
  >(null);
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [hubDrawerOpen, setHubDrawerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [loadedThreadMessagesKey, setLoadedThreadMessagesKey] = useState<
    string | null
  >(null);
  const [activeConnectorTools, setActiveConnectorTools] =
    useState<ActiveConnectorToolState>(EMPTY_ACTIVE_CONNECTOR_TOOLS);
  const [toolConfirmationInterventionSignal, setToolConfirmationInterventionSignal] =
    useState<ToolConfirmationInterventionSignal | null>(null);
  const pendingToolConfirmationResumeRef =
    useRef<ToolConfirmationResumeRequest | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (handledConnectorOAuthHubRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("connector_oauth");
    if (oauthStatus === "success" || oauthStatus === "error") {
      handledConnectorOAuthHubRef.current = true;
      if (window.matchMedia("(min-width: 768px)").matches) {
        if (!sourcesVisible) {
          toggleSourcesVisible();
        }
        return;
      }
      setHubDrawerOpen(true);
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
    setDisabledToolNames,
  } = useThreadSources({ threadId, workspaceId });
  const handleConnectorsChange = useCallback((connectors: SourceConnector[]) => {
    setActiveConnectorTools(resolveActiveConnectorToolState(connectors));
  }, []);
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
  const pendingVideoPresentationArtifactIds = useMemo(
    () => collectPendingVideoPresentationArtifactIds(messages),
    [messages],
  );

  const refreshVideoPresentationArtifactStatuses = useCallback(async () => {
    if (!workspaceId || pendingVideoPresentationArtifactIds.length === 0) {
      return;
    }

    const activeWorkspaceId = workspaceId;
    const results = await Promise.allSettled(
      pendingVideoPresentationArtifactIds.map(async (artifactId) => {
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
      results.forEach((result, index) => {
        const artifactId = pendingVideoPresentationArtifactIds[index];
        if (!artifactId) {
          return;
        }
        if (result.status === "fulfilled") {
          videoPresentationPollFailuresRef.current.delete(artifactId);
          next.set(result.value.snapshot.id, result.value.snapshot);
          return;
        }

        const failureCount =
          (videoPresentationPollFailuresRef.current.get(artifactId) ?? 0) + 1;
        videoPresentationPollFailuresRef.current.set(artifactId, failureCount);
        if (
          failureCount < VIDEO_PRESENTATION_MAX_CONSECUTIVE_POLL_FAILURES
        ) {
          return;
        }

        const currentSnapshot = next.get(artifactId);
        if (!currentSnapshot) {
          return;
        }
        next.set(artifactId, {
          ...currentSnapshot,
          errorMessage:
            result.reason instanceof Error
              ? result.reason.message
              : "Could not refresh this video presentation status.",
          status: "failed",
          updatedAt: new Date().toISOString(),
        });
      });
      return next;
    });

    if (
      results.some(
        (result) =>
          result.status === "fulfilled" &&
          (result.value.snapshot.status === "ready" ||
            result.value.snapshot.status === "failed"),
      )
    ) {
      setArtifactsRefreshKey((value) => value + 1);
    }
  }, [pendingVideoPresentationArtifactIds, workspaceId]);

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
          setActiveConnectorTools(resolveActiveConnectorToolState(result.items));
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
      runKey,
      threadRunId,
    }) => {
      setToolConfirmationInterventionSignal({
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
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

  useEffect(() => {
    clearEditingState();
    resetVersioningState();
    setStreamingAssistantSnapshot(null);
    setArtifactStatuses(new Map());
    setToolConfirmationInterventionSignal(null);
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
    setHasSavedThinkingPreference,
    setModelSelectionSources,
    setSearchEnabled,
    setSelectedByokModels,
    setSelectedModels,
    setStreamWithSelectedLlm,
    setThinkingSettings,
    streamThreadActionRef,
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

  useEffect(() => {
    if (!workspaceId || pendingVideoPresentationArtifactIds.length === 0) {
      return;
    }

    void refreshVideoPresentationArtifactStatuses();
  }, [
    pendingVideoPresentationArtifactIds,
    refreshVideoPresentationArtifactStatuses,
    workspaceId,
  ]);

  useEffect(() => {
    if (!workspaceId || pendingVideoPresentationArtifactIds.length === 0) {
      return;
    }

    const hasPendingVideoPresentation = pendingVideoPresentationArtifactIds.some(
      (artifactId) => {
        const status = artifactStatuses.get(artifactId)?.status ?? "pending";
        return status === "pending" || status === "running";
      },
    );
    if (!hasPendingVideoPresentation) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshVideoPresentationArtifactStatuses();
    }, 3000);

    return () => window.clearInterval(timer);
  }, [
    artifactStatuses,
    pendingVideoPresentationArtifactIds,
    refreshVideoPresentationArtifactStatuses,
    workspaceId,
  ]);

  const handleSendMessage = useCallback(
    async (
      input: ChatSendInput,
      options?: { allowWhileStreaming?: boolean },
    ) => {
      const text = input.content.trim();
      const images = input.images ?? [];
      if (
        (!text && images.length === 0) ||
        (chatExecutionState !== "idle" && !options?.allowWhileStreaming)
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
        searchEnabled,
      });
    },
    [
      editingAssistantMessageId,
      editingBranchIndex,
      editingGroupId,
      editingMessageId,
      chatExecutionState,
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

      await streamThreadAction({
        mode: "refresh",
        sourceIds: refreshSourceIds,
        skillIds: effectiveActiveSkillIds,
        searchEnabled,
        assistantMessageId: input.assistantMessageId,
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
      });
      pendingToolConfirmationResumeRef.current = next.pending;
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
      pending: pendingToolConfirmationResumeRef.current,
    });
    pendingToolConfirmationResumeRef.current = next.pending;
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
    byokCredentials,
    byokModelConfig,
    byokModels,
    byokProviders,
    cancelEditing,
    composerInitialCommand,
    composerInitialInput,
    composerResetKey,
    disabledToolNames,
    displayedCitations,
    editingGroupId,
    editingMessageId,
    handleActiveVersionChange,
    handleArtifactPreview,
    handleCitationClick,
    handleConnectorsChange,
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
    hubDrawerOpen,
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
    setActiveSkillIds,
    setArtifactsRefreshKey,
    setByokCredentials,
    setByokModelConfig,
    setByokModels,
    setByokProviders,
    setDisabledToolNames,
    setHubDrawerOpen,
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
