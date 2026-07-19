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
    sourceJsonUrl: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifactId)}/source.json`,
    artifactUrl: `/artifact-preview?${new URLSearchParams({
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
    }).toString()}`,
    fileName: `${safeStorageSegment(input.payload.project.title)}.video-presentation.json`,
    jobId: input.jobId,
    mimeType: "application/vnd.sourceweft.video-presentation+json",
    renderStrategy: "frontend_remotion_project_to_video",
    videoDownloadOnly: true,
  };
}
