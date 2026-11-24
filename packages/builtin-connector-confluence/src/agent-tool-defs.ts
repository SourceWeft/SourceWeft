import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

const activation = {
  default: "off",
  userControl: "enable-disable",
  skill: { declarable: true, activates: true },
} as const;
const configuration = {
  configurable: true,
  configKeys: ["connectorId"],
} as const;
const common = {
  domain: "connector",
  activation,
  configuration,
  // No Atlassian artwork is in the repo, so these fall back to the generic
  // tool icon.
  slash: { iconName: "tool", iconTone: "mono", supportsCommand: true },
} as const;

export const confluenceAgentToolDefs = [
  defineAgentTool({
    ...common,
    id: "searchConfluence",
    name: "search_confluence",
    capabilities: ["connector", "confluence", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Search Confluence",
      description: "Search Confluence pages in the connected spaces and pages",
    },
  }),
  defineAgentTool({
    ...common,
    id: "readConfluencePage",
    name: "read_confluence_page",
    capabilities: ["connector", "confluence", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Read Confluence page",
      description: "Read a selected Confluence page",
    },
  }),
  defineAgentTool({
    ...common,
    id: "listConfluenceSpaces",
    name: "list_confluence_spaces",
    capabilities: ["connector", "confluence", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "List Confluence spaces",
      description: "List the connected Confluence spaces",
    },
  }),
];
