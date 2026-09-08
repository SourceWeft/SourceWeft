import {
  HTML_ARTIFACT_TYPE,
  HTML_ARTIFACT_RENDERER,
  htmlArtifactPayloadSchema,
} from "@sourceweft/contracts/html-artifact";
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
 * applies. What the host cannot know is how to name the download, which is this
 * capability's decision and stays private to the package.
 */

export const SLIDES_ARTIFACT_TYPE = "slides";

const SLIDES_FILE_BASE_FALLBACK = "generated-presentation";

function withFileExtension(fileName: string, extension: string) {
  return fileName.toLowerCase().endsWith(extension)
    ? fileName
    : `${fileName}${extension}`;
}

function resolveSlidesFileName(input: { artifact: ArtifactViewRecord }) {
  const title = input.artifact.title?.trim();
  if (title) {
    return withFileExtension(
      sanitizeArtifactFileBase(title, {
        fallback: SLIDES_FILE_BASE_FALLBACK,
      }),
      ".pptx",
    );
  }
  // No title to name the deck after: let the host's generic naming answer.
  return null;
}

export const slidesArtifactViewHandler: ArtifactViewHandler = {
  artifactType: SLIDES_ARTIFACT_TYPE,
  resolveFileName: resolveSlidesFileName,
  /**
   * Slides have always been treated as inline-previewable regardless of the
   * stored file's MIME type, including the `.pptx` case the generic MIME
   * fallback would reject. Preserved verbatim here.
   */
  canPreviewInline: () => true,
};

export const htmlArtifactViewHandler: ArtifactViewHandler = {
  artifactType: HTML_ARTIFACT_TYPE,
  executionPolicy: "sandboxed-html",
  resolveContentType: () => "text/html",
  resolveRenderer: () => HTML_ARTIFACT_RENDERER,
  canPreviewInline: () => true,
  resolveFileName: ({ artifact }) =>
    htmlArtifactPayloadSchema.parse(artifact.payloadJson).fileName,
  buildPublicPayload: ({ artifact }) => {
    const parsed = htmlArtifactPayloadSchema.safeParse(artifact.payloadJson);
    if (!parsed.success) return null;
    const { fileName, byteLength, contentDigest, metadata, validation } =
      parsed.data;
    return {
      schemaVersion: 1,
      fileName,
      mimeType: "text/html",
      byteLength,
      contentDigest,
      metadata,
      validation,
    };
  },
};

export const createArtifactViewHandlers: CreateArtifactViewHandlers = () => [
  slidesArtifactViewHandler,
  htmlArtifactViewHandler,
];
