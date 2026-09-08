import { HTML_ARTIFACT_TYPE } from "@sourceweft/contracts/html-artifact";
import { htmlArtifactPreview } from "./html-artifact-preview";
import { PublishedArtifactBlock } from "./published-artifact-block";
/**
 * `publish_artifact`'s artifact UI, for both surfaces at once.
 *
 * `renderAs: "pptx"` is the same token this capability already declares in
 * `publishArtifactPresentation`, so the message-stream block and the tool's
 * presentation stay in sync by construction. `artifactTypes: ["slides"]` claims
 * the stored rows this capability writes — one owner for the type, with the
 * variant choice made inside `preview()` rather than by an ordering rule on the
 * generic side.
 */
import type { ArtifactUiModule } from "@sourceweft/contracts/artifact-ui";
import { SLIDES_ARTIFACT_TYPE } from "../artifact-view";
import { PublishedPresentationArtifactBlock } from "./artifact-block";
import { slidesPreview } from "./slides-preview";

export const publishArtifactArtifactUi: ArtifactUiModule = {
  id: "publish-artifact",
  renderAs: "pptx",
  artifactTypes: [SLIDES_ARTIFACT_TYPE, HTML_ARTIFACT_TYPE],
  Block: PublishedArtifactBlock,
  preview: (context) => htmlArtifactPreview(context) ?? slidesPreview(context),
};

export {
  PublishedPresentationArtifactBlock,
  resolvePublishedPresentationThumbnailUrl,
} from "./artifact-block";
export { slidesPreview } from "./slides-preview";
export { SlidesFallback } from "./slides-fallback";
export { PptxViewJsPreview } from "./slides-pptx-preview";
export {
  buildPublishedPresentationPreviewRecord,
  getPublishedPresentationFileName,
  getPublishedPresentationToolCallBrief,
  getPublishedPresentationToolCallTitle,
  isPublishedPresentationPending,
  normalizePublishedPresentationArtifactStatus,
  publishedPresentationDownloadName,
  resolvePublishedPresentationArtifact,
  shouldShowPublishedPresentationItem,
  type PublishedPresentationArtifact,
  type PublishedPresentationArtifactStatus,
  type PublishedPresentationGenerationMode,
  type PublishedPresentationToolCallView,
  type ToolOutputFieldReader,
  type ToolOutputValueReader,
} from "./artifact-view";
