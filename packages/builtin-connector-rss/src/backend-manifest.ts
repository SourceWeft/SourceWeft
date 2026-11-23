import type { ConnectorManifest } from "@sourceweft/contracts/connectors";
import { rssConnectorContribution } from "./contribution";

export function toBackendRssManifest(): ConnectorManifest {
  const contribution = rssConnectorContribution;
  return {
    type: contribution.id,
    displayName: contribution.title,
    auth: { kind: "none" },
    sync: {
      supportsIncremental: contribution.sync.supportsIncremental,
      defaultFrequencyMinutes: contribution.sync.defaultFrequencyMinutes,
      minFrequencyMinutes: contribution.sync.minFrequencyMinutes,
      resources: contribution.sync.resources.map((resource) => ({
        type: resource.type,
        displayName: resource.title,
        supportsDeleteDetection: resource.supportsDeleteDetection,
      })),
    },
    actions: [],
    configSchema: contribution.configSchema,
  };
}
