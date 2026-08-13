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
import { hasVideoPresentationRenderedVideo } from "./artifact-view";
import { VideoPresentationArtifactBlock } from "./artifact-block";
import { VideoPresentationPreview } from "./video-presentation-preview";

function videoPresentationPreview(
  context: ArtifactPreviewContext,
): ArtifactPreviewResult {
  // The render host absolutizes workspace-relative narration URLs for the
  // OWNER's in-app preview. A PUBLIC share has no host registered (and the
  // payload it renders already carries absolute, token-scoped asset URLs), so
  // fall back to identity instead of throwing — throwing here is what made the
  // share page silently drop to the poster/iframe instead of client-rendering.
  let resolveAssetUrl: (value: string) => string;
  try {
    resolveAssetUrl = artifactRenderHost().resolveApiAssetUrl;
  } catch {
    resolveAssetUrl = (value) => value;
  }
  // The sandbox render path stores a real mp4 under `payload.renderedVideo`; the
  // host serves it on the artifact file route, so let the toolbar's default
  // Download hand the user that file. Browser-compiled decks have no server file
  // — the download exists only as the in-preview client render — so those keep
  // the default download blocked. Open is always the client-rendered project.
  const hasServerVideo = hasVideoPresentationRenderedVideo(context.payload);
  const isShare = context.surface === "share";
  return {
    // The public share renders chrome-less and carries its OWN download (the
    // client-render overlay), so the host chrome must not offer a second one.
    blocksDefaultDownload: isShare ? true : !hasServerVideo,
    blocksDefaultOpen: true,
    id: "video-presentation",
    content: (
      <VideoPresentationPreview
        artifactStatus={context.artifact.status}
        chromeless={isShare}
        errorMessage={context.artifact.errorMessage}
        fileUrl={context.proxyFileUrl ?? context.downloadUrl}
        payload={context.payload}
        resolveAssetUrl={resolveAssetUrl}
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
  hasVideoPresentationRenderedVideo,
  isVideoPresentationFailed,
  resolveVideoPresentationArtifactRef,
  resolveVideoProjectStageLabel,
  type ToolOutputFieldReader,
  type VideoPresentationArtifactRef,
  type VideoPresentationArtifactStatus,
  type VideoPresentationToolCallView,
} from "./artifact-view";
