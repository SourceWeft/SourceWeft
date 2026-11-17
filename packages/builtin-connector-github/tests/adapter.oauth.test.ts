import assert from "node:assert/strict";
import test from "node:test";
import type { OAuthCodeExchangeInput, OAuthRefreshInput } from "@sourceweft/contracts";
import { createGithubConnectorAdapter, type GithubAdapterConfig } from "../src/adapter";
import { GithubAdapterError } from "../src/errors";

type RecordedCall = { url: string; method: string; body: unknown };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes a fake fetcher between the GitHub OAuth token endpoint and the
 * `GET /user` REST endpoint, recording every call. Unrouted endpoints throw,
 * so a stray request fails the test loudly. */
function router(handlers: {
  token?: (call: RecordedCall) => Response | Promise<Response>;
  user?: (call: RecordedCall) => Response | Promise<Response>;
}) {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const call: RecordedCall = { url, method, body };
    calls.push(call);
    if (url === "https://github.com/login/oauth/access_token") {
      return (
        handlers.token ??
        (() => json({ access_token: "default-token", expires_in: 3600 }))
      )(call);
    }
    if (new URL(url).pathname === "/user" && method === "GET") {
      return (
        handlers.user ??
        (() => json({ id: 1, login: "octocat", email: "octocat@example.com" }))
      )(call);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function adapter(
  fetcher: typeof fetch,
  overrides: Partial<GithubAdapterConfig> = {},
) {
  return createGithubConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "client-id",
    clientSecret: "client-secret",
    appSlug: "sourceweft-test",
    fetcher,
    retryBaseMs: 0,
    ...overrides,
  });
}

test("exchange maps the GitHub user", async () => {
  const { fetcher, calls } = router({
    token: () =>
      json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
    user: () => json({ id: 42, login: "octocat", email: "octocat@example.com" }),
  });
  const input: OAuthCodeExchangeInput = {
    code: "the-code",
    redirectUri: "https://sourceweft.example/v1/connectors/oauth/github/callback",
    scopes: [],
  };
  const token = await adapter(fetcher).exchangeOAuthCode(input);

  assert.equal(token.accessToken, "at-1");
  assert.equal(token.refreshToken, "rt-1");
  assert.equal(token.providerAccountId, "42");
  assert.equal(token.displayName, "octocat");
  assert.equal(token.providerAccountEmail, "octocat@example.com");

  const tokenCall = calls.find((call) => call.url.includes("access_token"));
  assert.equal(
    (tokenCall?.body as { redirect_uri: string }).redirect_uri,
    input.redirectUri,
  );
});

test("refresh delegates and returns the rotated token", async () => {
  const { fetcher, calls } = router({
    token: () =>
      json({ access_token: "at-2", refresh_token: "rt-rotated", expires_in: 28800 }),
  });
  const input: OAuthRefreshInput = { refreshToken: "rt-old", scopes: [] };
  const token = await adapter(fetcher).refreshOAuthToken(input);

  assert.equal(token.accessToken, "at-2");
  assert.equal(token.refreshToken, "rt-rotated");
  const tokenCall = calls[0];
  assert.ok(tokenCall);
  assert.deepEqual(tokenCall.body, {
    client_id: "client-id",
    client_secret: "client-secret",
    grant_type: "refresh_token",
    refresh_token: "rt-old",
  });
  // refresh never looks up the user.
  assert.equal(calls.length, 1);
});

test("refresh without a configured secret makes no request", async () => {
  const { fetcher, calls } = router({});
  await assert.rejects(
    adapter(fetcher, { clientSecret: "" }).refreshOAuthToken({
      refreshToken: "rt",
      scopes: [],
    }),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 503 &&
      error.code === "GITHUB_UNAVAILABLE",
  );
  assert.equal(calls.length, 0);
});

test("exchange without a configured client id makes no request", async () => {
  const { fetcher, calls } = router({});
  await assert.rejects(
    adapter(fetcher, { clientId: "" }).exchangeOAuthCode({
      code: "c",
      redirectUri: "u",
      scopes: [],
    }),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 503 &&
      error.code === "GITHUB_UNAVAILABLE",
  );
  assert.equal(calls.length, 0);
});

test("manifest client_id is empty without a slug", () => {
  const { fetcher } = router({});
  const withoutSlug = adapter(fetcher, { appSlug: "" }).getManifest();
  assert.equal(withoutSlug.auth.authorizationParams?.client_id, "");

  const withSlug = adapter(fetcher).getManifest();
  assert.equal(withSlug.auth.authorizationParams?.client_id, "client-id");
});

test("manifest client_id is empty without a client secret", () => {
  const { fetcher } = router({});
  const manifest = adapter(fetcher, { clientSecret: "" }).getManifest();
  assert.equal(manifest.auth.authorizationParams?.client_id, "");
});

test("discover yields nothing", async () => {
  const { fetcher, calls } = router({});
  const items = [];
  for await (const item of adapter(fetcher).discover({
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "github",
    config: { items: [] },
    accessToken: "access-token",
  })) {
    items.push(item);
  }
  assert.deepEqual(items, []);
  assert.equal(calls.length, 0);
});

test("extract is unsupported", async () => {
  const { fetcher } = router({});
  await assert.rejects(
    adapter(fetcher).extract({
      teamId: "team",
      workspaceId: "workspace",
      connectorId: "connector",
      connectorType: "github",
      config: { items: [] },
      accessToken: "access-token",
      item: {
        externalId: "repo:1",
        externalUri: null,
        title: "repo",
        mimeType: null,
        sizeBytes: null,
        externalUpdatedAt: null,
        contentHash: null,
        metadata: {},
      },
    }),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 400 &&
      error.code === "GITHUB_EXTRACT_UNSUPPORTED",
  );
});
