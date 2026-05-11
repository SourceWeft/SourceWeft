import { Copy, Pencil, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  Conversation,
  ConversationContent,
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
  MessageToolbar,
} from "@sourceweft/ui-web/components/ai-elements/message";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { expandSelectedSources, type SourceItem } from "../source-types";
import { WebToolResults } from "../web-tool-results";
import { getMessageText } from "./message-assets";
import { CitationAwareMessageResponse } from "./message-response";
import { GeneratedImageArtifacts, ReasoningTrace } from "./reasoning-trace";
import {
  mergeSourceIds,
  ReferencedFiles,
  UserMessageText,
} from "./source-rendering";
import type { CitationRecord, VersionedMessageGroup } from "./types";

type MessageListProps = {
  activeVersionByGroup?: Record<string, number>;
  allSources?: SourceItem[];
  highlightedMessageId?: string | null;
  isStreaming?: boolean;
  messageGroups?: VersionedMessageGroup[];
  onActiveVersionChange?: (input: {
    groupId: string;
    branchIndex: number;
  }) => void;
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
  workspaceId?: string | null;
};

export function MessageList({
  activeVersionByGroup = {},
  allSources = [],
  highlightedMessageId = null,
  isStreaming = false,
  messageGroups = [],
  onActiveVersionChange,
  onCitationClick,
  onSourcePreview,
  onWorkfileClick,
  onRestartFromMessage,
  onRefreshLatest,
  workspaceId,
}: MessageListProps) {
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
              const allEntries = group.versions.map(
                (version, originalIndex) => ({
                  version,
                  originalIndex,
                }),
              );

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
            const sourceById = new Map(
              allSources.map((source) => [source.id, source]),
            );
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
                    const messageText = getMessageText({
                      version,
                      workspaceId,
                    });
                    const isStreamingThisVersion =
                      isStreaming &&
                      isAssistant &&
                      isLatestAssistantGroup &&
                      versionIndex === activeVisibleBranchIndex;
                    const referencedSources = !isAssistant
                      ? (
                          version.effectiveSourceIds ??
                          expandSelectedSources(
                            allSources,
                            version.sourceIds ?? [],
                          ).map((source) => source.id)
                        )
                          .map((sourceId) => sourceById.get(sourceId))
                          .filter((source): source is SourceItem =>
                            Boolean(source),
                          )
                      : [];
                    const mentionSources = !isAssistant
                      ? mergeSourceIds(
                          version.mentionedSourceIds,
                          version.effectiveMentionedSourceIds,
                        )
                          .map((sourceId) => sourceById.get(sourceId))
                          .filter((source): source is SourceItem =>
                            Boolean(source),
                          )
                      : [];

                    return (
                      <div
                        className={cn(
                          "flex w-full flex-col gap-1 rounded-2xl transition-colors duration-700",
                          highlightedMessageId === version.id &&
                            "bg-primary/10 ring-1 ring-primary/25",
                        )}
                        data-chat-message-id={version.id}
                        key={version.id}
                      >
                        {!isAssistant && referencedSources.length > 0 ? (
                          <ReferencedFiles sources={referencedSources} />
                        ) : null}
                        <Message from={group.role}>
                          <MessageContent
                            className={
                              isAssistant
                                ? "max-w-none"
                                : "w-fit max-w-full rounded-3xl bg-secondary px-4 py-3 text-foreground shadow-sm"
                            }
                          >
                            {!isAssistant ? (
                              <div className="whitespace-pre-wrap break-words leading-6">
                                <UserMessageText
                                  onSourcePreview={onSourcePreview}
                                  sources={mentionSources}
                                  sourceIds={mergeSourceIds(
                                    version.mentionedSourceIds,
                                    version.effectiveMentionedSourceIds,
                                  )}
                                >
                                  {messageText}
                                </UserMessageText>
                              </div>
                            ) : (
                              <div className="space-y-3">
                                <ReasoningTrace
                                  isStreaming={isStreamingThisVersion}
                                  modelReasoning={version.modelReasoning}
                                  modelReasoningSegments={
                                    version.modelReasoningSegments
                                  }
                                  steps={version.thinkingSteps}
                                  toolCalls={version.toolCalls}
                                  workspaceId={workspaceId}
                                />
                                <WebToolResults
                                  availableCitations={
                                    version.availableCitations
                                  }
                                  onCitationClick={onCitationClick}
                                  toolCalls={version.toolCalls}
                                />
                                <CitationAwareMessageResponse
                                  availableCitations={
                                    version.availableCitations
                                  }
                                  citations={version.citations}
                                  onCitationClick={onCitationClick}
                                  onWorkfileClick={onWorkfileClick}
                                  showLoading={
                                    isStreamingThisVersion &&
                                    version.isTextPaused === true &&
                                    messageText.length > 0
                                  }
                                >
                                  {messageText}
                                </CitationAwareMessageResponse>
                                <GeneratedImageArtifacts
                                  toolCalls={version.toolCalls}
                                  workspaceId={workspaceId}
                                />
                                {version.isError ? (
                                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                    <p className="font-medium">
                                      Message failed
                                    </p>
                                    <p className="mt-1 whitespace-pre-wrap break-words text-destructive/90">
                                      {version.error ?? messageText}
                                    </p>
                                    {version.errorCode ? (
                                      <p className="mt-1 text-xs text-destructive/70">
                                        {version.errorCode}
                                      </p>
                                    ) : null}
                                  </div>
                                ) : null}
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
                                onClick={() =>
                                  void handleCopyMessage(messageText)
                                }
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
                                        selectedAssistantVersionForUser?.id ??
                                        null,
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
  );
}
