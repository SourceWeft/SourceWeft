import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowUp,
  Copy,
  FileText,
  Globe,
  Pencil,
  RotateCcw,
  Settings2,
  X,
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
  MessageBranch,
  MessageBranchContent,
  MessageBranchNext,
  MessageBranchPage,
  MessageBranchPrevious,
  MessageBranchSelector,
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
import { Shimmer } from "@sourceweft/ui-web/components/ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@sourceweft/ui-web/components/ai-elements/tool";
import { cn } from "@sourceweft/ui-web/lib/utils";
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

export type MessageVersion = {
  id: string;
  content: string;
  sourceUserMessageId?: string | null;
  toolCalls?: ToolCallRecord[];
};

export type ToolCallRecord = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  latencyMs: number | null;
  status: "running" | "completed" | "error";
  error: string | null;
};

export type VersionedMessageGroup = {
  groupId: string;
  turnId?: string;
  role: "user" | "assistant";
  versions: MessageVersion[];
  latestVersionId: string;
};

function getMessageText(version: MessageVersion): string {
  return version.content;
}

function Composer({
  isEditing = false,
  placeholder,
  onSubmit,
  onCancelEditing,
  className,
  initialInput = "",
  inputKey,
  selectedSources = [],
  onRemoveSource,
  disabled,
}: {
  isEditing?: boolean;
  placeholder?: string;
  onSubmit?: (message: PromptInputMessage) => void;
  onCancelEditing?: () => void;
  className?: string;
  initialInput?: string;
  inputKey?: string | number;
  selectedSources?: SourceItem[];
  onRemoveSource?: (id: string) => void;
  disabled?: boolean;
}) {
  const [searchEnabled, setSearchEnabled] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const visible = selectedSources.slice(0, 2);
  const overflow = selectedSources.length - 2;
  const hasSelectedSources = selectedSources.length > 0;

  useEffect(() => {
    if (!isEditing || disabled) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const textarea = rootRef.current?.querySelector(
        'textarea[name="message"]',
      ) as HTMLTextAreaElement | null;
      if (!textarea) {
        return;
      }

      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [disabled, isEditing, inputKey]);

  return (
    <div className={className} ref={rootRef}>
      <PromptInputProvider initialInput={initialInput} key={inputKey}>
        <PromptInput
          onSubmit={(message) => {
            if (disabled) {
              return;
            }
            (onSubmit ?? (() => undefined))(message);
          }}
        >
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
                autoFocus={isEditing && !disabled}
                onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                  if (isEditing && event.key === "Escape") {
                    event.preventDefault();
                    onCancelEditing?.();
                    return;
                  }

                  if (
                    disabled &&
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                  }
                }}
                placeholder={
                  placeholder ||
                  "Message your documents, links, or connected tools..."
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
                  <Globe className="size-4" />
                  <span className="sr-only">Search</span>
                </PromptInputButton>
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                {isEditing && onCancelEditing ? (
                  <PromptInputButton
                    className="size-7 rounded-full bg-muted/60 text-red-500/90 ring-1 ring-border/55 transition-colors hover:bg-muted/80 hover:text-red-500"
                    onClick={onCancelEditing}
                    size="icon-sm"
                    tooltip="Cancel edit (Esc)"
                    type="button"
                    variant="ghost"
                  >
                    <X className="size-3.5" />
                    <span className="sr-only">Cancel edit</span>
                  </PromptInputButton>
                ) : null}

                <div
                  className={cn(
                    "transition-opacity",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <PromptInputSubmit
                    aria-disabled={disabled || undefined}
                    className="size-9 shrink-0 rounded-full px-0 shadow-xs"
                    onClick={
                      disabled
                        ? (event) => {
                            event.preventDefault();
                          }
                        : undefined
                    }
                    status={disabled ? "streaming" : undefined}
                    tabIndex={disabled ? -1 : undefined}
                    type={disabled ? "button" : "submit"}
                  >
                    <ArrowUp className="size-4" />
                    <span className="sr-only">Send</span>
                  </PromptInputSubmit>
                </div>
              </div>
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>
      </PromptInputProvider>
    </div>
  );
}

function EmptyState({
  onSendMessage,
  composerInitialInput,
  composerResetKey,
  selectedSources,
  onRemoveSource,
}: {
  onSendMessage: (content: string) => void;
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
                    Work with your agent across your selected sources.
                  </h1>
                  <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                    Start with a prompt, compare evidence, or have the agent
                    synthesize what matters most before you open a
                    thread.
                  </p>
                </div>
              </div>
              <Suggestions className="justify-start gap-2 pt-2">
                {starterSuggestions.map((suggestion) => (
                  <Suggestion
                    className="h-auto rounded-full border-border/70 bg-background px-4 py-2 text-sm text-muted-foreground whitespace-normal hover:bg-muted hover:text-foreground"
                    key={suggestion}
                    onClick={onSendMessage}
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
            onSubmit={(message) => onSendMessage(message.text.trim())}
            placeholder="Message your documents, links, or connected tools..."
            selectedSources={selectedSources}
          />
        </div>
      </div>
    </section>
  );
}

export function ChatCanvas({
  activeVersionByGroup = {},
  composerInitialInput,
  composerResetKey,
  isEditing = false,
  isStreaming = false,
  showThinkingPlaceholder = false,
  messageGroups = [],
  mode,
  sourcesVisible,
  threadTitle,
  onActiveVersionChange,
  onCancelEditing,
  onRestartFromMessage,
  onRefreshLatest,
  onSendMessage,
  selectedSources = [],
  onRemoveSource,
  workspaceId,
}: {
  activeVersionByGroup?: Record<string, number>;
  composerInitialInput?: string;
  composerResetKey?: number;
  isEditing?: boolean;
  isStreaming?: boolean;
  showThinkingPlaceholder?: boolean;
  messageGroups?: VersionedMessageGroup[];
  mode: "thread" | "new";
  sourcesVisible: boolean;
  threadTitle: string;
  onActiveVersionChange?: (input: { groupId: string; branchIndex: number }) => void;
  onCancelEditing?: () => void;
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
  onSendMessage?: (content: string) => void;
  selectedSources?: SourceItem[];
  onRemoveSource?: (id: string) => void;
  workspaceId?: string | null;
}) {
  void sourcesVisible;

  function handleSendMessage(content: string) {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }
    onSendMessage?.(content);
  }

  if (mode === "new") {
    return (
      <EmptyState
        composerInitialInput={composerInitialInput}
        composerResetKey={composerResetKey}
        onRemoveSource={onRemoveSource ?? (() => undefined)}
        onSendMessage={handleSendMessage}
        selectedSources={selectedSources}
      />
    );
  }

  const latestUserGroup = [...messageGroups]
    .reverse()
    .find((group) => group.role === "user");
  const latestAssistantGroup = [...messageGroups]
    .reverse()
    .find((group) => group.role === "assistant");
  const latestUserGroupId = latestUserGroup?.groupId;
  const latestAssistantGroupId = latestAssistantGroup?.groupId;

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
            {messageGroups.map((group) => {
              const isAssistant = group.role === "assistant";
              const selectedUserVersionIdForAssistant = isAssistant
                ? (() => {
                    const userGroup = group.turnId
                      ? messageGroups.find(
                          (candidate) =>
                            candidate.role === "user" &&
                            candidate.turnId === group.turnId,
                        )
                      : null;
                    if (!userGroup) {
                      return null;
                    }

                    const latestUserVersionIndex = Math.max(
                      userGroup.versions.length - 1,
                      0,
                    );
                    const desiredUserBranchIndexRaw =
                      activeVersionByGroup[userGroup.groupId];
                    const activeUserBranchIndex = Math.min(
                      Math.max(
                        desiredUserBranchIndexRaw ?? latestUserVersionIndex,
                        0,
                      ),
                      latestUserVersionIndex,
                    );
                    return userGroup.versions[activeUserBranchIndex]?.id ?? null;
                  })()
                : null;

              const versionEntries = (() => {
                const allEntries = group.versions.map((version, originalIndex) => ({
                  version,
                  originalIndex,
                }));

                if (!isAssistant || !selectedUserVersionIdForAssistant) {
                  return allEntries;
                }

                const scopedEntries = allEntries.filter(
                  (entry) =>
                    entry.version.sourceUserMessageId ===
                    selectedUserVersionIdForAssistant,
                );

                return scopedEntries.length > 0 ? scopedEntries : allEntries;
              })();

              const latestVisibleVersionIndex = Math.max(
                versionEntries.length - 1,
                0,
              );
              const desiredOriginalBranchIndexRaw =
                activeVersionByGroup[group.groupId];
              const defaultOriginalBranchIndex =
                versionEntries[latestVisibleVersionIndex]?.originalIndex ?? 0;
              const desiredOriginalBranchIndex =
                typeof desiredOriginalBranchIndexRaw === "number"
                  ? desiredOriginalBranchIndexRaw
                  : defaultOriginalBranchIndex;
              const matchedVisibleIndex = versionEntries.findIndex(
                (entry) => entry.originalIndex === desiredOriginalBranchIndex,
              );
              const activeVisibleBranchIndex =
                matchedVisibleIndex >= 0
                  ? matchedVisibleIndex
                  : latestVisibleVersionIndex;
              const activeOriginalBranchIndex =
                versionEntries[activeVisibleBranchIndex]?.originalIndex ?? 0;

              const isLatestUserGroup = group.groupId === latestUserGroupId;
              const isLatestAssistantGroup =
                group.groupId === latestAssistantGroupId;
              const selectedUserVersionId = !isAssistant
                ? (group.versions[activeOriginalBranchIndex]?.id ?? null)
                : null;
              const assistantGroupForUser =
                !isAssistant && selectedUserVersionId
                  ? messageGroups.find(
                      (candidate) =>
                        candidate.role === "assistant" &&
                        candidate.versions.some(
                          (version) =>
                            version.sourceUserMessageId === selectedUserVersionId,
                        ),
                    )
                  : null;
              const selectedAssistantVersionForUser = (() => {
                if (!assistantGroupForUser || !selectedUserVersionId) {
                  return null;
                }

                const maxAssistantIndex = Math.max(
                  assistantGroupForUser.versions.length - 1,
                  0,
                );
                const preferredAssistantIndex = Math.min(
                  Math.max(
                    activeVersionByGroup[assistantGroupForUser.groupId] ??
                      maxAssistantIndex,
                    0,
                  ),
                  maxAssistantIndex,
                );
                const preferredAssistantVersion =
                  assistantGroupForUser.versions[preferredAssistantIndex] ?? null;
                if (
                  preferredAssistantVersion?.sourceUserMessageId ===
                  selectedUserVersionId
                ) {
                  return preferredAssistantVersion;
                }

                for (
                  let index = assistantGroupForUser.versions.length - 1;
                  index >= 0;
                  index -= 1
                ) {
                  const candidate = assistantGroupForUser.versions[index];
                  if (candidate?.sourceUserMessageId === selectedUserVersionId) {
                    return candidate;
                  }
                }

                return null;
              })();
              const toolbarVisibilityClass =
                "invisible pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:visible group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:visible group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100";

              return (
                <MessageBranch
                  className="group/message flex w-full flex-col gap-1"
                  defaultBranch={activeVisibleBranchIndex}
                  key={`${group.groupId}:${group.latestVersionId}:${selectedUserVersionIdForAssistant ?? "all"}:${activeOriginalBranchIndex}`}
                  onBranchChange={(branchIndex) => {
                    const selectedEntry = versionEntries[branchIndex];
                    if (!selectedEntry) {
                      return;
                    }

                    onActiveVersionChange?.({
                      groupId: group.groupId,
                      branchIndex: selectedEntry.originalIndex,
                    });
                  }}
                >
                  <MessageBranchContent>
                    {versionEntries.map(({ version }, versionIndex) => {
                      const messageText = getMessageText(version);
                      const isStreamingThisVersion =
                        isStreaming &&
                        isAssistant &&
                        isLatestAssistantGroup &&
                        versionIndex === activeVisibleBranchIndex;

                      return (
                        <div
                          className="flex w-full flex-col gap-1"
                          key={version.id}
                        >
                          <Message from={group.role}>
                            <MessageContent
                              className={
                                isAssistant
                                  ? "max-w-none"
                                  : "w-fit max-w-full rounded-3xl bg-secondary px-4 py-3 text-foreground shadow-sm"
                              }
                            >
                              {isStreamingThisVersion && !messageText ? (
                                showThinkingPlaceholder ? (
                                  <Shimmer className="text-muted-foreground">
                                    Thinking...
                                  </Shimmer>
                                ) : (
                                  <span className="block h-5" />
                                )
                              ) : !isAssistant ? (
                                <div className="whitespace-pre-wrap break-words leading-6">
                                  {messageText}
                                </div>
                              ) : (
                                <div className="space-y-3">
                                  {(version.toolCalls ?? []).length > 0 ? (
                                    <div className="space-y-2">
                                      {(version.toolCalls ?? []).map((toolCall) => {
                                        const state =
                                          toolCall.status === "running"
                                            ? "input-available"
                                            : toolCall.status === "error"
                                              ? "output-error"
                                              : "output-available";
                                        const output =
                                          toolCall.output ??
                                          (toolCall.latencyMs !== null
                                            ? { latencyMs: toolCall.latencyMs }
                                            : null);

                                        return (
                                          <Tool defaultOpen={toolCall.status !== "completed"} key={toolCall.id}>
                                            <ToolHeader
                                              state={state}
                                              title={`Tool · ${toolCall.tool}`}
                                              toolName={toolCall.tool}
                                              type="dynamic-tool"
                                            />
                                            <ToolContent>
                                              <ToolInput input={toolCall.input} />
                                              <ToolOutput
                                                errorText={
                                                  toolCall.status === "error"
                                                    ? (toolCall.error ?? "Tool execution failed.")
                                                    : undefined
                                                }
                                                output={output}
                                              />
                                            </ToolContent>
                                          </Tool>
                                        );
                                      })}
                                    </div>
                                  ) : null}
                                  <MessageResponse>{messageText}</MessageResponse>
                                </div>
                              )}
                            </MessageContent>
                          </Message>

                          <MessageToolbar
                            className={cn(
                              "mt-0.5 min-h-7 px-1 text-xs text-muted-foreground transition-opacity duration-150",
                              isAssistant ? "justify-start" : "justify-end",
                              toolbarVisibilityClass,
                            )}
                          >
                            <div className="flex items-center gap-1">
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

                                {!isAssistant &&
                                isLatestUserGroup &&
                                versionIndex === activeVisibleBranchIndex &&
                                !isStreaming ? (
                                  <MessageAction
                                    className="text-muted-foreground hover:text-foreground"
                                    label="Edit prompt"
                                    onClick={() => {
                                      onRestartFromMessage?.({
                                        groupId: group.groupId,
                                        message: messageText,
                                        messageId: version.id,
                                        assistantMessageId:
                                          selectedAssistantVersionForUser?.id ?? null,
                                        branchIndex: activeOriginalBranchIndex,
                                      });
                                    }}
                                    size="icon-sm"
                                    tooltip="Edit and restart"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <Pencil className="size-3" />
                                  </MessageAction>
                                ) : null}

                                {isAssistant &&
                                isLatestAssistantGroup &&
                                versionIndex === activeVisibleBranchIndex &&
                                !isStreaming ? (
                                  <MessageAction
                                    className="text-muted-foreground hover:text-foreground"
                                    label="Refresh"
                                    onClick={() => {
                                      onRefreshLatest?.({
                                        groupId: group.groupId,
                                        assistantMessageId: version.id,
                                        branchIndex: activeOriginalBranchIndex,
                                      });
                                    }}
                                    size="icon-sm"
                                    tooltip="Refresh"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <RotateCcw className="size-3" />
                                  </MessageAction>
                                ) : null}
                              </MessageActions>

                              <MessageBranchSelector>
                                <MessageBranchPrevious className="text-muted-foreground hover:text-foreground" />
                                <MessageBranchPage />
                                <MessageBranchNext className="text-muted-foreground hover:text-foreground" />
                              </MessageBranchSelector>
                            </div>
                          </MessageToolbar>
                        </div>
                      );
                    })}
                  </MessageBranchContent>
                </MessageBranch>
              );
            })}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-border/60 bg-background/95 px-6 py-5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <Composer
            className="w-full"
            disabled={isStreaming}
            initialInput={composerInitialInput}
            isEditing={isEditing}
            inputKey={`${threadTitle}-${composerResetKey ?? 0}`}
            onCancelEditing={onCancelEditing}
            onRemoveSource={onRemoveSource}
            onSubmit={(message) =>
              handleSendMessage(message.text.trim())
            }
            selectedSources={selectedSources}
          />
        </div>
      </div>
    </section>
  );
}
