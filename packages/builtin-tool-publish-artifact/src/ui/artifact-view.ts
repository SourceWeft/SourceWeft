/**
 * How `publish_artifact`'s tool output and artifact payload are read back for
 * display.
 *
 * Every key name below (`pptx_url`, `slide_count`, `generation_mode`,
 * `editable`, …) is this capability's own wire vocabulary, and the download
 * naming and preview-record shape are its own conventions. They live here,
 * beside the tool that writes them, so no generic renderer has to know them.
 *
 * React-free on purpose: the message-stream card, the preview panel and the
 * tests all share these readers. Transport-level decoding (whichever shape the
 * output arrived in) is injected by the caller — only the *meaning* of the keys
 * belongs to this package.
 */
import type { ArtifactPreviewRecord } from "@sourceweft/contracts/artifact-ui";
import { PUBLISH_ARTIFACT_TOOL_NAME } from "../agent-tool-defs";
import { SLIDES_ARTIFACT_TYPE } from "../artifact-view";

/** Reads one scalar field out of a tool call's output, however it arrived. */
export type ToolOutputFieldReader = (key: string) => string | null;
/** The same lookup, un-stringified — `editable` is a boolean on the wire. */
export type ToolOutputValueReader = (key: string) => unknown;

export type PublishedPresentationGenerationMode =
  | "visual_html"
  | "editable_native";

export type PublishedPresentationArtifactStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "archived";

export type PublishedPresentationArtifact = {
  artifactId: string | null;
  artifactUrl: string | null;
  editable: boolean | null;
  fileName: string | null;
  generationMode: PublishedPresentationGenerationMode | null;
  htmlUrl: string | null;
  previewImageUrl: string | null;
  previewRenderer: "html_iframe" | "pptxviewjs" | null;
  pptxUrl: string | null;
  renderStrategy: string | null;
  slideCount: number | null;
  sourceJsonUrl: string | null;
  status: PublishedPresentationArtifactStatus | null;
  title: string | null;
};

