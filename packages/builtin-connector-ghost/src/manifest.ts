import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { ghostConnectorContribution } from "./contribution";

export const builtinGhostConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/ghost",
  kind: "connector",
  name: "Ghost Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [ghostConnectorContribution],
} as const satisfies CapabilityManifestInput;
