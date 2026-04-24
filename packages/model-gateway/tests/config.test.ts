import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ALLOWED_MODEL_ALIASES,
  ModelGatewayError,
  resolveModelGatewayConfig,
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
        baseUrl: "https://api.deepinfra.com/v1/openai",
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
