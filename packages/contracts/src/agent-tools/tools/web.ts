import { defineAgentTool } from "../define";

export const webFetchTool = defineAgentTool({
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

export const webSearchTool = defineAgentTool({
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

export const webTools = [webFetchTool, webSearchTool] as const;
