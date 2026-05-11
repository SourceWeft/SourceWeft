import { defineAgentTool } from "../define";

export const generateImageTool = defineAgentTool({
  id: "generateImage",
  name: "generate_image",
  domain: "artifact",
  capabilities: ["artifact", "generated_image_artifact"],
  requirements: {
    modelKind: "image",
  },
  activation: {
    default: "always",
    userControl: "disable",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  configuration: {
    configurable: true,
    configKeys: ["aspectRatio", "quality", "style"],
  },
});

export const artifactTools = [generateImageTool] as const;
