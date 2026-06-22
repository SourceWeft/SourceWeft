import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ALLOWED_MODEL_ALIASES,
  ModelGatewayError,
  resolveModelGatewayConfig,
  resolveRequestTarget,
} from "../src/index";
import {
  assertModelAliasAllowed,
  buildRequestHeaders,
} from "../src/config";

const fetchStub: typeof fetch = async () => new Response("{}", { status: 200 });

test("resolveModelGatewayConfig normalizes values and applies defaults", () => {
  const resolved = resolveModelGatewayConfig({
    baseUrl: "https://gateway.example.com///",
    apiKey: "secret-token",
    fetch: fetchStub,
    defaultHeaders: {
      "X-App": "model-gateway-test",
    },
  });

  assert.equal(resolved.baseUrl, "https://gateway.example.com");
  assert.equal(resolved.timeoutMs, 30_000);
  assert.equal(resolved.maxRetries, 2);
  assert.deepEqual(resolved.allowedModelAliases, DEFAULT_ALLOWED_MODEL_ALIASES);
  assert.deepEqual(resolved.defaultHeaders, {
    "Content-Type": "application/json",
    "X-App": "model-gateway-test",
  });

  assert.deepEqual(buildRequestHeaders(resolved, { idempotencyKey: "idem-1" }), {
    "Content-Type": "application/json",
    "X-App": "model-gateway-test",
    Authorization: "Bearer secret-token",
    "Idempotency-Key": "idem-1",
  });
});

test("buildRequestHeaders supports custom API key headers", () => {
  const headers = buildRequestHeaders({
    defaultHeaders: {
      "Content-Type": "application/json",
    },
    apiKey: "cf-token",
    apiKeyHeaderName: "cf-aig-authorization",
    apiKeyHeaderPrefix: "Bearer ",
  });

  assert.deepEqual(headers, {
    "Content-Type": "application/json",
    "cf-aig-authorization": "Bearer cf-token",
  });
});

test("resolveRequestTarget carries provider custom API key header config", async () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    providers: {
      "cloudflare-aig": {
        kind: "openai-compatible",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/compat",
        apiKey: "cf-token",
        apiKeyHeaderName: "cf-aig-authorization",
        apiKeyHeaderPrefix: "Bearer ",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [
          {
            provider: "cloudflare-aig",
            model: "deepseek/deepseek-v4-pro",
            priority: 1,
          },
        ],
      },
    },
  });

  const target = await resolveRequestTarget(resolved, {
    model: "chat-default",
  });

  assert.equal(target.provider, "cloudflare-aig");
  assert.equal(target.providerKind, "openai-compatible");
  assert.equal(target.providerModel, "deepseek/deepseek-v4-pro");
  assert.equal(target.apiKey, "cf-token");
  assert.equal(target.apiKeyHeaderName, "cf-aig-authorization");
  assert.equal(target.apiKeyHeaderPrefix, "Bearer ");
});

test("resolveModelGatewayConfig rejects disallowed base URLs", () => {
  assert.throws(
    () =>
      resolveModelGatewayConfig({
        baseUrl: "https://gateway.example.com",
        fetch: fetchStub,
        allowedBaseUrls: ["https://allowed.example.com"],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "AUTH");
      return true;
    },
  );
});

test("assertModelAliasAllowed enforces configured aliases", () => {
  const resolved = resolveModelGatewayConfig({
    baseUrl: "https://gateway.example.com",
    fetch: fetchStub,
    allowedModelAliases: ["chat-default", "embed-default"],
  });

  assert.doesNotThrow(() => assertModelAliasAllowed("chat-default", resolved));

  assert.throws(
    () => assertModelAliasAllowed("custom-model", resolved),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "BAD_REQUEST");
      assert.match(error.message, /custom-model/);
      return true;
    },
  );
});

test("assertModelAliasAllowed can be bypassed when custom aliases are enabled", () => {
  const resolved = resolveModelGatewayConfig({
    baseUrl: "https://gateway.example.com",
    fetch: fetchStub,
    allowNonDefaultAliases: true,
  });

  assert.doesNotThrow(() => assertModelAliasAllowed("custom-model", resolved));
});


test("resolveModelGatewayConfig supports explicit providers and model routes", () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "or-key",
      },
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "di-key",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [
          { provider: "openrouter", model: "openai/gpt-4o-mini", priority: 1 },
          { provider: "deepinfra", model: "meta-llama/Meta-Llama-3.1-70B-Instruct", priority: 2 },
        ],
      },
    },
  });

  assert.equal(resolved.providers.openrouter?.kind, "openrouter");
  assert.equal(resolved.routes["chat-default"]?.targets[0]?.provider, "openrouter");
  assert.equal(resolved.routes["chat-default"]?.targets[1]?.provider, "deepinfra");
});

test("resolveRequestTarget carries provider routing from selected route target", async () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "or-key",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [
          {
            provider: "openrouter",
            model: "deepseek/deepseek-v4-pro",
            priority: 1,
            providerRouting: {
              only: ["deepseek"],
              sort: "latency",
            },
          },
        ],
      },
    },
  });

  const target = await resolveRequestTarget(resolved, {
    model: "chat-default",
  });

  assert.deepEqual(target.providerRouting, {
    only: ["deepseek"],
    sort: "latency",
  });
  assert.deepEqual(target.routeDecision.providerRouting, {
    only: ["deepseek"],
    sort: "latency",
  });
});


