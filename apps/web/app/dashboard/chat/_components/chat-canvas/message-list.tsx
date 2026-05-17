import { memo, useMemo, useState } from "react";
import {
  BookOpenIcon,
  Copy,
  Loader2,
  Pencil,
  RotateCcw,
  WrenchIcon,
} from "lucide-react";
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
import { Button } from "@sourceweft/ui-web/components/ui/button";
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
  sourceById,
  sources,
}: {
  content: string;
  onSourcePreview?: (source: SourceItem) => void;
  sourceById: Map<string, SourceItem>;
  sources: SourceItem[];
}) {
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
  hasOlderMessages?: boolean;
  highlightedMessageId?: string | null;
  isLoadingOlderMessages?: boolean;
  isStreaming?: boolean;
  messageGroups?: VersionedMessageGroup[];
  onActiveVersionChange?: (input: {
    groupId: string;
    branchIndex: number;
  }) => void;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
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
  }) => void;
  workspaceId?: string | null;
};

const MESSAGE_HISTORY_COLLAPSE_THRESHOLD = 140;
const MESSAGE_HISTORY_VISIBLE_TAIL_COUNT = 100;

type SelectedSourceIdsResolver = {
  resolve: (version: MessageVersion) => string[];
};

type MessageVersionEntry = {
  originalIndex: number;
  version: MessageVersion;
};

function resolveVersionEntries(input: {
  group: VersionedMessageGroup;
  selectedUserVersionIdForAssistant: string | null;
}) {
  const allEntries = input.group.versions.map((version, originalIndex) => ({
    originalIndex,
    version,
  }));

  if (
    input.group.role !== "assistant" ||
    !input.selectedUserVersionIdForAssistant
  ) {
    return allEntries;
  }

  const scopedEntries = allEntries.filter(
    (entry) =>
      entry.version.sourceUserMessageId ===
      input.selectedUserVersionIdForAssistant,
  );

  return scopedEntries.length > 0 ? scopedEntries : allEntries;
}

function resolveActiveOriginalBranchIndex(input: {
  desiredOriginalBranchIndexRaw?: number;
  versionEntries: MessageVersionEntry[];
}) {
  const latestVisibleVersionIndex = Math.max(input.versionEntries.length - 1, 0);
  const defaultOriginalBranchIndex =
    input.versionEntries[latestVisibleVersionIndex]?.originalIndex ?? 0;
  const desiredOriginalBranchIndex =
    typeof input.desiredOriginalBranchIndexRaw === "number"
      ? input.desiredOriginalBranchIndexRaw
      : defaultOriginalBranchIndex;
  const matchedVisibleIndex = input.versionEntries.findIndex(
    (entry) => entry.originalIndex === desiredOriginalBranchIndex,
  );
  const activeVisibleBranchIndex =
    matchedVisibleIndex >= 0 ? matchedVisibleIndex : latestVisibleVersionIndex;
  const activeOriginalBranchIndex =
    input.versionEntries[activeVisibleBranchIndex]?.originalIndex ?? 0;

  return { activeOriginalBranchIndex, activeVisibleBranchIndex };
}

function resolveSelectedUserVersionIdForAssistant(input: {
  activeVersionByGroup: Record<string, number>;
  group: VersionedMessageGroup;
  messageGroups: VersionedMessageGroup[];
}) {
  if (input.group.role !== "assistant" || !input.group.turnId) {
    return null;
  }

  const userGroup = input.messageGroups.find(
    (candidate) =>
      candidate.role === "user" && candidate.turnId === input.group.turnId,
  );
  if (!userGroup) {
    return null;
  }

  const latestUserVersionIndex = Math.max(userGroup.versions.length - 1, 0);
  const desiredUserBranchIndexRaw =
    input.activeVersionByGroup[userGroup.groupId];
  const activeUserBranchIndex = Math.min(
    Math.max(desiredUserBranchIndexRaw ?? latestUserVersionIndex, 0),
    latestUserVersionIndex,
  );
  return userGroup.versions[activeUserBranchIndex]?.id ?? null;
}

