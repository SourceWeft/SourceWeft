import { memo, useMemo, useState } from "react";
import { Bot, ChevronDown, Copy, Loader2, Pencil, RotateCcw } from "lucide-react";
import {
  Task,
  TaskContent,
  TaskTrigger,
} from "@sourceweft/ui-web/components/ai-elements/task";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
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
  MessageResponse,
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
import { PromptCommandIcon } from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { getAgentToolSlashCommand } from "@sourceweft/agent-tool-registry";
import { RawImage } from "../../../../_components/raw-image";
import { getActionIcon } from "../action-icons";
import { expandSelectedSources, type SourceItem } from "../source-types";
import { WebToolResults } from "../web-tool-results";
import {
  getAttachedWebToolCallIds,
  shouldRenderWebToolResultsFallback,
} from "../web-tool-results-state";
import { normalizeAssetUrl } from "./message-assets";
import { CitationAwareMessageResponse } from "./message-response";
import {
  AssistantActivityPlaceholder,
  AssistantActivityRenderItems,
} from "./assistant-activity-stack";
import { AssistantToolCard } from "./assistant-tool-card";
import { ArtifactOutputCard } from "./artifact-output-card";
import {
  buildAssistantRenderSegments,
  type AssistantTerminalBlock,
  type AssistantWorkflowBlock,
} from "./assistant-render-segments";
import {
  partitionWorkflowBlocksBySubagent,
  subagentDisplayName,
} from "./subagent-grouping";
import {
  getDelegateChipTitle,
  isDelegateToolName,
  parseDelegateToolCall,
} from "./delegate-tool-card-state";
import { formatCompactDuration } from "./duration-format";
import "../artifact-render-host";
import { useArtifactStatuses } from "./use-artifact-statuses";
import {
  isArtifactSnapshotActive,
  isToolOutputClaimingInProgress,
  resolveToolCallArtifactId,
} from "./artifact-work-state";
import { findLastAnswerSegmentId } from "./message-evidence";
import {
  buildMessageRenderState,
  getVisibleAssistantAnswerText,
  type MessageRenderState,
} from "./message-render-state";
import { resolveAssistantFallbackActivity } from "./message-list-state";
import {
  mergeSourceIds,
  SourceIcon,
  toAttachmentData,
  UserMessageText,
} from "./source-rendering";
import { ChatErrorNotice } from "./chat-error-notice";
import { shouldShowRunErrorBanner } from "./run-error-display";
import { resolveMessageVersionRunLifecycle } from "./thread-run-state";
import type {
  ArtifactStatusSnapshot,
  ArtifactPreviewRecord,
  CitationRecord,
  ChatMessageImagePart,
  MessageVersion,
  ToolConfirmationResolution,
  VersionedMessageGroup,
} from "./types";
import type { ActiveThreadRun } from "../../[threadId]/chat-stream-runner-control";

function sanitizeClientErrorMessage(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  if (
    /Error invoking tool/i.test(text) ||
    /Received tool input did not match expected schema/i.test(text) ||
    /\bkwargs\b/i.test(text) ||
    /Invalid input: expected .*received/i.test(text)
  ) {
    const toolName =
      text.match(/tool ['"]([^'"]+)['"]/i)?.[1] ??
      text.match(/\btool[=:]\s*([A-Za-z0-9_-]+)/i)?.[1];
    return toolName
      ? `${toolName} failed because the generated tool arguments were invalid. Please retry.`
      : "The generated tool arguments were invalid. Please retry.";
  }
  return text.length > 600 ? `${text.slice(0, 597).trimEnd()}...` : text;
}

const messageTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatMessageTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return messageTimestampFormatter.format(parsed);
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
            <RawImage
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
  const pattern =
    /\[(skills|skill-command|tool|source):([^\]]+)\]\(((?:\\.|[^)])*)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        text: content.slice(lastIndex, match.index),
        type: "text",
      });
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
    return (
      getAgentToolSlashCommand(normalized.replace(/^\//, ""))?.displayName ??
      normalized
    );
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
  const actionIcon =
    command.kind === "tool" ? getActionIcon(command.value) : null;
  const fallbackIconName = command.kind === "tool" ? "tool" : "skill";
  const useMutedIcon =
    actionIcon?.iconName &&
    actionIcon.iconName !== fallbackIconName &&
    actionIcon.iconTone !== "brand";
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 align-baseline text-sm font-semibold leading-6 text-blue-600 dark:text-blue-400"
      title={command.value}
    >
      <PromptCommandIcon
        className={cn(
          "size-3.5 shrink-0",
          useMutedIcon && "text-muted-foreground",
        )}
        fallbackIconName={fallbackIconName}
        iconName={actionIcon?.iconName}
        iconTone={actionIcon?.iconTone}
      />
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

  const sourceFromToken = (
    token: Extract<UserContentToken, { type: "source" }>,
  ) =>
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
  artifactStatuses,
  onArtifactPreview,
  onCitationClick,
  onWorkfileClick,
  renderState,
  resolvedConfirmations,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
  renderState: MessageRenderState;
  resolvedConfirmations?: ToolConfirmationResolution[];
  workspaceId?: string | null;
}) {
  const version = renderState.raw;
  const mergedArtifactStatuses = useArtifactStatuses({
    artifactStatuses,
    toolCalls: version.toolCalls,
    workspaceId,
  });
  const renderBlocks = renderState.bodyBlocks;
  const cancelledNotice =
    renderState.status === "cancelled" ? "Generation stopped by the user." : null;
  const isWorkflowRunning = renderState.status === "running";
  const segments = buildAssistantRenderSegments(renderBlocks);
  let lastWorkflowSegmentId: string | null = null;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment?.type === "workflow") {
      lastWorkflowSegmentId = segment.id;
      break;
    }
  }
  const lastAnswerSegmentId = findLastAnswerSegmentId({
    segments,
    toolCalls: version.toolCalls,
    workspaceId,
  });
  const attachedWebToolCallIds = getAttachedWebToolCallIds({
    renderBlocks,
    toolCalls: version.toolCalls,
  });
  const shouldRenderWebResultsFallback = shouldRenderWebToolResultsFallback({
    attachedToolCallIds: attachedWebToolCallIds,
    toolCalls: version.toolCalls,
  });
  const hasConcreteActiveActivity =
    (version.toolCalls ?? []).some((toolCall) => {
      if (
        toolCall.status === "running" ||
        toolCall.status === "approval_requested"
      ) {
        return true;
      }
      const artifactId = resolveToolCallArtifactId(toolCall.output);
      return artifactId
        ? isArtifactSnapshotActive(mergedArtifactStatuses.get(artifactId)) ||
            isToolOutputClaimingInProgress(toolCall.output)
        : false;
    }) ||
    (isWorkflowRunning &&
      segments.some((segment) =>
        segment.type === "workflow"
          ? segment.blocks.some((block) => block.type === "reasoning")
          : false,
      ));
  const fallbackPhase = resolveAssistantFallbackActivity({
    hasConcreteActiveActivity,
    isLive: renderState.shouldShowLiveThinking,
    text: renderState.text,
  });
  let didRenderWebResultsFallback = false;

  function resolveWorkflowBlockProducer(block: AssistantWorkflowBlock) {
    if (block.type !== "tool") {
      return undefined;
    }
    return version.toolCalls?.find((tool) => tool.id === block.toolCallId)
      ?.producer;
  }

  function resolveWorkflowDelegate(block: AssistantWorkflowBlock) {
    if (block.type !== "tool") {
      return undefined;
    }
    const toolCall = version.toolCalls?.find(
      (tool) => tool.id === block.toolCallId,
    );
    return toolCall && isDelegateToolName(toolCall.tool)
      ? { taskCallId: toolCall.id }
      : undefined;
  }

  function renderWorkflowBlockAsActivity(input: {
    block: AssistantWorkflowBlock;
    isRunning: boolean;
  }) {
    const { block } = input;
    if (block.type === "reasoning") {
      return (
        <AssistantActivityRenderItems
          availableCitations={renderState.availableCitations}
          isStreaming={input.isRunning}
          items={[
            {
              durationMs: block.durationMs,
              id: block.id,
              key: `block:${block.id}`,
              order: 0,
              text: block.text,
              type: "reasoning",
            },
          ]}
          onCitationClick={onCitationClick}
          onWorkfileClick={onWorkfileClick}
          resolvedConfirmations={resolvedConfirmations}
        />
      );
    }

    if (block.type === "tool") {
      const toolCall = version.toolCalls?.find(
        (item) => item.id === block.toolCallId,
      );
      if (!toolCall) {
        return null;
      }

      return (
        <div>
          <AssistantToolCard
            artifactStatuses={mergedArtifactStatuses}
            onWorkfileClick={onWorkfileClick}
            resolvedConfirmations={resolvedConfirmations}
            toolCall={toolCall}
            workspaceId={workspaceId}
          />
          <WebToolResults
            availableCitations={renderState.availableCitations}
            onCitationClick={onCitationClick}
            toolCall={toolCall}
            variant="activity-row"
          />
        </div>
      );
    }

    if (block.type === "text") {
      return (
        <CitationAwareMessageResponse
          availableCitations={renderState.availableCitations}
          citations={renderState.citations}
          onCitationClick={onCitationClick}
          onWorkfileClick={onWorkfileClick}
        >
          {block.text}
        </CitationAwareMessageResponse>
      );
    }

    if (block.type === "artifact_output") {
      return (
        <ArtifactOutputCard
          artifactStatuses={mergedArtifactStatuses}
          block={block}
          onArtifactPreview={onArtifactPreview}
          workspaceId={workspaceId}
        />
      );
    }

    return null;
  }

  function renderTerminalBlock(block: AssistantTerminalBlock) {
    if (block.type === "reasoning" || block.type === "text") {
      return (
        <CitationAwareMessageResponse
          availableCitations={renderState.availableCitations}
          citations={renderState.citations}
          onCitationClick={onCitationClick}
          onWorkfileClick={onWorkfileClick}
        >
          {block.text}
        </CitationAwareMessageResponse>
      );
    }

    if (block.type === "artifact_output") {
      return (
        <ArtifactOutputCard
          artifactStatuses={mergedArtifactStatuses}
          block={block}
          onArtifactPreview={onArtifactPreview}
          workspaceId={workspaceId}
        />
      );
    }

    const toolCall = version.toolCalls?.find(
      (item) => item.id === block.toolCallId,
    );
    if (!toolCall) {
      return null;
    }

    return (
      <div>
        <AssistantToolCard
          artifactStatuses={mergedArtifactStatuses}
          onWorkfileClick={onWorkfileClick}
          resolvedConfirmations={resolvedConfirmations}
          toolCall={toolCall}
          workspaceId={workspaceId}
        />
        <WebToolResults
          availableCitations={renderState.availableCitations}
          onCitationClick={onCitationClick}
          toolCall={toolCall}
          variant="activity-row"
        />
      </div>
    );
  }

  return (
    <>
      {segments.map((segment) => {
        if (segment.type === "terminal") {
          const artifactCount = segment.blocks.filter(
            (block) => block.type === "artifact_output",
          ).length;
          return (
            <div className="mt-2 max-w-3xl space-y-3" key={segment.id}>
              {artifactCount > 1 ? (
                <p className="text-xs font-medium text-muted-foreground">
                  {artifactCount} artifacts
                </p>
              ) : null}
              {segment.blocks.map((block) => (
                <div key={block.id}>{renderTerminalBlock(block)}</div>
              ))}
            </div>
          );
        }

        if (segment.type === "workflow") {
          return (
            <div
              className="my-1.5 max-w-2xl space-y-1 text-sm"
              data-assistant-activity-stack="true"
              key={segment.id}
            >
              {partitionWorkflowBlocksBySubagent(
                segment.blocks,
                resolveWorkflowBlockProducer,
                resolveWorkflowDelegate,
              ).map((item) => {
                const lastBlockIndex = segment.blocks.length - 1;
                const isBlockRunning = (blockIndex: number) =>
                  segment.id === lastWorkflowSegmentId &&
                  isWorkflowRunning &&
                  blockIndex === lastBlockIndex;
                if (item.kind === "delegate" || item.kind === "agent-group") {
                  const taskBlock =
                    item.kind === "delegate" ? item.taskBlock.block : undefined;
                  const toolCall =
                    taskBlock && taskBlock.type === "tool"
                      ? version.toolCalls?.find(
                          (tool) => tool.id === taskBlock.toolCallId,
                        )
                      : undefined;
                  const view = toolCall
                    ? parseDelegateToolCall(toolCall)
                    : null;
                  const isRunning = view?.status === "running";
                  const chipTitle =
                    (view ? getDelegateChipTitle(view.prompt) : null) ??
                    subagentDisplayName(view?.subagentType ?? item.subagentType);
                  const duration =
                    toolCall?.latencyMs != null &&
                    Number.isFinite(toolCall.latencyMs)
                      ? formatCompactDuration(toolCall.latencyMs)
                      : null;
                  return (
                    // LobeChat-style delegate row: "Call sub-agent" + a task pill
                    // + duration, collapsible into the brief / steps / report.
                    <Task defaultOpen key={item.key}>
                      <TaskTrigger title="Call sub-agent">
                        <div
                          className={cn(
                            ASSISTANT_ACTIVITY_ROW_CLASS,
                            "cursor-pointer text-muted-foreground text-sm transition-colors hover:text-foreground",
                          )}
                        >
                          <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
                            {isRunning ? (
                              <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" />
                            ) : (
                              <Bot className="size-4" />
                            )}
                          </span>
                          <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
                            <span className="shrink-0 font-medium text-foreground/80">
                              Call sub-agent
                            </span>
                            <Badge
                              className="min-w-0 truncate font-normal text-foreground/70"
                              variant="secondary"
                            >
                              {chipTitle}
                            </Badge>
                            {duration ? (
                              <span className="shrink-0 text-muted-foreground/60 text-xs">
                                {duration}
                              </span>
                            ) : null}
                            {view?.status === "error" ? (
                              <span className="shrink-0 text-destructive text-xs">
                                Failed
                              </span>
                            ) : null}
                          </span>
                          <span className="grid size-4 shrink-0 place-items-center">
                            <ChevronDown className="size-3 text-muted-foreground/50 transition-transform group-data-[state=open]:rotate-180" />
                          </span>
                        </div>
                      </TaskTrigger>
                      <TaskContent>
                        <div className="max-h-96 space-y-2.5 overflow-y-auto pr-1">
                          {view?.prompt ? (
                            <section className="space-y-1">
                              <span className="block pl-1 font-medium text-[11px] text-muted-foreground/50 tracking-wide">
                                Instruction
                              </span>
                              <div className="pl-1 text-[13px] text-muted-foreground/75">
                                <MessageResponse>{view.prompt}</MessageResponse>
                              </div>
                            </section>
                          ) : null}
                          {item.entries.map((entry) => (
                            <div key={entry.block.id}>
                              {renderWorkflowBlockAsActivity({
                                block: entry.block,
                                isRunning: isBlockRunning(entry.index),
                              })}
                            </div>
                          ))}
                          {item.entries.length === 0 && isRunning ? (
                            <p className="pl-1 text-[13px] text-muted-foreground/75 leading-5">
                              Working…
                            </p>
                          ) : null}
                          {view?.report ? (
                            <section className="space-y-1 border-border/50 border-t pt-2">
                              <span className="block pl-1 font-medium text-[11px] text-muted-foreground/50 tracking-wide">
                                Result
                              </span>
                              <div className="pl-1 text-sm">
                                <CitationAwareMessageResponse citations={undefined}>
                                  {view.report}
                                </CitationAwareMessageResponse>
                              </div>
                            </section>
                          ) : null}
                        </div>
                      </TaskContent>
                    </Task>
                  );
                }
                return (
                  <div key={item.block.id}>
                    {renderWorkflowBlockAsActivity({
                      block: item.block,
                      isRunning: isBlockRunning(item.index),
                    })}
                  </div>
                );
              })}
            </div>
          );
        }

        const blockText = getVisibleAssistantAnswerText({
          content: segment.blocks.map((block) => block.text).join(""),
          toolCalls: version.toolCalls,
          workspaceId,
        });
        if (blockText.length === 0) {
          return null;
        }

        const shouldRenderFallbackBeforeSegment =
          shouldRenderWebResultsFallback && !didRenderWebResultsFallback;
        didRenderWebResultsFallback = true;

        return (
          <div className="space-y-2" key={segment.id}>
            {shouldRenderFallbackBeforeSegment ? (
              <WebToolResults
                availableCitations={renderState.availableCitations}
                onCitationClick={onCitationClick}
                toolCalls={version.toolCalls}
              />
            ) : null}
            <CitationAwareMessageResponse
              availableCitations={
                segment.id === lastAnswerSegmentId
                  ? renderState.availableCitations
                  : []
              }
              citations={renderState.citations}
              className="ml-1"
              onCitationClick={onCitationClick}
              onWorkfileClick={onWorkfileClick}
            >
              {blockText}
            </CitationAwareMessageResponse>
          </div>
        );
      })}
      {shouldRenderWebResultsFallback && !didRenderWebResultsFallback ? (
        <WebToolResults
          availableCitations={renderState.availableCitations}
          onCitationClick={onCitationClick}
          toolCalls={version.toolCalls}
        />
      ) : null}
      {fallbackPhase ? (
        <div className="my-1.5">
          <AssistantActivityPlaceholder phase={fallbackPhase} />
        </div>
      ) : null}
      {cancelledNotice ? (
        <p className="text-sm text-muted-foreground">{cancelledNotice}</p>
      ) : null}
    </>
  );
}

