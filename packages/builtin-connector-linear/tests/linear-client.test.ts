import assert from "node:assert/strict";
import test from "node:test";
import {
  IDENTITY_QUERY,
  ISSUE_QUERY,
  PROJECTS_QUERY,
  SEARCH_ISSUES_QUERY,
  TEAMS_QUERY,
  TEAM_PROJECTS_QUERY,
} from "../src/documents";
import { LinearAdapterError, createLinearClient } from "../src/linear-client";

type RecordedCall = { url: string; init: RequestInit };

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function linear(fetcher: typeof fetch) {
  return createLinearClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetcher,
  });
}

function recordingFetcher(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

function graphqlError(message: string, code?: string): unknown {
  return {
    data: null,
    errors: [{ message, extensions: code ? { code } : undefined }],
  };
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

test("exchange posts a form body and maps the token", async () => {
  let tokenBody = new URLSearchParams();
  let tokenHeaders: HeadersInit | undefined;
  let tokenUrl = "";
  const client = linear(async (url, init) => {
    tokenUrl = String(url);
    tokenBody = new URLSearchParams(String(init?.body));
    tokenHeaders = init?.headers;
    return json({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 86400,
      scope: "read",
    });
  });

  const before = Date.now();
  const token = await client.exchangeAuthorizationCode(
    "auth-code",
    "https://sourceweft.example/v1/connectors/oauth/linear/callback",
  );

  assert.equal(tokenUrl, "https://api.linear.app/oauth/token");
  assert.equal(
    (tokenHeaders as Record<string, string>)["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.equal(tokenBody.get("code"), "auth-code");
  assert.equal(
    tokenBody.get("redirect_uri"),
    "https://sourceweft.example/v1/connectors/oauth/linear/callback",
  );
  assert.equal(tokenBody.get("client_id"), "client-id");
  assert.equal(tokenBody.get("client_secret"), "client-secret");

  assert.equal(token.accessToken, "access-token");
  assert.equal(token.refreshToken, "refresh-token");
  assert.ok(token.expiresAt instanceof Date);
  assert.ok(token.expiresAt!.getTime() >= before + 86400 * 1000);
});

test("refresh returns the rotated refresh token", async () => {
  let tokenBody = new URLSearchParams();
  const client = linear(async (_url, init) => {
    tokenBody = new URLSearchParams(String(init?.body));
    return json({
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
      scope: "read",
    });
  });

  const token = await client.refreshAccessToken("stored-refresh-token");

  assert.equal(tokenBody.get("grant_type"), "refresh_token");
  assert.equal(tokenBody.get("refresh_token"), "stored-refresh-token");
  assert.equal(token.accessToken, "new-access-token");
  assert.equal(token.refreshToken, "rotated-refresh-token");
});

test("refresh without refresh_token returns undefined", async () => {
  const client = linear(async () =>
    json({ access_token: "new-access-token", expires_in: 3600, scope: "read" }),
  );

  const token = await client.refreshAccessToken("stored-refresh-token");

  assert.equal(token.refreshToken, undefined);
});

test("scope string and scope array both map to scopes", async () => {
  const stringClient = linear(async () =>
    json({ access_token: "a", expires_in: 3600, scope: "read write,admin" }),
  );
  const stringToken = await stringClient.exchangeAuthorizationCode("code", "https://x/cb");
  assert.deepEqual(stringToken.scopes, ["read", "write", "admin"]);

  const arrayClient = linear(async () =>
    json({ access_token: "a", expires_in: 3600, scope: ["read", "write"] }),
  );
  const arrayToken = await arrayClient.exchangeAuthorizationCode("code", "https://x/cb");
  assert.deepEqual(arrayToken.scopes, ["read", "write"]);
});

test("token endpoint 400 is LINEAR_REAUTH_REQUIRED with status 400", async () => {
  const client = linear(async () => json({ error: "invalid_grant" }, 400));

  await assert.rejects(client.refreshAccessToken("expired-refresh-token"), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "LINEAR_REAUTH_REQUIRED");
    return true;
  });
});

test("token endpoint 401 is LINEAR_REAUTH_REQUIRED", async () => {
  const client = linear(async () => json({ error: "unauthorized" }, 401));

  await assert.rejects(client.refreshAccessToken("expired-refresh-token"), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "LINEAR_REAUTH_REQUIRED");
    return true;
  });
});

test("token endpoint 429 is LINEAR_RATE_LIMITED", async () => {
  const client = linear(async () => json({ error: "rate_limited" }, 429, { "Retry-After": "12" }));

  await assert.rejects(client.refreshAccessToken("stored-refresh-token"), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.code, "LINEAR_RATE_LIMITED");
    return true;
  });
});

test("token endpoint 503 is LINEAR_UNAVAILABLE", async () => {
  const client = linear(async () => json({}, 503));

  await assert.rejects(client.refreshAccessToken("stored-refresh-token"), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "LINEAR_UNAVAILABLE");
    return true;
  });
});

