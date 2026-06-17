export { generateImageAgentTool, generateImageAgentToolDefs } from "./agent-tool-defs";

export const builtinGenerateImageCapability = {
  id: "sourceweft/generate-image",
} as const;

export { createCapabilityAgentTools } from "./agent-tools";
export { builtinGenerateImageCapabilityManifest } from "./manifest";
export { buildArtifactPreviewUrl } from "./artifact-urls";
export { compactArtifactText } from "./artifact-text";
export {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  GENERATE_IMAGE_TOOL_ID,
} from "./image-types";
export {
  generateImageToolOptions,
} from "./options";
export {
  mergeImageArtifactConfig,
  normalizeArtifactImageConfig,
  normalizeArtifactToolSelection,
  normalizeGenerateImageToolSelection,
  normalizePartialArtifactImageConfig,
} from "./image-config";
export { resolveImageModelCapabilities } from "./image-capabilities";
export {
  resolveGenerateImageIntentDecision,
  type GenerateImageEnabledSkillDescriptor,
  type GenerateImageIntentDecisionInput,
  type GenerateImageIntentDecisionResult,
  type GenerateImageProfileRequest,
  type ResolvedGenerateImageProfile,
} from "./intent";
export type {
  ArtifactGenerationKind,
  ArtifactImageConfig,
  ArtifactIntentDecision,
  ArtifactToolSelection,
  GenerateImageToolSelection,
  ImageAspectRatio,
  ImageModelCapabilities,
  ImageQuality,
  ImageStyle,
  ImageToolOption,
} from "./image-types";
export {
  buildImageRuntimePromptLines,
  buildImageToolResult,
  generateImageSchema,
  sanitizeImageArtifactFileBase,
} from "./image-tools";
export type { ArtifactImageConfigLike } from "./image-tools";
export {
  createGenerateImageTool,
  GENERATED_IMAGE_PROGRESS_EVENT_TYPE,
  imageRuntimePromptProvider,
  buildImageRuntimePromptLines as buildImageAgentRuntimePromptLines,
  type ImageToolContext,
  type ImageToolRuntimeDeps,
  type ImageToolModelGateway,
  type ImageToolStorage,
  type ImageToolArtifacts,
  type ImageToolBilling,
} from "./tool-runtime";