function resolveSelectedAssistantVersionForUser(input: {
  activeVersionByGroup: Record<string, number>;
  messageGroups: VersionedMessageGroup[];
  selectedUserVersionId: string | null;
}) {
  if (!input.selectedUserVersionId) {
    return null;
  }

  const assistantGroup = input.messageGroups.find(
    (candidate) =>
      candidate.role === "assistant" &&
      candidate.versions.some(
        (version) =>
          version.sourceUserMessageId === input.selectedUserVersionId,
      ),
  );
  if (!assistantGroup) {
    return null;
  }

  const maxAssistantIndex = Math.max(assistantGroup.versions.length - 1, 0);
  const preferredAssistantIndex = Math.min(
    Math.max(
      input.activeVersionByGroup[assistantGroup.groupId] ?? maxAssistantIndex,
      0,
    ),
    maxAssistantIndex,
  );
  const preferredAssistantVersion =
    assistantGroup.versions[preferredAssistantIndex] ?? null;
  if (
    preferredAssistantVersion?.sourceUserMessageId === input.selectedUserVersionId
  ) {
    return preferredAssistantVersion;
  }

  for (let index = assistantGroup.versions.length - 1; index >= 0; index -= 1) {
    const candidate = assistantGroup.versions[index];
    if (candidate?.sourceUserMessageId === input.selectedUserVersionId) {
      return candidate;
    }
  }

  return null;
}

async function copyMessageText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Message copied.");
  } catch {
    toast.error("Couldn't copy the message.");
  }
}

function versionContainsHighlight(
  group: VersionedMessageGroup,
  highlightedMessageId: string | null | undefined,
) {
  return Boolean(
    highlightedMessageId &&
      group.versions.some((version) => version.id === highlightedMessageId),
  );
}

