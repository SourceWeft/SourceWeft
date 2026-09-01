import { defineAgentTool } from "@sourceweft/contracts/agent-tools";
import { reviewDeckVisualsTurnPreflight } from "./turn-preflight";

/**
 * Judges rendered slide images with the workspace's default vision model.
 *
 * This exists because the driving chat model cannot be trusted with visual QA:
 * it may have no vision at all, and the sandbox `read_file` tool refuses
 * binary files by design. The verdicts always come from the configured vision
 * profile, so QA results do not change when the user switches chat models.
 */
export const reviewDeckVisualsAgentTool = defineAgentTool({
  id: "reviewDeckVisuals",
  name: "review_deck_visuals",
  domain: "artifact",
  capabilities: ["artifact"],
  requirements: { modelKind: "vision" },
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  defaultPermission: "allow",
  executionTimeoutMs: 5 * 60_000,
  riskLevel: "low",
  turnPreflight: reviewDeckVisualsTurnPreflight,
});

export const REVIEW_DECK_VISUALS_TOOL_NAME = reviewDeckVisualsAgentTool.name;

export const pptDeckAgentToolDefs = [reviewDeckVisualsAgentTool] as const;
