import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicChatAdapter } from "../src/adapters/anthropic-chat";
import { AzureChatAdapter } from "../src/adapters/azure-chat";
import { DeepInfraChatAdapter } from "../src/adapters/deepinfra-chat";
import { OpenAICompatibleChatAdapter } from "../src/adapters/openai-compatible-chat";
import { OpenRouterChatAdapter } from "../src/adapters/openrouter-chat";
import { ModelGatewayError } from "../src/errors";
import type { ChatCompleteInput, RequestOptions } from "../src/types";
import { makeResolvedTarget } from "./helpers";

const target = makeResolvedTarget();

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
    makeResolvedTarget({
      provider: "cloudflare-aig",
      providerKind: "openai-compatible",
      providerModel: "deepseek/deepseek-v4-pro",
      apiKey: "cf-token",
      apiKeyHeaderName: "cf-aig-authorization",
      apiKeyHeaderPrefix: "Bearer ",
      defaultHeaders: {
        "HTTP-Referer": "https://sourceweft.example",
      },
    }),
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
    makeResolvedTarget({
      provider: "cloudflare-aig",
      providerKind: "openai-compatible",
      providerModel: "deepseek/deepseek-v4-pro",
      supports: ["chat", "json_schema"],
    }),
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

// The normalized model catalog (models.dev/LiteLLM) and catalog-derived
// profiles spell "can reason" as `reasoning_effort`.
const CATALOG_REASONING_FACTS = [
  "tools",
  "tool_choice",
  "response_format",
  "reasoning_effort",
];

test("OpenRouter chat adapter disables reasoning when the facts spell it reasoning_effort", () => {
  const adapter = new OpenRouterChatAdapter();
  const model = adapter.createModel(
    makeResolvedTarget({
      provider: "openrouter",
      providerKind: "openrouter",
      providerModel: "deepseek/deepseek-v4.1-flash",
    }),
    {
      ...input,
      thinking: {
        mode: "off",
        enabled: false,
        supportedParameters: CATALOG_REASONING_FACTS,
      },
    },
  );

  assert.deepEqual(modelKwargs(model), {
    reasoning: {
      effort: "none",
      exclude: true,
    },
  });
});

test("OpenRouter chat adapter keeps reasoning_effort when enabling reasoning", () => {
  const adapter = new OpenRouterChatAdapter();
  const model = adapter.createModel(
    makeResolvedTarget({
      provider: "openrouter",
      providerKind: "openrouter",
      providerModel: "deepseek/deepseek-v4.1-flash",
    }),
    {
      ...input,
      thinking: {
        mode: "effort",
        effort: "low",
        supportedParameters: CATALOG_REASONING_FACTS,
        supportedEfforts: ["low"],
      },
    },
  );

  assert.deepEqual(modelKwargs(model), { reasoning_effort: "low" });
});

test("OpenAI-compatible chat adapter sends nothing to turn off reasoning spelled reasoning_effort", () => {
  const adapter = new OpenAICompatibleChatAdapter();
  const model = adapter.createModel(
    makeResolvedTarget({
      providerKind: "openai-compatible",
      providerModel: "deepseek-v4-flash",
    }),
    {
      ...input,
      thinking: {
        mode: "off",
        enabled: false,
        supportedParameters: CATALOG_REASONING_FACTS,
      },
    },
  );

  assert.deepEqual(modelKwargs(model), {});
});

test("OpenAI-compatible chat adapter keeps standard SDK auth without custom headers", () => {
  const adapter = new OpenAICompatibleChatAdapter();
  const model = adapter.createModel(
    makeResolvedTarget({
      providerKind: "openai-compatible",
      defaultHeaders: {
        "HTTP-Referer": "https://sourceweft.example",
      },
    }),
    input,
  );

  assert.deepEqual(clientConfig(model)?.defaultHeaders, {
    "HTTP-Referer": "https://sourceweft.example",
  });
});

