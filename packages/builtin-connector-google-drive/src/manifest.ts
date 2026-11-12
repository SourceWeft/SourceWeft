import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { googleDriveConnectorContribution } from "./contribution";

export const builtinGoogleDriveConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/google-drive",
  kind: "connector",
  name: "Google Drive Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [googleDriveConnectorContribution],
} as const satisfies CapabilityManifestInput;
