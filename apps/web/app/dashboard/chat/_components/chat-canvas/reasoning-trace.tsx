import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  CheckIcon,
  CircleIcon,
  Download,
  ImageIcon,
  Loader2,
  Presentation,
  ListChecks,
  WrenchIcon,
} from "lucide-react";
import {
  AGENT_TOOL_NAMES,
  getAgentToolSlashCommand,
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { isPendingToolConfirmation } from "@sourceweft/contracts";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtImage,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@sourceweft/ui-web/components/ai-elements/chain-of-thought";
import {
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
} from "@sourceweft/ui-web/components/ai-elements/queue";
import { Shimmer } from "@sourceweft/ui-web/components/ai-elements/shimmer";
import {
  Task,
  TaskContent,
  TaskTrigger,
} from "@sourceweft/ui-web/components/ai-elements/task";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { RawImage } from "../../../../_components/raw-image";
import { apiBaseUrl } from "../../../../../lib/sdk";
import { resolveArtifactPageUrl } from "../artifact-urls";
import { hasWebPageToolResults } from "../web-tool-results";
import {
  getToolConfirmationOutput,
  isToolCallActivelyRunning,
} from "./tool-confirmation-state";
import {
  compactText,
  type GeneratedPresentationArtifactStatus,
  getToolOutputContent,
  normalizeAssetUrl,
  resolveArtifactDownloadUrl,
  resolveArtifactUrl,
  resolveGeneratedImageArtifact,
  resolveGeneratedPresentationArtifact,
} from "./message-assets";
import { GeneratedImagePreview } from "./generated-image-preview";
import {
  getConnectorToolDisplayLabel,
  getToolCallDetailParts,
  getToolApprovalDisplayLabel,
  getResolvedToolConfirmationMessage,
  getReasoningTraceTitle,
  isToolConfirmationResolved,
  isReasoningTraceThinking,
  shouldShowGeneratedPresentationItem,
} from "./reasoning-trace-state";
import {
  getTodoListTraceItems,
  isTodoListTraceStep,
  type TodoListTraceItem,
} from "./reasoning-trace-todos";
import { getSandboxToolSafeErrorMessage } from "./sandbox-tool-result-display";
import type {
  ArtifactPreviewRecord,
  ArtifactStatusSnapshot,
  ThinkingStepRecord,
  ToolConfirmationResolution,
  ToolCallRecord,
  TracePartRecord,
} from "./types";

type ReasoningTraceTimelineItem =
  | {
      kind: "model-reasoning";
      key: string;
      originalIndex: number;
      phase?: "initial" | "after_tool";
      sequence: number;
      text: string;
      toolCallId?: string;
      durationMs?: number;
    }
  | {
      kind: "step";
      key: string;
      originalIndex: number;
      sequence: number;
      step: ThinkingStepRecord;
    }
  | {
      kind: "tool";
      key: string;
      originalIndex: number;
      sequence: number;
      toolCall: ToolCallRecord;
      toolStep?: ThinkingStepRecord;
    };

type ToolTimelineItem = Extract<ReasoningTraceTimelineItem, { kind: "tool" }>;

function artifactPreviewCapabilities(input: {
  fileBacked: boolean;
  previewInline?: boolean;
  renderClientVideo?: boolean;
}) {
  return {
    canDownloadFile: input.fileBacked,
    canOpenFile: input.fileBacked,
    canPreviewInline: input.previewInline ?? input.fileBacked,
    canRenderClientVideo: input.renderClientVideo ?? false,
  };
}

function isStepTimelineItem(
  item: ReasoningTraceTimelineItem,
): item is Extract<ReasoningTraceTimelineItem, { kind: "step" }> {
  return item.kind === "step";
}

const GENERATED_IMAGE_DEFAULT_ASPECT_RATIO = "4 / 3";
const ILLEGAL_FILENAME_CHARS = new Set([
  "<",
  ">",
  ":",
  '"',
  "/",
  "\\",
  "|",
  "?",
  "*",
]);

function replaceIllegalFilenameCharacters(value: string) {
  return Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || code === 127 || ILLEGAL_FILENAME_CHARS.has(char)
        ? "-"
        : char;
    })
    .join("");
}

function getRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  return record ? record[key] : undefined;
}

function getToolQuery(toolCall: ToolCallRecord, toolStep?: ThinkingStepRecord) {
  const inputQuery = getRecordValue(toolCall.input, "query");
  if (typeof inputQuery === "string" && inputQuery.trim().length > 0) {
    return inputQuery.trim();
  }

  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const outputQuery = getRecordValue(output, "query");
  if (typeof outputQuery === "string" && outputQuery.trim().length > 0) {
    return outputQuery.trim();
  }

  const metadataQuery = getRecordValue(toolStep?.metadata, "query");
  return typeof metadataQuery === "string" && metadataQuery.trim().length > 0
    ? metadataQuery.trim()
    : null;
}

function getToolFetchUrls(toolCall: ToolCallRecord) {
  const items = getRecordValue(toolCall.input, "items");
  if (!Array.isArray(items)) {
    return [] as string[];
  }

  return items
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const url = (item as Record<string, unknown>).url;
      return typeof url === "string" && url.trim().length > 0
        ? url.trim()
        : null;
    })
    .filter((url): url is string => url !== null);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function TodoStatusIcon({
  status,
}: {
  status: TodoListTraceItem["status"];
}) {
  if (status === "completed") {
    return <CheckIcon className="size-3 text-muted-foreground/60" />;
  }
  if (status === "in_progress") {
    return <Loader2 className="size-3 animate-spin text-primary" />;
  }
  return <CircleIcon className="size-2.5 text-muted-foreground/60" />;
}

function DeepAgentTodoTrace({
  isCancelled,
  step,
}: {
  isCancelled: boolean;
  step: ThinkingStepRecord;
}) {
  const todos = getTodoListTraceItems(step.metadata);
  if (todos.length === 0) {
    return null;
  }

  const completedCount = todos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const isActive = !isCancelled && step.status === "in_progress";
  const title = isActive
    ? "Working through task plan..."
    : `Task plan ${completedCount}/${todos.length}`;

  return (
    <Task className="py-1" defaultOpen={isActive}>
      <TaskTrigger title={title}>
        <div className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-muted-foreground text-sm transition-colors hover:text-foreground">
          {isActive ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : (
            <ListChecks className="size-4" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {isActive ? <Shimmer duration={1}>{title}</Shimmer> : title}
          </span>
          <span className="text-muted-foreground/80 text-xs">
            {completedCount}/{todos.length}{" "}
            {pluralize(todos.length, "item")}
          </span>
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </TaskTrigger>
      <TaskContent className="pl-1">
        <ul className="space-y-1">
          {todos.map((todo) => {
            const completed = todo.status === "completed";
            const inProgress = todo.status === "in_progress" && !isCancelled;
            return (
              <QueueItem
                className="px-1 py-1 hover:bg-transparent"
                key={todo.id}
              >
                <div className="flex min-w-0 items-start gap-2">
                  <QueueItemIndicator
                    className={cn(
                      "mt-1 flex items-center justify-center",
                      inProgress
                        ? "border-primary/40 bg-primary/10"
                        : completed
                          ? "border-muted-foreground/20 bg-muted"
                          : undefined,
                    )}
                    completed={completed}
                  >
                    <TodoStatusIcon status={todo.status} />
                  </QueueItemIndicator>
                  <div className="min-w-0 flex-1">
                    <QueueItemContent
                      className={cn(
                        "line-clamp-none",
                        inProgress ? "text-foreground" : undefined,
                      )}
                      completed={completed}
                    >
                      {todo.content}
                    </QueueItemContent>
                    {todo.description ? (
                      <QueueItemDescription
                        className="ml-0"
                        completed={completed}
                      >
                        {todo.description}
                      </QueueItemDescription>
                    ) : null}
                  </div>
                </div>
              </QueueItem>
            );
          })}
        </ul>
      </TaskContent>
    </Task>
  );
}

function summarizeToolOutput(output: unknown) {
  const confirmation = getToolConfirmationOutput(output);
  if (confirmation) {
    return null;
  }
  const content = getToolOutputContent(output);
  return content ? compactText(content) : null;
}

function parseAspectRatio(value: unknown) {
  if (typeof value !== "string" || value === "auto") {
    return null;
  }

  const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
    return null;
  }

  return `${width} / ${height}`;
}

function formatToolName(toolName: string) {
  return toolName
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getToolDisplayName(toolName: string) {
  return (
    getAgentToolSlashCommand(toolName)?.displayName ?? formatToolName(toolName)
  );
}

function getWebSearchStatusLabel(status: ToolCallRecord["status"]) {
  if (status === "running" || status === "approval_requested") {
    return "Searching web";
  }
  if (status === "error") {
    return "Web search failed";
  }
  return "Searched web";
}

function getWebFetchStatusLabel(status: ToolCallRecord["status"]) {
  if (status === "running" || status === "approval_requested") {
    return "Fetching pages";
  }
  if (status === "error") {
    return "Page fetch failed";
  }
  return "Fetched pages";
}

const GENERATED_IMAGE_STAGE_LABELS: Record<string, string> = {
  billing: "Finalizing",
  generating: "Rendering",
  preparing: "Composing",
  ready: "Ready",
  saving: "Polishing",
};

const GENERATED_IMAGE_STAGE_INDEX: Record<string, number> = {
  preparing: 0,
  generating: 1,
  saving: 2,
  billing: 3,
  ready: 4,
};

function getGeneratedImageStatus(toolCall: ToolCallRecord) {
  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const input = toolCall.input;
  const stage = getRecordValue(output, "stage");
  const normalizedStage =
    typeof stage === "string" && stage.trim().length > 0 ? stage.trim() : null;
  const outputWidth = getRecordValue(output, "width");
  const outputHeight = getRecordValue(output, "height");
  const width =
    typeof outputWidth === "number" && Number.isFinite(outputWidth)
      ? outputWidth
      : null;
  const height =
    typeof outputHeight === "number" && Number.isFinite(outputHeight)
      ? outputHeight
      : null;
  const aspectRatio =
    width && height && height > 0
      ? `${width} / ${height}`
      : (parseAspectRatio(getRecordValue(output, "aspectRatio")) ??
        parseAspectRatio(getRecordValue(input, "aspectRatio")) ??
        GENERATED_IMAGE_DEFAULT_ASPECT_RATIO);

  return {
    aspectRatio,
    label: normalizedStage
      ? (GENERATED_IMAGE_STAGE_LABELS[normalizedStage] ??
        formatToolName(normalizedStage))
      : null,
    progress:
      normalizedStage && normalizedStage in GENERATED_IMAGE_STAGE_INDEX
        ? GENERATED_IMAGE_STAGE_INDEX[normalizedStage]
        : null,
    stage: normalizedStage,
  };
}

function getGeneratedImageTitle(toolCall: ToolCallRecord) {
  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const outputTitle = getRecordValue(output, "title");
  if (typeof outputTitle === "string" && outputTitle.trim().length > 0) {
    return outputTitle.trim();
  }

  const inputTitle = getRecordValue(toolCall.input, "title");
  if (typeof inputTitle === "string" && inputTitle.trim().length > 0) {
    return inputTitle.trim();
  }

  const prompt = getRecordValue(toolCall.input, "prompt");
  return typeof prompt === "string" && prompt.trim().length > 0
    ? compactText(prompt, 72)
    : null;
}

function getGeneratedImagePrompt(toolCall: ToolCallRecord) {
  const prompt = getRecordValue(toolCall.input, "prompt");
  if (typeof prompt === "string" && prompt.trim().length > 0) {
    return prompt.trim();
  }

  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const outputPrompt = getRecordValue(output, "prompt");
  return typeof outputPrompt === "string" && outputPrompt.trim().length > 0
    ? outputPrompt.trim()
    : null;
}

function getGeneratedPresentationTitle(toolCall: ToolCallRecord) {
  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const outputTitle = getRecordValue(output, "title");
  if (typeof outputTitle === "string" && outputTitle.trim().length > 0) {
    return outputTitle.trim();
  }

  const inputTitle = getRecordValue(toolCall.input, "title");
  return typeof inputTitle === "string" && inputTitle.trim().length > 0
    ? inputTitle.trim()
    : null;
}

function getGeneratedPresentationPrompt(toolCall: ToolCallRecord) {
  const brief = getRecordValue(toolCall.input, "brief");
  if (typeof brief === "string" && brief.trim().length > 0) {
    return brief.trim();
  }

  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const outputPrompt = getRecordValue(output, "prompt");
  return typeof outputPrompt === "string" && outputPrompt.trim().length > 0
    ? outputPrompt.trim()
    : null;
}

function downloadPresentationFileName(title: string, extension = "pptx") {
  const normalized = replaceIllegalFilenameCharacters(
    title.normalize("NFKC").trim(),
  )
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 120);
  const fallback = normalized || "generated-presentation";
  const suffix = `.${extension}`;
  const lowerFallback = fallback.toLowerCase();
  if (lowerFallback.endsWith(suffix)) {
    return fallback;
  }
  const withoutPresentationExtension = fallback.replace(
    /\.(?:pptx|html)$/i,
    "",
  );
  return `${withoutPresentationExtension}${suffix}`;
}

function downloadVideoPresentationFileName(title: string) {
  const normalized = replaceIllegalFilenameCharacters(
    title.normalize("NFKC").trim(),
  )
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 120);
  const fallback = normalized || "generated-video-presentation";
  return fallback.toLowerCase().endsWith(".mp4") ? fallback : `${fallback}.mp4`;
}

