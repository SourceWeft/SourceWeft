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
import { toBackendGithubManifest } from "./backend-manifest";
import { GithubAdapterError } from "./errors";
import { createGithubClient } from "./github-client";
import { listRepositoriesTool, readItemTool, searchItemsTool } from "./live-tools";
import { browseAction, describeAction, searchAction } from "./selection-actions";

export { GithubAdapterError } from "./errors";

export type GithubAdapterConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  appSlug: string;
  fetcher?: typeof fetch;
  retryBaseMs?: number;
};

/**
 * Builds the GitHub connector adapter: OAuth exchange/refresh mapped onto the
 * platform account, a tools-only `discover`/`extract` (nothing is ever
 * indexed — sync.resources is empty), and the three selection actions
 * (`github.browse`, `github.search`, `github.describe`) the shared selection
 * dialog drives, plus the three agent-facing live tools
 * (`github.items.search`, `github.item.read`, `github.repositories.list`) whose
 * reads are limited to the selected repositories, on the same `executeAction`
 * dispatch.
 */
export function createGithubConnectorAdapter(config: GithubAdapterConfig): ConnectorAdapter {
  const fetcher = config.fetcher ?? fetch;
  const client = createGithubClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetcher,
    retryBaseMs: config.retryBaseMs,
  });
  const redirectUri = `${config.baseUrl}/v1/connectors/oauth/github/callback`;

  return {
    capabilityId: "sourceweft/github",
    getManifest() {
      // Without every credential (including the App slug the help link
      // needs) the manifest carries no client id, so the platform refuses to
      // start authorization (CONNECTOR_OAUTH_CONFIG_MISSING) instead of
      // sending the user to GitHub for a code it cannot exchange (#543).
      const configured = Boolean(config.clientId && config.clientSecret && config.appSlug);
      return toBackendGithubManifest({
        clientId: configured ? config.clientId : "",
        redirectUri,
      });
    },
    async exchangeOAuthCode(input: OAuthCodeExchangeInput): Promise<OAuthTokenSet> {
      const token = await client.exchangeAuthorizationCode(input.code, input.redirectUri);
      const api = client.forToken(token.accessToken);
      const user = await api.getUser();
      return {
        ...token,
        providerAccountId: String(user.id),
        displayName: user.login,
        providerAccountEmail: user.email,
      };
    },
    refreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthTokenSet> {
      return client.refreshAccessToken(input.refreshToken);
    },
    async *discover(_input: ConnectorDiscoverInput): AsyncIterable<ConnectorItem> {
      // Tools-only connector: nothing is ever discovered or indexed.
    },
    async extract(_input: ConnectorExtractInput): Promise<ConnectorExtractedContent> {
      throw new GithubAdapterError(
        400,
        "GITHUB_EXTRACT_UNSUPPORTED",
        "GitHub connector does not support extraction",
      );
    },
    async executeAction(input: ConnectorActionInput): Promise<ConnectorActionResult> {
      const api = client.forToken(input.accessToken);
      if (input.actionType === "github.browse") {
        return { result: await browseAction(api, config.appSlug, input.request) };
      }
      if (input.actionType === "github.search") {
        return { result: await searchAction(api, input.request) };
      }
      if (input.actionType === "github.describe") {
        return { result: await describeAction(api, input.request) };
      }
      if (input.actionType === "github.items.search") {
        return { result: await searchItemsTool(api, input.config, input.request) };
      }
      if (input.actionType === "github.item.read") {
        return { result: await readItemTool(api, input.config, input.request) };
      }
      if (input.actionType === "github.repositories.list") {
        return { result: await listRepositoriesTool(api, input.config) };
      }
      throw new GithubAdapterError(400, "GITHUB_ACTION_UNSUPPORTED", "Unsupported GitHub action");
    },
  };
}
