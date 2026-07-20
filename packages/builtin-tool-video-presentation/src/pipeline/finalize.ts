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
    renderStrategy: "frontend_remotion_project_to_video",
    videoDownloadOnly: true,
  };
}