export type PublishedPresentationToolCallView = {
  readonly error: string | null;
  readonly input: Record<string, unknown>;
  readonly output: unknown;
  readonly tool: string;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmed(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

// ---------------------------------------------------------------------------
// Download naming
// ---------------------------------------------------------------------------

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

/**
 * The name the browser saves a published deck under. The two extensions this
 * capability can produce (`.pptx`, `.html`) are swapped rather than appended,
 * so a title that already carries one does not end up with two.
 */
export function publishedPresentationDownloadName(
  title: string,
  extension = "pptx",
) {
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

/** The download name for a card, preferring the published file's own name. */
export function getPublishedPresentationFileName(input: {
  artifactFileName?: string | null;
  generationMode?: PublishedPresentationGenerationMode | null;
  title?: string | null;
}) {
  return publishedPresentationDownloadName(
    input.artifactFileName ?? input.title ?? "",
    input.generationMode === "visual_html" ? "html" : "pptx",
  );
}

// ---------------------------------------------------------------------------
// Terminal-state rules
// ---------------------------------------------------------------------------

export function isPublishedPresentationPending(
  status?: PublishedPresentationArtifactStatus | null,
) {
  return status === "pending" || status === "running";
}

/**
 * The status the in-trace preview row reports.
 *
 * A published deck is a finished file by the time it has an artifact URL at
 * all — this capability publishes an already-generated artifact rather than
 * streaming one into existence — so the row is always `ready`. Long-running
 * deliverables that need a live status own their own card.
 */
const PUBLISHED_PRESENTATION_PREVIEW_STATUS =
  "ready" satisfies ArtifactPreviewRecord["status"];

/**
 * Whether the card belongs in the trace at all.
 *
 * The publisher is deliberately silent until it has a finished artifact: a
 * running, awaiting-approval or failed publish shows nothing, because the
 * artifact it publishes was already visible as the file that produced it.
 */
export function shouldShowPublishedPresentationItem(input: {
  fileUrl?: string | null;
  isArtifactPublisher: boolean;
  status: "running" | "approval_requested" | "completed" | "error";
}) {
  if (
    input.isArtifactPublisher &&
    (input.status === "running" ||
      input.status === "approval_requested" ||
      input.status === "error")
  ) {
    return false;
  }
  if (
    input.status === "running" ||
    input.status === "approval_requested" ||
    input.status === "error"
  ) {
    return true;
  }
  return Boolean(input.fileUrl);
}

// ---------------------------------------------------------------------------
// Tool-output decoding
// ---------------------------------------------------------------------------

export function normalizePublishedPresentationArtifactStatus(
  value: string | null,
): PublishedPresentationArtifactStatus | null {
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

function readNumberField(
  readField: ToolOutputFieldReader,
  readValue: ToolOutputValueReader,
  key: string,
) {
  const direct = readValue(key);
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  if (typeof direct === "string" && direct.trim().length > 0) {
    const parsed = Number(direct);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const text = readField(key);
  if (!text) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The artifact reference `publish_artifact` puts in its tool output.
 *
 * The caller supplies the transport-level readers (host facilities); the key
 * names, the `pptx_url` fallback and the "a failed publish has no card" rule
 * are this capability's business.
 */
export function resolvePublishedPresentationArtifact(input: {
  metadata?: Record<string, unknown> | undefined;
  readField: ToolOutputFieldReader;
  readValue: ToolOutputValueReader;
  toolCall: Pick<PublishedPresentationToolCallView, "error" | "tool">;
}): PublishedPresentationArtifact | null {
  const { readField, readValue, toolCall } = input;
  const isArtifactPublisher = toolCall.tool === PUBLISH_ARTIFACT_TOOL_NAME;
  if (!isArtifactPublisher) {
    return null;
  }

  if (toolCall.error) {
    return null;
  }

  const metadata = input.metadata;
  const artifactId =
    trimmed(metadata?.artifactId) ??
    readField("artifact_id") ??
    readField("artifactId");
  // `pptx_url` is the legacy spelling of the artifact URL; a published deck is
  // the only artifact that ever used it.
  const artifactUrl =
    trimmed(metadata?.artifactUrl) ??
    readField("artifact_url") ??
    readField("artifactUrl") ??
    readField("pptx_url");
  const title = readField("title") ?? trimmed(metadata?.title);
  const fileName = readField("file_name") ?? readField("fileName");
  const slideCount =
    readNumberField(readField, readValue, "slide_count") ??
    readNumberField(readField, readValue, "slideCount");
  const sourceJsonUrl = readField("source_json_url");
  const generationModeValue =
    readField("generation_mode") ?? readField("generationMode");
  const generationMode =
    generationModeValue === "visual_html" ||
    generationModeValue === "editable_native"
      ? generationModeValue
      : null;
  const previewRendererValue = readField("preview_renderer");
  const previewRenderer =
    previewRendererValue === "html_iframe" ||
    previewRendererValue === "pptxviewjs"
      ? previewRendererValue
      : null;
  const editableValue = readValue("editable");
  const editable =
    typeof editableValue === "boolean"
      ? editableValue
      : generationMode
        ? generationMode === "editable_native"
        : null;
  const htmlUrl = readField("html_url") ?? readField("htmlUrl");
  const pptxUrl = readField("pptx_url") ?? readField("pptxUrl");
  const previewImageUrl =
    readField("preview_image_url") ?? readField("previewImageUrl");
  const renderStrategy = readField("render_strategy");
  const status = normalizePublishedPresentationArtifactStatus(
    readField("status"),
  );

  if (!artifactUrl) {
    return null;
  }

  return {
    artifactId: artifactId || null,
    artifactUrl,
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

/** The title to show, preferring what the run reported over what was asked for. */
export function getPublishedPresentationToolCallTitle(
  toolCall: Pick<PublishedPresentationToolCallView, "input" | "output">,
) {
  return (
    trimmed(toRecord(toolCall.output)?.title) ?? trimmed(toolCall.input.title)
  );
}

/** The one-line description under the title: the brief that started the run. */
export function getPublishedPresentationToolCallBrief(
  toolCall: Pick<PublishedPresentationToolCallView, "input" | "output">,
) {
  return (
    trimmed(toolCall.input.brief) ?? trimmed(toRecord(toolCall.output)?.prompt)
  );
}

// ---------------------------------------------------------------------------
// The in-trace artifact row
// ---------------------------------------------------------------------------

/**
 * The artifact row the card hands to the preview panel before the stored row
 * has necessarily been fetched.
 *
 * A published deck is always file-backed, so it advertises download, open and
 * inline preview, and never client-side rendering.
 */
export function buildPublishedPresentationPreviewRecord(input: {
  artifactId: string | null;
  description?: string | null;
  fileUrl: string | null;
  generationMode: PublishedPresentationGenerationMode | null;
  source: {
    editable?: boolean | null;
    fileName?: string | null;
    htmlUrl?: string | null;
    previewImageUrl?: string | null;
    pptxUrl?: string | null;
    previewRenderer?: "html_iframe" | "pptxviewjs" | null;
    renderStrategy?: string | null;
    slideCount?: number | null;
    status?: PublishedPresentationArtifactStatus | null;
  };
  title: string | null;
  workspaceId?: string | null;
}): ArtifactPreviewRecord | null {
  if (!input.artifactId || !input.workspaceId || !input.fileUrl) {
    return null;
  }

  const status = PUBLISHED_PRESENTATION_PREVIEW_STATUS;
  const generationMode =
    input.generationMode ??
    (input.source.htmlUrl ? "visual_html" : "editable_native");

  return {
    id: input.artifactId,
    teamId: "",
    workspaceId: input.workspaceId,
    threadId: null,
    artifactType: SLIDES_ARTIFACT_TYPE,
    status,
    title: input.title,
    promptText: input.description ?? null,
    payloadJson: {
      editable: input.source.editable ?? generationMode === "editable_native",
      generationMode,
      renderStrategy: input.source.renderStrategy ?? undefined,
      html:
        input.source.htmlUrl && input.source.fileName
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
    completedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previewUrl: input.fileUrl,
    capabilities: {
      canDownloadFile: true,
      canOpenFile: true,
      canPreviewInline: true,
      canRenderClientSide: false,
    },
  };
}
