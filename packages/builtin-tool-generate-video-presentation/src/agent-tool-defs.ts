import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

export const generateVideoPresentationAgentTool = defineAgentTool({
  id: "generateVideoPresentation",
  name: "generate_video_presentation",
  domain: "artifact",
  capabilities: ["artifact", "workfile_write", "video_presentation_artifact"],
  requirements: {
    modelKind: "tts",
  },
  activation: {
    default: "off",
    userControl: "enable-disable",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  configuration: {
    configurable: true,
    configKeys: ["narrationEnabled"],
  },
  defaultPermission: "ask",
  riskLevel: "medium",
  slash: {
    description: "Generate a narrated video presentation",
    displayName: "Generate video presentation",
    iconName: "video-presentation",
    supportsCommand: true,
  },
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const GENERATE_VIDEO_PRESENTATION_TOOL_NAME = generateVideoPresentationAgentTool.name;

export const generateVideoPresentationAgentToolDefs = [
  generateVideoPresentationAgentTool,
] as const;
