/**
 * Video-presentation pipeline stage catalog.
 * Owns labels/order/weights for this builtin tool; wire shape lives in contracts.
 */
export {
  VIDEO_PRESENTATION_PIPELINE_STAGE_IDS,
  buildInitialVideoPresentationPipelineSteps,
  computeVideoPresentationOverallProgress,
  getVideoPresentationPipelineStepLabel,
  resolveVideoPresentationPipelineStageProgress,
  videoPresentationPipelineStageIdSchema,
  videoPresentationPipelineStepSchema,
  videoPresentationPipelineStepStatusSchema,
  type VideoPresentationPipelineStageId,
  type VideoPresentationPipelineStep,
  type VideoPresentationPipelineStepStatus,
} from "@sourceweft/contracts/video-presentation";
