import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { videoPresentationArtifactProtocol } from "./artifact-protocol";
import { videoPresentationPresentation } from "./presentation";

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
    configKeys: [
      "canvas",
      "durationTarget",
      "language",
      "motion",
      "narrationEnabled",
      "renderProfile",
      "slideCount",
      "stylePreset",
      "visualDirection",
    ],
  },
  defaultPermission: "ask",
  riskLevel: "medium",
  artifactProgress: videoPresentationArtifactProtocol,
  presentation: videoPresentationPresentation,
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const GENERATE_VIDEO_PRESENTATION_TOOL_NAME = generateVideoPresentationAgentTool.name;

export const generateVideoPresentationAgentToolDefs = [
  generateVideoPresentationAgentTool,
] as const;
