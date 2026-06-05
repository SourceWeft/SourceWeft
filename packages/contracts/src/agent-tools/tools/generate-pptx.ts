import { defineAgentTool } from "../define";

export const generatePptxTool = defineAgentTool({
  id: "generatePptx",
  name: "generate_pptx",
  domain: "artifact",
  capabilities: ["artifact", "workfile_write", "presentation_artifact"],
  activation: {
    default: "always",
    userControl: "enable-disable",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  configuration: {
    configurable: true,
    configKeys: [
      "aspectRatio",
      "customBrief",
      "includeSourceJson",
      "language",
      "preferHtmlTables",
      "stylePreset",
      "visualSystem",
    ],
  },
  defaultPermission: "ask",
  riskLevel: "medium",
  slash: {
    description: "Generate an editable PowerPoint PPTX deck",
    displayName: "Generate PPTX",
    iconName: "presentation",
    supportsCommand: true,
  },
});

export const presentationTools = [generatePptxTool] as const;
