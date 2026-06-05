import { defineAgentTool } from "../define";

export const generateVideoPresentationTool = defineAgentTool({
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

export const videoPresentationTools = [generateVideoPresentationTool] as const;
