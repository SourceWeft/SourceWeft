import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { zoteroConnectorContribution } from "./contribution";

export const builtinZoteroConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/zotero",
  kind: "connector",
  name: "Zotero Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [zoteroConnectorContribution],
} as const satisfies CapabilityManifestInput;
