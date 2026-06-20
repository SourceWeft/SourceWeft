import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

export const generateImageAgentTool = defineAgentTool({
  id: "generateImage",
  name: "generate_image",
  domain: "artifact",
  capabilities: ["artifact", "generated_image_artifact"],
  requirements: {
    modelKind: "image",
  },
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  configuration: {
    configurable: true,
    configKeys: ["aspectRatio", "quality", "style"],
  },
  defaultPermission: "allow",
  riskLevel: "low",
  slash: {
    description:
      "Internal SourceWeft image artifact generator. It is callable only when an image skill runtime or compatibility command explicitly enables it.",
    displayName: "Generate image",
    iconName: "image",
    supportsCommand: true,
  },
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const GENERATE_IMAGE_TOOL_NAME = generateImageAgentTool.name;

export const generateImageAgentToolDefs = [generateImageAgentTool] as const;
