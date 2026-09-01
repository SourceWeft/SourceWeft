import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicChatAdapter } from "../src/adapters/anthropic-chat";
import { AzureChatAdapter } from "../src/adapters/azure-chat";
import { DeepInfraChatAdapter } from "../src/adapters/deepinfra-chat";
import { OpenAICompatibleChatAdapter } from "../src/adapters/openai-compatible-chat";
import { OpenRouterChatAdapter } from "../src/adapters/openrouter-chat";
import { ModelGatewayError } from "../src/errors";
import type {
  ChatCompleteInput,
  RequestOptions,
  ResolvedRequestTarget,
} from "../src/types";

const target: ResolvedRequestTarget = {
  provider: "openai",
  providerKind: "openai",
  providerModel: "test-model",
  baseUrl: "https://gateway.example.com",
  apiKey: "test-key",
  defaultHeaders: {},
  supports: ["chat", "tool_calling", "json_schema"],
  routeDecision: {
    alias: "chat-default",
    mode: "GLOBAL",
    strategy: "priority",
    provider: "openai",
    providerKind: "openai",
  },
  requestMetadata: {},
};

const input: ChatCompleteInput = {
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
};

function modelRetryCount(model: unknown) {
  const caller = (model as { caller?: { maxRetries?: unknown } }).caller;
  return caller?.maxRetries;
}

function createWithOptions(createModel: (options?: RequestOptions) => unknown) {
  return {
    withoutOptions: createModel(),
    withoutRetries: createModel({ maxRetries: 0 }),
    withRetries: createModel({ maxRetries: 1 }),
  };
}

test("chat adapters preserve request maxRetries for LangChain models", () => {
  const adapters = [
    new OpenAICompatibleChatAdapter(),
    new OpenRouterChatAdapter(),
    new DeepInfraChatAdapter(),
    new AzureChatAdapter(),
    new AnthropicChatAdapter(),
  ];

  for (const adapter of adapters) {
    const models = createWithOptions((options) =>
      adapter.createModel(target, input, options),
    );

    assert.equal(
      modelRetryCount(models.withoutOptions),
      2,
      `${adapter.kind} should keep the legacy default retry count`,
    );
    assert.equal(
      modelRetryCount(models.withoutRetries),
      0,
      `${adapter.kind} should allow callers to disable SDK retries`,
    );
    assert.equal(
      modelRetryCount(models.withRetries),
      1,
      `${adapter.kind} should honor per-request retry count`,
    );
  }
});

function modelKwargs(model: unknown) {
  return (model as { modelKwargs?: unknown }).modelKwargs;
}

function clientConfig(model: unknown) {
  return (model as { clientConfig?: Record<string, unknown> }).clientConfig;
}

test("OpenAI-compatible chat adapter configures custom API key headers through LangChain", () => {
  const adapter = new OpenAICompatibleChatAdapter();
  const model = adapter.createModel(
    {
      ...target,
      provider: "cloudflare-aig",
      providerKind: "openai-compatible",
      providerModel: "deepseek/deepseek-v4-pro",
      apiKey: "cf-token",
      apiKeyHeaderName: "cf-aig-authorization",
      apiKeyHeaderPrefix: "Bearer ",
      defaultHeaders: {
        "HTTP-Referer": "https://sourceweft.example",
      },
      routeDecision: {
        ...target.routeDecision,
        provider: "cloudflare-aig",
        providerKind: "openai-compatible",
      },
    },
    input,
  );

  assert.deepEqual(clientConfig(model)?.defaultHeaders, {
    "HTTP-Referer": "https://sourceweft.example",
    Authorization: null,
    "cf-aig-authorization": "Bearer cf-token",
  });
});

