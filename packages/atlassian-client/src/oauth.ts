// Authorization-code exchange and refresh against Atlassian's single OAuth
// token endpoint, shared by Jira and Confluence.

import type { OAuthTokenSet } from "@sourceweft/contracts";
import { mapTokenError, unavailableError } from "./errors";
import { ATLASSIAN_TOKEN_URL, type AtlassianClientConfig } from "./http";

/** The platform abandons a refresh after 20 seconds, and Atlassian refresh
 * tokens rotate, so the token request is given a shorter budget than an API
 * request and must resolve or fail within it. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

type TokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
};

/** Reads the OAuth `error` field from a failed token response without placing
 * the body in any message; a body that is absent or not JSON yields `null`. */
async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

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
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailableError(config.errorPrefix);
  }
  if (!response.ok) {
    throw mapTokenError(response, config.errorPrefix, await readErrorCode(response));
  }
  let payload: TokenPayload;
  try {
    payload = (await response.json()) as TokenPayload;
  } catch {
    // A 2xx whose body is not JSON is an outage, not a usable token.
    throw unavailableError(config.errorPrefix);
  }
  if (typeof payload?.access_token !== "string" || payload.access_token.length === 0) {
    throw unavailableError(config.errorPrefix);
  }
  if (
    typeof payload.expires_in !== "number" ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  ) {
    throw unavailableError(config.errorPrefix);
  }
  return {
    accessToken: payload.access_token,
    // A refresh response may omit refresh_token: the caller keeps using the
    // one it already stored.
    refreshToken:
      typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
        ? payload.refresh_token
        : undefined,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000),
    scopes:
      typeof payload.scope === "string"
        ? payload.scope.split(" ").filter(Boolean)
        : undefined,
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
