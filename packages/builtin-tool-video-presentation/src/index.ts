export { generateVideoPresentationAgentTool, generateVideoPresentationAgentToolDefs } from "./agent-tool-defs";

export const builtinGenerateVideoPresentationCapability = {
  id: "sourceweft/video-presentation-tool",
} as const;

export { createCapabilityAgentTools } from "./agent-tools";
export { builtinGenerateVideoPresentationCapabilityManifest } from "./manifest";
export { buildArtifactAssetUrl, buildArtifactPreviewUrl } from "./artifact-urls";
export { buildVideoPresentationInitialPayload } from "./video-presentation-payload";
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
