import {
  getAgentToolPresentation,
  getAgentToolSlashCommand,
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { readArtifactOutputField } from "@sourceweft/contracts/artifact-progress";
import { resolveArtifactPageUrl } from "../artifact-urls";
import { getToolConfirmationOutput } from "./tool-confirmation-state";
import {
  compactText,
  type GeneratedPresentationArtifactStatus,
  getToolOutputContent,
  normalizeAssetUrl,
} from "./message-assets";
import {
  getConnectorToolDisplayLabel,
  getToolApprovalDisplayLabel,
} from "./reasoning-trace-state";
import {
  type DeliverableGenerationStatus,
  resolveDeliverableStatus,
  shouldSuppressDeliverableOutputSummary,
} from "./artifact-progress";
import { resolveToolCallArtifactId } from "./artifact-work-state";
import type {
  ArtifactPreviewRecord,
  ArtifactStatusSnapshot,
  ThinkingStepRecord,
  ToolConfirmationResolution,
  ToolCallRecord,
} from "./types";

export function artifactPreviewCapabilities(input: {
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

export function replaceIllegalFilenameCharacters(value: string) {
  return Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || code === 127 || ILLEGAL_FILENAME_CHARS.has(char)
        ? "-"
        : char;
    })
    .join("");
}

export function getRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  return record ? record[key] : undefined;
}