function shallowArrayEqual(left?: string[], right?: string[]) {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

function summarizeToolCalls(toolCalls: MessageVersion["toolCalls"]) {
  return (toolCalls ?? [])
    .map(
      (toolCall) =>
        `${toolCall.id}:${toolCall.tool}:${toolCall.status}:${toolCall.error ?? ""}`,
    )
    .join("|");
}

function summarizeThinkingSteps(steps: MessageVersion["thinkingSteps"]) {
  return (steps ?? [])
    .map(
      (step) =>
        `${step.id}:${step.status}:${step.title}:${step.description ?? ""}:${step.detail ?? ""}:${step.items.length}`,
    )
    .join("|");
}

function summarizeRenderBlocks(blocks: MessageVersion["renderBlocks"]) {
  return (blocks ?? [])
    .map((block) => {
      if (block.type === "text") {
        return `${block.id}:text:${block.text.length}`;
      }
      if (block.type === "generated_image") {
        return `${block.id}:generated_image:${block.toolCallId}`;
      }
      return "";
    })
    .join("|");
}

function areMessageVersionsRenderEqual(
  left: MessageVersion,
  right: MessageVersion,
) {
  return (
    left.id === right.id &&
    left.renderKey === right.renderKey &&
    left.content === right.content &&
    left.error === right.error &&
    left.errorCode === right.errorCode &&
    left.isCancelled === right.isCancelled &&
    left.isError === right.isError &&
    left.isTextInterrupted === right.isTextInterrupted &&
    left.isTextPaused === right.isTextPaused &&
    left.modelReasoning === right.modelReasoning &&
    left.sourceAssistantMessageId === right.sourceAssistantMessageId &&
    left.sourceUserMessageId === right.sourceUserMessageId &&
    shallowArrayEqual(left.sourceIds, right.sourceIds) &&
    shallowArrayEqual(left.effectiveSourceIds, right.effectiveSourceIds) &&
    shallowArrayEqual(left.mentionedSourceIds, right.mentionedSourceIds) &&
    shallowArrayEqual(
      left.effectiveMentionedSourceIds,
      right.effectiveMentionedSourceIds,
    ) &&
    summarizeToolCalls(left.toolCalls) === summarizeToolCalls(right.toolCalls) &&
    summarizeThinkingSteps(left.thinkingSteps) ===
      summarizeThinkingSteps(right.thinkingSteps) &&
    summarizeRenderBlocks(left.renderBlocks) ===
      summarizeRenderBlocks(right.renderBlocks) &&
    (left.citations?.length ?? 0) === (right.citations?.length ?? 0) &&
    (left.availableCitations?.length ?? 0) ===
      (right.availableCitations?.length ?? 0) &&
    (left.modelReasoningSegments?.length ?? 0) ===
      (right.modelReasoningSegments?.length ?? 0)
  );
}

function areMessageGroupsRenderEqual(
  left: VersionedMessageGroup,
  right: VersionedMessageGroup,
) {
  return (
    left.groupId === right.groupId &&
    left.latestVersionId === right.latestVersionId &&
    left.role === right.role &&
    left.turnId === right.turnId &&
    left.versions.length === right.versions.length &&
    left.versions.every((version, index) =>
      areMessageVersionsRenderEqual(version, right.versions[index] as MessageVersion),
    )
  );
}

type MessageGroupItemProps = {
  activeOriginalBranchIndexRaw?: number;
  group: VersionedMessageGroup;
  highlightedMessageId: string | null;
  isLatestAssistantGroup: boolean;
  isLatestUserGroup: boolean;
  isStreaming: boolean;
  onActiveVersionChange?: MessageListProps["onActiveVersionChange"];
  onArtifactPreview?: MessageListProps["onArtifactPreview"];
  onCitationClick?: MessageListProps["onCitationClick"];
  onRefreshLatest?: MessageListProps["onRefreshLatest"];
  onRestartFromMessage?: MessageListProps["onRestartFromMessage"];
  onSourcePreview?: MessageListProps["onSourcePreview"];
  onWorkfileClick?: MessageListProps["onWorkfileClick"];
  selectedAssistantVersionForUser: MessageVersion | null;
  selectedUserVersionIdForAssistant: string | null;
  selectedSourceIdsByKey: SelectedSourceIdsResolver;
  sourceById: Map<string, SourceItem>;
  workspaceId?: string | null;
};

const MessageGroupItem = memo(function MessageGroupItem({
  activeOriginalBranchIndexRaw,
  group,
  highlightedMessageId,
  isLatestAssistantGroup,
  isLatestUserGroup,
  isStreaming,
  onActiveVersionChange,
  onArtifactPreview,
  onCitationClick,
  onRefreshLatest,
  onRestartFromMessage,
  onSourcePreview,
  onWorkfileClick,
  selectedAssistantVersionForUser,
  selectedSourceIdsByKey,
  selectedUserVersionIdForAssistant,
  sourceById,
  workspaceId,
}: MessageGroupItemProps) {
  const isAssistant = group.role === "assistant";
  const versionEntries = resolveVersionEntries({
    group,
    selectedUserVersionIdForAssistant,
  });
  const { activeOriginalBranchIndex, activeVisibleBranchIndex } =
    resolveActiveOriginalBranchIndex({
      desiredOriginalBranchIndexRaw: activeOriginalBranchIndexRaw,
      versionEntries,
    });
  const toolbarVisibilityClass =
    "invisible pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:visible group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:visible group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100";

  return (
    <MessageBranch
      className="group/message flex w-full flex-col gap-1"
      defaultBranch={activeVisibleBranchIndex}
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
            ? selectedSourceIdsByKey
                .resolve(version)
                .map((sourceId) => sourceById.get(sourceId))
                .filter((source): source is SourceItem => Boolean(source))
            : [];
          const mentionSources = !isAssistant
            ? mergeSourceIds(
                version.mentionedSourceIds,
                version.effectiveMentionedSourceIds,
              )
                .map((sourceId) => sourceById.get(sourceId))
                .filter((source): source is SourceItem => Boolean(source))
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
                        sourceById={sourceById}
                        sources={mentionSources}
                      />
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <ReasoningTrace
                        isCancelled={version.isCancelled === true}
                        isStreaming={isStreamingThisVersion}
                        modelReasoning={version.modelReasoning}
                        modelReasoningSegments={version.modelReasoningSegments}
                        onArtifactPreview={onArtifactPreview}
                        steps={version.thinkingSteps}
                        toolCalls={version.toolCalls}
                        workspaceId={workspaceId}
                      />
                      <WebToolResults
                        availableCitations={version.availableCitations}
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
                          <p className="font-medium">Message failed</p>
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
                      onClick={() => void copyMessageText(messageText)}
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
}, areMessageGroupItemPropsEqual);

function areMessageGroupItemPropsEqual(
  previous: MessageGroupItemProps,
  next: MessageGroupItemProps,
) {
  if (!areMessageGroupsRenderEqual(previous.group, next.group)) {
    return false;
  }
  if (
    previous.activeOriginalBranchIndexRaw !==
      next.activeOriginalBranchIndexRaw ||
    previous.isLatestAssistantGroup !== next.isLatestAssistantGroup ||
    previous.isLatestUserGroup !== next.isLatestUserGroup ||
    previous.selectedUserVersionIdForAssistant !==
      next.selectedUserVersionIdForAssistant ||
    previous.sourceById !== next.sourceById ||
    previous.selectedSourceIdsByKey !== next.selectedSourceIdsByKey ||
    previous.workspaceId !== next.workspaceId ||
    previous.onActiveVersionChange !== next.onActiveVersionChange ||
    previous.onArtifactPreview !== next.onArtifactPreview ||
    previous.onCitationClick !== next.onCitationClick ||
    previous.onRefreshLatest !== next.onRefreshLatest ||
    previous.onRestartFromMessage !== next.onRestartFromMessage ||
    previous.onSourcePreview !== next.onSourcePreview ||
    previous.onWorkfileClick !== next.onWorkfileClick
  ) {
    return false;
  }
  if (
    previous.isStreaming !== next.isStreaming &&
    (previous.isLatestAssistantGroup ||
      next.isLatestAssistantGroup ||
      previous.isLatestUserGroup ||
      next.isLatestUserGroup)
  ) {
    return false;
  }
  if (
    !areNullableMessageVersionsRenderEqual(
      previous.selectedAssistantVersionForUser,
      next.selectedAssistantVersionForUser,
    )
  ) {
    return false;
  }
  if (
    previous.highlightedMessageId !== next.highlightedMessageId &&
    (versionContainsHighlight(previous.group, previous.highlightedMessageId) ||
      versionContainsHighlight(previous.group, next.highlightedMessageId))
  ) {
    return false;
  }

  return true;
}

function areNullableMessageVersionsRenderEqual(
  previous: MessageVersion | null,
  next: MessageVersion | null,
) {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return false;
  }
  return areMessageVersionsRenderEqual(previous, next);
}

export function MessageList({
  activeVersionByGroup = {},
  allSources = [],
  hasOlderMessages = false,
  highlightedMessageId = null,
  isLoadingOlderMessages = false,
  isStreaming = false,
  messageGroups = [],
  onActiveVersionChange,
  onArtifactPreview,
  onCitationClick,
  onLoadOlderMessages,
  onSourcePreview,
  onWorkfileClick,
  onRestartFromMessage,
  onRefreshLatest,
  workspaceId,
}: MessageListProps) {
  const sourceById = useMemo(
    () => new Map(allSources.map((source) => [source.id, source])),
    [allSources],
  );
  const selectedSourceIdsByKey = useMemo(() => {
    const cache = new Map<string, string[]>();
    return {
      resolve(version: MessageVersion) {
        if (version.effectiveSourceIds) {
          return version.effectiveSourceIds;
        }
        const key = `${version.id}:${(version.sourceIds ?? []).join(",")}`;
        const cached = cache.get(key);
        if (cached) {
          return cached;
        }
        const resolved = expandSelectedSources(
          allSources,
          version.sourceIds ?? [],
        ).map((source) => source.id);
        cache.set(key, resolved);
        return resolved;
      },
    };
  }, [allSources]);
  const latestGroups = useMemo(() => {
    let latestUserGroup: VersionedMessageGroup | undefined;
    let latestAssistantGroup: VersionedMessageGroup | undefined;
    for (let index = messageGroups.length - 1; index >= 0; index -= 1) {
      const group = messageGroups[index];
      if (!group) {
        continue;
      }
      if (!latestUserGroup && group.role === "user") {
        latestUserGroup = group;
      }
      if (!latestAssistantGroup && group.role === "assistant") {
        latestAssistantGroup = group;
      }
      if (latestUserGroup && latestAssistantGroup) {
        break;
      }
    }
    return { latestAssistantGroup, latestUserGroup };
  }, [messageGroups]);
  const latestUserGroup = latestGroups.latestUserGroup;
  const latestAssistantGroup = latestGroups.latestAssistantGroup;
  const latestUserGroupId = latestUserGroup?.groupId;
  const latestAssistantGroupId = latestAssistantGroup?.groupId;
  const [showCollapsedHistory, setShowCollapsedHistory] = useState(false);
  const collapsedHistoryCount =
    !showCollapsedHistory &&
    !isStreaming &&
    messageGroups.length > MESSAGE_HISTORY_COLLAPSE_THRESHOLD
      ? messageGroups.length - MESSAGE_HISTORY_VISIBLE_TAIL_COUNT
      : 0;
  const visibleMessageGroups =
    collapsedHistoryCount > 0
      ? messageGroups.slice(collapsedHistoryCount)
      : messageGroups;

  return (
    <Conversation className="min-h-0 flex-1">
      <ConversationContent className="px-6 py-8">
        <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-4">
          {hasOlderMessages ? (
            <div className="flex justify-center">
              <Button
                disabled={isLoadingOlderMessages}
                onClick={onLoadOlderMessages}
                size="sm"
                type="button"
                variant="outline"
              >
                {isLoadingOlderMessages ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Load earlier messages
              </Button>
            </div>
          ) : null}
          {collapsedHistoryCount > 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-muted/20 px-4 py-3 text-center text-xs text-muted-foreground">
              <span>
                {collapsedHistoryCount} older message groups hidden to keep this
                long thread responsive.
              </span>
              <Button
                onClick={() => setShowCollapsedHistory(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                Show hidden history
              </Button>
            </div>
          ) : null}
          {visibleMessageGroups.map((group) => {
            const selectedUserVersionIdForAssistant =
              resolveSelectedUserVersionIdForAssistant({
                activeVersionByGroup,
                group,
                messageGroups,
              });
            const versionEntries = resolveVersionEntries({
              group,
              selectedUserVersionIdForAssistant,
            });
            const { activeOriginalBranchIndex } =
              resolveActiveOriginalBranchIndex({
                desiredOriginalBranchIndexRaw: activeVersionByGroup[group.groupId],
                versionEntries,
              });
            const selectedUserVersionId =
              group.role === "user"
                ? (group.versions[activeOriginalBranchIndex]?.id ?? null)
                : null;
            const selectedAssistantVersionForUser =
              resolveSelectedAssistantVersionForUser({
                activeVersionByGroup,
                messageGroups,
                selectedUserVersionId,
              });
            const isLatestUserGroup = group.groupId === latestUserGroupId;
            const isLatestAssistantGroup =
              group.groupId === latestAssistantGroupId;

            return (
              <MessageGroupItem
                activeOriginalBranchIndexRaw={
                  activeVersionByGroup[group.groupId]
                }
                group={group}
                highlightedMessageId={highlightedMessageId}
                isLatestAssistantGroup={isLatestAssistantGroup}
                isLatestUserGroup={isLatestUserGroup}
                isStreaming={isStreaming}
                key={`${group.groupId}:${group.latestVersionId}:${selectedUserVersionIdForAssistant ?? "all"}:${activeOriginalBranchIndex}`}
                onActiveVersionChange={onActiveVersionChange}
                onArtifactPreview={onArtifactPreview}
                onCitationClick={onCitationClick}
                onRefreshLatest={onRefreshLatest}
                onRestartFromMessage={onRestartFromMessage}
                onSourcePreview={onSourcePreview}
                onWorkfileClick={onWorkfileClick}
                selectedAssistantVersionForUser={
                  selectedAssistantVersionForUser
                }
                selectedSourceIdsByKey={selectedSourceIdsByKey}
                selectedUserVersionIdForAssistant={
                  selectedUserVersionIdForAssistant
                }
                sourceById={sourceById}
                workspaceId={workspaceId}
              />
            );
          })}
        </div>
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
