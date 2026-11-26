import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { webDavConnectorContribution } from "./contribution";
import { nextcloudConnectorContribution } from "./nextcloud/contribution";

export const builtinWebDavConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/webdav",
  kind: "connector",
  name: "WebDAV Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  // One package capability, two connector contributions sharing all of the
  // WebDAV machinery (the capability model declares connectors as a list).
  connectors: [webDavConnectorContribution, nextcloudConnectorContribution],
} as const satisfies CapabilityManifestInput;
