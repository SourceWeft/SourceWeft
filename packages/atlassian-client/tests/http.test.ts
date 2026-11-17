import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "../src/errors";
import {
  atlassianApiUrl,
  atlassianRequest,
  type AtlassianClientConfig,
  type AtlassianErrorPrefix,
} from "../src/http";

const VALID_CLOUD_ID = "11111111-2222-3333-4444-555555555555";

type RecordedCall = { url: string; init: RequestInit };

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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

function config(
  fetcher: typeof fetch,
  errorPrefix: AtlassianErrorPrefix = "JIRA",
): AtlassianClientConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    errorPrefix,
    fetcher,
  };
}

function requestProjectSearch(client: AtlassianClientConfig) {
  return atlassianRequest(client, {
    accessToken: "access-token",
    product: "jira",
    cloudId: VALID_CLOUD_ID,
    path: "/rest/api/3/project/search",
  });
}

test("api url is built per product", () => {
  assert.equal(
    atlassianApiUrl("jira", VALID_CLOUD_ID, "/rest/api/3/project/search"),
    `https://api.atlassian.com/ex/jira/${VALID_CLOUD_ID}/rest/api/3/project/search`,
  );
  assert.equal(
    atlassianApiUrl("confluence", VALID_CLOUD_ID, "/wiki/api/v2/spaces"),
    `https://api.atlassian.com/ex/confluence/${VALID_CLOUD_ID}/wiki/api/v2/spaces`,
  );
});

test("bad cloud id is rejected without a request", async () => {
  const { fetcher, calls } = recordingFetcher(() => {
    throw new Error("must not call fetch for a bad cloud id");
  });
  const client = config(fetcher);

  await assert.rejects(
    atlassianRequest(client, {
      accessToken: "access-token",
      product: "jira",
      cloudId: "not-a-cloud-id",
      path: "/rest/api/3/project/search",
    }),
    (error) => {
      assert.ok(error instanceof AtlassianApiError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "JIRA_INVALID_REQUEST");
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("atlassianApiUrl rejects a path that does not start with /", () => {
  assert.throws(
    () => atlassianApiUrl("jira", VALID_CLOUD_ID, "rest/api/3/project/search"),
    (error) => {
      assert.ok(error instanceof AtlassianApiError);
      assert.equal(error.code, "JIRA_INVALID_REQUEST");
      return true;
    },
  );
});

test("401 maps to JIRA_REAUTH_REQUIRED", async () => {
  const client = config(async () => json({}, 401));
  await assert.rejects(requestProjectSearch(client), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "JIRA_REAUTH_REQUIRED");
    return true;
  });
});

test("403 maps to JIRA_NOT_FOUND", async () => {
  const client = config(async () => json({}, 403));
  await assert.rejects(requestProjectSearch(client), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "JIRA_NOT_FOUND");
    return true;
  });
});

test("404 maps to JIRA_NOT_FOUND", async () => {
  const client = config(async () => json({}, 404));
  await assert.rejects(requestProjectSearch(client), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "JIRA_NOT_FOUND");
    return true;
  });
});

test("400 maps to JIRA_INVALID_REQUEST", async () => {
  const client = config(async () => json({}, 400));
  await assert.rejects(requestProjectSearch(client), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "JIRA_INVALID_REQUEST");
    return true;
  });
});

test("an unmapped 4xx (418) maps to JIRA_REQUEST_FAILED with the original status", async () => {
  const client = config(async () => json({}, 418));
  await assert.rejects(requestProjectSearch(client), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 418);
    assert.equal(error.code, "JIRA_REQUEST_FAILED");
    return true;
  });
});

test("429 with a Retry-After header maps to JIRA_RATE_LIMITED with that many seconds", async () => {
  const client = config(async () => json({}, 429, { "Retry-After": "7" }));
  await assert.rejects(requestProjectSearch(client), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.code, "JIRA_RATE_LIMITED");
    assert.equal(error.details?.retryAfterSeconds, 7);
    return true;
  });
});

test("429 without a Retry-After header defaults to 60 seconds", async () => {
  const client = config(async () => json({}, 429));
  await assert.rejects(requestProjectSearch(client), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.code, "JIRA_RATE_LIMITED");
    assert.equal(error.details?.retryAfterSeconds, 60);
    return true;
  });
});

test("500 maps to JIRA_UNAVAILABLE with status 503", async () => {
  const client = config(async () => json({}, 500));
  await assert.rejects(requestProjectSearch(client), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("a thrown fetch maps to JIRA_UNAVAILABLE with status 503", async () => {
  const client = config(async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(requestProjectSearch(client), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("array query values repeat the parameter", async () => {
  let capturedUrl = "";
  const client = config(async (url) => {
    capturedUrl = String(url);
    return json({ ok: true });
  });

  await atlassianRequest(client, {
    accessToken: "access-token",
    product: "jira",
    cloudId: VALID_CLOUD_ID,
    path: "/rest/api/3/search",
    query: { fields: ["summary", "status"], maxResults: 10 },
  });

  const url = new URL(capturedUrl);
  assert.deepEqual(url.searchParams.getAll("fields"), ["summary", "status"]);
  assert.equal(url.searchParams.get("maxResults"), "10");
});

test("error messages carry no token", async () => {
  const token = "super-secret-access-token";
  const client = config(async () => json({}, 401));

  await assert.rejects(
    atlassianRequest(client, {
      accessToken: token,
      product: "jira",
      cloudId: VALID_CLOUD_ID,
      path: "/rest/api/3/myself",
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(token));
      assert.ok(!(error.stack ?? "").includes(token));
      return true;
    },
  );
});

test("prefix follows config", async () => {
  const client = config(async () => json({}, 404), "CONFLUENCE");

  await assert.rejects(
    atlassianRequest(client, {
      accessToken: "access-token",
      product: "confluence",
      cloudId: VALID_CLOUD_ID,
      path: "/wiki/api/v2/pages/1",
    }),
    (error) => {
      assert.ok(error instanceof AtlassianApiError);
      assert.equal(error.code, "CONFLUENCE_NOT_FOUND");
      return true;
    },
  );
});