export function getToolQuery(toolCall: ToolCallRecord, toolStep?: ThinkingStepRecord) {
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

export function getToolFetchUrls(toolCall: ToolCallRecord) {
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

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}


export function summarizeToolOutput(output: unknown, toolName: string) {
  const confirmation = getToolConfirmationOutput(output);
  if (
    confirmation ||
    shouldSuppressDeliverableOutputSummary({ toolCallOutput: output, toolName })
  ) {
    return null;
  }
  const content = getToolOutputContent(output);
  return content ? compactText(content) : null;
}

export function parseAspectRatio(value: unknown) {
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

export function formatToolName(toolName: string) {
  return toolName
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function getToolDisplayName(toolName: string) {
  return (
    getAgentToolSlashCommand(toolName)?.displayName ?? formatToolName(toolName)
  );
}

export function getWebSearchStatusLabel(status: ToolCallRecord["status"]) {
  if (status === "running" || status === "approval_requested") {
    return "Searching web";
  }
  if (status === "error") {
    return "Web search failed";
  }
  return "Searched web";
}

export function getWebFetchStatusLabel(status: ToolCallRecord["status"]) {
  if (status === "running" || status === "approval_requested") {
    return "Fetching pages";
  }
  if (status === "error") {
    return "Page fetch failed";
  }
  return "Fetched pages";
}

const GENERATED_IMAGE_STAGE_INDEX: Record<string, number> = {
  preparing: 0,
  generating: 1,
  saving: 2,
  billing: 3,
  ready: 4,
};

export function getGeneratedImageStatus(toolCall: ToolCallRecord) {
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

  // Display label lives on the capability (generateImagePresentation); this
  // helper only feeds the progress meter's aspect ratio and step index.
  return {
    aspectRatio,
    progress:
      normalizedStage && normalizedStage in GENERATED_IMAGE_STAGE_INDEX
        ? GENERATED_IMAGE_STAGE_INDEX[normalizedStage]
        : null,
    stage: normalizedStage,
  };
}

export function getGeneratedImageTitle(toolCall: ToolCallRecord) {
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

export function getGeneratedImagePrompt(toolCall: ToolCallRecord) {
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

export function getGeneratedPresentationTitle(toolCall: ToolCallRecord) {
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

export function getGeneratedPresentationPrompt(toolCall: ToolCallRecord) {
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

export function downloadPresentationFileName(title: string, extension = "pptx") {
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

export function downloadVideoPresentationFileName(title: string) {
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

export function getGeneratedPresentationFileName(input: {
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

export function getPresentationArtifactPreviewStatus(input: {
  isVideoPresentation: boolean;
  status?: GeneratedPresentationArtifactStatus | null;
}): ArtifactPreviewRecord["status"] {
  if (!input.isVideoPresentation) {
    return "ready";
  }
  return input.status ?? "pending";
}

export function isPresentationArtifactPending(
  status?: GeneratedPresentationArtifactStatus | null,
) {
  return status === "pending" || status === "running";
}

export function getVideoProjectStageLabel(
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
  if (stage === "generating_project_code") {
    return "Generating Remotion project code...";
  }
  if (stage === "installing_project") {
    return "Installing project dependencies...";
  }
  if (stage === "typechecking_project") {
    return "Typechecking generated project...";
  }
  if (stage === "rendering_smoke_preview") {
    return "Rendering smoke preview...";
  }
  if (stage === "planning_storyboard" || stage === "normalizing_blueprint") {
    return "Planning storyboard...";
  }
  if (stage === "materializing_assets") {
    return "Preparing visual assets...";
  }
  if (stage === "generating_audio_tracks") {
    return "Generating narration audio...";
  }
  if (stage === "assigning_slide_themes") {
    return "Assigning visual themes...";
  }
  if (stage === "generating_scene_modules") {
    return "Generating Remotion scene code...";
  }
  if (stage === "repairing_scene_modules") {
    return "Repairing scene code...";
  }
  if (stage === "publishing_video_project") {
    return "Finalizing video project...";
  }
  if (stage === "ready") {
    return "Ready for browser video export.";
  }
  if (stage === "failed") {
    return "Video project failed.";
  }
  return null;
}

export function getVideoProjectProgressLabel(
  payload: Record<string, unknown> | undefined,
) {
  const generation =
    payload?.generation &&
    typeof payload.generation === "object" &&
    !Array.isArray(payload.generation)
      ? (payload.generation as Record<string, unknown>)
      : null;
  const stageLabel = getVideoProjectStageLabel(payload);
  const progress =
    typeof generation?.progress === "number" &&
    Number.isFinite(generation.progress)
      ? Math.max(0, Math.min(100, Math.round(generation.progress)))
      : null;
  const attempt =
    typeof generation?.attempt === "number" ? generation.attempt : null;
  const maxAttempts =
    typeof generation?.maxAttempts === "number" ? generation.maxAttempts : null;
  const retryError =
    typeof generation?.errorMessage === "string" &&
    generation.errorMessage.trim().length > 0
      ? generation.errorMessage.trim()
      : null;
  const label =
    generation?.retrying === true
      ? "Retrying video generation..."
      : generation?.status === "failed"
        ? "Video project failed."
        : (stageLabel ?? "Video project preparing...");
  const progressSuffix =
    progress === null ? "" : ` ${progress}%`;
  const attemptSuffix =
    attempt && maxAttempts ? ` · attempt ${attempt}/${maxAttempts}` : "";
  const errorSuffix = retryError ? ` · ${compactText(retryError, 160)}` : "";
  return `${label}${progressSuffix}${attemptSuffix}${errorSuffix}`;
}

export function buildGeneratedPresentationPreviewArtifact(input: {
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
    previewStorageKey: null,
    previewMetadataJson: {},
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

/**
 * The verb a capability wants shown for this call. The words belong to the
 * capability, so the UI asks it rather than keeping a matrix of English here.
 * Returns null when the tool declares no presentation — the caller then falls
 * through to the generic label path.
 */
function resolveCapabilityVerb(
  toolCall: ToolCallRecord,
  generationStatus: DeliverableGenerationStatus | null,
) {
  return (
    getAgentToolPresentation(toolCall.tool)?.title({
      generationStatus,
      readOutputField: readArtifactOutputField,
      status:
        toolCall.status === "running" || toolCall.status === "approval_requested"
          ? "running"
          : toolCall.status === "error"
            ? "error"
            : "completed",
      toolInput: toolCall.input ?? {},
      toolOutput: toolCall.output,
    }) ?? null
  );
}

export function getToolDisplayLabel(
  toolCall: ToolCallRecord,
  confirmationResolution?: ToolConfirmationResolution | null,
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>,
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
    const verb = resolveCapabilityVerb(toolCall, null);
    if (verb) {
      const title = getGeneratedImageTitle(toolCall);
      return title ? `${verb}: ${compactText(title, 72)}` : verb;
    }
  }

  if (
    hasAgentToolCapability(toolCall.tool, "presentation_artifact") ||
    hasAgentToolCapability(toolCall.tool, "video_presentation_artifact")
  ) {
    const isVideoPresentation = hasAgentToolCapability(
      toolCall.tool,
      "video_presentation_artifact",
    );
    const artifactId = isVideoPresentation
      ? resolveToolCallArtifactId(toolCall.output)
      : undefined;
    const artifactSnapshot = artifactId
      ? artifactStatuses?.get(artifactId)
      : undefined;
    const generationStatus = isVideoPresentation
      ? resolveDeliverableStatus({
          artifactSnapshot,
          toolCallOutput: toolCall.output,
          toolCallStatus: toolCall.status,
          toolName: toolCall.tool,
        })
      : null;
    const verb = resolveCapabilityVerb(toolCall, generationStatus);
    if (verb) {
      const title = getGeneratedPresentationTitle(toolCall);
      return title ? `${verb}: ${compactText(title, 72)}` : verb;
    }
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

export function getConnectorResultSummary(
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

export function getToolOutputRecord(output: unknown) {
  return output && typeof output === "object" && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : null;
}

export function getConnectorToolResult(toolCall: ToolCallRecord) {
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

export function normalizeConnectorPages(value: unknown) {
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

export function formatThinkingMetadataValue(key: string, value: unknown) {
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

export function getThinkingMetadataParts(
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

export type VisionFallbackImageTrace = {
  description: string;
  fileName: string;
  imageId: string;
  mimeType: string | null;
  url: string;
};

export function getMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
) {
  const value = getRecordValue(metadata, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function getVisionFallbackImages(
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

export function isVisionFallbackStep(step: ThinkingStepRecord) {
  return step.metadata?.strategy === "vision_fallback";
}

export function getToolStepMetadataParts(
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
