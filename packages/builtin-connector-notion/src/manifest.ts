import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { notionConnectorContribution } from "./contribution";

export { notionConnectorContribution } from "./contribution";

export const builtinNotionConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/notion",
  kind: "connector",
  name: "Notion Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [notionConnectorContribution],
} as const satisfies CapabilityManifestInput;

export const builtinNotionConnectorCapability = {
  id: builtinNotionConnectorCapabilityManifest.id,
} as const;
