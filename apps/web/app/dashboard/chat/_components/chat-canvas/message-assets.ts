import {
  hasAgentToolCapability,
} from "@sourceweft/agent-tool-registry";
import {
  normalizeWebAssetUrl,
  resolveArtifactPreviewImageUrlFromArtifact,
  resolveArtifactPageUrlFromArtifact,
  resolveArtifactProxyFileUrlFromArtifact,
} from "../artifact-urls";
import type {
  ArtifactPreviewRecord,
  ChatMessageImagePart,
  MessageVersion,
  ThinkingStepRecord,
  ToolCallRecord,
} from "./types";

const TOOL_ONLY_EMPTY_RESPONSE_TEXT = "Model returned an empty response.";
const PUBLISH_ARTIFACT_TOOL_NAME = "publish_artifact";

export type GeneratedImageArtifact = {
  artifactId: string | null;
  artifactUrl: string | null;
  title: string | null;
};

export type GeneratedPresentationArtifact = {
  artifactId: string | null;
  artifactUrl: string | null;
  editable: boolean | null;
  fileName: string | null;
  generationMode: "visual_html" | "editable_native" | null;
  htmlUrl: string | null;
  previewImageUrl: string | null;
  previewRenderer: "html_iframe" | "pptxviewjs" | null;
  pptxUrl: string | null;
  renderStrategy: string | null;
  slideCount: number | null;
  sourceJsonUrl: string | null;
  status: GeneratedPresentationArtifactStatus | null;
  title: string | null;
};

export type GeneratedPresentationArtifactStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "archived";

