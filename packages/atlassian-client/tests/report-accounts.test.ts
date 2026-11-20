import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "../src/errors";
import type { AtlassianClientConfig } from "../src/http";
import { REPORT_ACCOUNTS_MAX_BATCH, reportAccounts } from "../src/report-accounts";

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function config(fetcher: typeof fetch, errorPrefix: "JIRA" | "CONFLUENCE" = "JIRA"): AtlassianClientConfig {
  return { clientId: "client-id", clientSecret: "client-secret", errorPrefix, fetcher };
}

const UPDATED_AT = new Date("2026-11-20T10:00:00.000Z");
const ACCOUNTS = [
  { accountId: "acc-1", updatedAt: UPDATED_AT },
  { accountId: "acc-2", updatedAt: UPDATED_AT },
];

function accountsOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({ accountId: `acc-${i}`, updatedAt: UPDATED_AT }));
}

test("sends one POST to the report-accounts endpoint with a bearer token and ISO timestamps", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = config(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  });

  await reportAccounts(client, { accessToken: "access-token", accounts: ACCOUNTS });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.atlassian.com/app/report-accounts/");
  assert.equal(calls[0]?.init.method, "POST");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer access-token");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    accounts: [
      { accountId: "acc-1", updatedAt: "2026-11-20T10:00:00.000Z" },
      { accountId: "acc-2", updatedAt: "2026-11-20T10:00:00.000Z" },
    ],
  });
});

test("204 means nothing to do", async () => {
  const client = config(async () => new Response(null, { status: 204 }));

  const result = await reportAccounts(client, { accessToken: "t", accounts: ACCOUNTS });

  assert.deepEqual(result, { closed: [], updated: [], ignored: 0, cyclePeriodDays: null });
});

test("200 returns the closed and updated account ids", async () => {
  const client = config(async () =>
    json({
      accounts: [
        { accountId: "acc-1", status: "closed" },
        { accountId: "acc-2", status: "updated" },
      ],
    }),
  );

  const result = await reportAccounts(client, { accessToken: "t", accounts: ACCOUNTS });

  assert.deepEqual(result.closed, ["acc-1"]);
  assert.deepEqual(result.updated, ["acc-2"]);
  assert.equal(result.ignored, 0);
});

test("answers that were not sent, unknown, duplicate or malformed are ignored", async () => {
  const client = config(async () =>
    json({
      accounts: [
        { accountId: "acc-1", status: "closed" },
        { accountId: "acc-1", status: "closed" }, // duplicate
        { accountId: "acc-1", status: "updated" }, // duplicate id, different status
        { accountId: "not-sent", status: "closed" }, // never sent
        { accountId: "acc-2", status: "deleted" }, // unknown status
        "acc-2", // non-object
        null, // non-object
        { status: "closed" }, // missing id
      ],
    }),
  );

  const result = await reportAccounts(client, { accessToken: "t", accounts: ACCOUNTS });

  assert.deepEqual(result.closed, ["acc-1"]);
  assert.deepEqual(result.updated, []);
  assert.equal(result.ignored, 7);
});

test("a 200 that is not JSON or lacks accounts is UNAVAILABLE", async () => {
  for (const response of [
    () => new Response("<html>", { status: 200 }),
    () => json({ other: [] }),
    () => json({ accounts: "nope" }),
    () => json(null),
  ]) {
    const client = config(async () => response(), "CONFLUENCE");
    await assert.rejects(reportAccounts(client, { accessToken: "t", accounts: ACCOUNTS }), (error) => {
      assert.ok(error instanceof AtlassianApiError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "CONFLUENCE_UNAVAILABLE");
      return true;
    });
  }
});

test("a network failure is UNAVAILABLE", async () => {
  const client = config(async () => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(reportAccounts(client, { accessToken: "t", accounts: ACCOUNTS }), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.code, "JIRA_UNAVAILABLE");
    return true;
  });
});

test("error statuses are mapped like every other Atlassian call", async () => {
  const cases: [number, number, string][] = [
    [401, 401, "JIRA_REAUTH_REQUIRED"],
    [400, 400, "JIRA_INVALID_REQUEST"],
    [500, 503, "JIRA_UNAVAILABLE"],
    [503, 503, "JIRA_UNAVAILABLE"],
    [429, 429, "JIRA_RATE_LIMITED"],
  ];
  for (const [upstream, statusCode, code] of cases) {
    const client = config(async () => new Response("{}", { status: upstream, headers: { "Retry-After": "30" } }));
    await assert.rejects(reportAccounts(client, { accessToken: "t", accounts: ACCOUNTS }), (error) => {
      assert.ok(error instanceof AtlassianApiError);
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.code, code);
      if (upstream === 429) assert.equal(error.details?.retryAfterSeconds, 30);
      return true;
    });
  }
});

test("zero or more than the batch limit accounts is rejected before any fetch", async () => {
  let calls = 0;
  const client = config(async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  }, "CONFLUENCE");

  assert.equal(REPORT_ACCOUNTS_MAX_BATCH, 90);
  for (const accounts of [[], accountsOf(REPORT_ACCOUNTS_MAX_BATCH + 1)]) {
    await assert.rejects(reportAccounts(client, { accessToken: "t", accounts }), (error) => {
      assert.ok(error instanceof AtlassianApiError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "CONFLUENCE_INVALID_REQUEST");
      return true;
    });
  }
  assert.equal(calls, 0);

  // The limit itself is accepted.
  await reportAccounts(client, { accessToken: "t", accounts: accountsOf(REPORT_ACCOUNTS_MAX_BATCH) });
  assert.equal(calls, 1);
});

// Atlassian's guide only says the `Cycle-Period` header "may" carry a different
// cycle period and never states its format, so the client does not interpret it:
// every header value, including none, yields `null` and callers keep their default.
test("Cycle-Period is not interpreted because its format is undocumented", async () => {
  for (const value of ["14", "14d", "P14D", "1209600", "garbage", ""]) {
    const client = config(async () => json({ accounts: [] }, 200, { "Cycle-Period": value }));
    const result = await reportAccounts(client, { accessToken: "t", accounts: ACCOUNTS });
    assert.equal(result.cyclePeriodDays, null, `value ${JSON.stringify(value)}`);
  }
  const noContent = config(async () => new Response(null, { status: 204, headers: { "Cycle-Period": "14" } }));
  const result = await reportAccounts(noContent, { accessToken: "t", accounts: ACCOUNTS });
  assert.equal(result.cyclePeriodDays, null);
});

test("the request uses the 30 second timeout", async () => {
  const original = AbortSignal.timeout;
  const timeouts: number[] = [];
  AbortSignal.timeout = (ms: number) => {
    timeouts.push(ms);
    return original.call(AbortSignal, ms);
  };
  try {
    const client = config(async () => new Response(null, { status: 204 }));
    await reportAccounts(client, { accessToken: "t", accounts: ACCOUNTS });
  } finally {
    AbortSignal.timeout = original;
  }
  assert.deepEqual(timeouts, [30000]);
});
