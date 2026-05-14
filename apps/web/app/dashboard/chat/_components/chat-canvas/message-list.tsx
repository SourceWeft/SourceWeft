import { BookOpenIcon, Copy, Pencil, RotateCcw, WrenchIcon } from "lucide-react";
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
import {
  Attachment,
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
  getAttachmentLabel,
} from "@sourceweft/ui-web/components/ai-elements/attachments";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { expandSelectedSources, type SourceItem } from "../source-types";
import { WebToolResults } from "../web-tool-results";
import {
  buildRenderBlocksFromMessageContent,
  getMessageImageParts,
  getMessageText,
  normalizeAssetUrl,
  stripGeneratedImageMarkdown,
} from "./message-assets";
import { CitationAwareMessageResponse } from "./message-response";
import {
  GeneratedImageArtifactBlock,
  GeneratedImageArtifacts,
  ReasoningTrace,
} from "./reasoning-trace";
import {
  mergeSourceIds,
  SourceIcon,
  toAttachmentData,
  UserMessageText,
} from "./source-rendering";
import type {
  ArtifactPreviewRecord,
  CitationRecord,
  ChatMessageImagePart,
  MessageRenderBlock,
  MessageVersion,
  ToolCallRecord,
  VersionedMessageGroup,
} from "./types";

function hasRenderBlocks(blocks: MessageRenderBlock[] | undefined) {
  return blocks !== undefined && blocks.length > 0;
}

function getToolCallById(toolCalls: ToolCallRecord[] | undefined) {
  return new Map((toolCalls ?? []).map((toolCall) => [toolCall.id, toolCall]));
}

function getInlineGeneratedImageToolIds(input: {
  blocks: MessageRenderBlock[] | undefined;
  toolCallById: Map<string, ToolCallRecord>;
}) {
  return new Set(
    (input.blocks ?? [])
      .filter(
        (
          block,
        ): block is Extract<MessageRenderBlock, { type: "generated_image" }> =>
          block.type === "generated_image",
      )
      .filter((block) => input.toolCallById.has(block.toolCallId))
      .map((block) => block.toolCallId),
  );
}

function getTrailingGeneratedImageToolCalls(input: {
  inlineToolIds: Set<string>;
  toolCalls?: ToolCallRecord[];
}) {
  return (input.toolCalls ?? []).filter(
    (toolCall) => !input.inlineToolIds.has(toolCall.id),
  );
}

function toImageAttachmentData(image: ChatMessageImagePart) {
  return {
    filename: image.fileName,
    id: image.id,
    mediaType: image.mimeType,
    type: "file" as const,
    url: normalizeAssetUrl(image.url),
  };
}

function UserMessageImageReference({ image }: { image: ChatMessageImagePart }) {
  const attachment = toImageAttachmentData(image);
  const label = getAttachmentLabel(attachment);

  return (
    <AttachmentHoverCard>
      <AttachmentHoverCardTrigger asChild>
        <div className="w-fit">
          <Attachment
            className="rounded-2xl bg-muted/55 px-2.5 py-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)]"
            data={attachment}
          >
            <AttachmentPreview />
            <AttachmentInfo className="max-w-[180px] text-[13px] font-medium" />
          </Attachment>
        </div>
      </AttachmentHoverCardTrigger>
      <AttachmentHoverCardContent>
        <div className="space-y-3">
          <div className="flex max-h-96 w-80 items-center justify-center overflow-hidden rounded-md border bg-muted/30">
            <img
              alt={label}
              className="max-h-full max-w-full object-contain"
              height={384}
              src={attachment.url}
              width={320}
            />
          </div>
          <div className="space-y-1 px-0.5">
            <h4 className="font-semibold text-sm leading-none">{label}</h4>
            {attachment.mediaType ? (
              <p className="font-mono text-muted-foreground text-xs">
                {attachment.mediaType}
              </p>
            ) : null}
          </div>
        </div>
      </AttachmentHoverCardContent>
    </AttachmentHoverCard>
  );
}

type UserContentToken =
  | { text: string; type: "text" }
  | {
      kind: "skill" | "skill-command" | "tool";
      label: string;
      value: string;
      type: "command";
    }
  | {
      sourceId: string;
      title: string;
      type: "source";
    };

function unescapeMarkerLabel(value: string) {
  return value.replace(/\\([\\)\]])/g, "$1");
}

