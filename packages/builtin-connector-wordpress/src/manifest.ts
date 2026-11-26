import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { wordpressConnectorContribution } from "./contribution";
import { wordpressLoginConnectorContribution } from "./login-contribution";

export const builtinWordPressConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/wordpress",
  kind: "connector",
  name: "WordPress Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  // One package capability, two connector contributions sharing the WordPress
  // REST machinery (the capability model declares connectors as a list).
  connectors: [
    wordpressConnectorContribution,
    wordpressLoginConnectorContribution,
  ],
} as const satisfies CapabilityManifestInput;
