import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicChatAdapter } from "../src/adapters/anthropic-chat";
import { AzureChatAdapter } from "../src/adapters/azure-chat";
import { DeepInfraChatAdapter } from "../src/adapters/deepinfra-chat";
import { OpenAICompatibleChatAdapter } from "../src/adapters/openai-compatible-chat";
import { OpenRouterChatAdapter } from "../src/adapters/openrouter-chat";
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

function createWithOptions(
  createModel: (options?: RequestOptions) => unknown,
) {
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