function parseMarkerContent(content: string): UserContentToken[] {
  const tokens: UserContentToken[] = [];
  const pattern = /\[(skills|skill-command|tool|source):([^\]]+)\]\(((?:\\.|[^)])*)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: content.slice(lastIndex, match.index), type: "text" });
    }

    const rawKind = match[1];
    const rawValue = match[2] ?? "";
    const label = unescapeMarkerLabel(match[3] ?? "");
    let decodedValue: string;
    try {
      decodedValue = decodeURIComponent(rawValue);
    } catch {
      decodedValue = rawValue;
    }
    if (rawKind === "source") {
      tokens.push({
        sourceId: decodedValue,
        title: label || decodedValue,
        type: "source",
      });
    } else {
      tokens.push({
        kind:
          rawKind === "tool"
            ? "tool"
            : rawKind === "skill-command"
              ? "skill-command"
              : "skill",
        label,
        value: `/${decodedValue.replace(/^\//, "")}`,
        type: "command",
      });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < content.length) {
    tokens.push({ text: content.slice(lastIndex), type: "text" });
  }

  return tokens.length > 0 ? tokens : [{ text: content, type: "text" }];
}

function commandTokenDisplayName(
  command: Extract<UserContentToken, { type: "command" }>,
) {
  const label = command.label?.trim();
  if (label) {
    return label.startsWith("/")
      ? label
          .replace(/^\//, "")
          .split(":")
          .pop()!
          .split(/[.\-_\s]+/)
          .filter(Boolean)
          .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
          .join(" ")
      : label;
  }
  const normalized = command.value.startsWith("/")
    ? command.value
    : `/${command.value}`;
  if (command.kind === "tool") {
    return normalized === "/generate_image" ? "Generate image" : normalized;
  }
  const skillSlug = normalized.replace(/^\//, "").split(":")[0] ?? normalized;
  return skillSlug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function UserCommandSegmentView({
  command,
}: {
  command: Extract<UserContentToken, { type: "command" }>;
}) {
  const label = commandTokenDisplayName(command);
  if (!label) {
    return null;
  }
  const Icon = command.kind === "tool" ? WrenchIcon : BookOpenIcon;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 align-baseline text-sm font-semibold leading-6 text-blue-600 dark:text-blue-400"
      title={command.value}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function UserMessageContent({
  content,
  onSourcePreview,
  sources,
}: {
  content: string;
  onSourcePreview?: (source: SourceItem) => void;
  sources: SourceItem[];
}) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const tokens = parseMarkerContent(content);

  const sourceFromToken = (token: Extract<UserContentToken, { type: "source" }>) =>
    sourceById.get(token.sourceId) ?? {
      contentText: "",
      id: token.sourceId,
      meta: "Mentioned source",
      parentSourceId: null,
      sourceType: "file_upload" as const,
      status: "Indexed" as const,
      storageKey: null,
      title: token.title,
      type: "DOC" as const,
    };

  return (
    <>
      {tokens.map((token, index) => {
        if (token.type === "command") {
          return (
            <UserCommandSegmentView
              command={token}
              key={`command-${token.value}-${index}`}
            />
          );
        }
        if (token.type === "source") {
          const source = sourceFromToken(token);
          return (
            <UserMessageText
              key={`source-${token.sourceId}-${index}`}
              onSourcePreview={onSourcePreview}
              sources={[source]}
              sourceIds={[token.sourceId]}
            >
              {`@${token.title}`}
            </UserMessageText>
          );
        }
        return (
          <UserMessageText
            key={`text-${index}`}
            onSourcePreview={onSourcePreview}
            sources={sources}
          >
            {token.text}
          </UserMessageText>
        );
      })}
    </>
  );
}

function UserMessageReferences({
  images,
  sources,
}: {
  images: ChatMessageImagePart[];
  sources: SourceItem[];
}) {
  if (sources.length === 0 && images.length === 0) {
    return null;
  }

  const showSourceCountOnly = sources.length > 2;
  const visibleSources = showSourceCountOnly ? [] : sources;

  return (
    <div className="ml-auto flex max-w-[85%] flex-wrap justify-end gap-2 pb-1 text-xs text-muted-foreground">
      <span className="inline-flex h-8 items-center px-1 font-medium text-foreground/70">
        Referenced
      </span>
      <Attachments className="gap-2" variant="inline">
        {showSourceCountOnly ? (
          <Attachment
            className="rounded-2xl bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground"
            data={{
              id: "source-count",
              mediaType: "text/plain",
              sourceId: "source-count",
              title: `${sources.length} sources`,
              type: "source-document",
            }}
          >
            {sources.length} sources
          </Attachment>
        ) : (
          visibleSources.map((source) => (
            <Attachment
              className="rounded-2xl bg-muted/55 px-3.5 py-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)]"
              data={toAttachmentData(source)}
              key={source.id}
              title={source.title}
            >
              <AttachmentPreview
                className="text-foreground/75"
                fallbackIcon={<SourceIcon className="size-4" source={source} />}
              />
              <AttachmentInfo className="max-w-[220px] text-[13px] font-medium" />
            </Attachment>
          ))
        )}
        {images.map((image) => (
          <UserMessageImageReference image={image} key={image.id} />
        ))}
      </Attachments>
    </div>
  );
}

function AssistantMessageBody({
  isStreaming,
  messageText,
  onCitationClick,
  onWorkfileClick,
  version,
  workspaceId,
}: {
  isStreaming: boolean;
  messageText: string;
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
  version: MessageVersion;
  workspaceId?: string | null;
}) {
  const fallbackRenderBlocks = !hasRenderBlocks(version.renderBlocks)
    ? buildRenderBlocksFromMessageContent({
        content: version.content,
        toolCalls: version.toolCalls,
        workspaceId,
      })
    : null;
  const renderBlocks = hasRenderBlocks(version.renderBlocks)
    ? (version.renderBlocks ?? [])
    : fallbackRenderBlocks;
  const toolCallById = getToolCallById(version.toolCalls);
  const inlineToolIds = getInlineGeneratedImageToolIds({
    blocks: renderBlocks ?? [],
    toolCallById,
  });
  const trailingImageToolCalls = getTrailingGeneratedImageToolCalls({
    inlineToolIds,
    toolCalls: version.toolCalls,
  });
  const cancelledNotice = version.isCancelled ? "已由用户停止生成。" : null;

  if (!renderBlocks) {
    return (
      <>
        {messageText.length > 0 ? (
          <CitationAwareMessageResponse
            availableCitations={version.availableCitations}
            citations={version.citations}
            onCitationClick={onCitationClick}
            onWorkfileClick={onWorkfileClick}
            showLoading={
              isStreaming &&
              version.isTextPaused === true &&
              messageText.length > 0
            }
          >
            {messageText}
          </CitationAwareMessageResponse>
        ) : null}
        {cancelledNotice ? (
          <p className="text-sm text-muted-foreground">{cancelledNotice}</p>
        ) : null}
        <GeneratedImageArtifacts
          toolCalls={version.toolCalls}
          workspaceId={workspaceId}
        />
      </>
    );
  }

  return (
    <>
      {renderBlocks.map((block) => {
        if (block.type === "generated_image") {
          return (
            <GeneratedImageArtifactBlock
              key={block.id}
              toolCall={toolCallById.get(block.toolCallId)}
              workspaceId={workspaceId}
            />
          );
        }

        const blockText = stripGeneratedImageMarkdown({
          content: block.text,
          toolCalls: version.toolCalls,
          trim: false,
          workspaceId,
        });
        if (blockText.length === 0) {
          return null;
        }

        return (
          <CitationAwareMessageResponse
            availableCitations={version.availableCitations}
            citations={version.citations}
            key={block.id}
            onCitationClick={onCitationClick}
            onWorkfileClick={onWorkfileClick}
            showLoading={
              isStreaming &&
              version.isTextPaused === true &&
              version.renderBlocks?.at(-1)?.id === block.id &&
              blockText.length > 0
            }
          >
            {blockText}
          </CitationAwareMessageResponse>
        );
      })}
      {cancelledNotice ? (
        <p className="text-sm text-muted-foreground">{cancelledNotice}</p>
      ) : null}
      <GeneratedImageArtifacts
        toolCalls={trailingImageToolCalls}
        workspaceId={workspaceId}
      />
    </>
  );
}

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
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
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
  onArtifactPreview,
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
                    const userMessageImages = !isAssistant
                      ? getMessageImageParts(version)
                      : [];
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
                        key={version.renderKey ?? version.id}
                      >
                        {!isAssistant ? (
                          <UserMessageReferences
                            images={userMessageImages}
                            sources={referencedSources}
                          />
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
                                <UserMessageContent
                                  content={messageText}
                                  onSourcePreview={onSourcePreview}
                                  sources={mentionSources}
                                />
                              </div>
                            ) : (
                              <div className="space-y-3">
                                <ReasoningTrace
                                  isCancelled={version.isCancelled === true}
                                  isStreaming={isStreamingThisVersion}
                                  modelReasoning={version.modelReasoning}
                                  modelReasoningSegments={
                                    version.modelReasoningSegments
                                  }
                                  onArtifactPreview={onArtifactPreview}
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
                                <AssistantMessageBody
                                  isStreaming={isStreamingThisVersion}
                                  messageText={messageText}
                                  onCitationClick={onCitationClick}
                                  onWorkfileClick={onWorkfileClick}
                                  version={version}
                                  workspaceId={workspaceId}
                                />
                                {version.isError && !version.isCancelled ? (
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
