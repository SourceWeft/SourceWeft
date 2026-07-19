import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { publishArtifactPresentation } from "./presentation";

export const publishArtifactAgentTool = defineAgentTool({
  id: "publishArtifact",
  name: "publish_artifact",
  domain: "artifact",
  capabilities: ["artifact", "workfile_write", "presentation_artifact"],
  presentation: publishArtifactPresentation,
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: false,
      activates: false,
    },
  },
  defaultPermission: "ask",
  riskLevel: "medium",
  slash: {
    description: "Publish an existing file artifact",
    displayName: "Publish Artifact",
    enabled: false,
    iconName: "upload",
    supportsCommand: false,
  },
});

export const PUBLISH_ARTIFACT_TOOL_NAME =
  publishArtifactAgentTool.name;

export const publishArtifactAgentToolDefs = [
  publishArtifactAgentTool,
] as const;
