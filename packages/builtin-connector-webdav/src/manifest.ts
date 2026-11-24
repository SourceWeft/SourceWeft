import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { webDavConnectorContribution } from "./contribution";

export const builtinWebDavConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/webdav",
  kind: "connector",
  name: "WebDAV Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [webDavConnectorContribution],
} as const satisfies CapabilityManifestInput;
