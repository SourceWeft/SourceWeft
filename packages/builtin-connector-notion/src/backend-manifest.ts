import type {
  ConnectorActionCapability,
  ConnectorManifest,
} from "@sourceweft/contracts/connectors";
import type {
  ConnectorActionContribution,
  ConnectorContribution,
} from "@sourceweft/capability-contracts";

export type BackendNotionConnectorManifest = ConnectorManifest;

export type BackendNotionConnectorRuntimeConfig = {
  readonly clientId: string;
  readonly redirectUri: string;
};

export function toBackendNotionConnectorManifest(
  contribution: ConnectorContribution,
  config: BackendNotionConnectorRuntimeConfig,
): ConnectorManifest {
  return {
    type: contribution.id,
    displayName: contribution.title,
    auth: {
      kind: contribution.auth.kind,
      authorizationUrl: contribution.auth.authorizationUrl,
      tokenUrl: contribution.auth.tokenUrl,
      scopes: [...contribution.auth.scopes],
      redirectUri: config.redirectUri,
      authorizationParams: {
        ...contribution.auth.authorizationParams,
        client_id: config.clientId,
      },
      sendScope: contribution.auth.sendScope,
    },
    sync: {
      supportsIncremental: contribution.sync.supportsIncremental,
      defaultFrequencyMinutes: contribution.sync.defaultFrequencyMinutes,
      resources: contribution.sync.resources.map((resource) => ({
        type: resource.type,
        displayName: resource.title,
        supportsDeleteDetection: resource.supportsDeleteDetection,
      })),
    },
    actions: contribution.actions.map(toBackendConnectorAction),
    configSchema: contribution.configSchema,
  };
}

function toBackendConnectorAction(action: ConnectorActionContribution) {
  return {
    type: action.id,
    displayName: action.title,
    riskLevel: action.risk,
    requiresApproval: action.requiresApproval,
    inputSchema: action.inputSchema,
    ...(action.agentToolName ? { agentToolName: action.agentToolName } : {}),
    ...(action.description ? { description: action.description } : {}),
    visibility: action.visibility,
    capabilities: action.capabilities.filter(isConnectorActionCapability),
  };
}

function isConnectorActionCapability(
  value: string,
): value is ConnectorActionCapability {
  switch (value) {
    case "connector_read":
    case "connector_write":
    case "connector_create":
    case "connector_update":
    case "connector_delete":
    case "connector_append":
    case "connector_upload":
    case "connector_move":
    case "connector_archive":
    case "connector_comment":
    case "artifact":
      return true;
    default:
      return false;
  }
}