test("token endpoint network error is LINEAR_UNAVAILABLE", async () => {
  const client = linear(async () => {
    throw new Error("network down");
  });

  await assert.rejects(client.refreshAccessToken("stored-refresh-token"), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "LINEAR_UNAVAILABLE");
    return true;
  });
});

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

test("query sends the bearer token and variables", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({ data: { viewer: { id: "u1" } } }));
  const client = linear(fetcher);

  const result = await client.query<{ viewer: { id: string } }>(
    "access-token",
    IDENTITY_QUERY,
    {},
  );

  assert.equal(calls[0]?.url, "https://api.linear.app/graphql");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer access-token");
  assert.equal(headers["Content-Type"], "application/json");
  const body = JSON.parse(String(calls[0]?.init.body)) as { query: string; variables: unknown };
  assert.equal(body.query, IDENTITY_QUERY);
  assert.deepEqual(body.variables, {});
  assert.deepEqual(result, { viewer: { id: "u1" } });
});

test("query passes variables through to the request body", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({ data: { issue: { id: "i1" } } }));
  const client = linear(fetcher);

  await client.query("access-token", ISSUE_QUERY, { id: "ENG-123" });

  const body = JSON.parse(String(calls[0]?.init.body)) as { variables: { id: string } };
  assert.equal(body.variables.id, "ENG-123");
});

test("documents are constant", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({ data: {} }));
  const client = linear(fetcher);

  await client.query("access-token", SEARCH_ISSUES_QUERY, {
    term: '") { viewer { id } } #',
    after: null,
  });
  await client.query("access-token", SEARCH_ISSUES_QUERY, {
    term: "引号\"测试",
    after: null,
  });

  const firstBody = JSON.parse(String(calls[0]?.init.body)) as { query: string };
  const secondBody = JSON.parse(String(calls[1]?.init.body)) as { query: string };
  assert.equal(firstBody.query, secondBody.query);
  assert.equal(firstBody.query, SEARCH_ISSUES_QUERY);
});

test("every exported document is a non-empty constant string", () => {
  for (const document of [
    IDENTITY_QUERY,
    TEAMS_QUERY,
    TEAM_PROJECTS_QUERY,
    PROJECTS_QUERY,
    SEARCH_ISSUES_QUERY,
    ISSUE_QUERY,
  ]) {
    assert.equal(typeof document, "string");
    assert.ok(document.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Error mapping — one test per table row, plus the two named ones.
// ---------------------------------------------------------------------------

test("http 401 is LINEAR_REAUTH_REQUIRED", async () => {
  const client = linear(async () => json(graphqlError("Not authenticated"), 401));

  await assert.rejects(client.query("bad-token", IDENTITY_QUERY, {}), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "LINEAR_REAUTH_REQUIRED");
    return true;
  });
});

test("ext AUTHENTICATION_ERROR is LINEAR_REAUTH_REQUIRED", async () => {
  const client = linear(async () =>
    json(graphqlError("Authentication failed", "AUTHENTICATION_ERROR"), 200),
  );

  await assert.rejects(client.query("token", IDENTITY_QUERY, {}), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "LINEAR_REAUTH_REQUIRED");
    return true;
  });
});

test("http 400 RATELIMITED is rate limited", async () => {
  const client = linear(async () =>
    json(graphqlError("Rate limited", "RATELIMITED"), 400, { "Retry-After": "45" }),
  );

  await assert.rejects(client.query("token", IDENTITY_QUERY, {}), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.code, "LINEAR_RATE_LIMITED");
    assert.match(error.message, /45 seconds/);
    return true;
  });
});

test("http 429 without a Retry-After header falls back to 60 seconds", async () => {
  const client = linear(async () => json(graphqlError("Too many requests"), 429));

  await assert.rejects(client.query("token", IDENTITY_QUERY, {}), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.code, "LINEAR_RATE_LIMITED");
    assert.match(error.message, /60 seconds/);
    return true;
  });
});

test("rate limit carries details.retryAfterSeconds", async () => {
  const client = linear(async () =>
    json(graphqlError("Rate limited", "RATELIMITED"), 400, { "Retry-After": "30" }),
  );

  await assert.rejects(client.query("token", IDENTITY_QUERY, {}), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.code, "LINEAR_RATE_LIMITED");
    assert.deepEqual(error.details, { retryAfterSeconds: 30 });
    assert.match(error.message, /30 seconds/);
    return true;
  });
});

test("http 403 is LINEAR_NOT_FOUND", async () => {
  const client = linear(async () => json(graphqlError("Forbidden"), 403));

  await assert.rejects(client.query("token", ISSUE_QUERY, { id: "ENG-1" }), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "LINEAR_NOT_FOUND");
    return true;
  });
});