test("resolveModelGatewayConfig accepts openai and azure-openai providers", () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
      },
      azure: {
        kind: "azure-openai",
        baseUrl: "https://example.openai.azure.com/openai",
        apiKey: "azure-key",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
      },
    },
  });

  assert.equal(resolved.providers.openai?.kind, "openai");
  assert.equal(resolved.providers.azure?.kind, "azure-openai");
});


test("resolveModelGatewayConfig accepts anthropic providers", () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    providers: {
      anthropic: {
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "anthropic-key",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [{ provider: "anthropic", model: "claude-3-5-sonnet-latest", priority: 1 }],
      },
    },
  });

  assert.equal(resolved.providers.anthropic?.kind, "anthropic");
});


test("resolveModelGatewayConfig accepts gemini providers", () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    providers: {
      gemini: {
        kind: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-key",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [{ provider: "gemini", model: "gemini-2.0-flash", priority: 1 }],
      },
    },
  });

  assert.equal(resolved.providers.gemini?.kind, "gemini");
});

test("resolveRequestTarget prefers profileAlias for GLOBAL routing", async () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    allowNonDefaultAliases: true,
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
      },
    },
    modelRoutes: {
      "profile-private": {
        strategy: "priority",
        targets: [{ provider: "openai", model: "gpt-4.1-mini", priority: 1 }],
      },
    },
  });

  const target = await resolveRequestTarget(resolved, {
    model: "chat-default",
    profileAlias: "profile-private",
  });

  assert.equal(target.provider, "openai");
  assert.equal(target.providerModel, "gpt-4.1-mini");
  assert.deepEqual(target.routeDecision, {
    alias: "profile-private",
    mode: "GLOBAL",
    strategy: "priority",
    provider: "openai",
    providerKind: "openai",
  });
});

test("resolveRequestTarget falls back to custom BYOK provider resolver", async () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    baseUrl: "https://gateway.example.com",
    byokProviderAllowList: ["custom-openai"],
    resolveCustomByokProvider: async (input) => {
      assert.equal(input.provider, "custom-openai");
      assert.equal(input.model, "my-custom-model");
      assert.equal(input.profileAlias, undefined);
      assert.equal(input.apiKey, "user-key");
      assert.deepEqual(input.metadata, { workspaceId: "ws-1" });
      return {
        kind: "openai-compatible",
        baseUrl: "https://custom.example.com/v1/",
        defaultHeaders: {
          "X-Custom": "1",
        },
      };
    },
  });

  const target = await resolveRequestTarget(resolved, {
    executionMode: "BYOK",
    model: "my-custom-model",
    byok: {
      provider: "custom-openai",
      apiKey: "user-key",
    },
    metadata: {
      workspaceId: "ws-1",
    },
  });

  assert.equal(target.provider, "custom-openai");
  assert.equal(target.providerKind, "openai-compatible");
  assert.equal(target.providerModel, "my-custom-model");
  assert.equal(target.baseUrl, "https://custom.example.com/v1");
  assert.equal(target.apiKey, "user-key");
  assert.deepEqual(target.defaultHeaders, {
    "X-Custom": "1",
  });
  assert.deepEqual(target.routeDecision, {
    alias: "custom-openai:my-custom-model",
    mode: "BYOK",
    strategy: "priority",
    provider: "custom-openai",
    providerKind: "openai-compatible",
  });
});

test("resolveRequestTarget prefers inline BYOK credential endpoint over system provider", async () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    allowedBaseUrls: [
      "https://api.openai.com/v1",
      "https://tenant-openai.example.com/v1",
    ],
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "global-openai-key",
        defaultHeaders: {
          "X-Global": "1",
        },
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [{ provider: "openai", model: "gpt-4.1-mini", priority: 1 }],
      },
    },
  });

  const target = await resolveRequestTarget(resolved, {
    executionMode: "BYOK",
    model: "gpt-4o",
    byok: {
      provider: "openai",
      providerKind: "openai-compatible",
      baseUrl: "https://tenant-openai.example.com/v1/",
      apiKey: "tenant-key",
      defaultHeaders: {
        "X-Tenant": "yes",
      },
    },
  });

  assert.equal(target.provider, "openai");
  assert.equal(target.providerKind, "openai-compatible");
  assert.equal(target.providerModel, "gpt-4o");
  assert.equal(target.baseUrl, "https://tenant-openai.example.com/v1");
  assert.equal(target.apiKey, "tenant-key");
  assert.deepEqual(target.defaultHeaders, {
    "X-Tenant": "yes",
  });
  assert.deepEqual(target.routeDecision, {
    alias: "openai:gpt-4o",
    mode: "BYOK",
    strategy: "priority",
    provider: "openai",
    providerKind: "openai-compatible",
  });
});

test("resolveRequestTarget uses provider-qualified BYOK routeDecision alias", async () => {
  const resolved = resolveModelGatewayConfig({
    fetch: fetchStub,
    baseUrl: "https://gateway.example.com",
    providers: {
      deepseek: {
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [{ provider: "deepseek", model: "deepseek-chat", priority: 1 }],
      },
    },
  });

  const target = await resolveRequestTarget(resolved, {
    executionMode: "BYOK",
    model: "deepseek-chat",
    byok: {
      provider: "deepseek",
      apiKey: "deepseek-key",
    },
  });

  assert.equal(target.providerModel, "deepseek-chat");
  assert.equal(target.routeDecision.alias, "deepseek:deepseek-chat");
  assert.equal(target.routeDecision.mode, "BYOK");
});
