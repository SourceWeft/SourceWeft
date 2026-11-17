// Authorization-code exchange and refresh against Atlassian's single OAuth
// token endpoint (shared by Jira and Confluence; see Global Constraints).

import type { OAuthTokenSet } from "@sourceweft/contracts";
import { mapTokenError, unavailableError } from "./errors";
import { ATLASSIAN_TOKEN_URL, type AtlassianClientConfig } from "./http";

const REQUEST_TIMEOUT_MS = 30000;

type TokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

async function tokenRequest(
  config: AtlassianClientConfig,
  body: Record<string, string>,
): Promise<OAuthTokenSet> {
  const fetcher = config.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(ATLASSIAN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailableError(config.errorPrefix);
  }
  if (!response.ok) {
    throw mapTokenError(response, config.errorPrefix);
  }
  const payload = (await response.json()) as TokenPayload;
  return {
    accessToken: payload.access_token ?? "",
    // A refresh response may omit refresh_token: the caller keeps using the
    // one it already stored.
    refreshToken: payload.refresh_token ?? undefined,
    expiresAt: payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000)
      : undefined,
    scopes: payload.scope ? payload.scope.split(" ").filter(Boolean) : undefined,
  };
}

export function exchangeAtlassianCode(
  config: AtlassianClientConfig,
  input: { code: string; redirectUri: string },
): Promise<OAuthTokenSet> {
  return tokenRequest(config, {
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
}

export function refreshAtlassianToken(
  config: AtlassianClientConfig,
  refreshToken: string,
): Promise<OAuthTokenSet> {
  return tokenRequest(config, {
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });
}
