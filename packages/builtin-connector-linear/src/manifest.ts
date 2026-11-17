import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { linearConnectorContribution } from "./contribution";

export const builtinLinearConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/linear",
  kind: "connector",
  name: "Linear Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [linearConnectorContribution],
} as const satisfies CapabilityManifestInput;
