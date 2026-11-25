import type { ConnectorManifest } from "@sourceweft/contracts/connectors";
import { nextcloudConnectorContribution } from "./contribution";

/** The backend `ConnectorManifest` for the Nextcloud connector, derived from the
 * same contribution the capability manifest declares (mirrors
 * `toBackendWebDavManifest`). */
export function toBackendNextcloudManifest(): ConnectorManifest {
  const contribution = nextcloudConnectorContribution;
  return {
    type: contribution.id,
    displayName: contribution.title,
    auth: { kind: "credential", scheme: contribution.auth.scheme },
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
    actions: contribution.actions.map((action) => ({
      type: action.id,
      displayName: action.title,
      description: action.description,
      visibility: action.visibility,
      capabilities: [...action.capabilities],
      riskLevel: action.risk,
      requiresApproval: action.requiresApproval,
      inputSchema: action.inputSchema,
    })),
    configSchema: contribution.configSchema,
    selection: contribution.selection,
  };
}
