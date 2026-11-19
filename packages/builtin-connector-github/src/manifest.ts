import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { githubConnectorContribution } from "./contribution";

export const builtinGithubConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/github",
  kind: "connector",
  name: "GitHub Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [githubConnectorContribution],
} as const satisfies CapabilityManifestInput;
