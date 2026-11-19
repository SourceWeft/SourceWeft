import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { jiraConnectorContribution } from "./contribution";

export const builtinJiraConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/jira",
  kind: "connector",
  name: "Jira Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [jiraConnectorContribution],
} as const satisfies CapabilityManifestInput;
