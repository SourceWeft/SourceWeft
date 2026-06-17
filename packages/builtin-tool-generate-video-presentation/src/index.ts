export { generateVideoPresentationAgentTool, generateVideoPresentationAgentToolDefs } from "./agent-tool-defs";

export const builtinGenerateVideoPresentationCapability = {
  id: "sourceweft/generate-video-presentation",
} as const;

export { createCapabilityAgentTools } from "./agent-tools";
export { builtinGenerateVideoPresentationCapabilityManifest } from "./manifest";
export { buildArtifactAssetUrl, buildArtifactPreviewUrl } from "./artifact-urls";
export { buildVideoPresentationInitialPayload } from "./video-presentation-payload";
export {
  buildVideoPresentationProjectFileName,
  compactVideoPresentationSourceText,
  sanitizeVideoPresentationFileBase,
  stripVideoPresentationMarkdown,
} from "./video-presentation-files";
export {
  compactVideoPresentationText,
  estimateNarrationDurationSeconds,
  getAudioTrackForSlide,
  getSlideDurationInFrames,
  getSlideDurationSeconds,
  getVideoDurationInFrames,
  getVideoDurationSeconds,
  stripRenderOnlyAudioFields,
} from "./video-presentation-render-spec";
export { buildVideoPresentationRequestKey } from "./video-presentation-request";
export { buildVideoPresentationRuntimePromptLines } from "./video-presentation-prompts";
export { buildVideoPresentationToolResult } from "./video-presentation-result";
export {
  generateVideoPresentationSchema,
  parseGenerateVideoPresentationArgs,
} from "./video-presentation-schema";
export type { GenerateVideoPresentationArgs } from "./video-presentation-schema";
export type { VideoPresentationSelection } from "./video-presentation-prompts";
export type {
  RenderableVideoPresentationAudioTrack,
  RenderableVideoPresentationSpec,
} from "./video-presentation-render-spec";
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
