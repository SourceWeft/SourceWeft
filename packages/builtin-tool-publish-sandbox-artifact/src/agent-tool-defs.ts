import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

export const publishSandboxArtifactAgentTool = defineAgentTool({
  id: "publishSandboxArtifact",
  name: "publish_sandbox_artifact",
  domain: "artifact",
  capabilities: ["artifact", "workfile_write", "presentation_artifact"],
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
    description: "Publish a sandbox-generated artifact",
    displayName: "Publish Sandbox Artifact",
    enabled: false,
    iconName: "upload",
    supportsCommand: false,
  },
});

export const PUBLISH_SANDBOX_ARTIFACT_TOOL_NAME =
  publishSandboxArtifactAgentTool.name;

export const publishSandboxArtifactAgentToolDefs = [
  publishSandboxArtifactAgentTool,
] as const;
