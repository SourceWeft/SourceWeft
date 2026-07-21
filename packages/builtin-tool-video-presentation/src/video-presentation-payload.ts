import {
  buildInitialVideoPresentationPipelineSteps,
  videoPresentationProjectPayloadSchema,
  type VideoPresentationCreateRequest,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import { buildArtifactPreviewUrl } from "./artifact-urls";
import { compactArtifactText } from "./artifact-text";
import { stripVideoPresentationMarkdown } from "./video-presentation-files";

export function buildVideoPresentationInitialPayload(input: {
  readonly artifactId: string;
  readonly fileName: string;
  readonly jobId: string;
  readonly request: VideoPresentationCreateRequest;
  readonly requestKey: string;
  readonly workspaceId: string;
}): VideoPresentationProjectPayload & {
  artifactKind: "video_presentation";
  artifactUrl: string;
  fileName: string;
  jobId: string;
  mimeType: "application/vnd.sourceweft.video-presentation+json";
  prompt: string;
  renderStrategy: "frontend_remotion_project_to_video";
  requestKey: string;
  videoDownloadOnly: true;
} {
  const title = input.request.title ?? "Video Presentation";
  const brief =
    input.request.brief?.trim() ||
    input.request.sourceDigest?.trim() ||
    title;
  const renderProfile = videoPresentationProjectPayloadSchema.shape.renderProfile.parse({
    stylePreset:
      input.request.renderProfile?.stylePreset ??
      input.request.stylePreset ??
      "cinematic",
    visualDensity: input.request.renderProfile?.visualDensity ?? "balanced",
    durationTarget:
      input.request.renderProfile?.durationTarget ??
      input.request.durationTarget ??
      "medium",
    language:
      input.request.renderProfile?.language ?? input.request.language ?? "auto",
  });
  const payload = {
    schemaVersion: 2,
    kind: "video_presentation",
    generation: {
      status: "pending",
      stage: "planning_storyboard",
      progress: 0,
      pipelineSteps: buildInitialVideoPresentationPipelineSteps(),
    },
    project: {
      title,
      fps: 30,
      width: 1920,
      height: 1080,
      durationSeconds: 0,
      stylePreset: renderProfile.stylePreset,
      globalVisualDirection: `${renderProfile.stylePreset} video presentation generated from a concise brief.`,
    },
    slides: [
      {
        slideNumber: 1,
        title,
        contentMarkdown: brief,
        speakerTranscript: [brief.slice(0, 500) || title],
        sceneIntent: "Introduce the requested video presentation topic.",
        assetRefs: [],
      },
    ],
    audioTracks: [],
    sceneModules: [],
    assets: [],
    preview: {
      slideCount: 1,
      durationSeconds: 0,
    },
    renderProfile,
    themeAssignments: [],
    sourceDigest: brief,
  };

  // The schema is a plain `z.object`, so it strips every key it does not
  // declare; the artifact-envelope fields below are re-attached after parsing
  // rather than listed twice.
  const normalized = videoPresentationProjectPayloadSchema.parse(payload);
  return {
    ...normalized,
    artifactKind: "video_presentation",
    artifactUrl: buildArtifactPreviewUrl({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
    }),
    fileName: input.fileName,
    jobId: input.jobId,
    mimeType: "application/vnd.sourceweft.video-presentation+json",
    prompt: compactArtifactText(
      stripVideoPresentationMarkdown(brief),
      1200,
    ),
    renderStrategy: "frontend_remotion_project_to_video",
    requestKey: input.requestKey,
    videoDownloadOnly: true,
  };
}
