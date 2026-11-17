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
  slash: { iconName: "jira", iconTone: "brand", supportsCommand: true },
} as const;

export const jiraAgentToolDefs = [
  defineAgentTool({
    ...common,
    id: "searchJiraIssues",
    name: "search_jira_issues",
    capabilities: ["connector", "jira", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Search Jira",
      description: "Search Jira issues in the connected projects",
    },
  }),
  defineAgentTool({
    ...common,
    id: "readJiraIssue",
    name: "read_jira_issue",
    capabilities: ["connector", "jira", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Read Jira issue",
      description: "Read a selected Jira issue",
    },
  }),
  defineAgentTool({
    ...common,
    id: "listJiraProjects",
    name: "list_jira_projects",
    capabilities: ["connector", "jira", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "List Jira projects",
      description: "List the connected Jira projects",
    },
  }),
];
