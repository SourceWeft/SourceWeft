import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { discoverGatewayCatalog, providerSupportsKind } from "./catalog-discovery";
import {
  hasLiteLLMPricing,
  resolveLiteLLMModelMatch,
} from "./litellm-capabilities";
import type { NormalizedModelInfo } from "./model-catalog/types";

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

test("OrcaRouter catalog discovery classifies modalities and stamps reasoning", async () => {
  const models = [
    {
      id: "openai/gpt-4o-mini",
      name: "OpenAI: GPT-4o-mini",
      supported_endpoint_types: ["openai", "openai-response"],
      context_length: 128000,
      max_completion_tokens: 16384,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
    },
    {
      id: "anthropic/claude-opus-4.6",
      supported_endpoint_types: ["openai", "anthropic"],
      context_length: 200000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.000015", completion: "0.000075" },
    },
    // OrcaRouter lists each model twice: bare alias (no name) + prefixed
    // canonical (has name). Only the prefixed one should survive.
    {
      id: "gpt-5.6-luna",
      supported_endpoint_types: ["openai", "openai-response"],
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.0000002", completion: "0.0000016" },
    },
    {
      id: "openai/gpt-5.6-luna",
      name: "OpenAI: GPT-5.6 Luna",
      supported_endpoint_types: ["openai", "openai-response"],
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.0000002", completion: "0.0000012" },
    },
    {
      id: "deepseek/deepseek-v4",
      supported_endpoint_types: ["openai"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.0000003", completion: "0.0000012" },
    },
    {
      id: "openai/text-embedding-3-small",
      supported_endpoint_types: ["embeddings"],
      pricing: { prompt: "0.00000002", completion: "0" },
    },
    {
      id: "openai/gpt-image-1",
      supported_endpoint_types: ["image-generation"],
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    },
    {
      id: "openai/tts-1",
      supported_endpoint_types: ["openai"],
    },
    {
      id: "kling/kling-3",
      supported_endpoint_types: ["openai-video"],
      architecture: { input_modalities: ["text"], output_modalities: ["video"] },
    },
    // Aggregator prefix (grok) differs from LiteLLM's key prefix (xai/...) —
    // capabilities must still resolve via bare-name match.
    {
      id: "grok/grok-4.6",
      supported_endpoint_types: ["openai"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
    // OrcaRouter's own routing slug — must NOT borrow another router's caps.
    { id: "orcarouter/auto", supported_endpoint_types: ["openai"] },
    // Media model with insufficient catalog signal (chat-ish endpoint, no
    // output_modalities) — an override `mode` must refile it as image, not chat.
    { id: "grok/grok-imagine-image", supported_endpoint_types: ["gemini"] },
  ];

  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ object: "list", data: models }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );

  // Capabilities come from the normalized model catalog, injected here as a
  // fixture resolver (the registry is source-agnostic; discovery just calls it).
  const info = (o: Partial<NormalizedModelInfo>): NormalizedModelInfo => ({
    id: "",
    reasoning: false,
    reasoningEfforts: [],
    toolCall: false,
    structuredOutput: false,
    vision: false,
    sources: ["test"],
    ...o,
  });
  const caps = new Map<string, NormalizedModelInfo>([
    ["anthropic/claude-opus-4.6", info({ reasoning: true, reasoningEfforts: ["low", "medium", "high"], vision: true })],
    ["openai/gpt-5.6-luna", info({ reasoning: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], toolCall: true, vision: true })],
    ["openai/gpt-4o-mini", info({ toolCall: true, vision: true })],
    ["grok/grok-4.6", info({ reasoning: true, reasoningEfforts: ["low", "medium", "high"] })],
    ["orcarouter/auto", info({ reasoning: true, toolCall: true, vision: true, modality: "chat" })],
    ["grok/grok-imagine-image", info({ modality: "image" })],
  ]);

  const candidates = await discoverGatewayCatalog({
    gateway: {
      slug: "orcarouter-default",
      providerName: "orcarouter",
      providerKind: "openai-compatible",
      catalogFormat: "orcarouter",
      baseUrl: "https://api.orcarouter.ai/v1",
      apiKey: "sk-orca-test",
      supports: ["chat", "embeddings", "image", "tts", "tool_calling"],
    },
    resolveCapabilities: (id) => caps.get(id) ?? null,
  });

  // Hits the gateway's own /models with bearer auth (not the OpenRouter URL).
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(fetchMock.mock.calls[0]?.[0], "https://api.orcarouter.ai/v1/models");
  const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-orca-test");

  const byId = (id: string, kind: string) =>
    candidates.find((c) => c.modelId === id && c.kind === kind);

  // Modality classification.
  assert.ok(byId("openai/text-embedding-3-small", "embedding"), "embedding classified");
  assert.ok(byId("openai/gpt-image-1", "image"), "image classified");
  assert.ok(byId("openai/tts-1", "tts"), "tts classified by id heuristic");
  assert.ok(byId("openai/gpt-4o-mini", "vision"), "vision from image input");
  assert.ok(byId("openai/gpt-4o-mini", "chat"), "chat emitted");
  assert.ok(byId("deepseek/deepseek-v4", "chat"), "text-only chat");
  // Video is dropped entirely.
  assert.equal(candidates.some((c) => c.modelId === "kling/kling-3"), false);
  // Bare alias id is filtered; only the provider-prefixed twin survives.
  assert.equal(candidates.some((c) => c.modelId === "gpt-5.6-luna"), false);
  assert.ok(byId("openai/gpt-5.6-luna", "chat"), "prefixed twin kept");
  assert.equal(
    candidates.filter((c) => c.modelId === "openai/gpt-5.6-luna" && c.kind === "chat").length,
    1,
    "prefixed model appears once per kind",
  );

  // LiteLLM supports_reasoning → reasoning_effort (thinking badge); a plain
  // chat model gets tools but no reasoning_effort.
  const opus = byId("anthropic/claude-opus-4.6", "chat");
  assert.ok(opus?.supportedParameters?.includes("reasoning_effort"), "opus reasoning");
  assert.ok((opus?.supportedEfforts?.length ?? 0) > 0);
  const luna = byId("openai/gpt-5.6-luna", "chat");
  assert.ok(luna?.supportedParameters?.includes("reasoning_effort"), "luna reasoning");
  assert.ok(luna?.supportedEfforts?.includes("xhigh"), "luna xhigh from litellm flag");
  const gpt = byId("openai/gpt-4o-mini", "chat");
  assert.ok(gpt?.supportedParameters?.includes("tools"), "gpt tools from litellm");
  assert.equal(gpt?.supportedParameters?.includes("reasoning_effort"), false, "gpt no reasoning");

  // The injected resolver supplies capabilities regardless of provider prefix.
  const grok = byId("grok/grok-4.6", "chat");
  assert.ok(grok?.supportedParameters?.includes("reasoning_effort"), "grok reasoning");

  // OrcaRouter routing slug: capabilities come from the normalized catalog
  // (model-overrides.json defines it), surfacing as a chat model.
  const auto = byId("orcarouter/auto", "chat");
  assert.ok(auto, "auto slug surfaces as a chat model");
  assert.ok(auto?.supportedParameters?.includes("reasoning_effort"), "auto defined via override");

  // A media model under-described by the catalog is refiled by its override
  // modality — image, not chat.
  assert.ok(byId("grok/grok-imagine-image", "image"), "media model filed as image via mode");
  assert.equal(
    Boolean(byId("grok/grok-imagine-image", "chat")),
    false,
    "not misfiled as chat",
  );

  // Inline pricing + context stay from OrcaRouter's own catalog (not LiteLLM).
  assert.equal(gpt?.pricing?.inputCostPerToken, 0.00000015);
  assert.equal(gpt?.contextLength, 128000);
  assert.equal(gpt?.providerCatalogSource, "orcarouter-models");
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
    // Generic openai-compatible discovery resolves capabilities from the
    // catalog; inject an empty resolver so the test stays offline.
    resolveCapabilities: () => null,
  });

  assert.equal(fetchMock.mock.calls.length, 1);
  const init = fetchMock.mock.calls[0]?.[1];
  const headers = init?.headers as Record<string, string>;

  assert.equal(headers["cf-aig-authorization"], "Bearer cf-token");
  assert.equal(headers.Authorization, undefined);
});
