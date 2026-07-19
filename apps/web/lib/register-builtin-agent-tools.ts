import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import { notionAgentToolDefs } from "@sourceweft/builtin-connector-notion";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { GENERATE_VIDEO_PRESENTATION_TOOL_NAME } from "@sourceweft/contracts/agent-tools";

/**
 * Keep the web registry in sync with backend-visible builtin tools that the
 * chat UI needs for capability checks (progress, composer locking, labels).
 */
const generateVideoPresentationAgentTool = defineAgentTool({
  id: "generateVideoPresentation",
  name: GENERATE_VIDEO_PRESENTATION_TOOL_NAME,
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
});

let registered = false;

export function registerBuiltinAgentTools() {
  if (registered) {
    return;
  }
  registerAgentTools([
    ...notionAgentToolDefs,
    generateVideoPresentationAgentTool,
  ]);
  registered = true;
}
