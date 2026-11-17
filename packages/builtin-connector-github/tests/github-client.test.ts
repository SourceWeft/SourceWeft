import assert from "node:assert/strict";
import test from "node:test";
import { GithubAdapterError } from "../src/errors";
import { createGithubClient } from "../src/github-client";

type FakeResponse = { status: number; headers?: Record<string, string>; body?: unknown };
type RecordedInit = RequestInit & {
  headers?: Record<string, string>;
  body?: string;
  method?: string;
};
type RecordedCall = { url: string; init: RecordedInit };

/**
 * Builds a `fetch` stand-in that records every call and answers from the
 * supplied handler. A handler that returns an `Error` makes the fetch reject
 * (a network failure); otherwise it resolves with a real `Response` so Octokit
 * can iterate its `Headers` and parse its JSON body exactly as in production.
 */
function makeFetcher(
  handler: (url: string, init: RecordedInit, callIndex: number) => FakeResponse | Error,
): { fetcher: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: unknown, init: RecordedInit = {}) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    const result = handler(url, init, calls.length - 1);
    if (result instanceof Error) {
      throw result;
    }
    const payload =
      result.body === undefined
        ? null
        : typeof result.body === "string"
          ? result.body
          : JSON.stringify(result.body);
    return new Response(payload, {
      status: result.status,
      headers: { "content-type": "application/json", ...(result.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function client(fetcher: typeof fetch) {
  return createGithubClient({
    clientId: "cid",
    clientSecret: "csecret",
    fetcher,
    // Zero so retries and throttle waits take no real time in tests.
    retryBaseMs: 0,
  });
}

async function assertRejects(
  run: () => Promise<unknown>,
  code: string,
  statusCode: number,
  checkDetails?: (details: Record<string, unknown> | undefined) => void,
): Promise<void> {
  await assert.rejects(run(), (error: unknown) => {
    assert.ok(
      error instanceof GithubAdapterError,
      `expected GithubAdapterError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    if (checkDetails) {
      checkDetails(error.details);
    }
    return true;
  });
}

// An error-table assertion runs through a real API call (`GET /user`).
function apiError(response: FakeResponse | Error) {
  const { fetcher, calls } = makeFetcher(() => response);
  return { api: client(fetcher).forToken("gho_token"), calls };
}

test("exchange posts JSON with the Accept header and maps expiry and refresh token", async () => {
  const { fetcher, calls } = makeFetcher(() => ({
    status: 200,
    body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 },
  }));
  const before = Date.now();
  const tokens = await client(fetcher).exchangeAuthorizationCode("the-code", "https://app.test/cb");

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://github.com/login/oauth/access_token");
  assert.equal((call.init.method ?? "").toUpperCase(), "POST");
  const headers = call.init.headers ?? {};
  assert.equal(headers["Accept"], "application/json");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(call.init.body ?? ""), {
    client_id: "cid",
    client_secret: "csecret",
    code: "the-code",
    redirect_uri: "https://app.test/cb",
  });

  assert.equal(tokens.accessToken, "at-1");
  assert.equal(tokens.refreshToken, "rt-1");
  assert.ok(tokens.expiresAt instanceof Date);
  const expiresMs = (tokens.expiresAt as Date).getTime();
  assert.ok(expiresMs >= before + 3_600_000);
  assert.ok(expiresMs <= Date.now() + 3_600_000);
});

test("refresh returns the rotated refresh token", async () => {
  const { fetcher, calls } = makeFetcher(() => ({
    status: 200,
    body: { access_token: "at-2", refresh_token: "rt-rotated", expires_in: 28800 },
  }));
  const tokens = await client(fetcher).refreshAccessToken("rt-old");

  const call = calls[0];
  assert.ok(call);
  assert.deepEqual(JSON.parse(call.init.body ?? ""), {
    client_id: "cid",
    client_secret: "csecret",
    grant_type: "refresh_token",
    refresh_token: "rt-old",
  });
  assert.equal(tokens.accessToken, "at-2");
  assert.equal(tokens.refreshToken, "rt-rotated");
});

test("token endpoint 200 with an error body is a failure", async () => {
  const exchange = makeFetcher(() => ({
    status: 200,
    body: { error: "bad_verification_code", error_description: "nope" },
  }));
  await assertRejects(
    () => client(exchange.fetcher).exchangeAuthorizationCode("c", "u"),
    "GITHUB_OAUTH_EXCHANGE_FAILED",
    400,
  );

  const refresh = makeFetcher(() => ({ status: 200, body: { error: "bad_refresh_token" } }));
  await assertRejects(
    () => client(refresh.fetcher).refreshAccessToken("rt"),
    "GITHUB_REAUTH_REQUIRED",
    400,
  );
});

test("token response without expiry has a null expiresAt and no refresh token", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 200,
    body: { access_token: "at-3", token_type: "bearer", scope: "" },
  }));
  const tokens = await client(fetcher).exchangeAuthorizationCode("c", "u");

  assert.equal(tokens.accessToken, "at-3");
  assert.equal(tokens.expiresAt, null);
  assert.equal(tokens.refreshToken, undefined);
});

test("token endpoint 503 is GITHUB_UNAVAILABLE with statusCode 503", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 503, body: { message: "unavailable" } }));
  await assertRejects(
    () => client(fetcher).exchangeAuthorizationCode("c", "u"),
    "GITHUB_UNAVAILABLE",
    503,
  );
});

// --- token endpoint failure classification (one case per row) --------------

test("refresh: bad_refresh_token is reauth-required", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 200, body: { error: "bad_refresh_token" } }));
  await assertRejects(() => client(fetcher).refreshAccessToken("rt"), "GITHUB_REAUTH_REQUIRED", 400);
});

test("refresh: invalid_grant is reauth-required", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 200, body: { error: "invalid_grant" } }));
  await assertRejects(() => client(fetcher).refreshAccessToken("rt"), "GITHUB_REAUTH_REQUIRED", 400);
});

test("refresh: a wrong client secret is unavailable, not reauth-required", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 200,
    body: { error: "incorrect_client_credentials" },
  }));
  await assertRejects(() => client(fetcher).refreshAccessToken("rt"), "GITHUB_UNAVAILABLE", 503);
});

test("refresh: any other error value is unavailable", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 200, body: { error: "sso_required" } }));
  await assertRejects(() => client(fetcher).refreshAccessToken("rt"), "GITHUB_UNAVAILABLE", 503);
});

test("refresh: an unparseable body is unavailable", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 200, body: "<html>not json</html>" }));
  await assertRejects(() => client(fetcher).refreshAccessToken("rt"), "GITHUB_UNAVAILABLE", 503);
});

test("refresh: a 2xx without an access token is unavailable", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 200, body: { token_type: "bearer" } }));
  await assertRejects(() => client(fetcher).refreshAccessToken("rt"), "GITHUB_UNAVAILABLE", 503);
});

test("refresh: a non-429 4xx is unavailable", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 400, body: { error: "bad_request" } }));
  await assertRejects(() => client(fetcher).refreshAccessToken("rt"), "GITHUB_UNAVAILABLE", 503);
});

test("token endpoint 429 is GITHUB_RATE_LIMITED with retryAfterSeconds", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 429,
    headers: { "retry-after": "42" },
    body: { message: "slow down" },
  }));
  await assertRejects(
    () => client(fetcher).refreshAccessToken("rt"),
    "GITHUB_RATE_LIMITED",
    429,
    (details) => assert.equal(details?.retryAfterSeconds, 42),
  );
});

test("exchange: a wrong client secret is unavailable", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 200,
    body: { error: "incorrect_client_credentials" },
  }));
  await assertRejects(
    () => client(fetcher).exchangeAuthorizationCode("c", "u"),
    "GITHUB_UNAVAILABLE",
    503,
  );
});

test("exchange: unusable bodies are unavailable", async () => {
  const unparseable = makeFetcher(() => ({ status: 200, body: "nonsense" }));
  await assertRejects(
    () => client(unparseable.fetcher).exchangeAuthorizationCode("c", "u"),
    "GITHUB_UNAVAILABLE",
    503,
  );
  const noToken = makeFetcher(() => ({ status: 200, body: { token_type: "bearer" } }));
  await assertRejects(
    () => client(noToken.fetcher).exchangeAuthorizationCode("c", "u"),
    "GITHUB_UNAVAILABLE",
    503,
  );
});

test("exchange: another error value stays GITHUB_OAUTH_EXCHANGE_FAILED", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 200, body: { error: "bad_verification_code" } }));
  await assertRejects(
    () => client(fetcher).exchangeAuthorizationCode("c", "u"),
    "GITHUB_OAUTH_EXCHANGE_FAILED",
    400,
  );
});

test("token requests carry an abort signal", async () => {
  const { fetcher, calls } = makeFetcher(() => ({
    status: 200,
    body: { access_token: "at", expires_in: 3600 },
  }));
  await client(fetcher).refreshAccessToken("rt");
  const call = calls[0];
  assert.ok(call);
  assert.ok(call.init.signal instanceof AbortSignal);
});

// --- unusable 2xx bodies ----------------------------------------------------

test("GraphQL null data is unavailable, not an empty selection", async () => {
  const nullData = makeFetcher(() => ({ status: 200, body: { data: null } }));
  await assertRejects(
    () => client(nullData.fetcher).forToken("t").resolveRepositories(["R_1"]),
    "GITHUB_UNAVAILABLE",
    503,
  );
  const badNodes = makeFetcher(() => ({ status: 200, body: { data: { nodes: "oops" } } }));
  await assertRejects(
    () => client(badNodes.fetcher).forToken("t").resolveRepositories(["R_1"]),
    "GITHUB_UNAVAILABLE",
    503,
  );
});

test("discussion search failure is an error, not an empty page", async () => {
  const { fetcher } = makeFetcher(() => ({ status: 200, body: { data: { search: null } } }));
  await assertRejects(
    () => client(fetcher).forToken("t").searchDiscussions("q", 10, null),
    "GITHUB_UNAVAILABLE",
    503,
  );
});

test("a malformed user profile is rejected", async () => {
  const noId = makeFetcher(() => ({ status: 200, body: { id: 0, login: "octocat" } }));
  await assertRejects(() => client(noId.fetcher).forToken("t").getUser(), "GITHUB_UNAVAILABLE", 503);
  const noLogin = makeFetcher(() => ({ status: 200, body: { id: 5, login: "" } }));
  await assertRejects(() => client(noLogin.fetcher).forToken("t").getUser(), "GITHUB_UNAVAILABLE", 503);
});

test("a failing request writes nothing to the console", async () => {
  const originalWarn = console.warn;
  const originalError = console.error;
  const warnCalls: unknown[][] = [];
  const errorCalls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  try {
    const { fetcher } = makeFetcher(() => ({ status: 500, body: { message: "Server Error" } }));
    await assert.rejects(() => client(fetcher).forToken("gho_secret").getUser());
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert.deepEqual(warnCalls, []);
  assert.deepEqual(errorCalls, []);
});

test("401 is GITHUB_REAUTH_REQUIRED", async () => {
  const { api } = apiError({ status: 401, body: { message: "Bad credentials" } });
  await assertRejects(() => api.getUser(), "GITHUB_REAUTH_REQUIRED", 401);
});

test("429 is GITHUB_RATE_LIMITED with retryAfterSeconds from retry-after", async () => {
  const { api, calls } = apiError({
    status: 429,
    headers: { "retry-after": "30" },
    body: { message: "Too many requests" },
  });
  await assertRejects(() => api.getUser(), "GITHUB_RATE_LIMITED", 429, (details) => {
    assert.equal(details?.retryAfterSeconds, 30);
  });
  assert.equal(calls.length, 1);
});

test("secondary rate limit 403 with retry-after is GITHUB_RATE_LIMITED", async () => {
  const { api } = apiError({
    status: 403,
    headers: { "retry-after": "60" },
    body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes." },
  });
  await assertRejects(() => api.getUser(), "GITHUB_RATE_LIMITED", 429, (details) => {
    assert.equal(details?.retryAfterSeconds, 60);
  });
});

test("403 without rate-limit headers is GITHUB_NOT_FOUND", async () => {
  const { api } = apiError({ status: 403, body: { message: "Resource not accessible by integration" } });
  await assertRejects(() => api.getUser(), "GITHUB_NOT_FOUND", 404);
});

test("404 and 410 are GITHUB_NOT_FOUND", async () => {
  const notFound = apiError({ status: 404, body: { message: "Not Found" } });
  await assertRejects(() => notFound.api.getUser(), "GITHUB_NOT_FOUND", 404);

  const gone = apiError({ status: 410, body: { message: "Issues are disabled" } });
  await assertRejects(() => gone.api.getUser(), "GITHUB_NOT_FOUND", 404);
});

test("422 is GITHUB_INVALID_REQUEST", async () => {
  const { api } = apiError({ status: 422, body: { message: "Validation Failed" } });
  await assertRejects(() => api.getUser(), "GITHUB_INVALID_REQUEST", 400);
});

test("a network error is GITHUB_UNAVAILABLE", async () => {
  const { api } = apiError(new Error("socket hang up"));
  await assertRejects(() => api.getUser(), "GITHUB_UNAVAILABLE", 503);
});

test("another 4xx is GITHUB_REQUEST_FAILED carrying the status, and is not retried", async () => {
  const { api, calls } = apiError({ status: 405, body: { message: "Method Not Allowed" } });
  await assertRejects(() => api.getUser(), "GITHUB_REQUEST_FAILED", 405);
  assert.equal(calls.length, 1);
});

test("a 500 is retried once then fails", async () => {
  const { api, calls } = apiError({ status: 500, body: { message: "Server Error" } });
  await assertRejects(() => api.getUser(), "GITHUB_UNAVAILABLE", 503);
  assert.equal(calls.length, 2);
});

function repoNode(id: string, nameWithOwner: string) {
  return {
    id,
    nameWithOwner,
    name: nameWithOwner.split("/")[1],
    url: `https://github.com/${nameWithOwner}`,
    description: null,
    isPrivate: false,
    isArchived: false,
    defaultBranchRef: { name: "main" },
  };
}

test("resolveRepositories keeps request order and nulls unknown ids", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 200,
    // Index 1 is an unresolvable id (null); index 2 is a non-repository node ({}).
    body: { data: { nodes: [repoNode("R_1", "acme/one"), null, {}] } },
  }));
  const result = await client(fetcher)
    .forToken("t")
    .resolveRepositories(["R_1", "R_missing", "R_user"]);

  assert.equal(result.length, 3);
  assert.deepEqual(result[0], {
    id: "R_1",
    nameWithOwner: "acme/one",
    name: "one",
    url: "https://github.com/acme/one",
    description: null,
    isPrivate: false,
    isArchived: false,
    defaultBranch: "main",
  });
  assert.equal(result[1], null);
  assert.equal(result[2], null);
});

test("resolveRepositories uses data when GraphQL also reports errors", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 200,
    body: {
      data: { nodes: [repoNode("R_1", "acme/one"), null] },
      errors: [
        {
          type: "NOT_FOUND",
          message: "Could not resolve to a node with the global id of 'R_bad'",
        },
      ],
    },
  }));
  const result = await client(fetcher).forToken("t").resolveRepositories(["R_1", "R_bad"]);

  assert.equal(result.length, 2);
  assert.equal(result[0]?.id, "R_1");
  assert.equal(result[0]?.nameWithOwner, "acme/one");
  assert.equal(result[1], null);
});

test("error messages carry no token", async () => {
  const token = "ghs_SUPERSECRETTOKENvalue0123456789abcd";
  const { fetcher, calls } = makeFetcher(() => ({ status: 401, body: { message: "Bad credentials" } }));

  await assert.rejects(
    () => client(fetcher).forToken(token).getUser(),
    (error: unknown) => {
      assert.ok(error instanceof GithubAdapterError);
      assert.equal(
        error.message,
        "GitHub no longer accepts this connection. Ask the user to reconnect GitHub in the connector settings.",
      );
      assert.ok(!error.message.includes(token), "message must not contain the token");
      assert.ok(!(error.stack ?? "").includes(token), "stack must not contain the token");
      return true;
    },
  );

  // Sanity: the token really was sent, so the assertions above are meaningful.
  const call = calls[0];
  assert.ok(call);
  assert.ok(JSON.stringify(call.init.headers ?? {}).includes(token));
});
