import {
  buildInitialVideoPresentationPipelineSteps,
  videoPresentationProjectPayloadSchema,
  type VideoPresentationCreateRequest,
  type VideoPresentationGenerationStage,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import { buildArtifactPreviewUrl } from "./artifact-urls";
import { compactArtifactText } from "./artifact-text";
import { stripVideoPresentationMarkdown } from "./video-presentation-files";

function buildGenerationStageSummary(stage: VideoPresentationGenerationStage) {
  switch (stage) {
    case "planning":
      return "Planning video project";
    case "generating_project_code":
      return "Generating project code";
    case "installing_project":
      return "Installing project dependencies";
    case "typechecking_project":
      return "Typechecking project";
    case "rendering_smoke_preview":
      return "Rendering smoke preview";
    case "planning_storyboard":
      return "Planning storyboard";
    case "materializing_assets":
      return "Preparing visual assets";
    case "generating_audio_tracks":
      return "Generating narration";
    case "assigning_slide_themes":
      return "Assigning slide themes";
    case "generating_scene_modules":
      return "Generating scene modules";
    case "repairing_scene_modules":
      return "Repairing scene modules";
    case "verifying_visual_quality":
      return "Reviewing rendered slides";
    case "publishing_video_project":
      return "Publishing video project";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

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
  stageSummary: string;
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
    stageSummary: buildGenerationStageSummary("planning_storyboard"),
    videoDownloadOnly: true,
  };

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
    stageSummary: buildGenerationStageSummary("planning_storyboard"),
    videoDownloadOnly: true,
  };
}

export function updateVideoPresentationPayloadGeneration(
  payload: VideoPresentationProjectPayload & Record<string, unknown>,
  input: {
    errorCode?: string;
    errorMessage?: string;
    progress: number;
    stage: VideoPresentationGenerationStage;
    status: VideoPresentationProjectPayload["generation"]["status"];
  },
): VideoPresentationProjectPayload & Record<string, unknown> {
  const normalized = videoPresentationProjectPayloadSchema.parse({
    ...payload,
    generation: {
      ...payload.generation,
      status: input.status,
      stage: input.stage,
      progress: input.progress,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    },
    preview: {
      ...payload.preview,
      slideCount: payload.slides.length,
    },
  });
  return {
    ...normalized,
    ...Object.fromEntries(
      Object.entries(payload).filter(([key]) =>
        [
          "artifactKind",
          "artifactUrl",
          "fileName",
          "jobId",
          "mimeType",
          "prompt",
          "renderStrategy",
          "requestKey",
          "stageSummary",
          "videoDownloadOnly",
        ].includes(key),
      ),
    ),
  };
}
