export { githubAgentToolDefs } from "./agent-tool-defs";
export {
  githubConnectorContribution,
  GITHUB_NODE_ID_PATTERN,
  GITHUB_INSTALLATION_CONTAINER_PATTERN,
  GITHUB_MAX_SELECTED_REPOSITORIES,
  GITHUB_REPOSITORY_NAME_PATTERN,
} from "./contribution";
export { builtinGithubConnectorCapabilityManifest } from "./manifest";
export { toBackendGithubManifest } from "./backend-manifest";
export { createGithubConnectorAdapter } from "./adapter";
export type { GithubAdapterConfig } from "./adapter";
export { GithubAdapterError } from "./errors";
export { createConnectorAdapters } from "./host-services";
