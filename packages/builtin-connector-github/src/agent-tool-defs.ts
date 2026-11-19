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
  slash: { iconName: "github", iconTone: "mono", supportsCommand: true },
} as const;

export const githubAgentToolDefs = [
  defineAgentTool({
    ...common,
    id: "searchGithub",
    name: "search_github",
    capabilities: ["connector", "github", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Search GitHub",
      description:
        "Search issues, pull requests, and discussions in the connected repositories",
    },
  }),
  defineAgentTool({
    ...common,
    id: "readGithubItem",
    name: "read_github_item",
    capabilities: ["connector", "github", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "Read GitHub item",
      description: "Read a selected GitHub issue, pull request, or discussion",
    },
  }),
  defineAgentTool({
    ...common,
    id: "listGithubRepositories",
    name: "list_github_repositories",
    capabilities: ["connector", "github", "connector_read"],
    defaultPermission: "allow",
    riskLevel: "low",
    slash: {
      ...common.slash,
      displayName: "List GitHub repositories",
      description: "List the repositories chosen for this connector",
    },
  }),
];
