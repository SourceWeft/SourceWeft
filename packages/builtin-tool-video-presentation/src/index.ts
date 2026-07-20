import {
  basicSceneCheck,
  buildSceneUserPrompt,
  extractSceneCodeAndTitle,
} from "./pipeline/scene-gen";
import { narrationBudgetIssues, planVideoProject } from "./pipeline/storyboard";

export { generateVideoPresentationAgentTool, generateVideoPresentationAgentToolDefs } from "./agent-tool-defs";

export const builtinGenerateVideoPresentationCapability = {
  id: "sourceweft/video-presentation-tool",
} as const;

export { createCapabilityAgentTools } from "./agent-tools";
export {
  createArtifactViewHandlers,
  videoPresentationArtifactViewHandler,
  VIDEO_PRESENTATION_ARTIFACT_TYPE,
} from "./artifact-view";
export {
  videoPresentationReusableArtifactQuery,
  VIDEO_PRESENTATION_PIPELINE_JOB_NAME,
  VIDEO_PRESENTATION_REUSABLE_STATUSES,
} from "./artifact-records";
export {
  normalizeGenerateVideoPresentationToolSelection,
  type GenerateVideoPresentationToolSelection,
} from "./tool-selection";
export { builtinGenerateVideoPresentationCapabilityManifest } from "./manifest";
export { buildArtifactAssetUrl, buildArtifactPreviewUrl } from "./artifact-urls";
export { buildVideoPresentationInitialPayload } from "./video-presentation-payload";
export {
  buildVideoPresentationStageView,
  type VideoPresentationStageView,
} from "./pipeline-digests";
export {
  lintSceneLayout,
  type SceneLayoutLintResult,
} from "./scene-lint";
export {
  VIDEO_PRESENTATION_THEME_DESCRIPTIONS,
  VIDEO_PRESENTATION_THEME_PRESETS,
  type VideoPresentationThemePreset,
} from "./theme-presets";
export {
  buildVisualQaJudgePrompt,
  parseVisualQaVerdicts,
  visualQaVerdictsSchema,
  type VisualQaSlideVerdict,
} from "./visual-qa";
export {
  VIDEO_PRESENTATION_PIPELINE_STAGE_IDS,
  buildInitialVideoPresentationPipelineSteps,
  computeVideoPresentationOverallProgress,
  getVideoPresentationPipelineStepLabel,
  isPipelineStageCompleted,
  normalizeWorkerStageToPipelineStage,
  resolveVideoPresentationPipelineStageProgress,
  type VideoPresentationPipelineStageId,
  type VideoPresentationPipelineStep,
} from "./pipeline-stages";
export {
  VIDEO_PRESENTATION_LABELLED_STAGE_IDS,
  getVideoPresentationStageLabel,
} from "./stage-labels";
export {
  buildVideoPresentationProjectFileName,
  sanitizeVideoPresentationFileBase,
  stripVideoPresentationMarkdown,
} from "./video-presentation-files";
export { buildVideoPresentationRequestKey } from "./video-presentation-request";
export { buildVideoPresentationRuntimePromptLines } from "./video-presentation-prompts";
export {
  buildVideoPresentationInputRequiredResult,
  buildVideoPresentationProcessingResult,
  buildVideoPresentationToolResult,
} from "./video-presentation-result";
export {
  generateVideoPresentationSchema,
  parseGenerateVideoPresentationArgs,
} from "./video-presentation-schema";
export type { GenerateVideoPresentationArgs } from "./video-presentation-schema";
export type { VideoPresentationSelection } from "./video-presentation-prompts";
export type { VideoPresentationStatus } from "./video-presentation-result";
export {
  createGenerateVideoPresentationTool,
  GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE,
  videoPresentationRuntimePromptProvider,
  buildVideoPresentationRuntimePromptLines as buildVideoPresentationAgentRuntimePromptLines,
  looksLikeVideoPresentationSpecText,
  type VideoPresentationToolContext,
  type VideoPresentationToolRuntimeDeps,
} from "./tool-runtime";
export {
  createDeliverablePipelines,
  createVideoPresentationPipelineDefinition,
} from "./pipeline/definition";
export { createVideoPipelineDeps, type VideoPipelineDeps } from "./pipeline/deps";

/** Mirrors the backend worker's testExports for the moved pipeline core. */
export const videoPipelineTestExports = {
  basicSceneCheck,
  buildSceneUserPrompt,
  extractSceneCodeAndTitle,
  narrationBudgetIssues,
  planVideoProject,
};
