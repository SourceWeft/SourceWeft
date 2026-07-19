import {
  VIDEO_PRESENTATION_PIPELINE_STAGE_IDS,
  getVideoPresentationPipelineStepLabel,
  type VideoPresentationPipelineStageId,
} from "@sourceweft/contracts/video-presentation";

export const VIDEO_PIPELINE_STAGE_BUDGETS: Record<
  VideoPresentationPipelineStageId,
  { budgetMs: number; maxAttempts: number }
> = {
  planning_storyboard: { budgetMs: 4 * 60_000, maxAttempts: 2 },
  materializing_assets: { budgetMs: 2 * 60_000, maxAttempts: 2 },
  generating_audio_tracks: { budgetMs: 5 * 60_000, maxAttempts: 2 },
  assigning_slide_themes: { budgetMs: 3 * 60_000, maxAttempts: 2 },
  generating_scene_modules: { budgetMs: 8 * 60_000, maxAttempts: 2 },
  repairing_scene_modules: { budgetMs: 6 * 60_000, maxAttempts: 2 },
  installing_project: { budgetMs: 8 * 60_000, maxAttempts: 2 },
  typechecking_project: { budgetMs: 8 * 60_000, maxAttempts: 2 },
  rendering_smoke_preview: { budgetMs: 8 * 60_000, maxAttempts: 2 },
  verifying_visual_quality: { budgetMs: 5 * 60_000, maxAttempts: 1 },
  publishing_video_project: { budgetMs: 60_000, maxAttempts: 1 },
};

export const videoPipelineStages = VIDEO_PRESENTATION_PIPELINE_STAGE_IDS.map(
  (id) => ({
    id,
    label: getVideoPresentationPipelineStepLabel(id),
    ...VIDEO_PIPELINE_STAGE_BUDGETS[id],
  }),
);
