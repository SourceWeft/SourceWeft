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
  // A Linear mark can replace this once the artwork is in the repository;
  // `apps/web/public/icons/tool.svg` ships today, a Linear icon does not.
  slash: { iconName: "tool", iconTone: "mono", supportsCommand: true },
} as const;

export const linearAgentToolDefs = [
  defineAgentTool({
    ...common,
    id: "searchLinearIssues",
    name: "search_linear_issues",
    capabilities: ["connector", "linear", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Search Linear",
      description: "Search Linear issues in the selected teams and projects",
    },
  }),
  defineAgentTool({
    ...common,
    id: "readLinearIssue",
    name: "read_linear_issue",
    capabilities: ["connector", "linear", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Read Linear issue",
      description: "Read a selected Linear issue",
    },
  }),
  defineAgentTool({
    ...common,
    id: "listLinearProjects",
    name: "list_linear_projects",
    capabilities: ["connector", "linear", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "List Linear projects",
      description: "List Linear projects in the selected teams and projects",
    },
  }),
];
