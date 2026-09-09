"use client";

import { useMemo } from "react";
import { ChatCanvas } from "../../_components/chat-canvas";
import { ChatErrorNotice } from "../../_components/chat-canvas/chat-error-notice";
import { selectedModelCapabilities } from "../../_components/model-catalog-utils";
import { ChatCanvasPanelSkeleton } from "../../../../_components/route-loading-skeleton";
import type { ChatUiState } from "../../_components/chat-ui-state";
import { ThreadDialogs } from "./thread-dialogs";
import { ThreadHeader } from "./thread-header";
import { LocalExecutionSelector } from "../../_components/local-execution-selector";
import { ThreadPresenceAvatars } from "./thread-presence-avatars";
import { ThreadTypingIndicator } from "./thread-typing-indicator";
import { ThreadSidePanels } from "./thread-side-panels";
import type { useThreadPageController } from "./use-thread-page-controller";
import {
  useChatHubContext,
  useRegisterChatHub,
  type ChatHubRegistration,
} from "../../_components/chat-hub-context";

function ModelCatalogErrorState() {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background px-6 py-10">
      <div className="max-w-sm text-center">
        <h2 className="text-sm font-semibold text-foreground">
          Model catalog failed to load
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Refresh the page before sending a message.
        </p>
      </div>
    </section>
  );
}

function ThreadUnavailableState() {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background px-6 py-10">
      <div className="max-w-sm text-center">
        <h2 className="text-sm font-semibold text-foreground">
          Thread unavailable
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This chat may have been deleted, moved, or you may no longer have
          access to it.
        </p>
      </div>
    </section>
  );
}

function shouldRenderThreadSkeleton(chatUiState: ChatUiState) {
  return (
    chatUiState.skeletonPolicy === "canvas" ||
    chatUiState.skeletonPolicy === "overlay"
  );
}

