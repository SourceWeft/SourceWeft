import { defineAgentTool } from "../define";

export const searchSourcesTool = defineAgentTool({
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
});

export const retrievalTools = [searchSourcesTool] as const;
