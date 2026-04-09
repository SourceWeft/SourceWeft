import type { UIMessage } from "ai";
import { useState } from "react";
import {
  ArrowUp,
  Copy,
  FileText,
  Pencil,
  RotateCcw,
  Search,
  Settings2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@sourceweft/ui-web/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
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
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
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
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { librarySources, messages } from "./mock-data";
import type { SourceItem } from "./mock-data";

const starterSuggestions = [
  "Summarize the selected sources",
  "Compare the main claims across these documents",
  "What changed between these reports?",
  "List the strongest supporting evidence",
];

function toAttachmentData(source: SourceItem) {
  return {
    id: source.id,
    mediaType: source.type,
    sourceId: source.id,
    subtitle: source.meta,
    title: source.title,
    type: "source-document" as const,
  };
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .reduce<string[]>((texts, part) => {
      if (part.type === "text") {
        texts.push(part.text);
      }
      return texts;
    }, [])
    .join("\n\n");
}

function Composer({
  placeholder,
  onSubmit,
  className,
  initialInput = "",
  inputKey,
  selectedSources = [],
  onRemoveSource,
}: {
  placeholder?: string;
  onSubmit?: (message: PromptInputMessage) => void;
  className?: string;
  initialInput?: string;
  inputKey?: string | number;
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
  const handlePromptSubmit = (message: PromptInputMessage) => {
    onSubmit?.(message);
  };

  return (
    <div className={className}>
      <PromptInputProvider initialInput={initialInput} key={inputKey}>
        <PromptInput onSubmit={handlePromptSubmit}>
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
                      mediaType: "text/plain",
                      sourceId: "overflow",
                      title: `+${overflow} more`,
                      type: "source-document",
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
            <PromptInputTools className="w-full flex-wrap gap-3">
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
                      ? "rounded-xl bg-foreground text-background shadow-sm hover:bg-foreground/90 hover:text-background"
                      : "rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
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

              <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <Tabs
                  className="gap-0"
                  onValueChange={(value) =>
                    setInteractionMode(value as "ask" | "agent")
                  }
                  value={interactionMode}
                >
                  <TabsList className="h-8 rounded-lg bg-muted/55 p-0.5">
                    <TabsTrigger
                      className="h-7 min-w-[56px] px-2.5 text-xs font-medium"
                      value="ask"
                    >
                      Ask
                    </TabsTrigger>
                    <TabsTrigger
                      className="h-7 min-w-[56px] px-2.5 text-xs font-medium"
                      value="agent"
                    >
                      Agent
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                <PromptInputSubmit className="size-9 shrink-0 rounded-full px-0 shadow-xs">
                  <ArrowUp className="size-4" />
                  <span className="sr-only">Send</span>
                </PromptInputSubmit>
              </div>
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>
      </PromptInputProvider>
    </div>
  );
}

function EmptyState({
  onSelectThread,
  composerInitialInput,
  composerResetKey,
  selectedSources,
  onRemoveSource,
}: {
  onSelectThread: (title?: string) => void;
  composerInitialInput?: string;
  composerResetKey?: number;
  selectedSources: SourceItem[];
  onRemoveSource: (id: string) => void;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="flex min-h-full items-center justify-center px-6 py-10">
          <div className="mx-auto flex w-full max-w-4xl flex-col items-start justify-center gap-8">
            <ConversationEmptyState className="w-full items-start gap-4 p-0 text-left">
              <div className="space-y-2">
                <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  New chat
                </p>
                <div className="space-y-3">
                  <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                    Ask grounded questions across your selected sources.
                  </h1>
                  <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                    Start with a question, compare evidence, or ask the
                    assistant to synthesize what matters most before you open a
                    thread.
                  </p>
                </div>
              </div>
              <Suggestions className="justify-start gap-2 pt-2">
                {starterSuggestions.map((suggestion) => (
                  <Suggestion
                    className="h-auto rounded-full border-border/70 bg-background px-4 py-2 text-sm text-muted-foreground whitespace-normal hover:bg-muted hover:text-foreground"
                    key={suggestion}
                    onClick={onSelectThread}
                    suggestion={suggestion}
                    variant="outline"
                  />
                ))}
              </Suggestions>
            </ConversationEmptyState>
          </div>
        </ConversationContent>
      </Conversation>

      <div className="border-t border-border/60 bg-background/95 px-6 py-5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <Composer
            className="w-full"
            initialInput={composerInitialInput}
            inputKey={composerResetKey}
            onRemoveSource={onRemoveSource}
            onSubmit={(message) =>
              onSelectThread(message.text.trim() || "New conversation")
            }
            placeholder="Ask about your documents, links, or connected tools..."
            selectedSources={selectedSources}
          />
        </div>
      </div>
    </section>
  );
}

export function ChatCanvas({
  composerInitialInput,
  composerResetKey,
  mode,
  sourcesVisible,
  threadTitle,
  onRestartFromMessage,
  onSelectThread,
  selectedSources = [],
  onRemoveSource,
}: {
  composerInitialInput?: string;
  composerResetKey?: number;
  mode: "thread" | "new";
  sourcesVisible: boolean;
  threadTitle: string;
  onRestartFromMessage?: (message: string) => void;
  onSelectThread: (title?: string) => void;
  selectedSources?: SourceItem[];
  onRemoveSource?: (id: string) => void;
}) {
  void sourcesVisible;

  if (mode === "new") {
    return (
      <EmptyState
        composerInitialInput={composerInitialInput}
        composerResetKey={composerResetKey}
        onRemoveSource={onRemoveSource ?? (() => undefined)}
        onSelectThread={onSelectThread}
        selectedSources={selectedSources}
      />
    );
  }

  const latestMessageId = messages.at(-1)?.id;
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const latestUserMessageId = latestUserMessage?.id;
  const latestUserMessageText = latestUserMessage
    ? getMessageText(latestUserMessage)
    : "";

  async function handleCopyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Message copied.");
    } catch {
      toast.error("Couldn't copy the message.");
    }
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="px-6 py-8">
          <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-4">
            {messages.map((message) =>
              message.parts.map((part, partIndex) => {
                if (part.type !== "text") {
                  return null;
                }

                const isAssistant = message.role === "assistant";
                const isLatestMessage = message.id === latestMessageId;
                const isLatestUserMessage = message.id === latestUserMessageId;
                const messageText = getMessageText(message);
                const toolbarVisibilityClass = isLatestMessage
                  ? "visible opacity-100"
                  : "invisible pointer-events-none opacity-0 transition-opacity group-hover/message:visible group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:visible group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100";

                return (
                  <div
                    className={cn(
                      "group/message flex flex-col gap-1",
                      !isAssistant && "items-end",
                    )}
                    key={`${message.id}-${partIndex}`}
                  >
                    <Message
                      className={cn(
                        isAssistant
                          ? "max-w-[85%]"
                          : "w-auto max-w-[80%] items-end",
                      )}
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

                    <MessageToolbar
                      className={cn(
                        "mt-0.5 min-h-7 px-1 text-xs text-muted-foreground transition-opacity duration-150",
                        isAssistant ? "justify-start" : "justify-end",
                        toolbarVisibilityClass,
                      )}
                    >
                      <MessageActions>
                        <MessageAction
                          className="text-muted-foreground hover:text-foreground"
                          label="Copy"
                          onClick={() => void handleCopyMessage(messageText)}
                          size="icon-sm"
                          tooltip="Copy"
                          type="button"
                          variant="ghost"
                        >
                          <Copy className="size-3" />
                        </MessageAction>

                        {!isAssistant && isLatestUserMessage ? (
                          <MessageAction
                            className="text-muted-foreground hover:text-foreground"
                            label="Edit prompt"
                            onClick={() => onRestartFromMessage?.(messageText)}
                            size="icon-sm"
                            tooltip="Edit and restart"
                            type="button"
                            variant="ghost"
                          >
                            <Pencil className="size-3" />
                          </MessageAction>
                        ) : null}

                        {isAssistant &&
                        isLatestMessage &&
                        latestUserMessageText ? (
                          <MessageAction
                            className="text-muted-foreground hover:text-foreground"
                            label="Refresh"
                            onClick={() =>
                              onSelectThread(latestUserMessageText)
                            }
                            size="icon-sm"
                            tooltip="Refresh"
                            type="button"
                            variant="ghost"
                          >
                            <RotateCcw className="size-3" />
                          </MessageAction>
                        ) : null}
                      </MessageActions>
                    </MessageToolbar>
                  </div>
                );
              }),
            )}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-border/60 bg-background/95 px-6 py-5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <Composer
            className="w-full"
            initialInput={composerInitialInput}
            inputKey={`${threadTitle}-${composerResetKey ?? 0}`}
            onRemoveSource={onRemoveSource}
            onSubmit={(message) =>
              onSelectThread(message.text.trim() || threadTitle)
            }
            selectedSources={selectedSources}
          />
        </div>
      </div>
    </section>
  );
}
