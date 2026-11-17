import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "../src/errors";
import { ATLASSIAN_TOKEN_URL, type AtlassianClientConfig } from "../src/http";
import { exchangeAtlassianCode, refreshAtlassianToken } from "../src/oauth";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function config(fetcher: typeof fetch): AtlassianClientConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    errorPrefix: "JIRA",
    fetcher,
  };
}

test("exchange posts a JSON body and maps the token", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = config(async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return json({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      scope: "read:jira-work read:jira-user",
    });
  });

  const before = Date.now();
  const token = await exchangeAtlassianCode(client, {
    code: "auth-code",
    redirectUri: "https://sourceweft.example/v1/connectors/oauth/jira/callback",
  });
  const after = Date.now();

  assert.equal(capturedUrl, ATLASSIAN_TOKEN_URL);
  assert.equal(capturedInit?.method, "POST");
  assert.equal(
    (capturedInit?.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, string>;
  assert.equal(body.grant_type, "authorization_code");
  assert.equal(body.client_id, "client-id");
  assert.equal(body.client_secret, "client-secret");
  assert.equal(body.code, "auth-code");
  assert.equal(
    body.redirect_uri,
    "https://sourceweft.example/v1/connectors/oauth/jira/callback",
  );

  assert.equal(token.accessToken, "access-token");
  assert.equal(token.refreshToken, "refresh-token");
  assert.deepEqual(token.scopes, ["read:jira-work", "read:jira-user"]);
  assert.ok(token.expiresAt instanceof Date);
  const expiresAtMs = token.expiresAt!.getTime();
  assert.ok(expiresAtMs >= before + 3600 * 1000 - 2000);
  assert.ok(expiresAtMs <= after + 3600 * 1000 + 2000);
});

test("refresh returns the rotated refresh token", async () => {
  const client = config(async () =>
    json({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      scope: "read:jira-work",
    }),
  );

  const token = await refreshAtlassianToken(client, "old-refresh-token");

  assert.equal(token.accessToken, "new-access-token");
  assert.equal(token.refreshToken, "new-refresh-token");
});

test("refresh without a new refresh token returns undefined", async () => {
  const client = config(async () =>
    json({
      access_token: "new-access-token",
      expires_in: 3600,
      scope: "read:jira-work",
    }),
  );

  const token = await refreshAtlassianToken(client, "old-refresh-token");

  assert.equal(token.refreshToken, undefined);
});

test("invalid_grant is REAUTH_REQUIRED with status 400", async () => {
  // Atlassian answers 403 invalid_grant for an unknown, expired or revoked
  // refresh token: that one case means the user must reconnect.
  const client = config(async () => json({ error: "invalid_grant" }, 403));

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "JIRA_REAUTH_REQUIRED");
    return true;
  });
});

test("invalid_client is UNAVAILABLE", async () => {
  // A wrong deployment secret must not look like a revoked grant.
  const client = config(async () => json({ error: "invalid_client" }, 401));

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("a 403 without invalid_grant is UNAVAILABLE", async () => {
  const client = config(async () => json({ error: "access_denied" }, 403));

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("a 429 at the token endpoint is RATE_LIMITED", async () => {
  const client = config(
    async () =>
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "11" },
      }),
  );

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.code, "JIRA_RATE_LIMITED");
    assert.equal(error.details?.retryAfterSeconds, 11);
    return true;
  });
});

test("a 2xx token response that is not JSON is UNAVAILABLE", async () => {
  const client = config(
    async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("a 2xx token response without an access_token is UNAVAILABLE", async () => {
  const client = config(async () => json({ expires_in: 3600 }));

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("a 2xx token response with an empty access_token is UNAVAILABLE", async () => {
  const client = config(async () => json({ access_token: "", expires_in: 3600 }));

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("a 2xx token response without a positive expires_in is UNAVAILABLE", async () => {
  const client = config(async () => json({ access_token: "access-token", expires_in: 0 }));

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("token requests pass an abort signal to fetch", async () => {
  let capturedInit: RequestInit | undefined;
  const client = config(async (_url, init) => {
    capturedInit = init;
    return json({ access_token: "access-token", expires_in: 3600 });
  });

  await refreshAtlassianToken(client, "old-refresh-token");

  assert.ok(capturedInit?.signal instanceof AbortSignal);
});

test("token endpoint 503 is UNAVAILABLE 503", async () => {
  const client = config(async () => json({ error: "down" }, 503));

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("a thrown fetch at the token endpoint is UNAVAILABLE 503", async () => {
  const client = config(async () => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(refreshAtlassianToken(client, "old-refresh-token"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});
