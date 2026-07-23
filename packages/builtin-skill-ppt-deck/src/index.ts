export const builtinPptDeckCapability = {
  id: "sourceweft/ppt-deck",
} as const;

export {
  pptDeckAgentToolDefs,
  reviewDeckVisualsAgentTool,
  REVIEW_DECK_VISUALS_TOOL_NAME,
} from "./agent-tool-defs";
export { createCapabilityAgentTools } from "./agent-tools";
export {
  DECK_VISUAL_QA_ISSUE_TYPES,
  aggregateDeckFindings,
  buildDeckVisualQaJudgePrompt,
  parseDeckVisualQaVerdicts,
  summarizeDeckVerdicts,
} from "./visual-qa";
