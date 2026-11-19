import type { ConnectorManifest } from "@sourceweft/contracts/connectors";
import { githubConnectorContribution } from "./contribution";

export function toBackendGithubManifest(input: {
  clientId: string;
  redirectUri: string;
}): ConnectorManifest {
  const contribution = githubConnectorContribution;
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
      resources: [],
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
      inputSchema: action.inputSchema,
    })),
    configSchema: contribution.configSchema,
    selection: contribution.selection,
  };
}
