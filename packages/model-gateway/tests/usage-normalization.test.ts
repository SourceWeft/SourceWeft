import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelCallObservation } from "../src/observation/normalize";
import { getProviderResponseAdapter } from "../src/adapters/providers/registry";
import { extractRawUsage } from "../src/normalize/extract";
import { normalizeOpenAICompatibleUsage } from "../src/normalize/protocols/openai-compatible";
import type { ResolvedRequestTarget } from "../src/types";

function target(provider: string): ResolvedRequestTarget {
  return {
    provider,
    providerKind:
      provider === "openrouter" ? "openrouter" : "openai-compatible",
    providerModel: "test-model",
    baseUrl: "https://provider.example/v1",
    defaultHeaders: {},
    supports: ["chat"],
    routeDecision: {
      mode: "GLOBAL",
      alias: "chat-default",
      strategy: "priority",
      provider,
      providerKind:
        provider === "openrouter" ? "openrouter" : "openai-compatible",
    },
    requestMetadata: {},
  };
}

test("normalizes OpenAI-compatible token usage without provider extensions", () => {
  assert.deepEqual(
    normalizeOpenAICompatibleUsage({
      prompt_tokens: 842,
      completion_tokens: 5012,
      total_tokens: 5854,
      prompt_tokens_details: {
        cached_tokens: 40,
      },
      completion_tokens_details: {
        reasoning_tokens: 3938,
      },
      cost: 0.012345678901,
      cost_details: {
        upstream_inference_cost: 0.012345678901,
      },
    }),
    {
      inputTokens: 842,
      outputTokens: 5012,
      totalTokens: 5854,
      cacheReadTokens: 40,
      cacheWriteTokens: undefined,
      reasoningTokens: 3938,
    },
  );
});

test("normalizes DeepSeek's top-level prompt_cache_hit_tokens as cacheReadTokens", () => {
  assert.deepEqual(
    normalizeOpenAICompatibleUsage({
      prompt_tokens: 1024,
      completion_tokens: 256,
      total_tokens: 1280,
      prompt_cache_hit_tokens: 768,
      prompt_cache_miss_tokens: 256,
    }),
    {
      inputTokens: 1024,
      outputTokens: 256,
      totalTokens: 1280,
      cacheReadTokens: 768,
      cacheWriteTokens: undefined,
    },
  );
});

test("prefers nested prompt_tokens_details.cached_tokens over DeepSeek's top-level field", () => {
  assert.equal(
    normalizeOpenAICompatibleUsage({
      prompt_tokens: 1024,
      completion_tokens: 256,
      prompt_tokens_details: { cached_tokens: 40 },
      prompt_cache_hit_tokens: 768,
    })?.cacheReadTokens,
    40,
  );
});

test("falls back to Anthropic's cache_read_input_tokens when neither OpenAI details nor DeepSeek's field are present", () => {
  assert.equal(
    normalizeOpenAICompatibleUsage({
      prompt_tokens: 1024,
      completion_tokens: 256,
      cache_read_input_tokens: 12,
    })?.cacheReadTokens,
    12,
  );
});

test("OpenRouter provider adapter enriches protocol usage with cost", () => {
  const raw = {
    usage: {
      prompt_tokens: 842,
      completion_tokens: 5012,
      total_tokens: 5854,
      cost: 0.012345678901,
      cost_details: {
        upstream_inference_cost: 0.012345678901,
      },
    },
  };
  const observation = normalizeModelCallObservation({
    modelAlias: "chat-default",
    context: {
      target: target("openrouter"),
      modality: "chat",
      rawResponse: raw,
    },
  });

  assert.equal(observation.cost?.inlineUsd, 0.012345678901);
  assert.equal(observation.cost?.source, "provider_inline");
  assert.equal(observation.usage?.providerCostUsd, 0.012345678901);
  assert.equal(observation.usage?.providerCostSource, "provider_inline");
  assert.equal(
    observation.usage?.providerCostSourcePath,
    "provider:openrouter.usage.cost",
  );
});

test("prefers raw response usage over LangChain usage metadata", () => {
  assert.deepEqual(
    normalizeOpenAICompatibleUsage(
      extractRawUsage({
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
        },
        additional_kwargs: {
          __raw_response: {
            usage: {
              prompt_tokens: 12,
              completion_tokens: 5,
              total_tokens: 17,
            },
          },
        },
      }),
    ),
    {
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
  );
});

