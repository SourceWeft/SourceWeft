import { htmlVisualReviewTurnPreflight } from "./html/visual-preflight";
import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { publishArtifactPresentation } from "./presentation";

export const publishArtifactAgentTool = defineAgentTool({
  id: "publishArtifact",
  name: "publish_artifact",
  domain: "artifact",
  capabilities: ["artifact", "workfile_write", "presentation_artifact"],
  presentation: publishArtifactPresentation,
  activation: {
    default: "always",
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

export const PUBLISH_ARTIFACT_TOOL_NAME = publishArtifactAgentTool.name;

export const reviewHtmlVisualsAgentTool = defineAgentTool({
  id: "reviewHtmlVisuals",
  name: "review_html_visuals",
  domain: "artifact",
  capabilities: ["artifact"],
  requirements: { modelKind: "vision", sandbox: true },
  activation: {
    default: "off",
    userControl: "none",
    skill: { declarable: true, activates: true },
  },
  defaultPermission: "allow",
  riskLevel: "low",
  executionTimeoutMs: 5 * 60_000,
  turnPreflight: htmlVisualReviewTurnPreflight,
});

export const publishArtifactAgentToolDefs = [
  reviewHtmlVisualsAgentTool,
  publishArtifactAgentTool,
] as const;
