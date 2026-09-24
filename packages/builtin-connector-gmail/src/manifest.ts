import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { gmailConnectorContribution } from "./contribution";

export const builtinGmailConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/gmail",
  kind: "connector",
  name: "Gmail Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [gmailConnectorContribution],
} as const satisfies CapabilityManifestInput;
