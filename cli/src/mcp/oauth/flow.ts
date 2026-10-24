import { randomBytes } from "node:crypto";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  selectResourceURL,
  startAuthorization,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpInspectError } from "../../errors";
import { openBrowser } from "./browser";
import {
  createCredentialedFetch,
  createOpenFetch,
  isSecureOrigin,
} from "./guard";
import { startLoopbackListener } from "./loopback";
import { redactSecrets } from "./redact";
import {
  resourceKey,
  type McpOAuthStore,
  type OAuthRecord,
  type StoredTokens,
} from "./store";

/**
 * The MCP authorization-code flow with PKCE, run on the user's machine, built
 * from the MCP SDK's own helpers: discovery (RFC 9728, RFC 8414), dynamic
 * client registration (RFC 7591), PKCE, token exchange and refresh. This file
 * orders them and adds what a CLI needs around them — the loopback redirect,
 * the browser, local storage, and a rule that a token goes only to the
 * endpoint the user named and the authorization server it declared.
 */

/** An access token this close to its end counts as expired. */
const EXPIRY_MARGIN_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

export type TokenSource = "stored" | "refreshed" | "signed-in";

/**
 * `reuse` takes a stored token that is still valid, refreshing an expired one;
 * `renew` refreshes regardless of its expiry (the server refused it);
 * `login` goes through the browser.
 */
export type AuthorizeMode = "reuse" | "renew" | "login";

export type AuthorizeOptions = {
  /** The MCP endpoint, already validated. */
  url: string;
  clientName: string;
  store: McpOAuthStore;
  mode: AuthorizeMode;
  /** Progress and instructions for the person at the terminal. */
  notice: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Replaceable in tests; true when a browser was started. */
  launchBrowser?: (url: string) => Promise<boolean>;
  callbackTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
};

export type Authorization = {
  accessToken: string;
  source: TokenSource;
  /** Everything this flow could have printed that must never appear in output. */
  secrets: string[];
};

function toStoredTokens(tokens: OAuthTokens, now: number): StoredTokens {
  return {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(typeof tokens.expires_in === "number"
      ? { expiresAt: now + tokens.expires_in * 1000 }
      : {}),
  };
}

function secretsOf(record: OAuthRecord | undefined): string[] {
  return [
    record?.tokens?.access_token,
    record?.tokens?.refresh_token,
    record?.client.client_secret,
  ].filter((value): value is string => Boolean(value));
}

function requireSecureEndpoints(
  metadata: AuthorizationServerMetadata,
  asUrl: string,
): void {
  for (const [name, value] of [
    ["authorization endpoint", metadata.authorization_endpoint],
    ["token endpoint", metadata.token_endpoint],
  ] as const) {
    if (!isSecureOrigin(new URL(value))) {
      throw new McpInspectError(
        `The authorization server ${asUrl} declares an insecure ${name} (${new URL(value).origin}); sign-in needs https.`,
      );
    }
  }
}

/**
 * Asks the endpoint for a token-less answer, to learn where its protected
 * resource metadata is (the `WWW-Authenticate` header of a 401). Nothing
 * secret is sent, and a failure only means discovery uses its default places.
 */
async function probeChallenge(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "sourceweft-cli", version: "0" },
        },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status !== 401) return {};
    const params = extractWWWAuthenticateParams(response);
    return {
      ...(params.resourceMetadataUrl
        ? { resourceMetadataUrl: params.resourceMetadataUrl }
        : {}),
      ...(params.scope ? { scope: params.scope } : {}),
    };
  } catch {
    return {};
  }
}

function describeFailure(error: unknown, secrets: readonly string[]): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text, secrets);
}

/**
 * A stored or fresh access token for the endpoint, signing in through the
 * browser only when nothing stored can be used. Every failure comes out as an
 * `McpInspectError` with secrets removed.
 */
export async function authorize(
  options: AuthorizeOptions,
): Promise<Authorization> {
  const secrets: string[] = [];
  try {
    return await authorizeUnchecked(options, secrets);
  } catch (error) {
    if (error instanceof McpInspectError) {
      throw new McpInspectError(
        redactSecrets(error.message, secrets),
        error.details.map((line) => redactSecrets(line, secrets)),
      );
    }
    throw new McpInspectError(
      `Sign-in failed: ${describeFailure(error, secrets)}`,
    );
  }
}