test("OpenRouter chat adapter merges provider routing into model kwargs", () => {
  const adapter = new OpenRouterChatAdapter();
  const model = adapter.createModel(
    makeResolvedTarget({
      provider: "openrouter",
      providerKind: "openrouter",
      providerRouting: {
        only: ["deepseek"],
        sort: "latency",
      },
    }),
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
    makeResolvedTarget({
      provider: "openrouter",
      providerKind: "openrouter",
      providerRouting: {
        sort: {
          by: "throughput",
          partition: "none",
        },
      },
    }),
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
        makeResolvedTarget({
          apiKey: undefined,
          provider: "openrouter",
          providerKind: "openrouter",
        }),
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
        makeResolvedTarget({
          apiKey: undefined,
          defaultHeaders: { Authorization: "Bearer header-only" },
          provider: "openrouter",
          providerKind: "openrouter",
        }),
        input,
      ),
    (error: unknown) =>
      error instanceof ModelGatewayError && error.code === "AUTH",
  );
});

const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { title: { type: "string" } },
  required: ["title"],
};

/** Runs requests through an adapter's model, recording every request body. */
function recordingFetch(content = '{"title":"ok"}') {
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        id: "gen-1",
        object: "chat.completion",
        created: 1,
        model: "vendor/model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { bodies, fetch };
}

test("OpenRouter chat adapter adds require_parameters to json_schema requests, merged with routing", async () => {
  const { bodies, fetch } = recordingFetch();
  const model = new OpenRouterChatAdapter().createModel(
    makeResolvedTarget({
      provider: "openrouter",
      providerKind: "openrouter",
      providerRouting: { only: ["novita"], sort: "latency" },
    }),
    { ...input, extraBody: { provider: { allow_fallbacks: false } } },
    { fetch, maxRetries: 0 },
  );

  const structured = await model
    .withStructuredOutput(JSON_SCHEMA, {
      includeRaw: true,
      name: "extract",
      method: "jsonSchema",
      strict: true,
    })
    .invoke("hello");
  assert.deepEqual((structured as { parsed: unknown }).parsed, { title: "ok" });
  assert.deepEqual(bodies[0]!.provider, {
    allow_fallbacks: false,
    only: ["novita"],
    sort: "latency",
    require_parameters: true,
  });
  assert.equal(
    (bodies[0]!.response_format as { type?: string }).type,
    "json_schema",
  );

  // A plain chat request on the same model is unchanged.
  await model.invoke("hello");
  assert.deepEqual(bodies[1]!.provider, {
    allow_fallbacks: false,
    only: ["novita"],
    sort: "latency",
  });
  assert.equal(bodies[1]!.response_format, undefined);
});

test("OpenRouter chat adapter adds a provider object only for strict json_schema requests", async () => {
  const { bodies, fetch } = recordingFetch();
  const model = new OpenRouterChatAdapter().createModel(
    makeResolvedTarget({ provider: "openrouter", providerKind: "openrouter" }),
    input,
    { fetch, maxRetries: 0 },
  );
  await model.invoke("hello");
  assert.equal(bodies[0]!.provider, undefined);

  await model
    .withStructuredOutput(JSON_SCHEMA, {
      includeRaw: true,
      name: "extract",
      method: "jsonSchema",
      strict: true,
    })
    .invoke("hello");
  assert.deepEqual(bodies[1]!.provider, { require_parameters: true });

  // Tool-based structured output carries no response_format.
  await model
    .withStructuredOutput(JSON_SCHEMA, {
      includeRaw: true,
      name: "extract",
      method: "functionCalling",
    })
    .invoke("hello");
  assert.equal(bodies[2]!.provider, undefined);

  // A non-strict json_schema (LangChain's default method) keeps today's
  // routing: requiring parameters there would 404 with no fallback.
  await model
    .withStructuredOutput(JSON_SCHEMA, {
      includeRaw: true,
      name: "extract",
      method: "jsonSchema",
    })
    .invoke("hello");
  assert.equal(
    (bodies[3]!.response_format as { type?: string }).type,
    "json_schema",
  );
  assert.equal(bodies[3]!.provider, undefined);
});

test("other adapters send a json_schema response format as-is", async () => {
  const { bodies, fetch } = recordingFetch();
  const model = new OpenAICompatibleChatAdapter().createModel(
    makeResolvedTarget({
      provider: "local",
      providerKind: "openai-compatible",
    }),
    input,
    { fetch, maxRetries: 0 },
  );
  await model
    .withStructuredOutput(JSON_SCHEMA, {
      includeRaw: true,
      name: "extract",
      method: "jsonSchema",
      strict: true,
    })
    .invoke("hello");
  assert.equal(bodies[0]!.provider, undefined);
  assert.equal(
    (bodies[0]!.response_format as { type?: string }).type,
    "json_schema",
  );
});