function extractArtifactIdFromUrl(value: string) {
  const match = value.match(/\/artifacts\/([^/?#]+)\/file(?:[?#].*)?$/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function getGeneratedImageArtifactRefs(input: {
  toolCalls?: ToolCallRecord[];
  workspaceId?: string | null;
}) {
  const artifactIds = new Set<string>();
  const artifactUrls = new Set<string>();

  for (const toolCall of input.toolCalls ?? []) {
    if (!hasAgentToolCapability(toolCall.tool, "generated_image_artifact")) {
      continue;
    }

    const artifact = resolveGeneratedImageArtifact(toolCall);
    if (!artifact) {
      continue;
    }

    if (artifact.artifactId) {
      artifactIds.add(artifact.artifactId);
    }

    const urls = [
      artifact.artifactUrl,
      resolveArtifactUrl({ artifact, workspaceId: input.workspaceId }),
    ];
    for (const url of urls) {
      if (!url) {
        continue;
      }
      artifactUrls.add(normalizeAssetUrl(url));
      const artifactId = extractArtifactIdFromUrl(url);
      if (artifactId) {
        artifactIds.add(artifactId);
      }
    }
  }

  return { artifactIds, artifactUrls };
}

export function stripGeneratedImageMarkdown(input: {
  content: string;
  toolCalls?: ToolCallRecord[];
  trim?: boolean;
  workspaceId?: string | null;
}) {
  const artifactRefs = getGeneratedImageArtifactRefs({
    toolCalls: input.toolCalls,
    workspaceId: input.workspaceId,
  });

  if (
    artifactRefs.artifactIds.size === 0 &&
    artifactRefs.artifactUrls.size === 0
  ) {
    return input.content;
  }

  const content = input.content
    .replace(
      /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (markdown: string, url: string) => {
        const rawUrl = String(url).trim();
        const normalizedUrl = normalizeAssetUrl(rawUrl);
        const artifactId = extractArtifactIdFromUrl(rawUrl);
        const isGeneratedImage =
          artifactRefs.artifactUrls.has(normalizedUrl) ||
          (artifactId ? artifactRefs.artifactIds.has(artifactId) : false);
        return isGeneratedImage ? "" : markdown;
      },
    )
    .replace(/\n{3,}/g, "\n\n");

  return input.trim === false ? content : content.trim();
}

export function getMessageText(input: {
  version: MessageVersion;
  workspaceId?: string | null;
}): string {
  const text = stripGeneratedImageMarkdown({
    content: input.version.content,
    toolCalls: input.version.toolCalls,
    workspaceId: input.workspaceId,
  });
  return text.trim() === TOOL_ONLY_EMPTY_RESPONSE_TEXT &&
    (input.version.toolCalls?.length ?? 0) > 0
    ? ""
    : text;
}

export function getMessageImageParts(version: MessageVersion) {
  const parts = version.contentJson?.parts;
  if (!Array.isArray(parts)) {
    return [] as ChatMessageImagePart[];
  }

  return parts.filter(
    (part): part is ChatMessageImagePart =>
      part.type === "image" &&
      typeof part.id === "string" &&
      typeof part.url === "string" &&
      typeof part.fileName === "string",
  );
}

export function compactText(value: string, maxLength = 160) {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength
    ? `${compacted.slice(0, maxLength - 1)}…`
    : compacted;
}

export function normalizeAssetUrl(value: string) {
  return normalizeWebAssetUrl(value);
}

export function resolveMessageAssetUrl(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  return normalizeAssetUrl(value);
}

function getToolOutputRecordFromContent(output: unknown) {
  const content = getToolOutputContent(output);
  if (!content) {
    return null;
  }

  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getToolOutputValue(output: unknown, key: string) {
  if (typeof output === "object" && output !== null) {
    const direct = (output as Record<string, unknown>)[key];
    if (direct !== undefined && direct !== null) {
      return direct;
    }

    const contentRecord = getToolOutputRecordFromContent(output);
    if (contentRecord && contentRecord[key] !== undefined) {
      return contentRecord[key];
    }

    return null;
  }

  const contentRecord = getToolOutputRecordFromContent(output);
  if (contentRecord && contentRecord[key] !== undefined) {
    return contentRecord[key];
  }

  return null;
}

function getToolOutputField(output: unknown, key: string) {
  const value = getToolOutputValue(output, key);
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof output !== "string") {
    const content = getToolOutputContent(output);
    if (!content) {
      return null;
    }
    const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim() ?? null;
  }

  const match = output.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function resolveGeneratedImageArtifact(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
): GeneratedImageArtifact | null {
  if (!hasAgentToolCapability(toolCall.tool, "generated_image_artifact")) {
    return null;
  }

  const metadata = toolStep?.metadata;
  const artifactId =
    (typeof metadata?.artifactId === "string"
      ? metadata.artifactId.trim()
      : "") || getToolOutputField(toolCall.output, "artifact_id");
  const artifactUrl =
    (typeof metadata?.artifactUrl === "string"
      ? metadata.artifactUrl.trim()
      : "") ||
    getToolOutputField(toolCall.output, "artifact_url") ||
    getToolOutputField(toolCall.output, "preview_url");
  const title = getToolOutputField(toolCall.output, "title");

  if (!artifactId && !artifactUrl) {
    return null;
  }

  return {
    artifactId: artifactId || null,
    artifactUrl: artifactUrl || null,
    title,
  };
}

function getToolOutputNumberField(output: unknown, key: string) {
  const direct = getToolOutputValue(output, key);
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  if (typeof direct === "string" && direct.trim().length > 0) {
    const parsed = Number(direct);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const text = getToolOutputField(output, key);
  if (!text) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeGeneratedPresentationArtifactStatus(
  value: string | null,
): GeneratedPresentationArtifactStatus | null {
  const normalized = value?.toLowerCase();
  if (
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "ready" ||
    normalized === "failed" ||
    normalized === "archived"
  ) {
    return normalized;
  }
  if (normalized === "queued") {
    return "pending";
  }
  if (normalized === "generating" || normalized === "rendering") {
    return "running";
  }
  if (normalized === "completed" || normalized === "success") {
    return "ready";
  }
  if (normalized === "error") {
    return "failed";
  }
  return null;
}

export function resolveGeneratedPresentationArtifact(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
): GeneratedPresentationArtifact | null {
  if (
    !hasAgentToolCapability(toolCall.tool, "presentation_artifact") &&
    !hasAgentToolCapability(toolCall.tool, "video_presentation_artifact")
  ) {
    return null;
  }

  if (
    toolCall.tool === PUBLISH_ARTIFACT_TOOL_NAME &&
    toolCall.error
  ) {
    return null;
  }

  const metadata = toolStep?.metadata;
  const artifactId =
    (typeof metadata?.artifactId === "string"
      ? metadata.artifactId.trim()
      : "") ||
    getToolOutputField(toolCall.output, "artifact_id") ||
    getToolOutputField(toolCall.output, "artifactId");
  const artifactUrl =
    (typeof metadata?.artifactUrl === "string"
      ? metadata.artifactUrl.trim()
      : "") ||
    getToolOutputField(toolCall.output, "artifact_url") ||
    getToolOutputField(toolCall.output, "artifactUrl") ||
    getToolOutputField(toolCall.output, "pptx_url");
  const title =
    getToolOutputField(toolCall.output, "title") ||
    (typeof metadata?.title === "string" ? metadata.title.trim() : "");
  const fileName =
    getToolOutputField(toolCall.output, "file_name") ||
    getToolOutputField(toolCall.output, "fileName");
  const slideCount =
    getToolOutputNumberField(toolCall.output, "slide_count") ??
    getToolOutputNumberField(toolCall.output, "slideCount");
  const sourceJsonUrl = getToolOutputField(toolCall.output, "source_json_url");
  const generationModeValue = getToolOutputField(
    toolCall.output,
    "generation_mode",
  ) ?? getToolOutputField(toolCall.output, "generationMode");
  const generationMode =
    generationModeValue === "visual_html" ||
    generationModeValue === "editable_native"
      ? generationModeValue
      : null;
  const previewRendererValue = getToolOutputField(
    toolCall.output,
    "preview_renderer",
  );
  const previewRenderer =
    previewRendererValue === "html_iframe" ||
    previewRendererValue === "pptxviewjs"
      ? previewRendererValue
      : null;
  const editableValue = getToolOutputValue(toolCall.output, "editable");
  const editable =
    typeof editableValue === "boolean"
      ? editableValue
      : generationMode
        ? generationMode === "editable_native"
        : null;
  const htmlUrl =
    getToolOutputField(toolCall.output, "html_url") ||
    getToolOutputField(toolCall.output, "htmlUrl");
  const pptxUrl =
    getToolOutputField(toolCall.output, "pptx_url") ||
    getToolOutputField(toolCall.output, "pptxUrl");
  const previewImageUrl =
    getToolOutputField(toolCall.output, "preview_image_url") ||
    getToolOutputField(toolCall.output, "previewImageUrl");
  const renderStrategy = getToolOutputField(toolCall.output, "render_strategy");
  const status = normalizeGeneratedPresentationArtifactStatus(
    getToolOutputField(toolCall.output, "status"),
  );

  if (toolCall.tool === PUBLISH_ARTIFACT_TOOL_NAME && !artifactUrl) {
    return null;
  }

  if (!artifactId && !artifactUrl) {
    return null;
  }

  return {
    artifactId: artifactId || null,
    artifactUrl: artifactUrl || null,
    editable,
    fileName: fileName || null,
    generationMode,
    htmlUrl: htmlUrl || null,
    previewImageUrl: previewImageUrl || null,
    previewRenderer,
    pptxUrl: pptxUrl || null,
    renderStrategy: renderStrategy || null,
    slideCount,
    sourceJsonUrl: sourceJsonUrl || null,
    status,
    title: title || null,
  };
}

export function resolveArtifactUrl(input: {
  artifact: GeneratedImageArtifact;
  workspaceId?: string | null;
}) {
  return resolveArtifactPageUrlFromArtifact({
    artifactId: input.artifact.artifactId,
    fallbackUrl: input.artifact.artifactUrl,
    workspaceId: input.workspaceId,
  });
}

export function resolveArtifactDownloadUrl(input: {
  artifact: Pick<GeneratedImageArtifact, "artifactId"> & {
    artifactUrl?: string | null;
  };
  workspaceId?: string | null;
}) {
  return resolveArtifactProxyFileUrlFromArtifact({
    artifactId: input.artifact.artifactId,
    download: true,
    fallbackUrl: input.artifact.artifactUrl,
    workspaceId: input.workspaceId,
  });
}

export function resolveGeneratedPresentationPreviewImageUrl(input: {
  artifactPreview?: Pick<
    ArtifactPreviewRecord,
    "id" | "previewMetadataJson" | "previewStorageKey" | "workspaceId"
  > | null;
  previewImageUrl?: string | null;
}) {
  const previewImageUrl =
    typeof input.previewImageUrl === "string" &&
    input.previewImageUrl.trim().length > 0
      ? input.previewImageUrl.trim()
      : null;
  if (previewImageUrl) {
    return normalizeWebAssetUrl(previewImageUrl);
  }

  return resolveArtifactPreviewImageUrlFromArtifact({
    artifactId: input.artifactPreview?.id,
    previewMetadataJson: input.artifactPreview?.previewMetadataJson,
    previewStorageKey: input.artifactPreview?.previewStorageKey,
    workspaceId: input.artifactPreview?.workspaceId,
  });
}

export function getToolOutputContent(output: unknown) {
  if (output === null || output === undefined) {
    return null;
  }

  if (typeof output === "string") {
    return output;
  }

  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.displayContent === "string") {
      return record.displayContent;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    return null;
  }

  return String(output);
}