function getGeneratedPresentationFileName(input: {
  artifactFileName?: string | null;
  generationMode?: "visual_html" | "editable_native" | null;
  title?: string | null;
  videoPresentation?: boolean;
}) {
  if (input.videoPresentation) {
    return downloadVideoPresentationFileName(
      input.title ?? input.artifactFileName ?? "",
    );
  }
  return downloadPresentationFileName(
    input.artifactFileName ?? input.title ?? "",
    input.generationMode === "visual_html" ? "html" : "pptx",
  );
}

function getPresentationArtifactPreviewStatus(input: {
  isVideoPresentation: boolean;
  status?: GeneratedPresentationArtifactStatus | null;
}): ArtifactPreviewRecord["status"] {
  if (!input.isVideoPresentation) {
    return "ready";
  }
  return input.status ?? "pending";
}

function isPresentationArtifactPending(
  status?: GeneratedPresentationArtifactStatus | null,
) {
  return status === "pending" || status === "running";
}

function getVideoProjectStageLabel(
  payload: Record<string, unknown> | undefined,
) {
  const generation =
    payload?.generation &&
    typeof payload.generation === "object" &&
    !Array.isArray(payload.generation)
      ? (payload.generation as Record<string, unknown>)
      : null;
  const stage = typeof generation?.stage === "string" ? generation.stage : null;
  if (stage === "planning") {
    return "Planning video scenes...";
  }
  if (stage === "generating_audio") {
    return "Generating narration audio...";
  }
  if (stage === "finalizing_project") {
    return "Finalizing video project...";
  }
  if (stage === "project_ready") {
    return "Ready for browser video export.";
  }
  if (stage === "failed") {
    return "Video project failed.";
  }
  return null;
}

function buildGeneratedPresentationPreviewArtifact(input: {
  artifactId: string | null;
  description?: string | null;
  fileUrl: string | null;
  generationMode: "visual_html" | "editable_native" | null;
  isVideoPresentation: boolean;
  source: {
    editable?: boolean | null;
    fileName?: string | null;
    htmlUrl?: string | null;
    previewImageUrl?: string | null;
    pptxUrl?: string | null;
    previewRenderer?: "html_iframe" | "pptxviewjs" | null;
    renderStrategy?: string | null;
    slideCount?: number | null;
    status?: GeneratedPresentationArtifactStatus | null;
  };
  title: string | null;
  workspaceId?: string | null;
}): ArtifactPreviewRecord | null {
  if (
    !input.artifactId ||
    !input.workspaceId ||
    (!input.fileUrl && !input.isVideoPresentation)
  ) {
    return null;
  }

  const status = getPresentationArtifactPreviewStatus({
    isVideoPresentation: input.isVideoPresentation,
    status: input.source.status,
  });
  const generationMode =
    input.generationMode ??
    (input.source.htmlUrl ? "visual_html" : "editable_native");

  return {
    id: input.artifactId,
    teamId: "",
    workspaceId: input.workspaceId,
    threadId: null,
    artifactType: input.isVideoPresentation ? "video_presentation" : "slides",
    status,
    title: input.title,
    promptText: input.description ?? null,
    payloadJson: {
      artifactKind: input.isVideoPresentation
        ? "video_presentation"
        : undefined,
      editable: input.isVideoPresentation
        ? false
        : (input.source.editable ?? generationMode === "editable_native"),
      generationMode,
      renderStrategy: input.source.renderStrategy ?? undefined,
      videoDownloadOnly: input.isVideoPresentation ? true : undefined,
      html:
        !input.isVideoPresentation &&
        input.source.htmlUrl &&
        input.source.fileName
          ? {
              assetUrl: input.source.htmlUrl,
              fileName: input.source.fileName,
            }
          : undefined,
      previewRenderer:
        input.source.previewRenderer ??
        (generationMode === "editable_native" ? "pptxviewjs" : "html_iframe"),
      previewImage: input.source.previewImageUrl
        ? {
            assetUrl: input.source.previewImageUrl,
          }
        : undefined,
      pptx:
        input.source.pptxUrl && input.source.fileName
          ? {
              assetUrl: input.source.pptxUrl,
              fileName: input.source.fileName,
            }
          : undefined,
      slideCount: input.source.slideCount ?? undefined,
    },
    storageBucket: null,
    storageKey: input.artifactId,
    errorCode: null,
    errorMessage: null,
    createdBy: null,
    completedAt: status === "ready" ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previewUrl:
      input.fileUrl ??
      (input.isVideoPresentation
        ? resolveArtifactPageUrl({
            artifactId: input.artifactId,
            workspaceId: input.workspaceId,
          })
        : null),
    capabilities: artifactPreviewCapabilities({
      fileBacked: !input.isVideoPresentation,
      previewInline: true,
      renderClientVideo: input.isVideoPresentation && status === "ready",
    }),
  };
}

