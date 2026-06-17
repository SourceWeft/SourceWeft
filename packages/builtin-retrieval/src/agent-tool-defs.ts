import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

export const searchSourcesAgentTool = defineAgentTool({
  id: "searchSources",
  name: "search_sources",
  domain: "retrieval",
  capabilities: ["retrieval", "citable_source", "oversized_current_turn"],
  activation: {
    default: "always",
    userControl: "none",
    skill: {
      declarable: false,
      activates: false,
    },
  },
  defaultPermission: "allow",
  riskLevel: "low",
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const SEARCH_SOURCES_TOOL_NAME = searchSourcesAgentTool.name;

export const retrievalAgentToolDefs = [searchSourcesAgentTool] as const;
