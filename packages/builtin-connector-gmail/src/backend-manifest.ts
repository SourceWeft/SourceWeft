import type { ConnectorManifest } from "@sourceweft/contracts/connectors";
import { gmailConnectorContribution } from "./contribution";

function toBackendGmailActions(contribution: typeof gmailConnectorContribution) {
  return contribution.actions.map((action) => ({
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
  }));
}

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
    actions: toBackendGmailActions(contribution),
    configSchema: contribution.configSchema,
  };
}

/**
 * The Composio-brokered variant of the Gmail manifest: same actions as the
 * standard OAuth2 manifest (live search, read, send), but brokered auth, no
 * sync resources (Composio mode offers live tools only, no mailbox
 * indexing), and a config schema reduced to the one setting that still
 * applies, `liveSearchEnabled`.
 */
export function toBackendGmailComposioManifest(): ConnectorManifest {
  const contribution = gmailConnectorContribution;
  return {
    type: contribution.id,
    displayName: contribution.title,
    auth: {
      kind: "brokered",
      broker: "composio",
      scopes: [...contribution.auth.scopes],
    },
    sync: {
      supportsIncremental: false,
      defaultFrequencyMinutes: contribution.sync.defaultFrequencyMinutes,
      minFrequencyMinutes: contribution.sync.minFrequencyMinutes,
      resources: [],
    },
    actions: toBackendGmailActions(contribution),
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        liveSearchEnabled: contribution.configSchema.properties.liveSearchEnabled,
      },
    },
  };
}
