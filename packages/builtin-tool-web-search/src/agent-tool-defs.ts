import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

export const webFetchAgentTool = defineAgentTool({
  id: "webFetch",
  name: "web_fetch",
  domain: "web",
  capabilities: ["web", "web_page_fetch", "oversized_current_turn"],
  requirements: {
    provider: "web",
  },
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

export const webSearchAgentTool = defineAgentTool({
  id: "webSearch",
  name: "web_search",
  domain: "web",
  capabilities: ["web", "web_query", "oversized_current_turn"],
  requirements: {
    provider: "web",
  },
  activation: {
    default: "off",
    userControl: "enable-disable",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  defaultPermission: "allow",
  riskLevel: "low",
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const WEB_FETCH_TOOL_NAME = webFetchAgentTool.name;
export const WEB_SEARCH_TOOL_NAME = webSearchAgentTool.name;

export const webAgentToolDefs = [webFetchAgentTool, webSearchAgentTool] as const;
