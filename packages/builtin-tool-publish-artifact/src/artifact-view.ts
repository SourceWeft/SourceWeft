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

export const createArtifactViewHandlers: CreateArtifactViewHandlers = () => [
  slidesArtifactViewHandler,
];
