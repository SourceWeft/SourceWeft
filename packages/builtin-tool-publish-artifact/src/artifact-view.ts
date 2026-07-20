import { sanitizeArtifactFileBase } from "@sourceweft/contracts/artifact-files";
import type {
  ArtifactViewHandler,
  ArtifactViewRecord,
  CreateArtifactViewHandlers,
} from "@sourceweft/contracts";

/**
 * Read-side takeover for `slides` artifacts.
 *
 * A slides artifact is still a stored file, so most of the generic fallback
 * applies. What the host cannot know is that this capability publishes two
 * shapes under one artifact type — an editable `.pptx` package and a
 * self-contained visual HTML deck — which differ in download name and in the
 * renderer the client should use. Both of those decisions, and the deck's
 * `generationMode` payload key they read, stay private to this package.
 *
 * NOTE: nothing on the write side currently stores `generationMode` in an
 * artifact payload (the publish tool only reports `generation_mode` in its tool
 * output, and only ever as `editable_native`), so the `visual_html` paths below
 * are unreachable today. They are carried over verbatim rather than dropped —
 * removing them is a separate decision.
 */

export const SLIDES_ARTIFACT_TYPE = "slides";

/** Renderer hint the client uses to open a visual HTML deck. */
export const VISUAL_HTML_DECK_RENDERER = "visual_html_deck";

const VISUAL_HTML_GENERATION_MODE = "visual_html";

const SLIDES_FILE_BASE_FALLBACK = "generated-presentation";

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readTrimmedString(
  record: Record<string, unknown> | null,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function withFileExtension(fileName: string, extension: string) {
  return fileName.toLowerCase().endsWith(extension)
    ? fileName
    : `${fileName}${extension}`;
}

function isVisualHtmlDeck(artifact: ArtifactViewRecord) {
  return (
    readTrimmedString(toObjectRecord(artifact.payloadJson), "generationMode") ===
    VISUAL_HTML_GENERATION_MODE
  );
}

function resolveSlidesFileName(input: { artifact: ArtifactViewRecord }) {
  const { artifact } = input;
  const payload = toObjectRecord(artifact.payloadJson);
  const fileName = readTrimmedString(payload, "fileName");
  const visualHtml = isVisualHtmlDeck(artifact);

  if (visualHtml && fileName) {
    return fileName;
  }
  const title = artifact.title?.trim();
  if (title) {
    return withFileExtension(
      sanitizeArtifactFileBase(title, {
        fallback: SLIDES_FILE_BASE_FALLBACK,
      }),
      visualHtml ? ".html" : ".pptx",
    );
  }
  // No title to name the deck after: let the host's generic naming answer.
  return null;
}

function resolveSlidesRenderer(input: { artifact: ArtifactViewRecord }) {
  return isVisualHtmlDeck(input.artifact) ? VISUAL_HTML_DECK_RENDERER : null;
}

export const slidesArtifactViewHandler: ArtifactViewHandler = {
  artifactType: SLIDES_ARTIFACT_TYPE,
  resolveFileName: resolveSlidesFileName,
  resolveRenderer: resolveSlidesRenderer,
  /**
   * Slides have always been treated as inline-previewable regardless of the
   * stored file's MIME type, including the `.pptx` case the generic MIME
   * fallback would reject. Preserved verbatim here.
   */
  canPreviewInline: () => true,
};

export const createArtifactViewHandlers: CreateArtifactViewHandlers = () => [
  slidesArtifactViewHandler,
];
