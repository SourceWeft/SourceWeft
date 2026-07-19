import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createRequestConfig,
  resolveModelGatewayConfig,
  resolveRequestTarget,
} from "@sourceweft/model-gateway";
import {
  buildRoutedModelGatewayConfig,
  getOrCreateRoutedGatewayClient,
  normalizeRouteProviderRouting,
  withOpenRouterAttributionHeaders,
} from "./runtime";
import type { RoutedGatewayConfig } from "./types";

function routedConfigFixture(versionId: string): RoutedGatewayConfig {
  return {
    versionId,
    providers: {
      primary: {
        gatewayConfigId: null,
        kind: "openai-compatible",
        baseUrl: "https://example.invalid/v1",
        isBYOK: false,
        hasGlobalApiKey: true,
        apiKey: "test-key",
        defaultHeaders: {},
        supports: ["chat"],
        timeoutMs: 30_000,
        maxRetries: 2,
      },
    },
    modelRoutes: {
      "test-alias": {
        strategy: "priority",
        targets: [{ provider: "primary", model: "test-model", priority: 1 }],
      },
    },
  };
}

test("withOpenRouterAttributionHeaders adds current and legacy OpenRouter attribution headers", () => {
  const headers = withOpenRouterAttributionHeaders({
    providerKind: "openrouter",
    defaultHeaders: {
      "X-Custom": "keep",
    },
  });

  assert.equal(headers["X-Custom"], "keep");
  assert.equal(headers["X-OpenRouter-Title"], "SourceWeft");
  assert.equal(headers["X-Title"], "SourceWeft");
  assert.equal(headers["HTTP-Referer"], "https://sourceweft.com");
});

test("withOpenRouterAttributionHeaders leaves non-OpenRouter headers unchanged", () => {
  const headers = withOpenRouterAttributionHeaders({
    providerKind: "openai-compatible",
    defaultHeaders: {
      "X-Custom": "keep",
    },
  });

  assert.deepEqual(headers, {
    "X-Custom": "keep",
  });
});

test("normalizeRouteProviderRouting reads provider routing from route constraints", () => {
  assert.deepEqual(
    normalizeRouteProviderRouting({
      providerRouting: {
        only: ["deepseek"],
        sort: {
          by: "throughput",
          partition: "none",
        },
      },
    }),
    {
      only: ["deepseek"],
      sort: {
        by: "throughput",
        partition: "none",
      },
    },
  );
  assert.equal(normalizeRouteProviderRouting({}), undefined);
});

test("buildRoutedModelGatewayConfig keeps provider limits per provider", () => {
  const built = buildRoutedModelGatewayConfig({
    versionId: "version-timeouts",
    providers: {
      fast: {
        gatewayConfigId: null,
        kind: "openai-compatible",
        baseUrl: "https://fast.invalid/v1",
        isBYOK: false,
        hasGlobalApiKey: true,
        defaultHeaders: {},
        supports: ["chat"],
        timeoutMs: 30_000,
        maxRetries: 2,
      },
      slow: {
        gatewayConfigId: null,
        kind: "openai-compatible",
        baseUrl: "https://slow.invalid/v1",
        isBYOK: false,
        hasGlobalApiKey: true,
        defaultHeaders: {},
        supports: ["video"],
        timeoutMs: 120_000,
        maxRetries: 1,
      },
    },
    modelRoutes: {},
  });

  // The slow provider's 120s budget must not become every provider's ceiling.
  assert.equal(built.providers?.fast?.timeoutMs, 30_000);
  assert.equal(built.providers?.slow?.timeoutMs, 120_000);
  assert.equal(built.providers?.fast?.maxRetries, 2);
  assert.equal(built.providers?.slow?.maxRetries, 1);
  assert.equal(built.timeoutMs, 30_000);
});

test("per-provider limits survive resolution into the request config", async () => {
  const built = buildRoutedModelGatewayConfig({
    versionId: "version-resolved",
    providers: {
      slow: {
        gatewayConfigId: null,
        kind: "openai-compatible",
        baseUrl: "https://slow.invalid/v1",
        isBYOK: false,
        hasGlobalApiKey: true,
        apiKey: "test-key",
        defaultHeaders: {},
        supports: ["chat"],
        timeoutMs: 120_000,
        maxRetries: 1,
      },
    },
    modelRoutes: {
      "slow-alias": {
        strategy: "priority",
        targets: [{ provider: "slow", model: "slow-model", priority: 1 }],
      },
    },
  });

  const resolved = resolveModelGatewayConfig(built);
  const target = await resolveRequestTarget(resolved, { model: "slow-alias" });
  // Guards the full chain: input config -> normalize -> target -> request
  // config. A drop anywhere in between silently reverts to the gateway default.
  assert.equal(createRequestConfig(resolved, target).timeoutMs, 120_000);
});

test("getOrCreateRoutedGatewayClient reuses the client for an unchanged config version", () => {
  const config = routedConfigFixture("version-reuse");

  assert.equal(
    getOrCreateRoutedGatewayClient(config),
    getOrCreateRoutedGatewayClient(config),
  );
});

test("getOrCreateRoutedGatewayClient evicts clients from superseded config versions", () => {
  const first = getOrCreateRoutedGatewayClient(routedConfigFixture("version-a"));
  const second = getOrCreateRoutedGatewayClient(
    routedConfigFixture("version-b"),
  );
  assert.notEqual(first, second);

  // Re-requesting the superseded version must rebuild rather than hit a cached
  // entry: a retained entry here is the memory leak this eviction prevents.
  const firstAgain = getOrCreateRoutedGatewayClient(
    routedConfigFixture("version-a"),
  );
  assert.notEqual(firstAgain, first);
});
