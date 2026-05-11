import { toast } from "sonner";
import type { PromptInputMentionSourceLoader } from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import type { SourceItem } from "../source-types";
import { Composer } from "./composer";
import { EmptyState } from "./empty-state";
import { MessageList } from "./message-list";
import type {
  ChatSendInput,
  ChatSkillItem,
  ChatToolName,
  CitationRecord,
  ImageModelCapabilities,
  PromptThinkingCapabilities,
  PromptThinkingSettings,
  VersionedMessageGroup,
} from "./types";

export function ChatCanvas({
  activeVersionByGroup = {},
  composerInitialInput,
  composerResetKey,
  highlightedMessageId = null,
  isEditing = false,
  isStreaming = false,
  messageGroups = [],
  mode,
  sourcesVisible,
  threadTitle,
  onActiveVersionChange,
  onCancelEditing,
  onCitationClick,
  onSourcePreview,
  onWorkfileClick,
  onRestartFromMessage,
  onRefreshLatest,
  onSendMessage,
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
  composerInitialInput?: string;
  composerResetKey?: number;
  highlightedMessageId?: string | null;
  isEditing?: boolean;
  isStreaming?: boolean;
  messageGroups?: VersionedMessageGroup[];
  mode: "thread" | "new";
  sourcesVisible: boolean;
  threadTitle: string;
  onActiveVersionChange?: (input: {
    groupId: string;
    branchIndex: number;
  }) => void;
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
            initialInput={composerInitialInput}
            isEditing={isEditing}
            inputKey={threadTitle + "-" + (composerResetKey ?? 0)}
            onCancelEditing={onCancelEditing}
            onRemoveSource={onRemoveSource}
            onSkillSelectionChange={onSkillSelectionChange}
            onSearchEnabledChange={onSearchEnabledChange}
            onSubmit={(message, tools) =>
              handleSendMessage({
                content: message.text.trim(),
                mentionedSourceIds: message.mentionedSourceIds,
                tools,
              })
            }
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
