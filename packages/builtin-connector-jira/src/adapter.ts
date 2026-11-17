import { AtlassianApiError } from "@sourceweft/atlassian-client";
import type {
  ConnectorActionInput,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorDiscoverInput,
  ConnectorExtractInput,
  ConnectorExtractedContent,
  ConnectorItem,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
  OAuthTokenSet,
} from "@sourceweft/contracts";
import { toBackendJiraManifest } from "./backend-manifest";

export type JiraAdapterConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
};

function unsupported(): AtlassianApiError {
  return new AtlassianApiError(
    400,
    "JIRA_UNSUPPORTED",
    "Not yet implemented",
  );
}

/**
 * Stub adapter for Task 4 of the Jira connector plan. `getManifest` already
 * works (client id is empty unless both credentials are set, per the #543
 * rule); every other method throws `400 JIRA_UNSUPPORTED` until Task 6
 * replaces this file with the real Jira client and adapter.
 */
export function createJiraConnectorAdapter(
  config: JiraAdapterConfig,
): ConnectorAdapter {
  const redirectUri = `${config.baseUrl}/v1/connectors/oauth/jira/callback`;

  return {
    capabilityId: "sourceweft/jira",
    getManifest() {
      // Without both credentials the manifest carries no client id, so the
      // platform refuses to start authorization (CONNECTOR_OAUTH_CONFIG_MISSING)
      // instead of sending the user to Atlassian for a code it cannot exchange.
      return toBackendJiraManifest({
        clientId: config.clientId && config.clientSecret ? config.clientId : "",
        redirectUri,
      });
    },
    async exchangeOAuthCode(
      _input: OAuthCodeExchangeInput,
    ): Promise<OAuthTokenSet> {
      throw unsupported();
    },
    async refreshOAuthToken(
      _input: OAuthRefreshInput,
    ): Promise<OAuthTokenSet> {
      throw unsupported();
    },
    async *discover(
      _input: ConnectorDiscoverInput,
    ): AsyncIterable<ConnectorItem> {
      throw unsupported();
    },
    async extract(
      _input: ConnectorExtractInput,
    ): Promise<ConnectorExtractedContent> {
      throw unsupported();
    },
    async executeAction(
      _input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      throw unsupported();
    },
  };
}