function getToolDisplayLabel(
  toolCall: ToolCallRecord,
  confirmationResolution?: ToolConfirmationResolution | null,
) {
  const approvalLabel = getToolApprovalDisplayLabel(
    toolCall,
    confirmationResolution,
  );
  if (approvalLabel) {
    return approvalLabel;
  }

  const connectorResult = getConnectorToolResult(toolCall);
  if (connectorResult) {
    return (
      getConnectorToolDisplayLabel(toolCall) ??
      `${getToolDisplayName(connectorResult.toolName)} completed`
    );
  }

  if (hasAgentToolCapability(toolCall.tool, "generated_image_artifact")) {
    const title = getGeneratedImageTitle(toolCall);
    const imageStatus = getGeneratedImageStatus(toolCall);
    const verb =
      toolCall.status === "running" || toolCall.status === "approval_requested"
        ? (imageStatus.label ?? "Generating image")
        : toolCall.status === "error"
          ? "Image generation failed"
          : "Generated image";
    return title ? `${verb}: ${compactText(title, 72)}` : verb;
  }

  if (
    hasAgentToolCapability(toolCall.tool, "presentation_artifact") ||
    hasAgentToolCapability(toolCall.tool, "video_presentation_artifact")
  ) {
    const isVideoPresentation = hasAgentToolCapability(
      toolCall.tool,
      "video_presentation_artifact",
    );
    const isArtifactPublisher =
      toolCall.tool === AGENT_TOOL_NAMES.publishArtifact;
    const title = getGeneratedPresentationTitle(toolCall);
    const verb =
      toolCall.status === "running" || toolCall.status === "approval_requested"
        ? isVideoPresentation
          ? "Generating video presentation"
          : isArtifactPublisher
            ? "Publishing presentation"
            : "Generating presentation"
        : toolCall.status === "error"
          ? isVideoPresentation
            ? "Video presentation generation failed"
            : isArtifactPublisher
              ? "Presentation publishing failed"
              : "Presentation generation failed"
          : isVideoPresentation
            ? "Generated video presentation"
            : isArtifactPublisher
              ? "Published presentation"
              : "Generated presentation";
    return title ? `${verb}: ${compactText(title, 72)}` : verb;
  }

  if (isAgentToolDomain(toolCall.tool, "retrieval")) {
    const query = getToolQuery(toolCall);
    return query
      ? `Search sources: ${compactText(query, 72)}`
      : "Search sources";
  }

  if (hasAgentToolCapability(toolCall.tool, "web_query")) {
    const query = getToolQuery(toolCall);
    const verb = getWebSearchStatusLabel(toolCall.status);
    return query ? `${verb}: ${compactText(query, 72)}` : verb;
  }

  if (hasAgentToolCapability(toolCall.tool, "web_page_fetch")) {
    const urls = getToolFetchUrls(toolCall);
    const count = urls.length;
    const firstUrl = urls[0] ? compactText(urls[0], 56) : null;
    const verb = getWebFetchStatusLabel(toolCall.status);
    if (count > 0 && firstUrl) {
      const suffix = count > 1 ? ` +${count - 1}` : "";
      return `${verb}: ${firstUrl}${suffix}`;
    }
    return verb;
  }

  const inputPreview = Object.entries(toolCall.input)
    .map(([key, value]) =>
      typeof value === "string" && value.trim().length > 0
        ? `${key}: ${compactText(value, 48)}`
        : null,
    )
    .find((value): value is string => value !== null);

  const toolName = getToolDisplayName(toolCall.tool);
  const prefix =
    toolCall.status === "running"
      ? "Using"
      : toolCall.status === "approval_requested"
        ? "Awaiting approval for"
        : toolCall.status === "error"
          ? "Failed"
          : "Used";

  return inputPreview
    ? `${prefix} ${toolName} (${inputPreview})`
    : `${prefix} ${toolName}`;
}

function getConnectorResultSummary(
  connectorResult: NonNullable<ReturnType<typeof getConnectorToolResult>>,
) {
  if (connectorResult.resultCount !== null) {
    const query = connectorResult.query
      ? ` for "${compactText(connectorResult.query, 56)}"`
      : "";
    return `Found ${connectorResult.resultCount} ${pluralize(connectorResult.resultCount, "page")}${query}.`;
  }

  if (connectorResult.pageId) {
    return `Page ID: ${connectorResult.pageId}`;
  }

  return null;
}

function getToolOutputRecord(output: unknown) {
  return output && typeof output === "object" && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : null;
}

function getConnectorToolResult(toolCall: ToolCallRecord) {
  if (!isAgentToolDomain(toolCall.tool, "connector")) {
    return null;
  }
  if (getToolConfirmationOutput(toolCall.output)) {
    return null;
  }
  const output = getToolOutputRecord(toolCall.output);
  if (output?.type !== "connector_tool_result") {
    return null;
  }
  const actionType = getRecordValue(output, "actionType");
  const connector = getRecordValue(output, "connector");
  const title = getRecordValue(output, "title");
  const outputToolName = getRecordValue(output, "toolName");
  const url = getRecordValue(output, "url");
  const pageId = getRecordValue(output, "pageId");
  const query = getRecordValue(output, "query");
  const resultCount = getRecordValue(output, "resultCount");
  const pages = getRecordValue(output, "pages");
  return {
    actionType:
      typeof actionType === "string" && actionType.trim()
        ? actionType.trim()
        : null,
    pageId: typeof pageId === "string" && pageId.trim() ? pageId.trim() : null,
    pages: normalizeConnectorPages(pages),
    provider:
      typeof connector === "string" && connector.trim()
        ? formatToolName(connector.trim())
        : "Connector",
    query: typeof query === "string" && query.trim() ? query.trim() : null,
    resultCount:
      typeof resultCount === "number" && Number.isFinite(resultCount)
        ? resultCount
        : null,
    title: typeof title === "string" && title.trim() ? title.trim() : null,
    toolName:
      typeof outputToolName === "string" && outputToolName.trim()
        ? outputToolName.trim()
        : toolCall.tool,
    url: typeof url === "string" && url.trim() ? url.trim() : null,
  };
}

function normalizeConnectorPages(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const pageId = getRecordValue(record, "pageId");
      const title = getRecordValue(record, "title");
      const url = getRecordValue(record, "url");
      const lastEditedTime = getRecordValue(record, "lastEditedTime");
      if (
        typeof pageId !== "string" &&
        typeof title !== "string" &&
        typeof url !== "string"
      ) {
        return null;
      }
      return {
        lastEditedTime:
          typeof lastEditedTime === "string" && lastEditedTime.trim()
            ? lastEditedTime.trim()
            : null,
        pageId:
          typeof pageId === "string" && pageId.trim() ? pageId.trim() : null,
        title: typeof title === "string" && title.trim() ? title.trim() : null,
        url: typeof url === "string" && url.trim() ? url.trim() : null,
      };
    })
    .filter(
      (
        item,
      ): item is {
        lastEditedTime: string | null;
        pageId: string | null;
        title: string | null;
        url: string | null;
      } => item !== null,
    );
}

function formatThinkingMetadataValue(key: string, value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "boolean") {
    if (!value) {
      return null;
    }
    return value ? "yes" : "no";
  }

  if (typeof value === "number") {
    if (key === "removedCitationCount" && value <= 0) {
      return null;
    }
    return key === "latencyMs" ? `${Math.round(value)}ms` : String(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return compactText(value, 64);
  }

  return null;
}

function getThinkingMetadataParts(
  metadata: Record<string, unknown> | undefined,
) {
  if (!metadata) {
    return [] as string[];
  }

  const labels: Record<string, string> = {
    availableCitationCount: "available citations",
    chunkCount: "chunks",
    hitCount: "hits",
    latencyMs: "time",
    limit: "limit",
    matchCount: "matches",
    pageCount: "pages",
    removedCitationCount: "removed citations",
    resultCount: "results",
    sourceCount: "sources",
    truncated: "truncated",
    usedCitationCount: "used citations",
  };

  return Object.keys(labels)
    .map((key) => {
      const formatted = formatThinkingMetadataValue(key, metadata[key]);
      return formatted ? `${labels[key]}: ${formatted}` : null;
    })
    .filter((item): item is string => item !== null);
}

type VisionFallbackImageTrace = {
  description: string;
  fileName: string;
  imageId: string;
  mimeType: string | null;
  url: string;
};

function getMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
) {
  const value = getRecordValue(metadata, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function getVisionFallbackImages(
  metadata: Record<string, unknown> | undefined,
) {
  const images = getRecordValue(metadata, "images");
  if (!Array.isArray(images)) {
    return [] as VisionFallbackImageTrace[];
  }

  return images
    .map((item): VisionFallbackImageTrace | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const fileName =
        typeof record.fileName === "string" && record.fileName.trim()
          ? record.fileName.trim()
          : "image";
      const imageId =
        typeof record.imageId === "string" && record.imageId.trim()
          ? record.imageId.trim()
          : fileName;
      const url =
        typeof record.url === "string" && record.url.trim()
          ? normalizeAssetUrl(record.url.trim())
          : null;
      if (!url) {
        return null;
      }

      return {
        description:
          typeof record.description === "string"
            ? record.description.trim()
            : "",
        fileName,
        imageId,
        mimeType:
          typeof record.mimeType === "string" && record.mimeType.trim()
            ? record.mimeType.trim()
            : null,
        url,
      };
    })
    .filter((item): item is VisionFallbackImageTrace => item !== null);
}

function isVisionFallbackStep(step: ThinkingStepRecord) {
  return step.metadata?.strategy === "vision_fallback";
}

function VisionFallbackStepDetails({ step }: { step: ThinkingStepRecord }) {
  const images = getVisionFallbackImages(step.metadata);
  const visionModelAlias = getMetadataString(step.metadata, "visionModelAlias");
  const chatModelAlias = getMetadataString(step.metadata, "chatModelAlias");

  return (
    <div className="space-y-3 text-muted-foreground text-xs leading-5">
      {visionModelAlias || chatModelAlias ? (
        <p>
          {visionModelAlias ? (
            <>
              <span className="font-medium text-foreground/80">
                Vision model:
              </span>{" "}
              {visionModelAlias}
            </>
          ) : null}
          {visionModelAlias && chatModelAlias ? " · " : null}
          {chatModelAlias ? (
            <>
              <span className="font-medium text-foreground/80">
                Chat model:
              </span>{" "}
              {chatModelAlias}
            </>
          ) : null}
        </p>
      ) : null}
      {images.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {images.map((image) => (
            <ChainOfThoughtImage
              caption={
                image.description
                  ? compactText(image.description, 220)
                  : image.fileName
              }
              className="mt-0"
              key={image.imageId}
            >
              <RawImage
                alt={image.fileName}
                className="max-h-40 w-full object-contain"
                height={160}
                src={image.url}
                width={240}
              />
            </ChainOfThoughtImage>
          ))}
        </div>
      ) : step.items.length > 0 ? (
        <ChainOfThoughtSearchResults>
          {step.items.map((result) => (
            <ChainOfThoughtSearchResult
              key={`${step.id}:${result}`}
              title={result}
            >
              <span className="max-w-[220px] truncate">{result}</span>
            </ChainOfThoughtSearchResult>
          ))}
        </ChainOfThoughtSearchResults>
      ) : null}
    </div>
  );
}

