import type { ConnectorManifest } from "@sourceweft/contracts/connectors";
import { googleDriveConnectorContribution } from "./contribution";

export function toBackendGoogleDriveManifest(input: {
  clientId: string;
  redirectUri: string;
}): ConnectorManifest {
  const contribution = googleDriveConnectorContribution;
  return {
    type: contribution.id,
    displayName: contribution.title,
    auth: {
      kind: "oauth2",
      authorizationUrl: contribution.auth.authorizationUrl,
      tokenUrl: contribution.auth.tokenUrl,
      scopes: [...contribution.auth.scopes],
      redirectUri: input.redirectUri,
      authorizationParams: {
        ...contribution.auth.authorizationParams,
        client_id: input.clientId,
      },
      sendScope: contribution.auth.sendScope,
    },
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
    // Unlike Gmail's contribution, none of this connector's actions declare
    // agentToolName, requestPrivacy, or allowStandingApproval, so there is no
    // per-variant field to carry across conditionally.
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
  };
}