export function DashboardChatThreadPageView({
  activeAssistantVersion,
  assistantVersionById,
  activeThreadRun,
  otherUserRunActive,
  presentViewers,
  typingViewers,
  onComposerType,
  queuedSends,
  onCancelQueuedSend,
  chatExecutionState,
  chatUiState,
  activeConnectorTools,
  activeCitationIndex,
  activeMcpInstallIds,
  activeMcpToolIds,
  activeSkillIds,
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
  handleComposerOptionsChange,
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
  initialSourcesForWorkspace,
  isDesktopPanel,
  isLoadingOlderMessages,
  isPersistentLayout,
  isStopping,
  isStreaming,
  librarySources,
  loadAvailableSkills,
  loadOlderThreadMessages,
  loadThreadMessages,
  latestRunFailure,
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
  handleSkillSelectionChange,
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
}: ReturnType<typeof useThreadPageController>) {
  const chatHubContext = useChatHubContext();
  const chatHubRegistration = useMemo<ChatHubRegistration>(
    () => ({
      activeCitationIndex,
      activeCitationMessageId: activeAssistantVersion?.id ?? null,
      activeMcpInstallIds,
      activeMcpToolIds,
      activeSkillIds,
      activeSourceIds,
      artifactsRefreshKey,
      availableSkills,
      hubSkills,
      capabilityCatalog,
      disabledToolNames,
      displayedCitations,
      initialSources: initialSourcesForWorkspace,
      initialSourcesLoaded: hasCachedWorkspaceSources(workspaceId),
      mode: "thread",
      onArtifactOpen: setPreviewArtifact,
      onArtifactPreviewClose: () => setPreviewArtifact(null),
      onCitationLocate: scrollToMessage,
      onCitationOpen: handleSourceHubCitationOpen,
      onConnectorsChange: handleConnectorsChange,
      onMcpSelectionChange: handleMcpSelectionChange,
      onSelectionChange: persistActiveSourceIds,
      onSkillSelectionChange: handleSkillSelectionChange,
      onSkillsCatalogChange: loadAvailableSkills,
      onSourceLoad: handleLibrarySourcesLoad,
      onSourceMerge: handleLibrarySourcesMerge,
      previewArtifact,
      threadCitations,
      threadId,
      workfilesRefreshKey,
      workspaceId,
      workspaceName,
    }),
    [
      activeAssistantVersion?.id,
      activeCitationIndex,
      activeMcpInstallIds,
      activeMcpToolIds,
      activeSkillIds,
      activeSourceIds,
      artifactsRefreshKey,
      availableSkills,
      hubSkills,
      capabilityCatalog,
      disabledToolNames,
      displayedCitations,
      handleConnectorsChange,
      handleLibrarySourcesLoad,
      handleLibrarySourcesMerge,
      handleMcpSelectionChange,
      handleSourceHubCitationOpen,
      hasCachedWorkspaceSources,
      initialSourcesForWorkspace,
      loadAvailableSkills,
      persistActiveSourceIds,
      previewArtifact,
      scrollToMessage,
      handleSkillSelectionChange,
      setPreviewArtifact,
      threadCitations,
      threadId,
      workfilesRefreshKey,
      workspaceId,
      workspaceName,
    ],
  );
  useRegisterChatHub(chatHubRegistration);

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ThreadHeader
          availableModels={availableModels}
          byokCredentials={byokCredentials}
          byokModels={byokModels}
          byokProviders={byokProviders}
          byokSelections={selectedByokModels}
          isModelCatalogLoading={chatUiState.status === "model-loading"}
          isPersistentLayout={isPersistentLayout}
          onAddByokModel={setByokModelConfig}
          onByokSelect={handleThreadByokSelect}
          onModelSelect={handleModelSelect}
          onOpenHub={() => {
            chatHubContext?.setMobileHubOpen(true);
          }}
          onToggleSources={toggleSourcesVisible}
          presenceSlot={<ThreadPresenceAvatars viewers={presentViewers} />}
          selectedModels={selectedModels}
          setSelectedModels={setSelectedModels}
          sourcesVisible={sourcesVisible}
          threadTitle={threadTitle}
        />

        <LocalExecutionSelector workspaceId={workspaceId} threadId={threadId} />
        {latestRunFailure && !activeThreadRun && !isStreaming && (
          <div className="shrink-0 px-4 pt-3">
            <ChatErrorNotice
              title="Message could not be started"
              message={latestRunFailure.errorMessage}
              code={latestRunFailure.errorCode}
            />
          </div>
        )}

        {chatUiState.status === "model-error" ? (
          <ModelCatalogErrorState />
        ) : chatUiState.status === "empty" &&
          chatUiState.errorKind === "thread" ? (
          <ThreadUnavailableState />
        ) : shouldRenderThreadSkeleton(chatUiState) ? (
          <ChatCanvasPanelSkeleton variant="thread" />
        ) : (
          <ChatCanvas
            activeVersionByGroup={activeVersionByGroup}
            assistantVersionById={assistantVersionById}
            activeThreadRun={activeThreadRun}
            otherUserRunActive={otherUserRunActive}
            typingIndicator={<ThreadTypingIndicator typing={typingViewers} />}
            onComposerType={onComposerType}
            queuedSends={queuedSends}
            onCancelQueuedSend={onCancelQueuedSend}
            chatExecutionState={chatExecutionState}
            allSources={librarySources}
            availableSkills={availableSkills}
            capabilityCatalog={capabilityCatalog}
            composerInitialCommand={composerInitialCommand}
            composerInitialInput={composerInitialInput}
            composerResetKey={composerResetKey}
            composerOptions={composerOptions}
            editingMessageId={editingMessageId}
            highlightedMessageId={highlightedMessageId}
            hasOlderMessages={Boolean(olderMessagesCursor)}
            isEditing={Boolean(editingMessageId && editingGroupId)}
            isLoadingOlderMessages={isLoadingOlderMessages}
            isStreaming={isStreaming}
            isStopping={isStopping}
            messageGroups={messageGroups}
            mode="thread"
            onActiveVersionChange={handleActiveVersionChange}
            artifactStatuses={artifactStatuses}
            onArtifactPreview={handleArtifactPreview}
            onCancelEditing={cancelEditing}
            onComposerOptionsChange={handleComposerOptionsChange}
            onCitationClick={handleCitationClick}
            onSourcePreview={handleSourcePreview}
            onWorkfileClick={handleWorkfilePreview}
            onRemoveSource={(id) =>
              persistActiveSourceIds(activeSourceIds.filter((x) => x !== id))
            }
            onRefreshLatest={handleRefreshLatest}
            onResumeToolConfirmation={handleResumeToolConfirmation}
            onRestartFromMessage={handleRestartFromMessage}
            onSendMessage={handleSendMessage}
            onSkillSelectionChange={handleSkillSelectionChange}
            onStopStreaming={handleStopStreaming}
            searchEnabled={searchEnabled}
            onSearchEnabledChange={setSearchEnabled}
            sourceMentionLoader={loadSourceMentions}
            selectedSources={selectedSources}
            selectedSkillIds={activeSkillIds}
            selectedMcpInstallIds={activeMcpInstallIds}
            selectedMcpToolIds={activeMcpToolIds}
            sourcesVisible={sourcesVisible}
            thinkingCapabilities={selectedModels.llm?.capabilities}
            toolConfirmationInterventionSignal={
              toolConfirmationInterventionSignal
            }
            modelCapabilities={selectedModelCapabilities(selectedModels)}
            imageModelAvailable={Boolean(selectedModels.image)}
            imageModelAlias={selectedModels.image?.modelAlias ?? null}
            notionConnectorId={activeConnectorTools.notionConnectorId}
            activeConnectorIds={activeConnectorTools.activeConnectorIds}
            disabledToolNames={disabledToolNames}
            onDisabledToolNamesChange={setDisabledToolNames}
            onLoadOlderMessages={() => void loadOlderThreadMessages()}
            onReloadMessages={loadThreadMessages}
            thinkingSettings={thinkingSettings}
            onThinkingSettingsChange={handleThinkingSettingsChange}
            threadTitle={threadTitle}
            workspaceId={workspaceId}
          />
        )}
      </div>

      <ThreadSidePanels
        isDesktopPanel={isDesktopPanel}
        onArtifactPreviewClose={() => setPreviewArtifact(null)}
        previewArtifact={previewArtifact}
        sourcesVisible={sourcesVisible}
        workspaceId={workspaceId}
      />

      <ThreadDialogs
        byokCredentials={byokCredentials}
        byokModelConfig={byokModelConfig}
        byokProviders={byokProviders}
        onByokConfigured={({ model, selection, type }) => {
          if (!model || !selection) {
            return;
          }
          handleThreadByokSelect({ model, selection, type });
        }}
        onByokModelConfigOpenChange={(open) => {
          if (!open) {
            setByokModelConfig(null);
          }
        }}
        onByokStateChange={({ credentials, models, providers }) => {
          setByokCredentials(credentials);
          setByokModels(models);
          setByokProviders(providers);
        }}
        onPreviewSourceOpenChange={(open) => {
          if (!open) {
            setPreviewCitation(null);
            setPreviewSource(null);
          }
        }}
        onPreviewWorkfileOpenChange={(open) => {
          if (!open) {
            setPreviewWorkfile(null);
          }
        }}
        onShortcutsOpenChange={setShortcutsOpen}
        previewCitation={previewCitation}
        previewSource={previewSource}
        previewWorkfile={previewWorkfile}
        shortcutDefinitions={shortcutDefinitions}
        shortcutsOpen={shortcutsOpen}
        workspaceId={workspaceId}
      />
    </div>
  );
}