function AssistantTimeline({
  artifactStatuses,
  onArtifactPreview,
  onCitationClick,
  onWorkfileClick,
  renderState,
  resolvedConfirmations,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
  renderState: MessageRenderState;
  resolvedConfirmations?: ToolConfirmationResolution[];
  workspaceId?: string | null;
}) {
  return (
    <AssistantMessageBody
      artifactStatuses={artifactStatuses}
      onArtifactPreview={onArtifactPreview}
      onCitationClick={onCitationClick}
      onWorkfileClick={onWorkfileClick}
      renderState={renderState}
      resolvedConfirmations={resolvedConfirmations}
      workspaceId={workspaceId}
    />
  );
}

type MessageListProps = {
  activeThreadRun?: ActiveThreadRun | null;
  activeVersionByGroup?: Record<string, number>;
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
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
  resolvedConfirmations?: ToolConfirmationResolution[];
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
  const latestVisibleVersionIndex = Math.max(
    input.versionEntries.length - 1,
    0,
  );
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
    preferredAssistantVersion?.sourceUserMessageId ===
    input.selectedUserVersionId
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

type MessageGroupItemProps = {
  activeOriginalBranchIndexRaw?: number;
  activeThreadRun?: ActiveThreadRun | null;
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
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
  resolvedConfirmations?: ToolConfirmationResolution[];
  selectedAssistantVersionForUser: MessageVersion | null;
  selectedUserVersionIdForAssistant: string | null;
  selectedSourceIdsByKey: SelectedSourceIdsResolver;
  sourceById: Map<string, SourceItem>;
  workspaceId?: string | null;
};

const MessageGroupItem = memo(function MessageGroupItem({
  activeOriginalBranchIndexRaw,
  activeThreadRun,
  artifactStatuses,
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
  resolvedConfirmations = [],
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
          const versionRunLifecycle =
            isAssistant && versionIndex === activeVisibleBranchIndex
              ? resolveMessageVersionRunLifecycle({
                  activeThreadRun,
                  isLatestAssistantGroup,
                  isStreaming,
                  version,
                })
              : "idle";
          const isStreamingThisVersion =
            versionRunLifecycle === "live" ||
            versionRunLifecycle === "waiting_for_approval";
          const sourceIds = !isAssistant
            ? selectedSourceIdsByKey.resolve(version)
            : [];
          const mentionedSourceIds = !isAssistant
            ? mergeSourceIds(
                version.mentionedSourceIds,
                version.effectiveMentionedSourceIds,
              )
            : [];
          const messageTimestamp = formatMessageTimestamp(version.createdAt);
          const renderState = buildMessageRenderState({
            isAssistantStreaming: isStreamingThisVersion,
            mentionedSourceIds,
            role: group.role,
            sourceIds,
            timestamp: messageTimestamp ?? undefined,
            version,
            workspaceId,
          });
          const messageText =
            renderState.error && !version.isCancelled
              ? (sanitizeClientErrorMessage(renderState.error.message) ??
                renderState.error.message)
              : renderState.text;
          const referencedSources = !isAssistant
            ? renderState.sourceIds
                .map((sourceId) => sourceById.get(sourceId))
                .filter((source): source is SourceItem => Boolean(source))
            : [];
          const mentionSources = !isAssistant
            ? renderState.mentionedSourceIds
                .map((sourceId) => sourceById.get(sourceId))
                .filter((source): source is SourceItem => Boolean(source))
            : [];
          const hasActiveRunOnThisGroup =
            isAssistant &&
            versionIndex === activeVisibleBranchIndex &&
            isLatestAssistantGroup &&
            Boolean(activeThreadRun);
          const showRunErrorBanner = shouldShowRunErrorBanner({
            hasActiveRunOnThisGroup,
            isStreamingThisVersion,
            renderState,
          });

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
                  images={renderState.imageParts}
                  sources={referencedSources}
                />
              ) : null}
              {messageTimestamp ? (
                <div
                  className={cn(
                    "flex min-h-5 px-1 text-[11px] leading-5 text-muted-foreground",
                    isAssistant ? "justify-start" : "justify-end",
                    toolbarVisibilityClass,
                  )}
                >
                  <span>{messageTimestamp}</span>
                </div>
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
                      <AssistantTimeline
                        artifactStatuses={artifactStatuses}
                        onArtifactPreview={onArtifactPreview}
                        onCitationClick={onCitationClick}
                        onWorkfileClick={onWorkfileClick}
                        renderState={renderState}
                        resolvedConfirmations={resolvedConfirmations}
                        workspaceId={workspaceId}
                      />
                      {showRunErrorBanner && renderState.error ? (
                        <ChatErrorNotice
                          code={renderState.error.code}
                          message={
                            sanitizeClientErrorMessage(
                              renderState.error.message,
                            ) ?? "Model error"
                          }
                          title="Message failed"
                        />
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
});

export function MessageList({
  activeThreadRun = null,
  activeVersionByGroup = {},
  allSources = [],
  artifactStatuses,
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
  resolvedConfirmations = [],
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
    !activeThreadRun &&
    messageGroups.length > MESSAGE_HISTORY_COLLAPSE_THRESHOLD
      ? messageGroups.length - MESSAGE_HISTORY_VISIBLE_TAIL_COUNT
      : 0;
  const visibleMessageGroups =
    collapsedHistoryCount > 0
      ? messageGroups.slice(collapsedHistoryCount)
      : messageGroups;

  return (
    <Conversation className="h-full min-h-0 flex-1 overflow-hidden [scrollbar-gutter:stable]">
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
                desiredOriginalBranchIndexRaw:
                  activeVersionByGroup[group.groupId],
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
                activeThreadRun={activeThreadRun}
                artifactStatuses={artifactStatuses}
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
                resolvedConfirmations={resolvedConfirmations}
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
