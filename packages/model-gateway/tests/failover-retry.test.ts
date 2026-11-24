/**
 * Same-provider SDK retries against failover: with another route target
 * waiting, a rate-limited, unfunded or unauthorized provider is not retried —
 * the request moves on at once, even when the provider asks to retry after a
 * short wait. Transient faults keep their retry, and the last target keeps its
 * whole retry budget.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../src/index";
import { resolveRequestDefaults } from "../src/request-options";
import { TargetHealthRegistry } from "../src/target-health";
import type { ModelGatewayConfig } from "../src/types";
import { createJsonResponse, makeResolvedTarget } from "./helpers";

const payload = {
  model: "chat-default",
  messages: [{ role: "user" as const, content: "hello" }],
};

function success() {
  return createJsonResponse({
    id: "failover-retry",
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/**
 * A 429 carries a short `Retry-After`: that is the rate limit LangChain waits
 * out and retries (a bare 429, a 401 and a 402 it already gives up on).
 */
function failure(status: number) {
  return createJsonResponse(
    { error: { message: `HTTP ${status}` } },
    { status, ...(status === 429 ? { headers: { "Retry-After": "0" } } : {}) },
  );
}

/** Counts requests per host; `respond` answers the n-th request to a host. */
function config(
  hosts: string[],
  respond: (host: string, count: number) => Response,
): { settings: ModelGatewayConfig; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const providers: ModelGatewayConfig["providers"] = {};
  for (const host of hosts) {
    counts[host] = 0;
    providers[host] = {
      kind: "openai-compatible",
      baseUrl: `https://${host}.example/v1`,
      apiKey: "test-key",
      maxRetries: 1,
    };
  }
  return {
    counts,
    settings: {
      timeoutMs: 5_000,
      targetHealth: new TargetHealthRegistry(),
      fetch: async (input) => {
        const host = new URL(String(input)).hostname.split(".")[0]!;
        counts[host] = (counts[host] ?? 0) + 1;
        return respond(host, counts[host]!);
      },
      providers,
      modelRoutes: {
        "chat-default": {
          strategy: "priority",
          targets: hosts.map((host, index) => ({
            provider: host,
            model: "test-model",
            priority: index + 1,
          })),
        },
      },
    },
  };
}

for (const [status, label] of [
  [429, "rate limit"],
  [402, "quota"],
  [401, "auth"],
] as const) {
  test(`a ${label} (${status}) fails over without a same-provider retry`, async () => {
    const { settings, counts } = config(["first", "second"], (host) =>
      host === "first" ? failure(status) : success(),
    );

    await createModelGateway(settings).chat.complete(payload);

    assert.deepEqual(counts, { first: 1, second: 1 });
  });
}

test("a transient upstream fault keeps its same-provider retry", async () => {
  const { settings, counts } = config(["first", "second"], (host, count) =>
    host === "first" && count === 1 ? failure(503) : success(),
  );

  await createModelGateway(settings).chat.complete(payload);

  assert.deepEqual(counts, { first: 2, second: 0 });
});

test("the last target keeps its retry for a rate limit", async () => {
  const { settings, counts } = config(["only"], (_host, count) =>
    count === 1 ? failure(429) : success(),
  );

  await createModelGateway(settings).chat.complete(payload);

  assert.deepEqual(counts, { only: 2 });
});

test("request defaults say whether another target remains", () => {
  const settings = { timeoutMs: 1_000, maxRetries: 2 };
  const attempt = (index: number, of: number) =>
    makeResolvedTarget({
      routeDecision: { attempt: { index, of, primaryProvider: "openai" } },
    });

  assert.equal(
    resolveRequestDefaults(settings, attempt(1, 2)).failoverAvailable,
    true,
  );
  assert.equal(
    resolveRequestDefaults(settings, attempt(2, 2)).failoverAvailable,
    false,
  );
  // Outside a failover chain the caller's options pass through untouched.
  assert.equal(
    "failoverAvailable" in
      resolveRequestDefaults(settings, makeResolvedTarget()),
    false,
  );
});

test("the retry log says no retry follows when the SDK refuses one", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const { settings, counts } = config(["only"], () =>
    createJsonResponse({ error: { message: "bad key" } }, { status: 401 }),
  );
  settings.logger = {
    warn: (event, fields) => {
      if (event === "model-gateway.retry") logs.push(fields ?? {});
    },
  };

  await assert.rejects(createModelGateway(settings).chat.complete(payload));

  // maxRetries is 1, but LangChain never retries a 401.
  assert.deepEqual(counts, { only: 1 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.willRetry, false);
  assert.equal(logs[0]?.errorCode, "AUTH");
});

test("the retry log marks a failure sent to the next target", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const { settings } = config(["first", "second"], (host) =>
    host === "first" ? failure(429) : success(),
  );
  settings.logger = {
    warn: (event, fields) => {
      if (event === "model-gateway.retry") logs.push(fields ?? {});
    },
  };

  await createModelGateway(settings).chat.complete(payload);

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.willRetry, false);
  assert.equal(logs[0]?.failover, true);
  assert.equal(logs[0]?.provider, "first");
});
