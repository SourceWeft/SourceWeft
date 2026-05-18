"use client";

import { ChatCanvas } from "../../_components/chat-canvas";
import { ThreadDialogs } from "./thread-dialogs";
import { ThreadHeader } from "./thread-header";
import { ThreadSidePanels } from "./thread-side-panels";
import type { useThreadPageController } from "./use-thread-page-controller";

export function DashboardChatThreadPageView({
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
}: ReturnType<typeof useThreadPageController>) {
  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ThreadHeader
          availableModels={availableModels}
          byokCredentials={byokCredentials}
          byokModels={byokModels}
          byokProviders={byokProviders}
          byokSelections={selectedByokModels}
          isPersistentLayout={isPersistentLayout}
          onAddByokModel={setByokModelConfig}
          onByokSelect={handleThreadByokSelect}
          onModelSelect={handleModelSelect}
          onOpenHub={() => setHubDrawerOpen(true)}
          onToggleSources={toggleSourcesVisible}
          selectedModels={selectedModels}
          setSelectedModels={setSelectedModels}
          sourcesVisible={sourcesVisible}
          threadTitle={threadTitle}
        />

        <ChatCanvas
          activeVersionByGroup={activeVersionByGroup}
          allSources={librarySources}
          availableSkills={availableSkills}
          composerInitialCommand={composerInitialCommand}
          composerInitialInput={composerInitialInput}
          composerResetKey={composerResetKey}
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
          onArtifactPreview={handleArtifactPreview}
          onCancelEditing={cancelEditing}
          onCitationClick={handleCitationClick}
          onSourcePreview={handleSourcePreview}
          onWorkfileClick={handleWorkfilePreview}
          onRemoveSource={(id) =>
            persistActiveSourceIds(activeSourceIds.filter((x) => x !== id))
          }
          onRefreshLatest={handleRefreshLatest}
          onRestartFromMessage={handleRestartFromMessage}
          onSendMessage={handleSendMessage}
          onSkillSelectionChange={setActiveSkillIds}
          onStopStreaming={handleStopStreaming}
          searchEnabled={searchEnabled}
          onSearchEnabledChange={setSearchEnabled}
          sourceMentionLoader={loadSourceMentions}
          selectedSources={selectedSources}
          selectedSkillIds={activeSkillIds}
          sourcesVisible={sourcesVisible}
          thinkingCapabilities={selectedModels.llm?.capabilities}
          imageCapabilities={
            selectedModels.image?.capabilities?.imageGeneration
          }
          imageModelAvailable={Boolean(selectedModels.image)}
          imageModelAlias={selectedModels.image?.modelAlias ?? null}
          disabledToolNames={disabledToolNames}
          onDisabledToolNamesChange={setDisabledToolNames}
          onLoadOlderMessages={() => void loadOlderThreadMessages()}
          thinkingSettings={thinkingSettings}
          onThinkingSettingsChange={handleThinkingSettingsChange}
          threadTitle={threadTitle}
          workspaceId={workspaceId}
        />
      </div>

      <ThreadSidePanels
        activeCitationIndex={activeCitationIndex}
        activeCitationMessageId={activeAssistantVersion?.id ?? null}
        activeSkillIds={activeSkillIds}
        activeSourceIds={activeSourceIds}
        artifactsRefreshKey={artifactsRefreshKey}
        availableSkills={availableSkills}
        disabledToolNames={disabledToolNames}
        displayedCitations={displayedCitations}
        hubDrawerOpen={hubDrawerOpen}
        initialSourcesForWorkspace={initialSourcesForWorkspace}
        initialSourcesLoaded={hasCachedWorkspaceSources(workspaceId)}
        isDesktopPanel={isDesktopPanel}
        isPersistentLayout={isPersistentLayout}
        loadAvailableSkills={loadAvailableSkills}
        onArtifactOpen={setPreviewArtifact}
        onArtifactPreviewClose={() => setPreviewArtifact(null)}
        onCitationLocate={scrollToMessage}
        onCitationOpen={handleSourceHubCitationOpen}
        onHubDrawerOpenChange={setHubDrawerOpen}
        onLibrarySourcesLoad={handleLibrarySourcesLoad}
        onLibrarySourcesMerge={handleLibrarySourcesMerge}
        onSelectionChange={persistActiveSourceIds}
        onSkillSelectionChange={setActiveSkillIds}
        previewArtifact={previewArtifact}
        sourcesVisible={sourcesVisible}
        threadCitations={threadCitations}
        threadId={threadId}
        workfilesRefreshKey={workfilesRefreshKey}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
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

