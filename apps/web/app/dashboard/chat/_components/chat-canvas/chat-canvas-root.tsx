import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  getActiveToolConfirmationItems,
  ToolInterventionBar,
  type ToolConfirmationIntervention,
} from "./tool-confirmation";
import type {
  ArtifactPreviewRecord,
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

function findToolConfirmationResumeTarget(input: {
  activeVersionByGroup: Record<string, number>;
  messageGroups: VersionedMessageGroup[];
  messageId: string;
}) {
  for (const group of input.messageGroups) {
    if (group.role !== "assistant") {
      continue;
    }

    const branchIndex = group.versions.findIndex(
      (version) => version.id === input.messageId,
    );
    const version = group.versions[branchIndex];
    if (!version) {
      continue;
    }

    return {
      groupId: group.groupId,
      assistantMessageId: version.id,
      branchIndex:
        branchIndex >= 0
          ? branchIndex
          : (input.activeVersionByGroup[group.groupId] ??
            Math.max(group.versions.length - 1, 0)),
    };
  }

  return null;
}

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
  composerInitialCommand = null,
  composerInitialInput,
  composerResetKey,
  editingMessageId = null,
  highlightedMessageId = null,
  hasOlderMessages = false,
  isEditing = false,
  isLoadingOlderMessages = false,
  isStreaming = false,
  isStopping = false,
  messageGroups = [],
  mode,
  sourcesVisible,
  threadTitle,
  onActiveVersionChange,
  onArtifactPreview,
  onCancelEditing,
  onCitationClick,
  onLoadOlderMessages,
  onSourcePreview,
  onWorkfileClick,
  onRestartFromMessage,
  onRefreshLatest,
  onSendMessage,
  onStopStreaming,
  allSources = [],
  sourceMentionLoader,
  selectedSources = [],
  availableSkills = [],
  selectedSkillIds = [],
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
    toolApprovalResume?: ToolApprovalResume | null;
  }) => void;
  onSendMessage?: (input: ChatSendInput) => void;
  onStopStreaming?: () => void;
  allSources?: SourceItem[];
  sourceMentionLoader?: PromptInputMentionSourceLoader;
  selectedSources?: SourceItem[];
  availableSkills?: ChatSkillItem[];
  selectedSkillIds?: string[];
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
  const [activeIntervention, setActiveIntervention] =
    useState<ToolConfirmationIntervention | null>(null);
  const handledInterventionSignalIdRef = useRef<string | null>(null);
  const activeConfirmationItems = useMemo(
    () => getActiveToolConfirmationItems(messageGroups, activeVersionByGroup),
    [activeVersionByGroup, messageGroups],
  );

  useEffect(() => {
    if (
      !toolConfirmationInterventionSignal ||
      handledInterventionSignalIdRef.current ===
        toolConfirmationInterventionSignal.id ||
      activeConfirmationItems.length === 0
    ) {
      return;
    }
    const next = activeConfirmationItems[0];
    if (!next) {
      return;
    }
    handledInterventionSignalIdRef.current =
      toolConfirmationInterventionSignal.id;
    setActiveIntervention({
      id: next.confirmation.id,
      messageId: next.messageId,
      toolCallId: next.toolCall.id,
    });
  }, [activeConfirmationItems, toolConfirmationInterventionSignal]);

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
    onSendMessage?.(input);
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <MessageList
        activeVersionByGroup={activeVersionByGroup}
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
        workspaceId={workspaceId}
      />

      <ToolInterventionBar
        activeIntervention={activeIntervention}
        activeVersionByGroup={activeVersionByGroup}
        messageGroups={messageGroups}
        onInterventionSettled={({ result, item }) => {
          setActiveIntervention(null);
          const resumeTarget = findToolConfirmationResumeTarget({
            activeVersionByGroup,
            messageGroups,
            messageId: item.messageId,
          });
          if (resumeTarget) {
            onRefreshLatest?.({
              groupId: resumeTarget.groupId,
              assistantMessageId: resumeTarget.assistantMessageId,
              branchIndex: resumeTarget.branchIndex,
              toolApprovalResume: result.resume ?? null,
            });
          }
        }}
        workspaceId={workspaceId}
      />

      <div className="border-t border-border/60 bg-background/95 px-6 py-5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <Composer
            className="w-full"
            allSources={allSources}
            sourceMentionLoader={sourceMentionLoader}
            disabled={isStreaming}
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
            ) =>
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