test("extracts protocol usage preserved inside LangChain response metadata", () => {
  assert.deepEqual(
    extractRawUsage({
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
      },
      response_metadata: {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          provider_extension: 0.25,
        },
      },
    }),
    {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      provider_extension: 0.25,
    },
  );
});

test("DeepInfra provider adapter normalizes inference_status usage and cost", () => {
  const observation = normalizeModelCallObservation({
    modelAlias: "rerank-default",
    context: {
      target: target("deepinfra"),
      modality: "rerank",
      rawResponse: {
        inference_status: {
          tokens_input: 89,
          tokens_generated: 7,
          cost: 0.000089,
        },
      },
    },
  });
  assert.deepEqual(observation.usage, {
    inputTokens: 89,
    outputTokens: 7,
    totalTokens: 96,
    providerCostUsd: 0.000089,
    providerCostSource: "provider_inline",
    providerCostSourcePath: "provider:deepinfra.inference_status.cost",
  });
});

test("OrcaRouter provider adapter owns request headers, resolved model, and cost_usd", () => {
  const adapter = getProviderResponseAdapter("orcarouter");
  const requestPatch = adapter?.decorateRequest?.({
    target: target("orcarouter"),
    modality: "chat",
    stream: true,
    extraBody: { stream_options: { custom: true } },
  });
  assert.deepEqual(requestPatch, {
    headers: { "X-OrcaRouter-Include-Cost": "true" },
    extraBody: {
      stream_options: { custom: true, include_usage: true },
    },
  });

  const observation = normalizeModelCallObservation({
    modelAlias: "chat-default",
    context: {
      target: target("orcarouter"),
      modality: "chat",
      rawResponse: {
        usage: {
          prompt_tokens: 842,
          completion_tokens: 5012,
          total_tokens: 5854,
          cost_usd: 0.0123,
        },
      },
      responseMetadata: { model_name: "qwen3.7-plus" },
      responseHeaders: new Headers({
        "X-Orca-Request-Id": "orca-request-1",
        "X-Orca-Resolved-Model": "qwen/qwen3.7-plus",
        "X-Orca-Router": "auto",
        "X-Unrelated": "discard-me",
      }),
    },
  });

  assert.equal(observation.identity.resolvedProviderModel, "qwen/qwen3.7-plus");
  assert.equal(observation.identity.providerRequestId, "orca-request-1");
  assert.equal(observation.identity.routerName, "auto");
  assert.equal(observation.cost?.inlineUsd, 0.0123);
  assert.equal(observation.cost?.source, "provider_inline");
  assert.deepEqual(observation.providerResponseHeaders, {
    "x-orca-request-id": "orca-request-1",
    "x-orca-resolved-model": "qwen/qwen3.7-plus",
    "x-orca-router": "auto",
  });
});

test("an unregistered provider cannot turn cost_usd into provider cost", () => {
  const observation = normalizeModelCallObservation({
    modelAlias: "chat-default",
    context: {
      target: target("generic-provider"),
      modality: "chat",
      rawResponse: {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cost_usd: 999,
        },
      },
    },
  });

  assert.equal(observation.cost, undefined);
  assert.equal(observation.usage?.providerCostUsd, undefined);
});

test("OrcaRouter receipt adapter returns settled model, usage, and cost", async () => {
  const adapter = getProviderResponseAdapter("orcarouter");
  const receipt = await adapter?.reconcileCost?.({
    baseUrl: "https://api.orcarouter.ai/v1",
    apiKey: "test-key",
    requestId: "orca-request-1",
    fetch: async (input, init) => {
      assert.equal(
        String(input),
        "https://api.orcarouter.ai/v1/generation?id=orca-request-1",
      );
      assert.deepEqual(init?.headers, { Authorization: "Bearer test-key" });
      return new Response(
        JSON.stringify({
          data: {
            model: "qwen/qwen3.7-plus",
            tokens_prompt: 842,
            tokens_completion: 5012,
            tokens_total: 5854,
            total_cost: 0.0124,
            cost_currency: "USD",
          },
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(receipt?.resolvedProviderModel, "qwen/qwen3.7-plus");
  assert.deepEqual(receipt?.usage, {
    inputTokens: 842,
    outputTokens: 5012,
    totalTokens: 5854,
  });
  assert.equal(receipt?.settledCostUsd, 0.0124);
});
