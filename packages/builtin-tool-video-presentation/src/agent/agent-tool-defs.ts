import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { createVideoModelTurnPreflight } from "./preflight";
import {
  GENERATE_VIDEO_ASSETS_TOOL_NAME,
  GENERATE_VIDEO_NARRATION_TOOL_NAME,
  LOAD_VIDEO_PRESENTATION_TOOL_NAME,
  PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
  VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
} from "./tool-names";

export {
  GENERATE_VIDEO_ASSETS_TOOL_NAME,
  GENERATE_VIDEO_NARRATION_TOOL_NAME,
  LOAD_VIDEO_PRESENTATION_TOOL_NAME,
  PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
  VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
} from "./tool-names";

const activation = {
  default: "off" as const,
  userControl: "none" as const,
  skill: { declarable: true, activates: true },
};

export const loadVideoPresentationAgentTool = defineAgentTool({
  id: "loadVideoPresentation",
  name: LOAD_VIDEO_PRESENTATION_TOOL_NAME,
  domain: "artifact",
  capabilities: ["artifact", "filesystem", "sandbox_file_transfer"],
  activation,
  defaultPermission: "allow",
  executionScope: "root_only",
  riskLevel: "low",
});

export const generateVideoAssetsAgentTool = defineAgentTool({
  id: "generateVideoAssets",
  name: GENERATE_VIDEO_ASSETS_TOOL_NAME,
  domain: "artifact",
  capabilities: ["filesystem", "sandbox_file_transfer"],
  requirements: { modelKind: "image" },
  activation,
  defaultPermission: "allow",
  executionTimeoutMs: 5 * 60_000,
  executionScope: "root_only",
  riskLevel: "medium",
  turnPreflight: createVideoModelTurnPreflight({ required: false }),
});

export const generateVideoNarrationAgentTool = defineAgentTool({
  id: "generateVideoNarration",
  name: GENERATE_VIDEO_NARRATION_TOOL_NAME,
  domain: "artifact",
  capabilities: ["filesystem", "sandbox_file_transfer"],
  requirements: { modelKind: "tts" },
  activation,
  defaultPermission: "allow",
  executionTimeoutMs: 5 * 60_000,
  executionScope: "root_only",
  riskLevel: "medium",
  turnPreflight: createVideoModelTurnPreflight({ required: false }),
});

export const validateVideoPresentationAgentTool = defineAgentTool({
  id: "validateVideoPresentation",
  name: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
  domain: "artifact",
  capabilities: ["filesystem", "sandbox_execute", "sandbox_file_transfer"],
  requirements: { modelKind: "vision" },
  activation,
  defaultPermission: "allow",
  executionTimeoutMs: 10 * 60_000,
  executionScope: "root_only",
  sandboxRuntimeAssets: ["chrome-headless-shell"],
  riskLevel: "medium",
  turnPreflight: createVideoModelTurnPreflight({ required: false }),
});

export const publishVideoPresentationAgentTool = defineAgentTool({
  id: "publishVideoPresentation",
  name: PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
  domain: "artifact",
  capabilities: ["artifact", "filesystem", "video_presentation_artifact"],
  activation,
  defaultPermission: "allow",
  executionScope: "root_only",
  riskLevel: "medium",
  terminalResult: {
    kind: "committed_artifact",
    artifactType: "video_presentation",
  },
});

export const videoPresentationAgentToolDefs = [
  loadVideoPresentationAgentTool,
  generateVideoAssetsAgentTool,
  generateVideoNarrationAgentTool,
  validateVideoPresentationAgentTool,
  publishVideoPresentationAgentTool,
] as const;
