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
import type { ChatSendInput } from "../../_components/chat-canvas";
import {
  desktopBridge,
  handleDesktopAuthDeepLink,
} from "../../../../../lib/desktop-bridge";
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
  resolveContextSourceIds,
  resolveEditSourceIds,
  resolveRefreshSourceIds,
} from "./message-groups";
import { mergeSourceIds } from "./thread-utils";

type DashboardChatState = ReturnType<typeof useDashboardChatState>;

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

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
    sourcesVisible,
    startNewChat,
    switchWorkspace,
    toggleSourcesVisible,
    updateChatTitle,
    updateChatSourceCount,
    workspaceId,
    workspaceName,
    workspaces,
  } = dashboardState;

  const chatItem = privateChats.find((c) => c.id === threadId);
  const threadTitle = chatItem?.title ?? "Chat";

  const isPersistentLayout = useMediaQuery("(min-width: 768px)");
  const isDesktopPanel = useMediaQuery("(min-width: 1024px)");
  const [workfilesRefreshKey, setWorkfilesRefreshKey] = useState(0);
  const [artifactsRefreshKey, setArtifactsRefreshKey] = useState(0);
  const [composerInitialInput, setComposerInitialInput] = useState("");
  const [composerInitialCommand, setComposerInitialCommand] = useState<
    ChatSendInput["command"] | null
  >(null);
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [hubDrawerOpen, setHubDrawerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
    setActiveSkillIds,
    setDisabledToolNames,
  } = useThreadSources({ threadId, workspaceId });

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
    clearAttachedRunKeyIfCurrent,
    clearRunIfCurrent,
    isStopping,
    isStreaming,
    markRunStarted,
    markRunTerminal,
    setActiveThreadRun,
    stopStreaming: handleStopStreaming,
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
    setActiveThreadRun,
    streamThreadActionRef,
    threadId,
    workspaceId,
  });

  const {
    activeAssistantVersion,
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
    updateChatSourceCount,
    updateChatTitle,
    workspaceId,
  });

  const loadThreadMessagesRef = useRef(loadThreadMessages);
  const bootstrappedThreadKeyRef = useRef<string | null>(null);

  useBrowserLayoutEffect(() => {
    streamThreadActionRef.current = streamThreadAction;
  }, [streamThreadAction]);

  useBrowserLayoutEffect(() => {
    loadThreadMessagesRef.current = loadThreadMessages;
  }, [loadThreadMessages]);

  useEffect(() => {
    clearEditingState();
    resetVersioningState();
    setStreamingAssistantSnapshot(null);
  }, [
    clearEditingState,
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

  const handleSendMessage = useCallback(
    async (input: ChatSendInput) => {
      const text = input.content.trim();
      const images = input.images ?? [];
      if ((!text && images.length === 0) || isStreaming) {
        return;
      }

      const contextSourceIds = resolveContextSourceIds({
        messages,
        activeSourceIds,
      });
      const mentionedSourceIds = mergeSourceIds(input.mentionedSourceIds);
      const sendSourceIds = mergeSourceIds(contextSourceIds);
      const selectedSkillIds = input.skillIds ?? effectiveActiveSkillIds;

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
          tools: input.tools,
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
        tools: input.tools,
        command: input.command,
        searchEnabled,
      });
    },
    [
      editingAssistantMessageId,
      editingBranchIndex,
      editingGroupId,
      editingMessageId,
      isStreaming,
      messageGroups,
      messages,
      activeSourceIds,
      effectiveActiveSkillIds,
      searchEnabled,
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

      startNewChat();
      void switchWorkspace(targetWorkspaceId);
      router.push("/dashboard/chat");
    },
    [router, startNewChat, switchWorkspace, workspaceId],
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
    activeCitationIndex,
    activeSkillIds,
    activeSourceIds,
    activeVersionByGroup,
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
    handleLibrarySourcesLoad,
    handleLibrarySourcesMerge,
    handleModelSelect,
    handleRefreshLatest,
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
    loadSourceMentions,
    messageGroups,
    olderMessagesCursor,
    persistActiveSourceIds,
    previewArtifact,
    previewCitation,
    previewSource,
    previewWorkfile,
    searchEnabled,
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
    toggleSourcesVisible,
    workfilesRefreshKey,
    workspaceId,
    workspaceName,
  };
}
