import { z } from "zod";
import {
  artifactPipelineStepSchema,
  artifactPipelineStepStatusSchema,
} from "./artifact-pipeline";
import type { VideoPresentationGenerationStage } from "./video-presentation";

export const VIDEO_PRESENTATION_PIPELINE_STAGE_IDS = [
  "planning_storyboard",
  "materializing_assets",
  "generating_audio_tracks",
  "assigning_slide_themes",
  "generating_scene_modules",
  "repairing_scene_modules",
  "installing_project",
  "typechecking_project",
  "rendering_smoke_preview",
  "verifying_visual_quality",
  "publishing_video_project",
] as const;

export const videoPresentationPipelineStageIdSchema = z.enum(
  VIDEO_PRESENTATION_PIPELINE_STAGE_IDS,
);

export const videoPresentationPipelineStepStatusSchema =
  artifactPipelineStepStatusSchema;

export const videoPresentationPipelineStepSchema = artifactPipelineStepSchema
  .omit({ id: true })
  .extend({
    id: videoPresentationPipelineStageIdSchema,
  });

export type VideoPresentationPipelineStageId = z.infer<
  typeof videoPresentationPipelineStageIdSchema
>;
export type VideoPresentationPipelineStepStatus = z.infer<
  typeof videoPresentationPipelineStepStatusSchema
>;
export type VideoPresentationPipelineStep = z.infer<
  typeof videoPresentationPipelineStepSchema
>;

/**
 * Overall progress per generation stage. Covers every
 * VideoPresentationGenerationStage — not just the pipeline stage ids — so the
 * worker and the pipeline helpers below cannot report different percentages
 * for the same stage.
 */
export const VIDEO_PRESENTATION_STAGE_PROGRESS: Record<
  VideoPresentationGenerationStage,
  number
> = {
  planning: 0,
  generating_project_code: 8,
  planning_storyboard: 16,
  materializing_assets: 28,
  generating_audio_tracks: 40,
  assigning_slide_themes: 52,
  generating_scene_modules: 64,
  repairing_scene_modules: 76,
  installing_project: 84,
  typechecking_project: 88,
  rendering_smoke_preview: 92,
  verifying_visual_quality: 94,
  publishing_video_project: 96,
  ready: 100,
  failed: 100,
};

const STAGE_PROGRESS = VIDEO_PRESENTATION_STAGE_PROGRESS;

/**
 * The pipeline stage table's words. Nothing outside this file re-types them:
 * the capability's stage-label module resolves every user-facing stage name
 * through here, so a stage cannot read one way in the pipeline panel and
 * another way in the message trace.
 *
 * These words are persisted into `pipelineSteps.label`, so they are the source
 * a rendering path adopts rather than the one it overrides — rewording here
 * leaves older rows saying something else, forever.
 */
export function getVideoPresentationPipelineStepLabel(
  stageId: VideoPresentationPipelineStageId,
) {
  switch (stageId) {
    case "planning_storyboard":
      return "Planning storyboard";
    case "materializing_assets":
      return "Preparing visual assets";
    case "generating_audio_tracks":
      return "Generating narration audio";
    case "assigning_slide_themes":
      return "Assigning slide themes";
    case "generating_scene_modules":
      return "Generating Remotion scene code";
    case "repairing_scene_modules":
      return "Repairing scene code";
    case "installing_project":
      return "Installing project dependencies";
    case "typechecking_project":
      return "Typechecking project";
    case "rendering_smoke_preview":
      return "Rendering smoke preview";
    case "verifying_visual_quality":
      return "Reviewing rendered slides";
    case "publishing_video_project":
      return "Publishing video project";
  }
}

export function buildInitialVideoPresentationPipelineSteps(): VideoPresentationPipelineStep[] {
  return VIDEO_PRESENTATION_PIPELINE_STAGE_IDS.map((id) => ({
    id,
    label: getVideoPresentationPipelineStepLabel(id),
    status: "pending" as const,
  }));
}

export function resolveVideoPresentationPipelineStageProgress(
  stageId: VideoPresentationPipelineStageId,
) {
  return STAGE_PROGRESS[stageId];
}

export function computeVideoPresentationOverallProgress(
  steps: readonly VideoPresentationPipelineStep[],
) {
  if (steps.length === 0) {
    return 0;
  }
  const completed = steps.filter((step) => step.status === "completed").length;
  const running = steps.find((step) => step.status === "running");
  if (running) {
    const base = resolveVideoPresentationPipelineStageProgress(running.id);
    const runningContribution =
      typeof running.progress === "number" ? (running.progress / 100) * 8 : 4;
    return Math.min(99, Math.round(base + runningContribution));
  }
  if (steps.every((step) => step.status === "completed")) {
    return 100;
  }
  void completed;
  const lastCompleted = [...steps]
    .reverse()
    .find((step) => step.status === "completed");
  return lastCompleted
    ? resolveVideoPresentationPipelineStageProgress(lastCompleted.id)
    : 0;
}

export function normalizeWorkerStageToPipelineStage(
  stage: string,
): VideoPresentationPipelineStageId | null {
  if (stage === "generating_project_code") {
    return "planning_storyboard";
  }
  return VIDEO_PRESENTATION_PIPELINE_STAGE_IDS.includes(
    stage as VideoPresentationPipelineStageId,
  )
    ? (stage as VideoPresentationPipelineStageId)
    : null;
}

export function isPipelineStageCompleted(
  checkpointStage: VideoPresentationPipelineStageId | undefined,
  stageId: VideoPresentationPipelineStageId,
) {
  if (!checkpointStage) {
    return false;
  }
  const checkpointIndex =
    VIDEO_PRESENTATION_PIPELINE_STAGE_IDS.indexOf(checkpointStage);
  const stageIndex = VIDEO_PRESENTATION_PIPELINE_STAGE_IDS.indexOf(stageId);
  return checkpointIndex >= stageIndex;
}
