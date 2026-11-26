import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { discourseConnectorContribution } from "./contribution";

export const builtinDiscourseConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/discourse",
  kind: "connector",
  name: "Discourse Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [discourseConnectorContribution],
} as const satisfies CapabilityManifestInput;
