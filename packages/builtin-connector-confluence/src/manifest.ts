import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { confluenceConnectorContribution } from "./contribution";

export const builtinConfluenceConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/confluence",
  kind: "connector",
  name: "Confluence Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [confluenceConnectorContribution],
} as const satisfies CapabilityManifestInput;
