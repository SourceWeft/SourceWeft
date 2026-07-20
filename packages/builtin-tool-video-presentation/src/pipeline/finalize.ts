import {
  buildArtifactPreviewUrl,
  buildArtifactSourceJsonUrl,
} from "@sourceweft/contracts/artifact-urls";
import {
  videoPresentationProjectPayloadSchema,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import { safeStorageSegment } from "./util";

export function buildVideoPresentationSourceJson(
  payload: VideoPresentationProjectPayload,
) {
  return videoPresentationProjectPayloadSchema.parse({
    ...payload,
    generation: {
      ...payload.generation,
    },
  });
}

export function attachReadySourceJson(input: {
  artifactId: string;
  jobId: string;
  payload: VideoPresentationProjectPayload;
  workspaceId: string;
}) {
  const sourceJson = buildVideoPresentationSourceJson(input.payload);
  // Two render strategies exist at once while the preview flip is pending, so
  // these two fields describe what this artifact actually has rather than what
  // the capability used to do. A run whose sandbox render failed (or whose
  // narration could not be assembled) publishes with no `renderedVideo` and is
  // still, truthfully, a browser-compiled presentation.
  const renderedVideo = input.payload.renderedVideo;
  return {
    ...input.payload,
    sourceJson,
    sourceJsonFileName: `${safeStorageSegment(input.payload.project.title)}.source.json`,
    sourceJsonUrl: buildArtifactSourceJsonUrl({
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
    }),
    artifactUrl: buildArtifactPreviewUrl({
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
    }),
    fileName: `${safeStorageSegment(input.payload.project.title)}.video-presentation.json`,
    jobId: input.jobId,
    mimeType: "application/vnd.sourceweft.video-presentation+json",
    renderStrategy: renderedVideo
      ? "sandbox_remotion_project_to_mp4"
      : "frontend_remotion_project_to_video",
    // `videoDownloadOnly` says the deck has no video file to hand a user — true
    // for the browser-compiled path, where the "video" only exists while a
    // player is compiling scene code. Once a server-rendered mp4 is stored
    // there is a real file on the asset route, so the claim stops being true.
    videoDownloadOnly: !renderedVideo,
  };
}
