import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { discoverGatewayCatalog, providerSupportsKind } from "./catalog-discovery";
import {
  hasLiteLLMPricing,
  resolveLiteLLMModelMatch,
} from "./litellm-capabilities";

test("LiteLLM matcher prefers provider-qualified keys and enforces provider compatibility", () => {
  const match = resolveLiteLLMModelMatch({
    modelId: "meta-llama/Llama-3.3-70B-Instruct",
    provider: "together_ai",
    litellmData: {
      "meta-llama/Llama-3.3-70B-Instruct": {
        litellm_provider: "deepinfra",
        mode: "chat",
        input_cost_per_token: 1,
        output_cost_per_token: 2,
        supports_function_calling: true,
      },
      "together_ai/meta-llama/Llama-3.3-70B-Instruct": {
        litellm_provider: "together_ai",
        mode: "chat",
        input_cost_per_token: 3,
        output_cost_per_token: 4,
        supports_function_calling: true,
      },
    },
  });

  assert.equal(match.type, "matched");
  if (match.type === "matched") {
    assert.equal(match.key, "together_ai/meta-llama/Llama-3.3-70B-Instruct");
    assert.equal(match.kind, "chat");
    assert.equal(match.entry.supports_function_calling, true);
    assert.equal(hasLiteLLMPricing(match.entry), true);
  }
});

test("LiteLLM matcher classifies vision, image, and ASR modes", () => {
  const litellmData = {
    "provider/vision-model": {
      litellm_provider: "provider",
      mode: "chat",
      supports_vision: true,
      supports_function_calling: true,
      input_cost_per_token: 1,
    },
    "provider/image-model": {
      litellm_provider: "provider",
      mode: "image_generation",
      input_cost_per_image: 1,
    },
    "provider/asr-model": {
      litellm_provider: "provider",
      mode: "speech_to_text",
      input_cost_per_audio_token: 1,
    },
  };

  const vision = resolveLiteLLMModelMatch({
    modelId: "vision-model",
    provider: "provider",
    litellmData,
  });
  const image = resolveLiteLLMModelMatch({
    modelId: "image-model",
    provider: "provider",
    litellmData,
  });
  const asr = resolveLiteLLMModelMatch({
    modelId: "asr-model",
    provider: "provider",
    litellmData,
  });

  assert.equal(vision.type === "matched" ? vision.kind : null, "vision");
  assert.equal(image.type === "matched" ? image.kind : null, "image");
  assert.equal(asr.type === "matched" ? asr.kind : null, "asr");
});

test("catalog kind support requires transport capabilities and tool calling for chat", () => {
  const gateway = {
    slug: "test",
    providerName: "test",
    providerKind: "openai-compatible",
    baseUrl: "https://example.com/v1",
    supports: ["chat", "image"],
  };

  assert.equal(providerSupportsKind(gateway, "chat"), false);
  assert.equal(providerSupportsKind(gateway, "image"), true);
  assert.equal(providerSupportsKind(gateway, "asr"), false);

  assert.equal(
    providerSupportsKind(
      { ...gateway, supports: ["chat", "tool_calling", "asr"] },
      "chat",
    ),
    true,
  );
});

test("OpenRouter catalog discovery sends attribution headers", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );

  await discoverGatewayCatalog({
    gateway: {
      slug: "openrouter-default",
      providerName: "openrouter",
      providerKind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      supports: ["chat", "tool_calling"],
    },
  });

  assert.equal(fetchMock.mock.calls.length, 1);
  const init = fetchMock.mock.calls[0]?.[1];
  const headers = init?.headers as Record<string, string>;

  assert.equal(headers["X-OpenRouter-Title"], "SourceWeft");
  assert.equal(headers["X-Title"], "SourceWeft");
  assert.equal(headers["HTTP-Referer"], "https://sourceweft.com");
});

test("OpenAI-compatible catalog discovery supports custom API key headers", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );

  await discoverGatewayCatalog({
    gateway: {
      slug: "cloudflare-aig-default",
      providerName: "cloudflare-aig",
      providerKind: "openai-compatible",
      baseUrl: "https://gateway.example.com/compat",
      apiKey: "cf-token",
      apiKeyHeaderName: "cf-aig-authorization",
      apiKeyHeaderPrefix: "Bearer ",
      supports: ["chat", "tool_calling"],
    },
    litellmData: {},
  });

  assert.equal(fetchMock.mock.calls.length, 1);
  const init = fetchMock.mock.calls[0]?.[1];
  const headers = init?.headers as Record<string, string>;

  assert.equal(headers["cf-aig-authorization"], "Bearer cf-token");
  assert.equal(headers.Authorization, undefined);
});
