import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { dropboxConnectorContribution } from "./contribution";

export const builtinDropboxConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/dropbox",
  kind: "connector",
  name: "Dropbox Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [dropboxConnectorContribution],
} as const satisfies CapabilityManifestInput;
