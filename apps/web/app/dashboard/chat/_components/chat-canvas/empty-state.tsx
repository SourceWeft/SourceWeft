import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "@sourceweft/ui-web/components/ai-elements/conversation";
import { Suggestion } from "@sourceweft/ui-web/components/ai-elements/suggestion";
import type { PromptInputMentionSourceLoader } from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import type { FileUIPart } from "ai";
import type { SourceItem } from "../source-types";
import { Composer } from "./composer";
import type {
  ChatSendInput,
  ChatSkillItem,
  ChatToolName,
  CapabilityCatalog,
  PromptThinkingCapabilities,
  PromptThinkingSettings,
} from "./types";
import type { ComposerOptionsState } from "./composer-options";

const starterSuggestions = [
  "Summarize the selected sources",
  "Compare the main claims across these documents",
  "What changed between these reports?",
  "List the strongest supporting evidence",
];

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
      mimeType: file.mediaType as
        "image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined,
    }));
}

export function EmptyState({
  composerDraftKey,
  workingFolderSlot,
  onSendMessage,
  composerInitialInput,
  composerResetKey,
  allSources,
  sourceMentionLoader,
  selectedSources,
  availableSkills,
  capabilityCatalog,
  selectedSkillIds,
  selectedMcpInstallIds,
  selectedMcpToolIds,
  onRemoveSource,
  onSkillSelectionChange,
  submitDisabled = false,
  searchEnabled,
  onSearchEnabledChange,
  thinkingCapabilities,
  thinkingSettings,
  onThinkingSettingsChange,
  modelCapabilities,
  imageModelAvailable,
  imageModelAlias,
  notionConnectorId = null,
  activeConnectorIds,
  disabledToolNames = [],
  onDisabledToolNamesChange,
  onStopStreaming,
  isStopping = false,
  composerOptions,
  onComposerOptionsChange,
}: {
  composerDraftKey?: string;
  workingFolderSlot?: import("react").ReactNode;
  onSendMessage: (input: ChatSendInput) => void;
  composerInitialInput?: string;
  composerResetKey?: number;
  allSources: SourceItem[];
  sourceMentionLoader?: PromptInputMentionSourceLoader;
  selectedSources: SourceItem[];
  availableSkills?: ChatSkillItem[];
  capabilityCatalog?: CapabilityCatalog | null;
  selectedSkillIds?: string[];
  selectedMcpInstallIds?: string[];
  selectedMcpToolIds?: string[];
  onRemoveSource: (id: string) => void;
  onSkillSelectionChange?: (skillIds: string[]) => void;
  submitDisabled?: boolean;
  searchEnabled?: boolean;
  onSearchEnabledChange?: (enabled: boolean) => void;
  thinkingCapabilities?: PromptThinkingCapabilities;
  thinkingSettings?: PromptThinkingSettings;
  onThinkingSettingsChange?: (settings: PromptThinkingSettings) => void;
  modelCapabilities?: Record<string, unknown>;
  imageModelAvailable?: boolean;
  imageModelAlias?: string | null;
  notionConnectorId?: string | null;
  activeConnectorIds?: Record<string, string | null>;
  disabledToolNames?: ChatToolName[];
  onDisabledToolNamesChange?: (toolNames: ChatToolName[]) => void;
  onStopStreaming?: () => void;
  isStopping?: boolean;
  composerOptions?: ComposerOptionsState;
  onComposerOptionsChange?: (options: ComposerOptionsState) => void;
}) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <Conversation className="h-full min-h-0 flex-1 overflow-hidden">
        <ConversationContent className="flex min-h-full items-center justify-center px-4 py-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col items-start justify-center gap-8">
            <ConversationEmptyState className="w-full items-start gap-4 p-0 text-left">
              <div className="space-y-2">
                <p className="chat-empty-eyebrow text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  New chat
                </p>
                <div className="space-y-3">
                  <h1 className="chat-empty-title max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                    Work with your agent across your selected sources.
                  </h1>
                  <p className="chat-empty-description max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                    Start with a prompt, compare evidence, or have the agent
                    synthesize what matters most before you open a thread.
                  </p>
                </div>
              </div>
              <div className="flex w-full flex-wrap items-start gap-2 pt-2">
                {starterSuggestions.map((suggestion) => (
                  <Suggestion
                    className="h-auto max-w-full rounded-full border-border/70 bg-background px-4 py-2 text-sm text-muted-foreground whitespace-normal hover:bg-muted hover:text-foreground"
                    key={suggestion}
                    onClick={(content) => onSendMessage({ content })}
                    suggestion={suggestion}
                    variant="outline"
                  />
                ))}
              </div>
            </ConversationEmptyState>
          </div>
        </ConversationContent>
      </Conversation>

      <div className="shrink-0 border-t border-border/60 bg-background/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <Composer
            draftKey={composerDraftKey}
            workingFolderSlot={workingFolderSlot}
            className="w-full"
            allSources={allSources}
            sourceMentionLoader={sourceMentionLoader}
            submitDisabled={submitDisabled}
            isStopping={isStopping}
            initialInput={composerInitialInput}
            inputKey={composerResetKey}
            onRemoveSource={onRemoveSource}
            onSkillSelectionChange={onSkillSelectionChange}
            onSubmit={(
              message,
              tools,
              command,
              skillIds,
              content,
              invocation,
            ) =>
              onSendMessage({
                content: content ?? message.text.trim(),
                images: promptFilesToImages(message.files),
                mentionedSourceIds: message.mentionedSourceIds,
                skillIds,
                tools,
                command,
                invocation,
              })
            }
            onStopStreaming={onStopStreaming}
            onSearchEnabledChange={onSearchEnabledChange}
            onThinkingSettingsChange={onThinkingSettingsChange}
            placeholder="Message your documents, links, or connected tools..."
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
        </div>
      </div>
    </section>
  );
}
