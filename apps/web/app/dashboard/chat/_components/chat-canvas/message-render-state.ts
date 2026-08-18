import { buildAssistantActivityItems } from "./assistant-activity-items";
import {
  shouldShowAssistantBottomLoading,
  shouldShowAssistantLiveThinking,
} from "./message-list-state";
import type { MessageVersion } from "./types";
import {
  getMessageImageParts,
  getMessageText,
  stripGeneratedImageMarkdown,
} from "./message-assets";

export type AssistantLifecycle =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type MessageRenderState = {
  activityItems: ReturnType<typeof buildAssistantActivityItems>;
  availableCitations: NonNullable<MessageVersion["availableCitations"]>;
  bodyBlocks: NonNullable<MessageVersion["renderBlocks"]>;
  citations: NonNullable<MessageVersion["citations"]>;
  error: { code?: string | null; message: string } | null;
  id: string;
  imageParts: ReturnType<typeof getMessageImageParts>;
  isAssistantStreaming: boolean;
  mentionedSourceIds: string[];
  raw: MessageVersion;
  renderKey: string;
  renderRevision: string;
  role: "user" | "assistant";
  shouldShowBottomLoading: boolean;
  shouldShowLiveThinking: boolean;
  sourceIds: string[];
  status: AssistantLifecycle | "user";
  text: string;
  timestamp?: string;
};

function sortedSignature(values: string[] | undefined) {
  return (values ?? []).join(",");
}

function blockSignature(blocks: MessageRenderState["bodyBlocks"]) {
  return blocks
    .map((block) => {
      const placement = block.placement ?? "";
      if (block.type === "text") {
        return `${block.id}:text:${placement}:${block.text}`;
      }
      if (block.type === "reasoning") {
        return `${block.id}:reasoning:${placement}:${block.durationMs ?? ""}:${block.text}`;
      }
      if (block.type === "artifact_output") {
        return `${block.id}:artifact_output:${placement}:${block.artifactId}:${block.artifactVersionId}`;
      }
      return `${block.id}:${block.type}:${placement}:${block.toolCallId}`;
    })
    .join("|");
}

function toolSignature(toolCalls: MessageVersion["toolCalls"]) {
  return (toolCalls ?? [])
    .map(
      (toolCall) =>
        `${toolCall.id}:${toolCall.tool}:${toolCall.status}:${toolCall.error ?? ""}:${toolCall.latencyMs ?? ""}:${toolCall.approvalState ?? ""}`,
    )
    .join("|");
}

function activitySignature(items: MessageRenderState["activityItems"]) {
  return items
    .map((item) => {
      if (item.type === "tool") {
        return `${item.key}:tool:${item.toolCall.id}:${item.toolCall.status}:${item.toolCall.error ?? ""}:${item.toolCall.approvalState ?? ""}`;
      }
      if (item.type === "step") {
        return `${item.key}:step:${item.status}:${item.title}:${item.items.join("\n")}`;
      }
      return `${item.key}:reasoning:${item.text}:${item.durationMs ?? ""}`;
    })
    .join("|");
}

function citationSignature(citations: MessageRenderState["citations"]) {
  return citations
    .map((citation) =>
      [
        citation.citation,
        citation.chunkId,
        citation.chunkNo ?? "",
        citation.sourceId ?? "",
        citation.sourceTitle ?? "",
        citation.documentId ?? "",
        citation.externalUri ?? "",
        citation.score,
        citation.excerpt,
        citation.content ?? "",
      ].join(":"),
    )
    .join("|");
}

function resolveAssistantStatus(input: {
  isStreaming: boolean;
  version: MessageVersion;
}): AssistantLifecycle {
  const { isStreaming, version } = input;
  if (version.isCancelled) {
    return "cancelled";
  }
  if (version.isError || version.errorCode) {
    return "failed";
  }
  if (version.threadRun?.status === "waiting_for_approval") {
    return "waiting_for_approval";
  }
  if (
    isStreaming ||
    version.threadRun?.status === "running" ||
    version.threadRun?.status === "queued" ||
    version.threadRun?.status === "cancel_requested"
  ) {
    return "running";
  }
  if (
    version.threadRun?.status === "completed" ||
    (version.finishReason &&
      version.finishReason !== "tool_confirmation_requested")
  ) {
    return "completed";
  }
  return "idle";
}

