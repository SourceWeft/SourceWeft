import {
  createArtifactProgressProtocol,
  type ArtifactProgressDescriptor,
} from "@sourceweft/contracts/artifact-progress";
import { buildInitialVideoPresentationPipelineSteps } from "@sourceweft/contracts/video-presentation";

/**
 * Video presentation's progress contribution.
 *
 * Reading progress is entirely generic — the deliverable host writes the same
 * `generation` block for every pipeline — so this package declares only the two
 * facts the generic reader cannot infer: which structured tool outputs belong
 * to this capability, and which steps to show before the first payload lands.
 *
 * A new deliverable capability adds a descriptor like this one and nothing else;
 * it does not reimplement the protocol and it does not need web-side code.
 */
export const videoPresentationArtifactProgressDescriptor: ArtifactProgressDescriptor =
  {
    title: "Video presentation",
    outputTypes: [
      "video_presentation_processing_result",
      "video_presentation_artifact_result",
      "generate_video_presentation_progress",
    ],
    initialSteps: buildInitialVideoPresentationPipelineSteps,
  };

export const videoPresentationArtifactProtocol = createArtifactProgressProtocol(
  videoPresentationArtifactProgressDescriptor,
);
