import type {
  ArtifactPreviewContext,
  ArtifactPreviewResult,
  ArtifactUiModule,
} from "@sourceweft/contracts/artifact-ui";
import { VIDEO_PRESENTATION_ARTIFACT_TYPE } from "../artifact-view";
import { VideoPresentationPreview } from "./video-presentation-preview";

function videoPresentationPreview(
  context: ArtifactPreviewContext,
): ArtifactPreviewResult {
  const isShare = context.surface === "share";
  return {
    // Exact-version downloads live inside the preview; the generic toolbar URL
    // points at the mutable current artifact and must never replace it.
    blocksDefaultDownload: true,
    blocksDefaultOpen: true,
    id: "video-presentation",
    content: (
      <VideoPresentationPreview
        chromeless={isShare}
        downloadUrl={context.downloadUrl}
        errorMessage={context.artifact.errorMessage}
        fileUrl={context.proxyFileUrl ?? context.downloadUrl}
        payload={context.payload}
        previewImageUrl={context.previewImageUrl}
        title={context.title}
      />
    ),
  };
}

export const videoPresentationArtifactUi: ArtifactUiModule = {
  id: "video-presentation",
  artifactTypes: [VIDEO_PRESENTATION_ARTIFACT_TYPE],
  preview: videoPresentationPreview,
};

export { VideoPresentationPreview } from "./video-presentation-preview";
export {
  VideoPresentationExportControls,
  videoPresentationDownloadName,
} from "./video-presentation-export";
