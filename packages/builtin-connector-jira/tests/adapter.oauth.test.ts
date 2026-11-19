import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "@sourceweft/atlassian-client";
import type {
  ConnectorDiscoverInput,
  ConnectorExtractInput,
  ConnectorManifest,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
} from "@sourceweft/contracts";
import { createJiraConnectorAdapter, type JiraAdapterConfig } from "../src/adapter";

// The Jira manifest always uses the platform's standard OAuth2 flow; this
// narrows the manifest's auth union so its OAuth2 fields can be read.
function oauth2Auth(manifest: ConnectorManifest) {
  assert.equal(manifest.auth.kind, "oauth2");
  if (manifest.auth.kind !== "oauth2") throw new Error("unreachable");
  return manifest.auth;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function adapter(
  fetcher: typeof fetch,
  overrides: Partial<JiraAdapterConfig> = {},
) {
  return createJiraConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "jira-client-id",
    clientSecret: "jira-client-secret",
    fetcher,
    ...overrides,
  });
}

function neverCalledFetcher(): typeof fetch {
  return (async (url: string | URL | Request) => {
    throw new Error(`Unexpected request: ${String(url)}`);
  }) as typeof fetch;
}

test("manifest client_id is empty without a secret", () => {
  const withoutSecret = createJiraConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "jira-client-id",
    clientSecret: "",
  });
  assert.equal(
    oauth2Auth(withoutSecret.getManifest()).authorizationParams?.client_id,
    "",
  );

  const withBoth = createJiraConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "jira-client-id",
    clientSecret: "jira-client-secret",
  });
  assert.equal(
    oauth2Auth(withBoth.getManifest()).authorizationParams?.client_id,
    "jira-client-id",
  );
  assert.equal(
    oauth2Auth(withBoth.getManifest()).redirectUri,
    "https://sourceweft.example/v1/connectors/oauth/jira/callback",
  );
});

test("exchange maps the Atlassian account", async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const value = String(url);
    calls.push(value);
    if (value === "https://auth.atlassian.com/oauth/token") {
      return json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "read:jira-work read:jira-user read:me offline_access",
      });
    }
    if (value === "https://api.atlassian.com/me") {
      return json({
        account_id: "account-1",
        email: "user@example.com",
        name: "User One",
      });
    }
    throw new Error(`Unexpected request: ${value}`);
  }) as typeof fetch;

  const jira = adapter(fetcher);
  const input: OAuthCodeExchangeInput = {
    code: "auth-code",
    redirectUri: "https://sourceweft.example/v1/connectors/oauth/jira/callback",
    scopes: ["read:jira-work"],
  };
  const token = await jira.exchangeOAuthCode(input);

  assert.equal(token.accessToken, "access-token");
  assert.equal(token.refreshToken, "refresh-token");
  assert.equal(token.providerAccountId, "account-1");
  assert.equal(token.providerAccountEmail, "user@example.com");
  assert.equal(token.displayName, "User One");
  assert.deepEqual(calls, [
    "https://auth.atlassian.com/oauth/token",
    "https://api.atlassian.com/me",
  ]);
});

test("exchange falls back displayName to email, then account id", async () => {
  const fetcher = (async (url: string | URL | Request) => {
    const value = String(url);
    if (value === "https://auth.atlassian.com/oauth/token") {
      return json({ access_token: "access-token", expires_in: 3600 });
    }
    if (value === "https://api.atlassian.com/me") {
      return json({ account_id: "account-1" });
    }
    throw new Error(`Unexpected request: ${value}`);
  }) as typeof fetch;

  const jira = adapter(fetcher);
  const token = await jira.exchangeOAuthCode({
    code: "auth-code",
    redirectUri: "https://sourceweft.example/v1/connectors/oauth/jira/callback",
    scopes: [],
  });
  assert.equal(token.providerAccountEmail, null);
  assert.equal(token.displayName, "account-1");
});

test("refresh delegates and returns the rotated token", async () => {
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    assert.equal(value, "https://auth.atlassian.com/oauth/token");
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.client_id, "jira-client-id");
    assert.equal(body.client_secret, "jira-client-secret");
    assert.equal(body.refresh_token, "old-refresh-token");
    return json({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      scope: "read:jira-work",
    });
  }) as typeof fetch;

  const jira = adapter(fetcher);
  const input: OAuthRefreshInput = {
    refreshToken: "old-refresh-token",
    scopes: [],
  };
  const token = await jira.refreshOAuthToken(input);
  assert.equal(token.accessToken, "new-access-token");
  assert.equal(token.refreshToken, "new-refresh-token");
  // Refresh delegates verbatim: it does not call /me or add identity fields.
  assert.equal("providerAccountId" in token, false);
});

test("refresh without a configured secret makes no request", async () => {
  const jira = adapter(neverCalledFetcher(), { clientSecret: "" });
  await assert.rejects(
    jira.refreshOAuthToken({ refreshToken: "old-refresh-token", scopes: [] }),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 503 &&
      error.code === "JIRA_UNAVAILABLE",
  );
});

test("exchange without a configured client id makes no request", async () => {
  const jira = adapter(neverCalledFetcher(), { clientId: "" });
  await assert.rejects(
    jira.exchangeOAuthCode({
      code: "auth-code",
      redirectUri: "https://sourceweft.example/v1/connectors/oauth/jira/callback",
      scopes: [],
    }),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 503 &&
      error.code === "JIRA_UNAVAILABLE",
  );
});

test("discover yields nothing", async () => {
  const jira = adapter(neverCalledFetcher());
  const input: ConnectorDiscoverInput = {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "jira",
    config: { items: [] },
    accessToken: "access-token",
  };
  const items: unknown[] = [];
  for await (const item of jira.discover(input)) {
    items.push(item);
  }
  assert.deepEqual(items, []);
});

test("extract is unsupported", async () => {
  const jira = adapter(neverCalledFetcher());
  const input: ConnectorExtractInput = {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "jira",
    config: { items: [] },
    accessToken: "access-token",
    item: {
      externalId: "project:aaaaaaaa-2222-3333-4444-555555555555:10000",
      externalUri: null,
      title: "Alpha",
      mimeType: null,
      sizeBytes: null,
      externalUpdatedAt: null,
      contentHash: null,
      metadata: {},
    },
  };
  await assert.rejects(
    jira.extract(input),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 400 &&
      error.code === "JIRA_UNSUPPORTED",
  );
});
