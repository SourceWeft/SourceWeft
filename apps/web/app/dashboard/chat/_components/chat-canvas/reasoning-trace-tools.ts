import {
  getAgentToolPresentation,
  getAgentToolSlashCommand,
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { readArtifactOutputField } from "@sourceweft/contracts/artifact-progress";
// The image tool's output vocabulary (stages, aspect-ratio fields, title
// fallbacks) is decoded inside the capability package that writes it. Re-exported
// here so the app's existing call sites and tests keep one import path.
export {
  getGeneratedImagePrompt,
  getGeneratedImageStatus,
  getGeneratedImageTitle,
} from "@sourceweft/agent-tool-registry/ui";
import { getGeneratedImageTitle } from "@sourceweft/agent-tool-registry/ui";
import { getToolConfirmationOutput } from "./tool-confirmation-state";
import {
  compactText,
  getToolOutputContent,
  normalizeAssetUrl,
} from "./message-assets";
import {
  getConnectorToolDisplayLabel,
  getToolApprovalDisplayLabel,
} from "./reasoning-trace-state";
import {
  type DeliverableGenerationStatus,
  isDeliverableToolName,
  resolveDeliverableStatus,
  shouldSuppressDeliverableOutputSummary,
} from "./artifact-progress";
import { resolveToolCallArtifactId } from "./artifact-work-state";
import type {
  ArtifactStatusSnapshot,
  ThinkingStepRecord,
  ToolConfirmationResolution,
  ToolCallRecord,
} from "./types";

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

/**
 * The `generation` block every long-running artifact payload carries: which
 * stage it is on, how far along, and whether it is retrying. The shape is part
 * of the artifact payload contract — the *stage ids inside it* mean nothing
 * here, they are the producing capability's vocabulary.
 */
function readArtifactGeneration(payload: Record<string, unknown> | undefined) {
  return payload?.generation &&
    typeof payload.generation === "object" &&
    !Array.isArray(payload.generation)
    ? (payload.generation as Record<string, unknown>)
    : null;
}

/**
 * Stage vocabulary shared by every deliverable capability. Generic code names a
 * situation with these; the capability supplies the words for it.
 */
const SHARED_ARTIFACT_STAGE_IDS = {
  failed: "failed",
  preparing: "preparing",
  retrying: "retrying",
} as const;

/** Last-resort copy when a tool declares no words at all for its stage. */
const UNLABELLED_STAGE_FALLBACK = "Working";

/**
 * Words for one stage, asked of the tool that produced it. Generic renderers
 * pass along the stage id they were handed and never interpret it — a local
 * copy of some capability's stage list is how the message trace and the preview
 * panel ended up saying different things about one stage.
 */
export function getToolStageLabel(
  toolName: string | null | undefined,
  stageId: string | null | undefined,
) {
  if (!toolName || !stageId) {
    return null;
  }
  return (
    getAgentToolPresentation(toolName)?.stageStep?.({ stageId })?.item ?? null
  );
}

/** The stage words for an artifact payload, as its producing tool words them. */
export function getArtifactStageLabel(
  toolName: string | null | undefined,
  payload: Record<string, unknown> | undefined,
) {
  const generation = readArtifactGeneration(payload);
  const stage = typeof generation?.stage === "string" ? generation.stage : null;
  return getToolStageLabel(toolName, stage);
}

export function getArtifactGenerationProgressLabel(
  toolName: string | null | undefined,
  payload: Record<string, unknown> | undefined,
) {
  const generation = readArtifactGeneration(payload);
  const stageLabel = getArtifactStageLabel(toolName, payload);
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
  // "retrying", "failed" and "preparing" are shared stage vocabulary, so their
  // words also come from the capability rather than from a list kept here.
  const preparing = () =>
    getToolStageLabel(toolName, SHARED_ARTIFACT_STAGE_IDS.preparing) ??
    UNLABELLED_STAGE_FALLBACK;
  const label =
    generation?.retrying === true
      ? (getToolStageLabel(toolName, SHARED_ARTIFACT_STAGE_IDS.retrying) ??
        preparing())
      : generation?.status === "failed"
        ? (getToolStageLabel(toolName, SHARED_ARTIFACT_STAGE_IDS.failed) ??
          preparing())
        : (stageLabel ?? preparing());
  const progressSuffix =
    progress === null ? "" : ` ${progress}%`;
  const attemptSuffix =
    attempt && maxAttempts ? ` · attempt ${attempt}/${maxAttempts}` : "";
  const errorSuffix = retryError ? ` · ${compactText(retryError, 160)}` : "";
  return `${label}${progressSuffix}${attemptSuffix}${errorSuffix}`;
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
    // Only a deliverable (a tool that reports artifact progress) has a live
    // generation status to fold into its verb; a one-shot publisher does not.
    const isDeliverable = isDeliverableToolName(toolCall.tool);
    const artifactId = isDeliverable
      ? resolveToolCallArtifactId(toolCall.output)
      : undefined;
    const artifactSnapshot = artifactId
      ? artifactStatuses?.get(artifactId)
      : undefined;
    const generationStatus = isDeliverable
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