export function buildMessageRenderState(input: {
  isAssistantStreaming: boolean;
  mentionedSourceIds?: string[];
  role: "user" | "assistant";
  sourceIds?: string[];
  timestamp?: string;
  version: MessageVersion;
  workspaceId?: string | null;
}): MessageRenderState {
  const { isAssistantStreaming, role, timestamp, version, workspaceId } = input;
  const text = getMessageText({ version, workspaceId });
  const bodyBlocks = version.renderBlocks ?? [];
  const activityItems =
    role === "assistant"
      ? buildAssistantActivityItems({
          assistantText: version.content,
          steps: version.thinkingSteps,
          toolCalls: version.toolCalls,
          traceParts: version.traceParts,
        })
      : [];
  const citations = version.citations ?? [];
  const availableCitations = version.availableCitations ?? [];
  const sourceIds =
    input.sourceIds ?? version.effectiveSourceIds ?? version.sourceIds ?? [];
  const mentionedSourceIds =
    input.mentionedSourceIds ??
    version.effectiveMentionedSourceIds ??
    version.mentionedSourceIds ??
    [];
  const shouldShowBottomLoading =
    role === "assistant"
      ? shouldShowAssistantBottomLoading({
          isCancelled: version.isCancelled,
          isStreaming: isAssistantStreaming,
          threadRunStatus: version.threadRun?.status,
        })
      : false;
  const shouldShowLiveThinking =
    role === "assistant"
      ? shouldShowAssistantLiveThinking({
          isCancelled: version.isCancelled,
          isStreaming: isAssistantStreaming,
        })
      : false;
  const status =
    role === "assistant"
      ? resolveAssistantStatus({ isStreaming: isAssistantStreaming, version })
      : "user";
  const visibleText =
    version.isError && !version.isCancelled ? (version.error ?? text) : text;
  const renderRevision = [
    version.id,
    version.renderKey ?? "",
    role,
    status,
    visibleText,
    version.error ?? "",
    version.errorCode ?? "",
    version.isTextPaused ? "paused" : "",
    version.isTextInterrupted ? "interrupted" : "",
    sortedSignature(sourceIds),
    sortedSignature(mentionedSourceIds),
    blockSignature(bodyBlocks),
    toolSignature(version.toolCalls),
    activitySignature(activityItems),
    citationSignature(citations),
    citationSignature(availableCitations),
    version.threadRun?.id ?? "",
    version.threadRun?.status ?? "",
    version.threadRun?.mode ?? "",
    version.threadRun?.approvalRequestedAt ?? "",
    version.threadRun?.approvalExpiresAt ?? "",
    timestamp ?? "",
  ].join("\u001f");

  return {
    activityItems,
    availableCitations,
    bodyBlocks,
    citations,
    error:
      version.isError && !version.isCancelled
        ? {
            code: version.errorCode,
            message: version.error ?? text,
          }
        : null,
    id: version.id,
    imageParts: role === "user" ? getMessageImageParts(version) : [],
    isAssistantStreaming,
    mentionedSourceIds,
    raw: version,
    renderKey: version.renderKey ?? version.id,
    renderRevision,
    role,
    shouldShowBottomLoading,
    shouldShowLiveThinking,
    sourceIds,
    status,
    text,
    timestamp,
  };
}

export function getVisibleAssistantAnswerText(input: {
  content: string;
  toolCalls?: MessageVersion["toolCalls"];
  workspaceId?: string | null;
}) {
  return stripGeneratedImageMarkdown({
    content: input.content,
    toolCalls: input.toolCalls,
    trim: false,
    workspaceId: input.workspaceId,
  });
}
