import type { CapabilityManifestInput } from "@sourceweft/capability-contracts";
import { rssConnectorContribution } from "./contribution";

export const builtinRssConnectorCapabilityManifest = {
  schemaVersion: 1,
  id: "sourceweft/rss",
  kind: "connector",
  name: "RSS / Atom Connector",
  version: "0.1.0",
  entry: "./src/index.ts",
  connectors: [rssConnectorContribution],
} as const satisfies CapabilityManifestInput;
