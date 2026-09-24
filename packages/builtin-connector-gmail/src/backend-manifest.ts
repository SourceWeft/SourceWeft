import type { ConnectorManifest } from "@sourceweft/contracts/connectors";
import { gmailConnectorContribution } from "./contribution";

export function toBackendGmailManifest(input: {
  clientId: string;
  redirectUri: string;
}): ConnectorManifest {
  const contribution = gmailConnectorContribution;
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
      supportsIncremental: true,
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
      ...("agentToolName" in action
        ? { agentToolName: action.agentToolName }
        : {}),
      description: action.description,
      visibility: action.visibility,
      capabilities: [...action.capabilities],
      riskLevel: action.risk,
      requiresApproval: action.requiresApproval,
      ...("requestPrivacy" in action
        ? { requestPrivacy: action.requestPrivacy }
        : {}),
      ...("allowStandingApproval" in action
        ? { allowStandingApproval: action.allowStandingApproval }
        : {}),
      inputSchema: action.inputSchema,
    })),
    configSchema: contribution.configSchema,
  };
}
