import type { UIMessage } from "ai";
import { useState } from "react";
import {
  ArrowUp,
  Copy,
  FileText,
  Settings2,
  RotateCcw,
  Search,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@sourceweft/ui-web/components/ai-elements/conversation";
import {
  MessageAction,
  MessageActions,
  Message,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from "@sourceweft/ui-web/components/ai-elements/message";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@sourceweft/ui-web/components/ai-elements/attachments";
import {
  PromptInputBody,
  PromptInputHeader,
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTab,
  PromptInputTabsList,
  PromptInputTextarea,
  PromptInputTools,
} from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import {
  Suggestion,
  Suggestions,
} from "@sourceweft/ui-web/components/ai-elements/suggestion";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@sourceweft/ui-web/components/ai-elements/sources";
import { librarySources, messages } from "./mock-data";
import type { SourceItem } from "./mock-data";

const starterSuggestions = [
  "Summarize the selected sources",
  "Compare the main claims across these documents",
  "What changed between these reports?",
  "List the strongest supporting evidence",
];

function truncateTitle(title: string, max = 20): string {
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

function toAttachmentData(source: SourceItem) {
  return {
    id: source.id,
    mediaType: source.type,
    subtitle: source.meta,
    title: source.title,
  };
}

function Composer({
  placeholder,
  onSubmit,
  className,
  selectedSources = [],
  onRemoveSource,
}: {
  placeholder?: string;
  onSubmit?: () => void;
  className?: string;
  selectedSources?: SourceItem[];
  onRemoveSource?: (id: string) => void;
}) {
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [interactionMode, setInteractionMode] = useState<"ask" | "agent">(
    "ask",
  );
  const visible = selectedSources.slice(0, 2);
  const overflow = selectedSources.length - 2;
  const hasSelectedSources = selectedSources.length > 0;

  return (
    <div className={className}>
      <div className="w-full">
        <PromptInput>
          {hasSelectedSources ? (
            <PromptInputHeader>
              <Attachments className="gap-2.5 pt-0.5" variant="inline">
                {visible.map((source) => (
                  <Attachment
                    className="rounded-2xl bg-muted/55 px-3.5 py-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)]"
                    data={toAttachmentData(source)}
                    key={source.id}
                    onRemove={() => onRemoveSource?.(source.id)}
                  >
                    <AttachmentPreview
                      className="text-foreground/75"
                      fallbackIcon={<FileText className="size-4" />}
                    />
                    <AttachmentInfo className="max-w-[220px] text-[13px] font-medium" />
                    <AttachmentRemove
                      className="text-foreground/55 hover:bg-background/60"
                      label={`Remove ${source.title}`}
                    />
                  </Attachment>
                ))}
                {overflow > 0 && (
                  <Attachment
                    className="rounded-2xl bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground"
                    data={{
                      id: "overflow",
                      title: `+${overflow} more`,
                    }}
                  >
                    +{overflow} more
                  </Attachment>
                )}
              </Attachments>
            </PromptInputHeader>
          ) : null}
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={
                placeholder ||
                "Ask about your documents, links, or connected tools..."
              }
            />
          </PromptInputBody>
          <PromptInputFooter className="border-t-0">
            <PromptInputTools className="justify-between gap-4">
              <div className="flex min-w-0 items-center gap-1.5">
                <PromptInputButton
                  className="rounded-xl text-muted-foreground hover:text-foreground"
                  size="icon-sm"
                  tooltip="Settings"
                  type="button"
                  variant="ghost"
                >
                  <Settings2 className="size-4" />
                  <span className="sr-only">Open settings</span>
                </PromptInputButton>

                <PromptInputButton
                  aria-pressed={searchEnabled}
                  className={
                    searchEnabled
                      ? "rounded-xl text-foreground shadow-xs"
                      : "rounded-xl text-muted-foreground hover:text-foreground"
                  }
                  onClick={() => setSearchEnabled((value) => !value)}
                  size="icon-sm"
                  tooltip={{ content: "Search sources", shortcut: "S" }}
                  type="button"
                  variant={searchEnabled ? "secondary" : "ghost"}
                >
                  <Search className="size-4" />
                  <span className="sr-only">Search</span>
                </PromptInputButton>
              </div>

              <PromptInputTabsList className="shrink-0 gap-0.5 bg-transparent p-0.5">
                <PromptInputTab>
                  <PromptInputButton
                    className={
                      interactionMode === "ask"
                        ? "rounded-lg px-2.5 text-foreground shadow-xs"
                        : "rounded-lg px-2.5 text-muted-foreground hover:text-foreground"
                    }
                    onClick={() => setInteractionMode("ask")}
                    size="sm"
                    type="button"
                    variant={interactionMode === "ask" ? "secondary" : "ghost"}
                  >
                    Ask
                  </PromptInputButton>
                </PromptInputTab>
                <PromptInputTab>
                  <PromptInputButton
                    className={
                      interactionMode === "agent"
                        ? "rounded-lg px-2.5 text-foreground shadow-xs"
                        : "rounded-lg px-2.5 text-muted-foreground hover:text-foreground"
                    }
                    onClick={() => setInteractionMode("agent")}
                    size="sm"
                    type="button"
                    variant={
                      interactionMode === "agent" ? "secondary" : "ghost"
                    }
                  >
                    Agent
                  </PromptInputButton>
                </PromptInputTab>
              </PromptInputTabsList>

              <PromptInputSubmit
                className="size-9 shrink-0 rounded-full px-0 shadow-xs"
                onClick={onSubmit}
                type="button"
              >
                <ArrowUp className="size-4" />
                <span className="sr-only">Send</span>
              </PromptInputSubmit>
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

function EmptyState({
  onSelectThread,
  selectedSources,
  onRemoveSource,
}: {
  onSelectThread: (title?: string) => void;
  selectedSources: SourceItem[];
  onRemoveSource: (id: string) => void;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          <div className="mx-auto flex min-h-full w-full max-w-3xl px-6 pt-8 pb-4">
            <ConversationEmptyState
              className="justify-center gap-3 py-0"
              description="Ask about your selected sources and every answer will stay anchored to them."
              title="Start a grounded conversation"
            >
              <Suggestions className="gap-1.5 pt-1">
                {starterSuggestions.map((suggestion) => (
                  <Suggestion
                    className="border-border/70 bg-background/70 text-muted-foreground hover:text-foreground"
                    key={suggestion}
                    onClick={() => onSelectThread(suggestion)}
                    suggestion={suggestion}
                  />
                ))}
              </Suggestions>
            </ConversationEmptyState>
          </div>
        </ConversationContent>
      </Conversation>

      <div className="border-t border-border bg-background px-6 py-4">
        <Composer
          className="mx-auto w-full max-w-3xl"
          onRemoveSource={onRemoveSource}
          onSubmit={() => onSelectThread("New conversation")}
          placeholder="Ask about your sources..."
          selectedSources={selectedSources}
        />
      </div>
    </section>
  );
}

export function ChatCanvas({
  mode,
  sourcesVisible,
  threadTitle,
  onSelectThread,
  selectedSources = [],
  onRemoveSource,
}: {
  mode: "thread" | "new";
  sourcesVisible: boolean;
  threadTitle: string;
  onSelectThread: (title?: string) => void;
  selectedSources?: SourceItem[];
  onRemoveSource?: (id: string) => void;
}) {
  void sourcesVisible;

  if (mode === "new") {
    return (
      <EmptyState
        onRemoveSource={onRemoveSource ?? (() => undefined)}
        onSelectThread={onSelectThread}
        selectedSources={selectedSources}
      />
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 px-6 py-6">
            {messages.map((message, messageIndex) =>
              message.parts.map((part, partIndex) => {
                if (part.type !== "text") {
                  return null;
                }

                const isAssistant = message.role === "assistant";
                const isLastMessage = messageIndex === messages.length - 1;

                return (
                  <div
                    className={isAssistant ? "space-y-2" : "flex justify-end"}
                    key={`${message.id}-${partIndex}`}
                  >
                    <Message
                      className={
                        isAssistant
                          ? "max-w-[85%]"
                          : "w-auto max-w-[80%] items-end"
                      }
                      from={message.role}
                    >
                      {isAssistant ? (
                        <Sources className="max-w-full">
                          <SourcesTrigger count={3} />
                          <SourcesContent>
                            {librarySources.slice(0, 3).map((source) => (
                              <Source
                                href="#"
                                key={source.id}
                                title={source.title}
                              />
                            ))}
                          </SourcesContent>
                        </Sources>
                      ) : null}

                      <MessageContent
                        className={
                          isAssistant
                            ? "max-w-none"
                            : "rounded-3xl bg-secondary px-4 py-3 text-foreground shadow-sm"
                        }
                      >
                        <MessageResponse>{part.text}</MessageResponse>
                      </MessageContent>
                    </Message>

                    {isAssistant && isLastMessage ? (
                      <MessageToolbar className="mt-1 items-center text-xs text-muted-foreground">
                        <div />
                        <MessageActions>
                          <MessageAction
                            className="text-muted-foreground hover:text-foreground"
                            label="Copy"
                            size="icon-sm"
                            tooltip="Copy"
                            type="button"
                            variant="ghost"
                          >
                            <Copy className="size-3" />
                          </MessageAction>
                          <MessageAction
                            className="text-muted-foreground hover:text-foreground"
                            label="Retry"
                            size="icon-sm"
                            tooltip="Retry"
                            type="button"
                            variant="ghost"
                          >
                            <RotateCcw className="size-3" />
                          </MessageAction>
                        </MessageActions>
                      </MessageToolbar>
                    ) : null}
                  </div>
                );
              }),
            )}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-border bg-background px-6 py-4">
        <Composer
          className="mx-auto w-full max-w-3xl"
          onRemoveSource={onRemoveSource}
          onSubmit={() => onSelectThread(threadTitle)}
          selectedSources={selectedSources}
        />
      </div>
    </section>
  );
}
