import { useMemo } from "react";
import { toast } from "sonner";
import type { FileUIPart } from "ai";
import type { PromptInputMentionSourceLoader } from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import type { SourceItem } from "../source-types";
import { Composer } from "./composer";
import { EmptyState } from "./empty-state";
import { MessageList } from "./message-list";
import { getMessageImageParts, normalizeAssetUrl } from "./message-assets";
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

export function ChatCanvas({
  activeVersionByGroup = {},
  composerInitialCommand = null,
  composerInitialInput,
  composerResetKey,
  editingMessageId = null,
  highlightedMessageId = null,
  isEditing = false,
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
  onThinkingSettingsChange,
  imageCapabilities,
  imageModelAvailable,
  imageModelAlias,
  disabledToolNames = [],
  onDisabledToolNamesChange,
}: {
  activeVersionByGroup?: Record<string, number>;
  composerInitialCommand?: ChatSendInput["command"] | null;
  composerInitialInput?: string;
  composerResetKey?: number;
  editingMessageId?: string | null;
  highlightedMessageId?: string | null;
  isEditing?: boolean;
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
  onThinkingSettingsChange?: (settings: PromptThinkingSettings) => void;
  imageCapabilities?: ImageModelCapabilities;
  imageModelAvailable?: boolean;
  imageModelAlias?: string | null;
  disabledToolNames?: ChatToolName[];
  onDisabledToolNamesChange?: (toolNames: ChatToolName[]) => void;
}) {
  void sourcesVisible;
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

  function handleSendMessage(input: ChatSendInput) {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }
    onSendMessage?.(input);
  }

  if (mode === "new") {
    return (
      <EmptyState
        composerInitialInput={composerInitialInput}
        composerResetKey={composerResetKey}
        allSources={allSources}
        sourceMentionLoader={sourceMentionLoader}
        onRemoveSource={onRemoveSource ?? (() => undefined)}
        onSkillSelectionChange={onSkillSelectionChange}
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
        disabledToolNames={disabledToolNames}
        onDisabledToolNamesChange={onDisabledToolNamesChange}
      />
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <MessageList
        activeVersionByGroup={activeVersionByGroup}
        allSources={allSources}
        highlightedMessageId={highlightedMessageId}
        isStreaming={isStreaming}
        messageGroups={messageGroups}
        onActiveVersionChange={onActiveVersionChange}
        onArtifactPreview={onArtifactPreview}
        onCitationClick={onCitationClick}
        onRefreshLatest={onRefreshLatest}
        onRestartFromMessage={onRestartFromMessage}
        onSourcePreview={onSourcePreview}
        onWorkfileClick={onWorkfileClick}
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
            onRemoveSource={onRemoveSource}
            onSkillSelectionChange={onSkillSelectionChange}
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
            disabledToolNames={disabledToolNames}
            onDisabledToolNamesChange={onDisabledToolNamesChange}
          />
        </div>
      </div>
    </section>
  );
}