test("OpenAI-compatible chat adapter forwards timeout and disables supported reasoning", () => {
  const adapter = new OpenAICompatibleChatAdapter();
  const model = adapter.createModel(
    {
      ...target,
      provider: "cloudflare-aig",
      providerKind: "openai-compatible",
      providerModel: "deepseek/deepseek-v4-pro",
      supports: ["chat", "json_schema"],
      routeDecision: {
        ...target.routeDecision,
        provider: "cloudflare-aig",
        providerKind: "openai-compatible",
      },
    },
    {
      ...input,
      thinking: {
        mode: "off",
        supportedParameters: ["reasoning", "include_reasoning"],
      },
    },
    {
      maxRetries: 0,
      timeoutMs: 12_345,
    },
  );

  assert.equal(modelRetryCount(model), 0);
  assert.equal((model as { timeout?: unknown }).timeout, 12_345);
  // "off" must actually stop reasoning (effort "none"), not merely hide it —
  // hidden reasoning still burns the max_tokens budget.
  assert.deepEqual(modelKwargs(model), {
    reasoning: {
      effort: "none",
      exclude: true,
    },
  });
});

test("OpenAI-compatible chat adapter keeps standard SDK auth without custom headers", () => {
  const adapter = new OpenAICompatibleChatAdapter();
  const model = adapter.createModel(
    {
      ...target,
      providerKind: "openai-compatible",
      defaultHeaders: {
        "HTTP-Referer": "https://sourceweft.example",
      },
      routeDecision: {
        ...target.routeDecision,
        providerKind: "openai-compatible",
      },
    },
    input,
  );

  assert.deepEqual(clientConfig(model)?.defaultHeaders, {
    "HTTP-Referer": "https://sourceweft.example",
  });
});

test("OpenRouter chat adapter merges provider routing into model kwargs", () => {
  const adapter = new OpenRouterChatAdapter();
  const model = adapter.createModel(
    {
      ...target,
      provider: "openrouter",
      providerKind: "openrouter",
      providerRouting: {
        only: ["deepseek"],
        sort: "latency",
      },
      routeDecision: {
        ...target.routeDecision,
        provider: "openrouter",
        providerKind: "openrouter",
      },
    },
    {
      ...input,
      extraBody: {
        provider: {
          allow_fallbacks: false,
          sort: "price",
        },
      },
    },
  );

  assert.deepEqual(modelKwargs(model), {
    provider: {
      allow_fallbacks: false,
      only: ["deepseek"],
      sort: "latency",
    },
  });
});

test("OpenRouter chat adapter supports object provider routing sort", () => {
  const adapter = new OpenRouterChatAdapter();
  const model = adapter.createModel(
    {
      ...target,
      provider: "openrouter",
      providerKind: "openrouter",
      providerRouting: {
        sort: {
          by: "throughput",
          partition: "none",
        },
      },
      routeDecision: {
        ...target.routeDecision,
        provider: "openrouter",
        providerKind: "openrouter",
      },
    },
    input,
  );

  assert.deepEqual(modelKwargs(model), {
    provider: {
      sort: {
        by: "throughput",
        partition: "none",
      },
    },
  });
});

test("OpenRouter chat adapter fails fast with a typed auth error when credentials are missing", () => {
  const adapter = new OpenRouterChatAdapter();

  assert.throws(
    () =>
      adapter.createModel(
        {
          ...target,
          apiKey: undefined,
          provider: "openrouter",
          providerKind: "openrouter",
          routeDecision: {
            ...target.routeDecision,
            provider: "openrouter",
            providerKind: "openrouter",
          },
        },
        input,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "AUTH");
      assert.equal(error.retryable, false);
      assert.equal(error.provider, "openrouter");
      assert.equal(error.message, "OpenRouter API key is not configured");
      return true;
    },
  );
});

test("OpenRouter chat adapter does not treat an Authorization header as the SDK API key", () => {
  const adapter = new OpenRouterChatAdapter();

  assert.throws(
    () =>
      adapter.createModel(
        {
          ...target,
          apiKey: undefined,
          defaultHeaders: { Authorization: "Bearer header-only" },
          provider: "openrouter",
          providerKind: "openrouter",
          routeDecision: {
            ...target.routeDecision,
            provider: "openrouter",
            providerKind: "openrouter",
          },
        },
        input,
      ),
    (error: unknown) =>
      error instanceof ModelGatewayError && error.code === "AUTH",
  );
});