test("ext FORBIDDEN is LINEAR_NOT_FOUND", async () => {
  const client = linear(async () => json(graphqlError("You cannot see this", "FORBIDDEN"), 200));

  await assert.rejects(client.query("token", ISSUE_QUERY, { id: "ENG-1" }), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "LINEAR_NOT_FOUND");
    return true;
  });
});

test("entity not found is LINEAR_NOT_FOUND", async () => {
  const client = linear(async () => json(graphqlError("Entity not found - could not find Issue"), 200));

  await assert.rejects(client.query("token", ISSUE_QUERY, { id: "ENG-999" }), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "LINEAR_NOT_FOUND");
    return true;
  });
});

test("http 500 is LINEAR_UNAVAILABLE", async () => {
  const client = linear(async () => json({}, 500));

  await assert.rejects(client.query("token", IDENTITY_QUERY, {}), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "LINEAR_UNAVAILABLE");
    return true;
  });
});

test("network error is LINEAR_UNAVAILABLE", async () => {
  const client = linear(async () => {
    throw new Error("socket hang up");
  });

  await assert.rejects(client.query("token", IDENTITY_QUERY, {}), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "LINEAR_UNAVAILABLE");
    return true;
  });
});

test("timeout is LINEAR_UNAVAILABLE", async () => {
  const client = linear(async () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  });

  await assert.rejects(client.query("token", IDENTITY_QUERY, {}), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "LINEAR_UNAVAILABLE");
    return true;
  });
});

test("other 4xx GraphQL error is LINEAR_REQUEST_FAILED", async () => {
  const client = linear(async () => json(graphqlError("Something else went wrong"), 422));

  await assert.rejects(client.query("token", IDENTITY_QUERY, {}), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "LINEAR_REQUEST_FAILED");
    assert.match(error.message, /Linear request failed \(422\)/);
    return true;
  });
});

test("error messages carry no token or variables", async () => {
  const secretToken = "super-secret-access-token-value";
  const searchText = "confidential search text";
  const client = linear(async () => json(graphqlError("Entity not found"), 200));

  await assert.rejects(
    client.query(secretToken, SEARCH_ISSUES_QUERY, { term: searchText, after: null }),
    (error) => {
      assert.ok(error instanceof LinearAdapterError);
      assert.ok(!error.message.includes(secretToken));
      assert.ok(!error.message.includes(searchText));
      assert.ok(!(error.stack ?? "").includes(secretToken));
      assert.ok(!(error.stack ?? "").includes(searchText));
      return true;
    },
  );
});

test("ok response without data is LINEAR_UNAVAILABLE", async () => {
  const bodies: Array<() => Response> = [
    () => new Response("", { status: 200, headers: { "Content-Type": "application/json" } }),
    () => new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    () => json({}),
    () => json({ data: null }),
  ];
  for (const make of bodies) {
    const client = linear(async () => make());
    await assert.rejects(client.query("token", IDENTITY_QUERY, {}), (error) => {
      assert.ok(error instanceof LinearAdapterError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "LINEAR_UNAVAILABLE");
      assert.match(error.message, /Linear request failed \(200\)/);
      return true;
    });
  }
});

test("token response that is not JSON is LINEAR_UNAVAILABLE", async () => {
  const client = linear(async () => new Response("oops", { status: 200 }));

  await assert.rejects(client.refreshAccessToken("stored-refresh-token"), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "LINEAR_UNAVAILABLE");
    return true;
  });
});

test("token response without access_token is LINEAR_UNAVAILABLE", async () => {
  const client = linear(async () => json({ expires_in: 3600, scope: "read" }));

  await assert.rejects(client.refreshAccessToken("stored-refresh-token"), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "LINEAR_UNAVAILABLE");
    return true;
  });
});

test("invalid_client on refresh is LINEAR_UNAVAILABLE", async () => {
  const client = linear(async () => json({ error: "invalid_client" }, 400));

  await assert.rejects(client.refreshAccessToken("stored-refresh-token"), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "LINEAR_UNAVAILABLE");
    return true;
  });
});

test("invalid_grant on refresh is LINEAR_REAUTH_REQUIRED", async () => {
  const client = linear(async () => json({ error: "invalid_grant" }, 400));

  await assert.rejects(client.refreshAccessToken("stored-refresh-token"), (error) => {
    assert.ok(error instanceof LinearAdapterError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "LINEAR_REAUTH_REQUIRED");
    return true;
  });
});

test("token requests pass a timeout signal", async () => {
  const { fetcher, calls } = recordingFetcher((call) =>
    call.url.endsWith("/oauth/token")
      ? json({ access_token: "a", expires_in: 3600, scope: "read" })
      : json({ data: { viewer: { id: "u1" } } }),
  );
  const client = linear(fetcher);

  await client.refreshAccessToken("stored-refresh-token");
  await client.query("access-token", IDENTITY_QUERY, {});

  assert.ok((calls[0]?.init.signal as unknown) instanceof AbortSignal);
  assert.ok((calls[1]?.init.signal as unknown) instanceof AbortSignal);
});