function getToolStepMetadataParts(
  metadata: Record<string, unknown> | undefined,
) {
  if (!metadata) {
    return [] as string[];
  }

  const rest = { ...metadata };
  delete rest.concurrency;
  delete rest.hitCount;
  delete rest.latencyMs;
  delete rest.limit;
  delete rest.pageCount;
  delete rest.query;
  delete rest.resultCount;
  delete rest.urlCount;
  return getThinkingMetadataParts(rest);
}

function ToolCallDetails({
  artifactStatuses,
  onArtifactPreview,
  resolvedConfirmations = [],
  toolCall,
  toolStep,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
  toolCall: ToolCallRecord;
  toolStep?: ThinkingStepRecord;
  workspaceId?: string | null;
}) {
  const query = getToolQuery(toolCall, toolStep);
  const shouldShowQuery = Boolean(query && !isAgentToolDomain(toolCall.tool, "retrieval"));
  const fetchUrls = getToolFetchUrls(toolCall);
  const outputSummary = summarizeToolOutput(toolCall.output);
  const toolConfirmation = getToolConfirmationOutput(toolCall.output);
  const confirmationResolution = toolConfirmation
    ? resolvedConfirmations.find(
        (item) => item.confirmationId === toolConfirmation.id,
      )
    : null;
  const isResolvedConfirmation = isToolConfirmationResolved({
    confirmation: toolConfirmation,
    confirmationResolution,
  });
  const resolvedConfirmationMessage = getResolvedToolConfirmationMessage({
    confirmation: toolConfirmation,
    confirmationResolution,
  });
  const connectorResult = getConnectorToolResult(toolCall);
  const imageArtifact = resolveGeneratedImageArtifact(toolCall, toolStep);
  const presentationArtifact = resolveGeneratedPresentationArtifact(
    toolCall,
    toolStep,
  );
  const imageStatus = hasAgentToolCapability(toolCall.tool, "generated_image_artifact")
    ? getGeneratedImageStatus(toolCall)
    : null;
  const imagePrompt = hasAgentToolCapability(toolCall.tool, "generated_image_artifact")
    ? getGeneratedImagePrompt(toolCall)
    : null;
  const imageUrl = imageArtifact
    ? resolveArtifactUrl({ artifact: imageArtifact, workspaceId })
    : null;
  const presentationUrl = presentationArtifact
    ? resolveArtifactUrl({ artifact: presentationArtifact, workspaceId })
    : null;
  const presentationTitle =
    presentationArtifact?.title ?? getGeneratedPresentationTitle(toolCall);
  const presentationFileName = presentationArtifact
    ? getGeneratedPresentationFileName({
        artifactFileName: presentationArtifact.fileName,
        title: presentationTitle,
        videoPresentation: hasAgentToolCapability(toolCall.tool, "video_presentation_artifact"),
      })
    : null;
  const isVideoPresentationTool = hasAgentToolCapability(
    toolCall.tool,
    "video_presentation_artifact",
  );
  const presentationArtifactStatus = getPresentationArtifactPreviewStatus({
    isVideoPresentation: isVideoPresentationTool,
    status:
      (presentationArtifact?.artifactId
        ? artifactStatuses?.get(presentationArtifact.artifactId)?.status
        : null) ?? presentationArtifact?.status,
  });
  const presentationArtifactStatusSnapshot = presentationArtifact?.artifactId
    ? artifactStatuses?.get(presentationArtifact.artifactId)
    : undefined;
  const previewArtifact =
    imageArtifact?.artifactId && workspaceId && imageUrl
      ? ({
          id: imageArtifact.artifactId,
          teamId: "",
          workspaceId,
          threadId: null,
          artifactType: "image",
          status: "ready",
          title: imageArtifact.title ?? getGeneratedImageTitle(toolCall),
          promptText: getGeneratedImagePrompt(toolCall),
          payloadJson: {},
          storageBucket: null,
          storageKey: imageArtifact.artifactId,
          errorCode: null,
          errorMessage: null,
          createdBy: null,
          completedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          previewUrl: imageUrl,
          capabilities: artifactPreviewCapabilities({ fileBacked: true }),
        } satisfies ArtifactPreviewRecord)
      : null;
  const presentationPreviewArtifact =
    presentationArtifact && (presentationUrl || isVideoPresentationTool)
      ? buildGeneratedPresentationPreviewArtifact({
          artifactId: presentationArtifact.artifactId,
          description: getGeneratedPresentationPrompt(toolCall),
          fileUrl: presentationUrl,
          generationMode: presentationArtifact.generationMode,
          isVideoPresentation: isVideoPresentationTool,
          source: presentationArtifact,
          title: presentationTitle,
          workspaceId,
        })
      : null;
  const effectivePresentationPreviewArtifact =
    presentationPreviewArtifact &&
    isVideoPresentationTool &&
    presentationArtifactStatus
      ? ({
          ...presentationPreviewArtifact,
          payloadJson:
            presentationArtifactStatusSnapshot?.payloadJson ??
            presentationPreviewArtifact.payloadJson,
          capabilities:
            presentationArtifactStatusSnapshot?.capabilities ??
            presentationPreviewArtifact.capabilities,
          previewUrl:
            presentationArtifactStatusSnapshot?.previewUrl ??
            presentationPreviewArtifact.previewUrl,
          status: presentationArtifactStatus,
          storageBucket:
            presentationArtifactStatusSnapshot?.storageBucket ??
            presentationPreviewArtifact.storageBucket,
          storageKey:
            presentationArtifactStatusSnapshot?.storageKey ??
            presentationPreviewArtifact.storageKey,
          completedAt:
            presentationArtifactStatus === "ready"
              ? (presentationArtifactStatusSnapshot?.completedAt ??
                presentationPreviewArtifact.completedAt ??
                new Date().toISOString())
              : presentationPreviewArtifact.completedAt,
          updatedAt:
            presentationArtifactStatusSnapshot?.updatedAt ??
            new Date().toISOString(),
        } satisfies ArtifactPreviewRecord)
      : presentationPreviewArtifact;
  const canOpenPresentationArtifact =
    presentationArtifactStatus === "ready" || !isVideoPresentationTool;
  const shouldShowOutputSummary = Boolean(
    outputSummary &&
      !imageArtifact &&
      !presentationArtifact &&
      !toolConfirmation &&
      !isAgentToolDomain(toolCall.tool, "retrieval") &&
      !isAgentToolDomain(toolCall.tool, "web") &&
      outputSummary !== "{}",
  );

  return (
    <div className="space-y-2 text-muted-foreground text-xs leading-5">
      {shouldShowQuery ? (
        <p>
          <span className="font-medium text-foreground/80">Query:</span> {query}
        </p>
      ) : null}
      {toolStep?.detail ? <p>{toolStep.detail}</p> : null}
      {imageStatus?.label ? (
        <p>
          <span className="font-medium text-foreground/80">Stage:</span>{" "}
          {imageStatus.label}
        </p>
      ) : null}
      {imagePrompt ? (
        <p>
          <span className="font-medium text-foreground/80">Prompt:</span>{" "}
          {imagePrompt}
        </p>
      ) : null}
      {fetchUrls.length > 0 && !hasWebPageToolResults([toolCall]) ? (
        <div>
          <span className="font-medium text-foreground/80">URLs:</span>{" "}
          {fetchUrls.slice(0, 5).map((url, index) => (
            <span key={url}>
              {index > 0 ? ", " : null}
              {compactText(url, 80)}
            </span>
          ))}
        </div>
      ) : null}
      {imageArtifact && imageUrl ? (
        <p>
          <span className="font-medium text-foreground/80">Artifact:</span>{" "}
          <button
            className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => {
              if (previewArtifact && onArtifactPreview) {
                onArtifactPreview(previewArtifact);
                return;
              }
              window.open(imageUrl, "_blank", "noopener,noreferrer");
            }}
            type="button"
          >
            {imageArtifact.title ?? "Open generated image"}
          </button>
        </p>
      ) : null}
      {presentationArtifact && presentationUrl ? (
        <p>
          <span className="font-medium text-foreground/80">Artifact:</span>{" "}
          <button
            className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            disabled={!canOpenPresentationArtifact}
            onClick={() => {
              if (!canOpenPresentationArtifact) {
                return;
              }
              if (effectivePresentationPreviewArtifact && onArtifactPreview) {
                onArtifactPreview(effectivePresentationPreviewArtifact);
                return;
              }
              window.open(presentationUrl, "_blank", "noopener,noreferrer");
            }}
            type="button"
          >
            {presentationFileName ??
              (isVideoPresentationTool
                ? "Open generated video presentation"
                : "Open generated PPTX")}
          </button>
          {isVideoPresentationTool && presentationArtifactStatus !== "ready" ? (
            <span className="ml-1 text-muted-foreground">
              (
              {presentationArtifactStatus === "failed"
                ? "project failed"
                : "project preparing"}
              )
            </span>
          ) : null}
        </p>
      ) : null}
      {toolConfirmation ? (
        isResolvedConfirmation ? (
          <p>{resolvedConfirmationMessage}</p>
        ) : (
          <p>Waiting for your decision before this action runs.</p>
        )
      ) : null}
      {connectorResult?.url ? (
        <p>
          <a
            className="font-medium text-primary underline-offset-4 hover:underline"
            href={connectorResult.url}
            rel="noreferrer"
            target="_blank"
          >
            Open {connectorResult.title ?? connectorResult.provider} result
          </a>
        </p>
      ) : null}
      {connectorResult ? (
        <>
          {(() => {
            const summary = getConnectorResultSummary(connectorResult);
            return summary ? <p>{summary}</p> : null;
          })()}
          {connectorResult.pages.length > 0 ? (
            <ChainOfThoughtSearchResults>
              {connectorResult.pages.slice(0, 8).map((page, index) => {
                const label =
                  page.title ?? page.pageId ?? page.url ?? `Page ${index + 1}`;
                const badge = (
                  <ChainOfThoughtSearchResult
                    key={`${toolCall.id}:connector-page:${page.pageId ?? page.url ?? index}`}
                    title={label}
                  >
                    <span className="max-w-[260px] truncate">
                      {compactText(label, 96)}
                    </span>
                  </ChainOfThoughtSearchResult>
                );
                return page.url ? (
                  <a
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    href={page.url}
                    key={`${toolCall.id}:connector-page-link:${page.pageId ?? page.url ?? index}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {badge}
                  </a>
                ) : (
                  badge
                );
              })}
            </ChainOfThoughtSearchResults>
          ) : null}
        </>
      ) : null}
      {shouldShowOutputSummary ? <p>{outputSummary}</p> : null}
      {toolCall.error ? (
        <p className="text-destructive">
          {getSandboxToolSafeErrorMessage({
            error: toolCall.error,
            toolName: toolCall.tool,
          })}
        </p>
      ) : null}
    </div>
  );
}

function GeneratedImageLoadingMask({
  isVisible,
  stageIndex,
  stageLabel,
  title,
}: {
  isVisible: boolean;
  stageIndex: number | null;
  stageLabel: string;
  title: string;
}) {
  return (
    <div
      aria-hidden={!isVisible}
      aria-label="Generating image"
      className={cn(
        "absolute inset-0 z-10 overflow-hidden rounded-lg transition-opacity duration-500",
        isVisible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      role={isVisible ? "status" : undefined}
    >
      <div className="absolute inset-0 bg-[linear-gradient(145deg,hsl(var(--background))_0%,hsl(var(--muted))_44%,hsl(var(--background))_100%)]" />
      <div className="absolute inset-0 opacity-80 [background-image:radial-gradient(circle_at_18%_18%,hsl(var(--primary)/0.18),transparent_30%),radial-gradient(circle_at_82%_72%,hsl(var(--foreground)/0.10),transparent_30%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(105deg,transparent_0%,hsl(var(--foreground)/0.04)_30%,hsl(var(--foreground)/0.14)_48%,hsl(var(--foreground)/0.05)_66%,transparent_100%)] bg-[length:220%_100%] animate-[image-sheen_2.2s_ease-in-out_infinite]" />
      <div className="absolute inset-0 opacity-35 [background-image:linear-gradient(hsl(var(--foreground)/0.08)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.08)_1px,transparent_1px)] [background-size:40px_40px]" />
      <div className="absolute inset-5 rounded-md border border-background/60 bg-background/10 shadow-[inset_0_1px_0_hsl(var(--background)/0.65)]" />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-background/90 via-background/45 to-transparent" />
      <div className="absolute right-4 bottom-4 left-4">
        <div className="rounded-md border border-border/70 bg-background/80 px-3 py-2 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">
                {title}
              </p>
              <p className="text-[11px] text-muted-foreground">{stageLabel}</p>
            </div>
            <div className="grid size-6 shrink-0 place-items-center rounded-full border border-border/70 bg-background/70">
              <div className="size-2 rounded-full bg-primary shadow-[0_0_18px_hsl(var(--primary)/0.55)]" />
            </div>
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                className={cn(
                  "h-1 rounded-full transition-colors duration-300",
                  stageIndex !== null && index <= stageIndex
                    ? "bg-primary"
                    : "bg-muted-foreground/20",
                )}
                key={index}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneratedImageArtifactItem({
  aspectRatio,
  downloadUrl,
  imageUrl,
  onArtifactPreview,
  stageLabel,
  stageProgress,
  status,
  title,
}: {
  aspectRatio: string;
  downloadUrl?: string | null;
  imageUrl?: string | null;
  onArtifactPreview?: () => void;
  stageLabel: string;
  stageProgress: number | null;
  status: ToolCallRecord["status"];
  title: string;
}) {
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const showMask = status === "running" || Boolean(imageUrl && !isImageLoaded);

  useEffect(() => {
    setIsImageLoaded(false);
  }, [imageUrl]);

  if (!imageUrl) {
    return (
      <div
        className="relative isolate max-h-[520px] w-full max-w-xl overflow-hidden rounded-lg border border-dashed border-border bg-muted"
        style={{ aspectRatio }}
      >
        <GeneratedImageLoadingMask
          isVisible={status === "running"}
          stageIndex={stageProgress}
          stageLabel={stageLabel}
          title={title}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative isolate max-h-[520px] w-full max-w-xl overflow-hidden rounded-lg bg-muted",
        isImageLoaded && "bg-transparent",
      )}
      style={{ aspectRatio }}
    >
      <GeneratedImagePreview
        className={cn(
          "size-full transition-opacity duration-200 [&>span]:size-full [&>span]:min-h-0 [&>span]:min-w-0 [&>span>img]:h-full [&>span>img]:w-full [&>span>img]:object-contain",
          isImageLoaded ? "opacity-100" : "opacity-0",
        )}
        downloadUrl={downloadUrl ?? imageUrl}
        imageUrl={imageUrl}
        onClick={onArtifactPreview}
        onImageLoad={() => setIsImageLoaded(true)}
        title={title}
      />
      <GeneratedImageLoadingMask
        isVisible={showMask}
        stageIndex={stageProgress}
        stageLabel={stageLabel}
        title={title}
      />
    </div>
  );
}

export function GeneratedImageArtifacts({
  onArtifactPreview,
  toolCalls,
  workspaceId,
}: {
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  toolCalls: ToolCallRecord[] | undefined;
  workspaceId?: string | null;
}) {
  const imageItems = (toolCalls ?? [])
    .filter((toolCall) => hasAgentToolCapability(toolCall.tool, "generated_image_artifact"))
    .map((toolCall) => {
      const artifact = resolveGeneratedImageArtifact(toolCall);
      const imageUrl = artifact
        ? resolveArtifactUrl({ artifact, workspaceId })
        : null;
      const downloadUrl = artifact
        ? resolveArtifactDownloadUrl({ artifact, workspaceId })
        : null;
      const title =
        artifact?.title ||
        getGeneratedImageTitle(toolCall) ||
        "Generated image";
      const prompt = getGeneratedImagePrompt(toolCall);
      const previewArtifact =
        artifact?.artifactId && workspaceId && imageUrl
          ? ({
              id: artifact.artifactId,
              teamId: "",
              workspaceId,
              threadId: null,
              artifactType: "image",
              status: "ready",
              title,
              promptText: prompt,
              payloadJson: {},
              storageBucket: null,
              storageKey: artifact.artifactId,
              errorCode: null,
              errorMessage: null,
              createdBy: null,
              completedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              previewUrl: imageUrl,
              capabilities: artifactPreviewCapabilities({ fileBacked: true }),
            } satisfies ArtifactPreviewRecord)
          : null;
      return {
        downloadUrl,
        imageUrl,
        previewArtifact,
        title,
        toolCall,
      };
    })
    .filter(({ imageUrl, toolCall }) => {
      if (
        toolCall.status === "running" ||
        toolCall.status === "approval_requested" ||
        toolCall.status === "error"
      ) {
        return true;
      }
      return Boolean(imageUrl);
    });

  if (imageItems.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {imageItems.map(
        ({ downloadUrl, imageUrl, previewArtifact, title, toolCall }) => {
          const imageStatus = getGeneratedImageStatus(toolCall);
          const stageLabel = imageStatus.label ?? "Rendering";

          if (toolCall.status === "error") {
            return (
              <div
                className="max-w-xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                key={toolCall.id}
              >
                {toolCall.error ?? "Image generation failed."}
              </div>
            );
          }

          return (
            <GeneratedImageArtifactItem
              aspectRatio={imageStatus.aspectRatio}
              downloadUrl={downloadUrl ?? imageUrl}
              imageUrl={imageUrl}
              key={toolCall.id}
              onArtifactPreview={
                previewArtifact && onArtifactPreview
                  ? () => onArtifactPreview(previewArtifact)
                  : undefined
              }
              stageLabel={stageLabel}
              stageProgress={imageStatus.progress ?? null}
              status={toolCall.status}
              title={title}
            />
          );
        },
      )}
    </div>
  );
}

export function GeneratedImageArtifactBlock({
  onArtifactPreview,
  toolCall,
  workspaceId,
}: {
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  toolCall: ToolCallRecord | undefined;
  workspaceId?: string | null;
}) {
  return (
    <GeneratedImageArtifacts
      onArtifactPreview={onArtifactPreview}
      toolCalls={toolCall ? [toolCall] : []}
      workspaceId={workspaceId}
    />
  );
}

function GeneratedPresentationArtifactItem({
  artifactStatus,
  artifactStatusSnapshot,
  artifactPreview,
  artifactFileName,
  description,
  downloadUrl,
  generationMode,
  isVideoPresentation,
  isArtifactPublisher,
  modeLabel,
  onArtifactPreview,
  slideCount,
  sourceJsonUrl,
  status,
  title,
}: {
  artifactStatus?: GeneratedPresentationArtifactStatus | null;
  artifactStatusSnapshot?: ArtifactStatusSnapshot;
  artifactPreview?: ArtifactPreviewRecord | null;
  artifactFileName?: string | null;
  description?: string | null;
  downloadUrl?: string | null;
  generationMode?: "visual_html" | "editable_native" | null;
  isVideoPresentation?: boolean;
  isArtifactPublisher?: boolean;
  modeLabel: string;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  slideCount?: number | null;
  sourceJsonUrl?: string | null;
  status: ToolCallRecord["status"];
  title: string;
}) {
  const previewStatus = artifactStatus ?? artifactPreview?.status ?? "pending";
  const effectiveArtifactPreview =
    artifactPreview && isVideoPresentation
      ? ({
          ...artifactPreview,
          payloadJson:
            artifactStatusSnapshot?.payloadJson ?? artifactPreview.payloadJson,
          capabilities:
            artifactStatusSnapshot?.capabilities ?? artifactPreview.capabilities,
          previewUrl:
            artifactStatusSnapshot?.previewUrl ?? artifactPreview.previewUrl,
          status: previewStatus,
          storageBucket:
            artifactStatusSnapshot?.storageBucket ??
            artifactPreview.storageBucket,
          storageKey:
            artifactStatusSnapshot?.storageKey ?? artifactPreview.storageKey,
          completedAt:
            artifactStatus === "ready"
              ? (artifactStatusSnapshot?.completedAt ??
                artifactPreview.completedAt ??
                new Date().toISOString())
              : artifactPreview.completedAt,
          updatedAt:
            artifactStatusSnapshot?.updatedAt ?? new Date().toISOString(),
        } satisfies ArtifactPreviewRecord)
      : artifactPreview;
  const isArtifactPending = isPresentationArtifactPending(artifactStatus);
  const isArtifactError = artifactStatus === "failed";
  const videoProjectStageLabel = isVideoPresentation
    ? getVideoProjectStageLabel(
        artifactStatusSnapshot?.payloadJson ?? artifactPreview?.payloadJson,
      )
    : null;
  const isPending =
    status === "running" ||
    status === "approval_requested" ||
    isArtifactPending;
  const isError = status === "error" || isArtifactError;
  const canPreview =
    Boolean(effectiveArtifactPreview && onArtifactPreview) &&
    !isPending &&
    !isError;
  const effectiveDownloadUrl = isVideoPresentation ? null : downloadUrl;
  const previewImage = effectiveArtifactPreview?.payloadJson?.previewImage;
  const previewImageUrl =
    previewImage &&
    typeof previewImage === "object" &&
    !Array.isArray(previewImage) &&
    typeof (previewImage as Record<string, unknown>).assetUrl === "string"
      ? ((previewImage as Record<string, unknown>).assetUrl as string)
      : null;
  const handleDownload = () => {
    if (!effectiveDownloadUrl) {
      return;
    }

    const link = document.createElement("a");
    link.href = effectiveDownloadUrl;
    link.download = getGeneratedPresentationFileName({
      artifactFileName,
      generationMode,
      title,
      videoPresentation: isVideoPresentation,
    });
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const handlePreview = () => {
    if (effectiveArtifactPreview && onArtifactPreview && canPreview) {
      onArtifactPreview(effectiveArtifactPreview);
    }
  };
  const handlePreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handlePreview();
  };

  return (
    <div
      aria-label={canPreview ? `Open artifact preview for ${title}` : undefined}
      className={cn(
        "w-full max-w-xl overflow-hidden rounded-lg border border-border bg-background shadow-sm transition-colors",
        canPreview &&
          "cursor-pointer hover:border-foreground/25 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
      onClick={canPreview ? handlePreview : undefined}
      onKeyDown={canPreview ? handlePreviewKeyDown : undefined}
      role={canPreview ? "button" : undefined}
      tabIndex={canPreview ? 0 : undefined}
    >
      <div className="flex items-start gap-3 p-3">
        <div className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted/60">
          {previewImageUrl && !isPending ? (
            <RawImage
              alt={title}
              className="size-full object-cover"
              loading="lazy"
              src={previewImageUrl}
            />
          ) : isPending ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <Presentation className="size-5 text-foreground/80" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {title}
              </p>
              {description ? (
                <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              disabled={
                isPending ||
                isError ||
                (isVideoPresentation ? !canPreview : !effectiveDownloadUrl)
              }
              onClick={(event) => {
                event.stopPropagation();
                if (isVideoPresentation) {
                  handlePreview();
                  return;
                }
                handleDownload();
              }}
              title={
                isVideoPresentation
                  ? "Open video presentation"
                  : modeLabel === "Visual deck"
                    ? "Download HTML deck"
                    : "Download PPTX"
              }
              type="button"
            >
              <Download className="size-3.5" />
              {isVideoPresentation ? "Download Video" : "Download"}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5">
              {modeLabel}
            </span>
            {typeof slideCount === "number" ? (
              <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5">
                {slideCount} slides
              </span>
            ) : null}
            {sourceJsonUrl && !isPending && !isError ? (
              <a
                className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                href={sourceJsonUrl}
                onClick={(event) => event.stopPropagation()}
                rel="noopener"
              >
                Source JSON
              </a>
            ) : null}
            {isPending ? (
              <span>
                {isVideoPresentation
                  ? (videoProjectStageLabel ??
                    (artifactStatus === "running"
                      ? "Preparing video project..."
                      : "Preparing video project..."))
                  : isArtifactPublisher
                    ? "Publishing presentation..."
                    : "Generating presentation..."}
              </span>
            ) : null}
          </div>
          {isError ? (
            <p className="mt-2 text-xs text-destructive">
              {isVideoPresentation
                ? (videoProjectStageLabel ??
                  "Video presentation generation failed.")
                : isArtifactPublisher
                  ? "Presentation publishing failed."
                  : "PPTX generation failed."}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function GeneratedPresentationArtifacts({
  artifactStatuses,
  onArtifactPreview,
  toolCalls,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  toolCalls: ToolCallRecord[] | undefined;
  workspaceId?: string | null;
}) {
  const presentationItems = (toolCalls ?? [])
    .filter(
      (toolCall) =>
        hasAgentToolCapability(toolCall.tool, "presentation_artifact") ||
        hasAgentToolCapability(toolCall.tool, "video_presentation_artifact"),
    )
    .map((toolCall) => {
      const isVideoPresentation = hasAgentToolCapability(
        toolCall.tool,
        "video_presentation_artifact",
      );
      const isArtifactPublisher =
        toolCall.tool === AGENT_TOOL_NAMES.publishArtifact;
      const artifact = resolveGeneratedPresentationArtifact(toolCall);
      const fileUrl = artifact
        ? resolveArtifactUrl({ artifact, workspaceId })
        : null;
      const downloadUrl = artifact
        ? resolveArtifactDownloadUrl({ artifact, workspaceId })
        : null;
      const sourceJsonUrl =
        artifact?.sourceJsonUrl &&
        (artifact.sourceJsonUrl.startsWith("http")
          ? artifact.sourceJsonUrl
          : `${apiBaseUrl}${artifact.sourceJsonUrl}`);
      const title =
        artifact?.title ||
        getGeneratedPresentationTitle(toolCall) ||
        (isArtifactPublisher
          ? "Published presentation"
          : isVideoPresentation
          ? "Generated video presentation"
          : "Generated presentation");
      const description = getGeneratedPresentationPrompt(toolCall);
      const generationMode =
        artifact?.generationMode ??
        (artifact?.htmlUrl ? "visual_html" : "editable_native");
      const modeLabel = isVideoPresentation
        ? "Video presentation"
        : isArtifactPublisher
          ? "PowerPoint presentation"
        : generationMode === "editable_native"
          ? "Editable PowerPoint"
          : "Visual deck";
      const artifactStatus = getPresentationArtifactPreviewStatus({
        isVideoPresentation,
        status:
          (artifact?.artifactId
            ? artifactStatuses?.get(artifact.artifactId)?.status
            : null) ?? artifact?.status,
      });
      const artifactStatusSnapshot = artifact?.artifactId
        ? artifactStatuses?.get(artifact.artifactId)
        : undefined;
      const previewArtifact =
        artifact && (fileUrl || isVideoPresentation)
          ? buildGeneratedPresentationPreviewArtifact({
              artifactId: artifact.artifactId,
              description,
              fileUrl:
                fileUrl ??
                (artifact.artifactId && workspaceId
                  ? resolveArtifactPageUrl({
                      artifactId: artifact.artifactId,
                      workspaceId,
                    })
                  : null),
              generationMode,
              isVideoPresentation,
              source: artifact,
              title,
              workspaceId,
            })
          : null;
      return {
        artifact,
        artifactStatus,
        artifactStatusSnapshot,
        downloadUrl,
        fileUrl: isVideoPresentation ? null : fileUrl,
        generationMode,
        isVideoPresentation,
        isArtifactPublisher,
        previewArtifact,
        description,
        modeLabel,
        sourceJsonUrl,
        title,
        toolCall,
      };
    })
    .filter((item) =>
      shouldShowGeneratedPresentationItem({
        fileUrl: item.fileUrl,
        isArtifactPublisher: item.isArtifactPublisher,
        isVideoPresentation: item.isVideoPresentation,
        previewArtifact: item.previewArtifact,
        status: item.toolCall.status,
      }),
    )
    .filter((item, index, items) => {
      if (!item.artifact?.artifactId) {
        return true;
      }
      return (
        items.findIndex(
          (candidate) =>
            candidate.artifact?.artifactId === item.artifact?.artifactId,
        ) === index
      );
    });

  if (presentationItems.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {presentationItems.map(
        ({
          artifact,
          artifactStatus,
          artifactStatusSnapshot,
          description,
          downloadUrl,
          fileUrl,
          generationMode,
          isVideoPresentation,
          isArtifactPublisher,
          modeLabel,
          previewArtifact,
          title,
          sourceJsonUrl,
          toolCall,
        }) => {
          if (toolCall.status === "error") {
            return (
              <div
                className="max-w-xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                key={toolCall.id}
              >
                {toolCall.error ??
                  (isVideoPresentation
                    ? "Video presentation generation failed."
                    : "PPTX generation failed.")}
              </div>
            );
          }

          return (
            <GeneratedPresentationArtifactItem
              artifactStatus={artifactStatus}
              artifactStatusSnapshot={artifactStatusSnapshot}
              artifactPreview={previewArtifact}
              artifactFileName={artifact?.fileName}
              description={description}
              downloadUrl={downloadUrl ?? fileUrl}
              generationMode={generationMode}
              isVideoPresentation={isVideoPresentation}
              isArtifactPublisher={isArtifactPublisher}
              key={toolCall.id}
              modeLabel={modeLabel}
              onArtifactPreview={onArtifactPreview}
              slideCount={artifact?.slideCount}
              sourceJsonUrl={sourceJsonUrl}
              status={toolCall.status}
              title={title}
            />
          );
        },
      )}
    </div>
  );
}

export function GeneratedPresentationArtifactBlock({
  artifactStatuses,
  onArtifactPreview,
  toolCall,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  toolCall: ToolCallRecord | undefined;
  workspaceId?: string | null;
}) {
  return (
    <GeneratedPresentationArtifacts
      artifactStatuses={artifactStatuses}
      onArtifactPreview={onArtifactPreview}
      toolCalls={toolCall ? [toolCall] : []}
      workspaceId={workspaceId}
    />
  );
}

function getToolTraceRenderState({
  isCancelled,
  resolvedConfirmationIds,
  resolvedConfirmations,
  toolCall,
  toolStep,
}: {
  isCancelled: boolean;
  resolvedConfirmationIds: Set<string>;
  resolvedConfirmations: ToolConfirmationResolution[];
  toolCall: ToolCallRecord;
  toolStep?: ThinkingStepRecord;
}) {
  const toolConfirmation = getToolConfirmationOutput(toolCall.output);
  const confirmationResolution = toolConfirmation
    ? resolvedConfirmations.find(
        (resolution) => resolution.confirmationId === toolConfirmation.id,
      )
    : null;
  const isResolvedConfirmation = isToolConfirmationResolved({
    confirmation: toolConfirmation,
    confirmationResolution,
  });
  const metadataParts = getToolStepMetadataParts(toolStep?.metadata);
  const detailParts = getToolCallDetailParts(
    toolCall,
    toolStep,
    confirmationResolution,
  );
  const summary =
    [
      toolStep?.description ?? null,
      detailParts.length > 0 ? detailParts.join(" · ") : null,
      metadataParts.length > 0 ? metadataParts.join(" · ") : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ") || undefined;
  const isActivelyRunningTool = isToolCallActivelyRunning({
    resolvedConfirmationIds,
    toolCall,
  });
  const toolStatus: "complete" | "active" | "pending" =
    toolConfirmation && !isResolvedConfirmation
      ? isCancelled
        ? "pending"
        : "active"
      : isActivelyRunningTool
        ? isCancelled
          ? "pending"
          : "active"
        : toolCall.status === "error"
          ? "pending"
          : "complete";

  return {
    confirmationResolution,
    label: getToolDisplayLabel(toolCall, confirmationResolution),
    summary,
    toolStatus,
  };
}

function ToolTraceStep({
  artifactStatuses,
  className,
  icon = WrenchIcon,
  isCancelled,
  onArtifactPreview,
  resolvedConfirmationIds,
  resolvedConfirmations,
  toolCall,
  toolStep,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  className?: string;
  icon?: typeof WrenchIcon;
  isCancelled: boolean;
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  resolvedConfirmationIds: Set<string>;
  resolvedConfirmations: ToolConfirmationResolution[];
  toolCall: ToolCallRecord;
  toolStep?: ThinkingStepRecord;
  workspaceId?: string | null;
}) {
  const { label, summary, toolStatus } = getToolTraceRenderState({
    isCancelled,
    resolvedConfirmationIds,
    resolvedConfirmations,
    toolCall,
    toolStep,
  });

  return (
    <ChainOfThoughtStep
      className={className}
      description={summary}
      icon={icon}
      label={label}
      status={toolStatus}
    >
      <ToolCallDetails
        artifactStatuses={artifactStatuses}
        onArtifactPreview={onArtifactPreview}
        resolvedConfirmations={resolvedConfirmations}
        toolCall={toolCall}
        toolStep={toolStep}
        workspaceId={workspaceId}
      />
    </ChainOfThoughtStep>
  );
}

function ToolCallGroup({
  artifactStatuses,
  isCancelled,
  items,
  onArtifactPreview,
  resolvedConfirmationIds,
  resolvedConfirmations,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  isCancelled: boolean;
  items: ToolTimelineItem[];
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  resolvedConfirmationIds: Set<string>;
  resolvedConfirmations: ToolConfirmationResolution[];
  workspaceId?: string | null;
}) {
  const [header, ...children] = items;
  const hasChildren = children.length > 0;
  const shouldDefaultOpen = items.some(
    (item) =>
      item.toolCall.status === "error" ||
      isToolCallActivelyRunning({
        resolvedConfirmationIds,
        toolCall: item.toolCall,
      }),
  );
  const [isOpen, setIsOpen] = useState(shouldDefaultOpen);

  useEffect(() => {
    if (shouldDefaultOpen) {
      setIsOpen(true);
    }
  }, [shouldDefaultOpen]);

  if (!header) {
    return null;
  }

  const headerState = getToolTraceRenderState({
    isCancelled,
    resolvedConfirmationIds,
    resolvedConfirmations,
    toolCall: header.toolCall,
    toolStep: header.toolStep,
  });
  const groupSummary =
    items.length > 1
      ? [headerState.summary, `${items.length} tool calls`]
          .filter((part): part is string => Boolean(part))
          .join(" · ")
      : headerState.summary;

  return (
    <div className="fade-in-0 slide-in-from-top-2 animate-in space-y-2 text-sm">
      <button
        className={cn(
          "group flex w-full items-start gap-2 rounded-md text-left transition-colors hover:bg-muted/50",
          hasChildren ? "cursor-pointer" : "cursor-default",
        )}
        disabled={!hasChildren}
        onClick={() => {
          if (hasChildren) {
            setIsOpen((value) => !value);
          }
        }}
        type="button"
      >
        <div className="relative mt-0.5 text-muted-foreground">
          <WrenchIcon className="size-4" />
          {hasChildren ? (
            <div className="absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1 space-y-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5">
            {hasChildren ? (
              <ChevronDownIcon
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  isOpen ? "rotate-0" : "-rotate-90",
                )}
              />
            ) : null}
            <span className="truncate text-muted-foreground">
              {headerState.label}
            </span>
          </div>
          {groupSummary ? (
            <div className="text-muted-foreground text-xs">{groupSummary}</div>
          ) : null}
        </div>
      </button>
      {!hasChildren || isOpen ? (
        <div className={hasChildren ? "ml-6" : undefined}>
          <ToolCallDetails
            artifactStatuses={artifactStatuses}
            onArtifactPreview={onArtifactPreview}
            resolvedConfirmations={resolvedConfirmations}
            toolCall={header.toolCall}
            toolStep={header.toolStep}
            workspaceId={workspaceId}
          />
        </div>
      ) : null}
      {hasChildren && isOpen ? (
        <div className="ml-6 space-y-2 border-border/70 border-l pl-3">
          {children.map((item) => (
            <ToolTraceStep
              artifactStatuses={artifactStatuses}
              className="text-muted-foreground"
              isCancelled={isCancelled}
              key={item.key}
              onArtifactPreview={onArtifactPreview}
              resolvedConfirmationIds={resolvedConfirmationIds}
              resolvedConfirmations={resolvedConfirmations}
              toolCall={item.toolCall}
              toolStep={item.toolStep}
              workspaceId={workspaceId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function groupTimelineItems(items: ReasoningTraceTimelineItem[]) {
  const grouped: Array<
    | ReasoningTraceTimelineItem
    | { kind: "tool-group"; key: string; items: ToolTimelineItem[] }
  > = [];
  let pendingTools: ToolTimelineItem[] = [];

  const flushTools = () => {
    if (pendingTools.length === 0) {
      return;
    }
    grouped.push({
      kind: "tool-group",
      key: `tool-group:${pendingTools.map((item) => item.key).join(":")}`,
      items: pendingTools,
    });
    pendingTools = [];
  };

  for (const item of items) {
    if (item.kind === "tool") {
      pendingTools.push(item);
      continue;
    }
    flushTools();
    grouped.push(item);
  }

  flushTools();
  return grouped;
}

export function ReasoningTrace({
  artifactStatuses,
  isCancelled = false,
  isStreaming,
  onArtifactPreview,
  resolvedConfirmations = [],
  steps,
  traceParts,
  toolCalls,
  workspaceId,
}: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  isCancelled?: boolean;
  isStreaming: boolean;
  modelReasoning?: string;
  modelReasoningSegments?: unknown[];
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
  steps: ThinkingStepRecord[] | undefined;
  traceEvents?: unknown[];
  traceParts?: TracePartRecord[];
  toolCalls: ToolCallRecord[] | undefined;
  workspaceId?: string | null;
}) {
  const resolvedConfirmationIds = new Set(
    resolvedConfirmations.map((item) => item.confirmationId),
  );
  const safeSteps = steps ?? [];
  const safeToolCalls = (toolCalls ?? []).filter((toolCall, index, calls) => {
    return calls.findIndex((call) => call.id === toolCall.id) === index;
  });
  const stepByToolCallId = new Map(
    safeSteps
      .map((step) => {
        const toolCallId = step.metadata?.toolCallId;
        return typeof toolCallId === "string"
          ? ([toolCallId, step] as const)
          : null;
      })
      .filter(
        (entry): entry is readonly [string, ThinkingStepRecord] =>
          entry !== null,
      ),
  );
  const tracePartItems: ReasoningTraceTimelineItem[] = (traceParts ?? [])
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((part) => {
      if (part.kind === "reasoning") {
        return {
          kind: "model-reasoning" as const,
          key: `part:${part.id}`,
          originalIndex: part.order,
          phase: part.phase,
          sequence: part.order,
          text: part.text,
          toolCallId: part.toolCallId,
          durationMs: part.durationMs,
        };
      }
      if (part.kind === "step") {
        return {
          kind: "step" as const,
          key: `part:${part.id}`,
          originalIndex: part.order,
          sequence: part.order,
          step: {
            id: part.id,
            title: part.title,
            status: part.status,
            items: part.items,
            sequence: part.order,
            description: null,
            detail: null,
            metadata: part.metadata,
          } satisfies ThinkingStepRecord,
        };
      }
      const matchedToolCall = safeToolCalls.find(
        (toolCall) => toolCall.id === part.toolCallId,
      );
      const approvalState =
        part.approvalState ?? matchedToolCall?.approvalState;
      const approvalConfirmationId =
        part.approvalConfirmationId ?? matchedToolCall?.approvalConfirmationId;
      const toolCall: ToolCallRecord = {
        id: part.toolCallId,
        tool: part.tool,
        input: part.input,
        output: part.output,
        latencyMs: part.latencyMs ?? null,
        status: part.status,
        error: part.error ?? null,
        sequence: part.order,
        ...(approvalState ? { approvalState } : {}),
        ...(approvalConfirmationId ? { approvalConfirmationId } : {}),
      };
      return {
        kind: "tool" as const,
        key: `part:${part.id}`,
        originalIndex: part.order,
        sequence: part.order,
        toolCall,
        toolStep: stepByToolCallId.get(part.toolCallId),
      };
    });
  const activeStep = isCancelled
    ? undefined
    : tracePartItems
        .filter(
          (
            item,
          ): item is Extract<ReasoningTraceTimelineItem, { kind: "step" }> =>
            item.kind === "step" && item.step.status === "in_progress",
        )
        .at(-1)?.step;
  const latestDisplayStep = tracePartItems
    .filter(isStepTimelineItem)
    .map((step, index) => ({ index, step }))
    .sort((left, right) => {
      const sequenceDelta =
        (left.step.step.sequence ?? left.index) -
        (right.step.step.sequence ?? right.index);
      return sequenceDelta === 0 ? left.index - right.index : sequenceDelta;
    })
    .at(-1)?.step.step;
  const hasRunningToolCall =
    !isCancelled &&
    tracePartItems.some(
      (item) =>
        item.kind === "tool" &&
        isToolCallActivelyRunning({
          resolvedConfirmationIds,
          toolCall: item.toolCall,
        }),
    );
  const waitingForConfirmation =
    !isCancelled &&
    tracePartItems.some((item) => {
      if (item.kind !== "tool") {
        return false;
      }
      const confirmation = getToolConfirmationOutput(item.toolCall.output);
      return (
        confirmation !== null &&
        isPendingToolConfirmation(confirmation) &&
        !resolvedConfirmationIds.has(confirmation.id)
      );
    });
  const hasTraceItems = tracePartItems.length > 0;
  const isThinking = isReasoningTraceThinking({
    hasActiveStep: Boolean(activeStep),
    hasRunningToolCall,
    hasTraceItems,
    isCancelled,
    isStreaming,
    waitingForConfirmation,
  });
  const allComplete =
    hasTraceItems &&
    tracePartItems.every(
      (item) => item.kind !== "step" || item.step.status === "completed",
    ) &&
    !hasRunningToolCall &&
    !waitingForConfirmation &&
    !isStreaming;
  const [isOpen, setIsOpen] = useState(!allComplete);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const startTimeRef = useRef<number | null>(null);

  const toolTraceIds = new Set(
    tracePartItems
      .filter((item): item is ToolTimelineItem => item.kind === "tool")
      .map((item) => item.toolCall.id),
  );
  const timelineItems = tracePartItems.filter((item) => {
    if (item.kind !== "step") {
      return true;
    }

    const toolCallId = item.step.metadata?.toolCallId;
    return typeof toolCallId !== "string" || !toolTraceIds.has(toolCallId);
  });
  const renderTimelineItems = groupTimelineItems(timelineItems);
  const timelineSignature = timelineItems
    .map((item) => {
      if (item.kind === "model-reasoning") {
        return `${item.key}:${item.text.length}`;
      }
      if (item.kind === "step") {
        return `${item.key}:${item.step.status}:${item.step.title}:${item.step.items.length}`;
      }
      return `${item.key}:${item.toolCall.status}:${item.toolCall.latencyMs ?? ""}`;
    })
    .join("|");
  const reasoningDurationMs = tracePartItems.reduce<number | undefined>(
    (longest, item) => {
      if (
        item.kind !== "model-reasoning" ||
        typeof item.durationMs !== "number"
      ) {
        return longest;
      }

      return Math.max(longest ?? 0, item.durationMs);
    },
    undefined,
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const element = contentRef.current;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [isOpen, timelineSignature]);

  useEffect(() => {
    if (isStreaming) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }
      return;
    }

    if (startTimeRef.current !== null) {
      setDuration(Date.now() - startTimeRef.current);
      startTimeRef.current = null;
    }
  }, [isStreaming]);

  const hasActiveStep = Boolean(activeStep);

  useEffect(() => {
    if (hasActiveStep || waitingForConfirmation) {
      setIsOpen(true);
    }
  }, [
    hasActiveStep,
    activeStep?.id,
    activeStep?.status,
    activeStep?.title,
    waitingForConfirmation,
  ]);

  if (!hasTraceItems && !isStreaming) {
    return null;
  }

  const title = getReasoningTraceTitle({
    activeStep,
    duration,
    hasRunningToolCall,
    hasModelReasoning: tracePartItems.some(
      (item) => item.kind === "model-reasoning",
    ),
    hasTraceItems,
    isCancelled,
    isStreaming,
    latestDisplayStep,
    reasoningDurationMs,
    waitingForConfirmation,
  });

  return (
    <ChainOfThought
      className="space-y-0 py-1"
      onOpenChange={setIsOpen}
      open={isOpen}
    >
      <ChainOfThoughtHeader
        className="py-0"
        icon={
          isThinking ? <Loader2 className="size-4 animate-spin" /> : undefined
        }
      >
        <span className="block min-w-0 truncate">
          <span className="truncate">
            {isThinking ? <Shimmer duration={1}>{title}</Shimmer> : title}
          </span>
        </span>
      </ChainOfThoughtHeader>
      {isOpen && timelineItems.length > 0 ? (
        <ChainOfThoughtContent
          className="subtle-scrollbar max-h-64 overflow-y-auto overscroll-contain pr-2"
          ref={contentRef}
        >
          {renderTimelineItems.map((item) => {
            if (item.kind === "model-reasoning") {
              return (
                <div
                  className="fade-in-0 slide-in-from-top-2 animate-in rounded-md px-1 py-0.5 text-[13px] text-foreground/85 leading-[1.6]"
                  key={item.key}
                >
                  <div className="whitespace-pre-wrap break-words">
                    {item.text}
                  </div>
                </div>
              );
            }

            if (item.kind === "step") {
              const { step } = item;
              if (isTodoListTraceStep(step)) {
                return (
                  <DeepAgentTodoTrace
                    isCancelled={isCancelled}
                    key={item.key}
                    step={step}
                  />
                );
              }

              const isVisionFallback = isVisionFallbackStep(step);
              const metadataParts = getThinkingMetadataParts(step.metadata);
              const stepDescription =
                [
                  step.description ?? null,
                  metadataParts.length > 0 ? metadataParts.join(" · ") : null,
                ]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ") || undefined;
              const stepLabel = (
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="truncate">{step.title}</span>
                  {stepDescription ? (
                    <span className="min-w-0 text-muted-foreground text-xs leading-5">
                      {stepDescription}
                    </span>
                  ) : null}
                  {step.status === "in_progress" ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 font-medium text-[11px]",
                        isCancelled
                          ? "bg-muted text-muted-foreground"
                          : "bg-primary/10 text-primary",
                      )}
                    >
                      {isCancelled ? "Stopped" : "Running"}
                    </span>
                  ) : null}
                </span>
              );
              const stepStatus =
                step.status === "in_progress"
                  ? isCancelled
                    ? "pending"
                    : "active"
                  : step.status === "pending"
                    ? "pending"
                    : "complete";
              return (
                <ChainOfThoughtStep
                  icon={isVisionFallback ? ImageIcon : undefined}
                  key={item.key}
                  label={stepLabel}
                  status={stepStatus}
                >
                  {step.detail ? (
                    <p className="text-muted-foreground text-xs leading-5">
                      {step.detail}
                    </p>
                  ) : null}
                  {isVisionFallback ? (
                    <VisionFallbackStepDetails step={step} />
                  ) : step.items.length > 0 ? (
                    <ChainOfThoughtSearchResults>
                      {step.items.map((result) => (
                        <ChainOfThoughtSearchResult
                          key={`${step.id}:${result}`}
                          title={result}
                        >
                          <span className="max-w-[220px] truncate">
                            {result}
                          </span>
                        </ChainOfThoughtSearchResult>
                      ))}
                    </ChainOfThoughtSearchResults>
                  ) : null}
                </ChainOfThoughtStep>
              );
            }

            if (item.kind === "tool-group") {
              return (
                <ToolCallGroup
                  artifactStatuses={artifactStatuses}
                  isCancelled={isCancelled}
                  items={item.items}
                  key={item.key}
                  onArtifactPreview={onArtifactPreview}
                  resolvedConfirmationIds={resolvedConfirmationIds}
                  resolvedConfirmations={resolvedConfirmations}
                  workspaceId={workspaceId}
                />
              );
            }

            return null;
          })}
        </ChainOfThoughtContent>
      ) : null}
    </ChainOfThought>
  );
}
