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
import { toBackendConfluenceManifest } from "./backend-manifest";

export type ConfluenceAdapterConfig = {
  baseUrl: string;
  redirectUri?: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
};

function unavailable(): AtlassianApiError {
  return new AtlassianApiError(
    503,
    "CONFLUENCE_UNAVAILABLE",
    "Confluence is not available",
  );
}

/**
 * Confluence connector adapter. It publishes the manifest; OAuth, selection and
 * the agent-visible tools are not served yet, so each of those answers with a
 * clear error instead of pretending to work.
 */
export function createConfluenceConnectorAdapter(
  config: ConfluenceAdapterConfig,
): ConnectorAdapter {
  const redirectUri =
    config.redirectUri ??
    `${config.baseUrl}/v1/connectors/oauth/confluence/callback`;

  return {
    capabilityId: "sourceweft/confluence",
    getManifest() {
      // Without both credentials the manifest carries no client id, so the
      // platform refuses to start authorization (CONNECTOR_OAUTH_CONFIG_MISSING)
      // instead of sending the user to Atlassian for a code it cannot exchange.
      return toBackendConfluenceManifest({
        clientId: config.clientId && config.clientSecret ? config.clientId : "",
        redirectUri,
      });
    },
    async exchangeOAuthCode(
      _input: OAuthCodeExchangeInput,
    ): Promise<OAuthTokenSet> {
      throw unavailable();
    },
    async refreshOAuthToken(_input: OAuthRefreshInput): Promise<OAuthTokenSet> {
      throw unavailable();
    },
    async *discover(
      _input: ConnectorDiscoverInput,
    ): AsyncIterable<ConnectorItem> {
      // Tools-only connector: nothing is indexed.
    },
    async extract(
      _input: ConnectorExtractInput,
    ): Promise<ConnectorExtractedContent> {
      throw new AtlassianApiError(
        400,
        "CONFLUENCE_UNSUPPORTED",
        "The Confluence connector does not index content.",
      );
    },
    async executeAction(
      _input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      throw new AtlassianApiError(
        400,
        "CONFLUENCE_UNSUPPORTED_ACTION",
        "Unsupported Confluence action",
      );
    },
  };
}
