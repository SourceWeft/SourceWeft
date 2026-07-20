/**
 * `generate_video_presentation`'s artifact UI, for both surfaces at once.
 *
 * `renderAs: "video"` is the same token this capability already declares in
 * `videoPresentationPresentation`, so the message-stream block and the tool's
 * presentation stay in sync by construction. `artifactTypes:
 * ["video_presentation"]` claims the stored rows this capability writes, so the
 * preview panel needs no payload sniffing on the generic side.
 */
import {
  artifactRenderHost,
  type ArtifactPreviewContext,
  type ArtifactPreviewResult,
  type ArtifactUiModule,
} from "@sourceweft/contracts/artifact-ui";
import { VIDEO_PRESENTATION_ARTIFACT_TYPE } from "../artifact-view";
import { VideoPresentationArtifactBlock } from "./artifact-block";
import { VideoPresentationPreview } from "./video-presentation-preview";

function videoPresentationPreview(
  context: ArtifactPreviewContext,
): ArtifactPreviewResult {
  const host = artifactRenderHost();
  return {
    // A video presentation owns both chrome actions: it has no server-side file
    // to download or open, only a project the browser renders.
    blocksDefaultDownload: true,
    blocksDefaultOpen: true,
    id: "video-presentation",
    content: (
      <VideoPresentationPreview
        artifactStatus={context.artifact.status}
        errorMessage={context.artifact.errorMessage}
        payload={context.payload}
        resolveAssetUrl={host.resolveApiAssetUrl}
        title={context.title}
      />
    ),
  };
}

export const videoPresentationArtifactUi: ArtifactUiModule = {
  id: "video-presentation",
  renderAs: "video",
  artifactTypes: [VIDEO_PRESENTATION_ARTIFACT_TYPE],
  Block: VideoPresentationArtifactBlock,
  preview: videoPresentationPreview,
};

export { VideoPresentationArtifactBlock } from "./artifact-block";
export { VideoPresentationPreview } from "./video-presentation-preview";
export {
  VideoPresentationExportControls,
  videoPresentationDownloadName,
} from "./video-presentation-export";
export {
  buildVideoPresentationPreviewRecord,
  canRenderVideoPresentationScenes,
  getVideoPresentationPayloadStageWords,
  getVideoPresentationStageWords,
  getVideoPresentationToolCallBrief,
  getVideoPresentationToolCallTitle,
  isVideoPresentationFailed,
  resolveVideoPresentationArtifactRef,
  resolveVideoProjectStageLabel,
  type ToolOutputFieldReader,
  type VideoPresentationArtifactRef,
  type VideoPresentationArtifactStatus,
  type VideoPresentationToolCallView,
} from "./artifact-view";