async function authorizeUnchecked(
  options: AuthorizeOptions,
  secrets: string[],
): Promise<Authorization> {
  const now = options.now ?? Date.now;
  const serverUrl = new URL(options.url);
  const resourceId = resourceKey(options.url);
  const openFetch = createOpenFetch(options.fetchImpl);

  const challenge = await probeChallenge(options.url, openFetch);
  const info = await discoverOAuthServerInfo(serverUrl, {
    ...(challenge.resourceMetadataUrl
      ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
      : {}),
    fetchFn: openFetch,
  });
  const asUrl = info.authorizationServerUrl;
  const metadata = info.authorizationServerMetadata;
  if (!metadata) {
    throw new McpInspectError(
      `${serverUrl.origin} does not publish OAuth metadata (no protected-resource or authorization-server document was found), so --oauth cannot sign in to it. Use --header with a token you already hold.`,
    );
  }
  requireSecureEndpoints(metadata, asUrl);
  const resource = await selectResourceURL(
    serverUrl,
    {} as OAuthClientProvider,
    info.resourceMetadata,
  );
  // As the SDK does: the metadata's own spelling of the resource, verbatim.
  const resourceIndicator =
    resource && info.resourceMetadata
      ? info.resourceMetadata.resource
      : undefined;
  const scope = challenge.scope ?? info.resourceMetadata?.scopes_supported?.join(" ");

  const tokenFetch = createCredentialedFetch(
    [new URL(metadata.token_endpoint).origin],
    options.fetchImpl,
  );

  const record = await options.store.load(resourceId, asUrl);
  secrets.push(...secretsOf(record));
  const stored = record?.tokens;

  if (record && stored && options.mode !== "login") {
    const fresh =
      stored.expiresAt === undefined ||
      stored.expiresAt - now() > EXPIRY_MARGIN_MS;
    if (fresh && options.mode === "reuse") {
      return { accessToken: stored.access_token, source: "stored", secrets };
    }
    if (stored.refresh_token) {
      try {
        const refreshed = await refreshAuthorization(asUrl, {
          metadata,
          clientInformation: record.client,
          refreshToken: stored.refresh_token,
          ...(resourceIndicator ? { resource: resourceIndicator } : {}),
          fetchFn: tokenFetch,
        });
        const next: OAuthRecord = {
          ...record,
          tokens: toStoredTokens(refreshed, now()),
        };
        await options.store.save(next);
        secrets.push(...secretsOf(next));
        return {
          accessToken: refreshed.access_token,
          source: "refreshed",
          secrets,
        };
      } catch (error) {
        // The server said the grant is gone: sign in again. A network
        // failure or a refused redirect is not that and is reported.
        if (!(error instanceof OAuthError)) throw error;
        options.notice(
          "The stored sign-in could not be renewed; signing in again.",
        );
      }
    }
  }

  return signIn({
    options,
    secrets,
    asUrl,
    metadata,
    resourceIndicator,
    scope,
    resourceId,
    tokenFetch,
    openFetch,
    now,
  });
}

async function signIn(input: {
  options: AuthorizeOptions;
  secrets: string[];
  asUrl: string;
  metadata: AuthorizationServerMetadata;
  resourceIndicator: string | undefined;
  scope: string | undefined;
  resourceId: string;
  tokenFetch: typeof fetch;
  openFetch: typeof fetch;
  now: () => number;
}): Promise<Authorization> {
  const { options, metadata, asUrl, secrets } = input;
  if (!metadata.registration_endpoint) {
    throw new McpInspectError(
      `The authorization server ${asUrl} does not offer dynamic client registration, and this command carries no preregistered client for it. Obtain a token another way and pass it with --header "Authorization: Bearer <token>".`,
    );
  }
  if (!isSecureOrigin(new URL(metadata.registration_endpoint))) {
    throw new McpInspectError(
      `The authorization server ${asUrl} declares an insecure registration endpoint; sign-in needs https.`,
    );
  }

  const state = randomBytes(32).toString("base64url");
  const listener = await startLoopbackListener({
    expectedState: state,
    ...(metadata.issuer ? { issuer: metadata.issuer } : {}),
    ...(options.callbackTimeoutMs !== undefined
      ? { timeoutMs: options.callbackTimeoutMs }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  try {
    const registered: OAuthClientInformationFull = await registerClient(asUrl, {
      metadata,
      clientMetadata: {
        client_name: options.clientName,
        redirect_uris: [listener.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      ...(input.scope ? { scope: input.scope } : {}),
      fetchFn: input.openFetch,
    });
    if (registered.client_secret) secrets.push(registered.client_secret);

    const { authorizationUrl, codeVerifier } = await startAuthorization(asUrl, {
      metadata,
      clientInformation: registered,
      redirectUrl: listener.redirectUri,
      state,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.resourceIndicator ? { resource: input.resourceIndicator } : {}),
    });
    secrets.push(codeVerifier);

    const launch = options.launchBrowser ?? openBrowser;
    const opened = await launch(authorizationUrl.href);
    if (opened) {
      options.notice(
        `Opened your browser to sign in to ${new URL(options.url).origin}. Waiting for you to approve (the sign-in returns to ${listener.redirectUri} on this computer).`,
      );
    } else {
      options.notice(
        `Could not open a browser. Open this address in a browser on THIS computer to sign in:\n\n${authorizationUrl.href}\n\nThe sign-in returns to ${listener.redirectUri}, an address that exists only on this computer, so it can finish only when the browser runs here. A browser on another machine, or inside a remote session, cannot complete it; in that case obtain a token another way and pass it with --header.`,
      );
    }

    const { code } = await listener.result;
    secrets.push(code);
    const tokens = await exchangeAuthorization(asUrl, {
      metadata,
      clientInformation: registered,
      authorizationCode: code,
      codeVerifier,
      redirectUri: listener.redirectUri,
      ...(input.resourceIndicator ? { resource: input.resourceIndicator } : {}),
      fetchFn: input.tokenFetch,
    });
    secrets.push(tokens.access_token);
    if (tokens.refresh_token) secrets.push(tokens.refresh_token);

    await options.store.save({
      version: 1,
      resource: input.resourceId,
      issuer: asUrl,
      client: {
        client_id: registered.client_id,
        ...(registered.client_secret
          ? { client_secret: registered.client_secret }
          : {}),
        client_name: options.clientName,
        redirect_uris: [listener.redirectUri],
        token_endpoint_auth_method:
          registered.token_endpoint_auth_method ?? "none",
      },
      tokens: toStoredTokens(tokens, input.now()),
    });
    return { accessToken: tokens.access_token, source: "signed-in", secrets };
  } finally {
    await listener.close();
  }
}
