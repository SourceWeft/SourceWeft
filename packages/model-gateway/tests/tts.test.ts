import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../src/index";

function audioResponse(contentType = "audio/mpeg") {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    headers: {
      "Content-Type": contentType,
    },
  });
}

test("tts.speech maps OpenRouter instructions into provider options", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return audioResponse();
    },
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "openrouter-key",
      },
    },
    modelRoutes: {
      "tts-default": {
        strategy: "priority",
        targets: [
          {
            provider: "openrouter",
            model: "openai/gpt-4o-mini-tts-2025-12-15",
            priority: 1,
          },
        ],
      },
    },
  });

  await gateway.tts.speech({
    model: "tts-default",
    input: "Hello from SourceWeft",
    voice: "alloy",
    instructions: "Use a crisp narration voice.",
    responseFormat: "mp3",
    extraBody: {
      provider: {
        order: ["OpenAI"],
        options: {
          openai: {
            previous: "keep",
          },
        },
      },
    },
  });

  assert.equal(
    requests[0]?.url,
    "https://openrouter.ai/api/v1/audio/speech",
  );
  const body = JSON.parse(String(requests[0]?.init.body));
  assert.equal(body.instructions, undefined);
  assert.deepEqual(body, {
    model: "openai/gpt-4o-mini-tts-2025-12-15",
    input: "Hello from SourceWeft",
    voice: "alloy",
    response_format: "mp3",
    provider: {
      order: ["OpenAI"],
      options: {
        openai: {
          previous: "keep",
          instructions: "Use a crisp narration voice.",
        },
      },
    },
  });
});

test("tts.speech sends DeepInfra OpenAI-compatible speech request", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return audioResponse("audio/wav");
    },
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "deepinfra-key",
      },
    },
    modelRoutes: {
      "tts-default": {
        strategy: "priority",
        targets: [
          {
            provider: "deepinfra",
            model: "XiaomiMiMo/MiMo-V2.5-tts",
            priority: 1,
          },
        ],
      },
    },
  });

  const result = await gateway.tts.speech({
    model: "tts-default",
    input: "Hello from SourceWeft",
    voice: "mimo",
    instructions: "Use a warm narration voice.",
    responseFormat: "wav",
    speed: 1.1,
    extraBody: {
      sample_rate: 24000,
    },
  });

  assert.equal(
    requests[0]?.url,
    "https://api.deepinfra.com/v1/openai/audio/speech",
  );
  assert.equal(
    (requests[0]?.init.headers as Record<string, string>)?.Authorization,
    "Bearer deepinfra-key",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    model: "XiaomiMiMo/MiMo-V2.5-tts",
    input: "Hello from SourceWeft",
    voice: "mimo",
    response_format: "wav",
    speed: 1.1,
    instructions: "Use a warm narration voice.",
    sample_rate: 24000,
  });
  assert.equal(result.provider, "deepinfra");
  assert.equal(result.providerModel, "XiaomiMiMo/MiMo-V2.5-tts");
  assert.equal(result.mimeType, "audio/wav");
});

test("tts.speech sends OpenAI-compatible speech request with top-level instructions", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return audioResponse("audio/mpeg");
    },
    providers: {
      orcarouter: {
        kind: "openai-compatible",
        baseUrl: "https://api.orcarouter.ai/v1",
        apiKey: "sk-orca-key",
      },
    },
    modelRoutes: {
      "tts-default": {
        strategy: "priority",
        targets: [
          { provider: "orcarouter", model: "openai/gpt-4o-mini-tts", priority: 1 },
        ],
      },
    },
  });

  const result = await gateway.tts.speech({
    model: "tts-default",
    input: "Hello from SourceWeft",
    voice: "alloy",
    instructions: "Use a crisp narration voice.",
    responseFormat: "mp3",
    extraBody: { sample_rate: 24000 },
  });

  assert.equal(requests[0]?.url, "https://api.orcarouter.ai/v1/audio/speech");
  assert.equal(
    (requests[0]?.init.headers as Record<string, string>)?.Authorization,
    "Bearer sk-orca-key",
  );
  // OrcaRouter takes OpenAI-native top-level instructions — no provider wrapper.
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    model: "openai/gpt-4o-mini-tts",
    input: "Hello from SourceWeft",
    voice: "alloy",
    response_format: "mp3",
    instructions: "Use a crisp narration voice.",
    sample_rate: 24000,
  });
  assert.equal(result.provider, "orcarouter");
  assert.equal(result.mimeType, "audio/mpeg");
});

test("OpenRouter TTS supports custom API key headers", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return audioResponse();
    },
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "router-token",
        apiKeyHeaderName: "x-router-key",
      },
    },
    modelRoutes: {
      "tts-default": {
        strategy: "priority",
        targets: [{ provider: "openrouter", model: "tts-model", priority: 1 }],
      },
    },
  });

  await gateway.tts.speech({
    model: "tts-default",
    input: "Hello from SourceWeft",
  });

  assert.equal(
    (requests[0]?.init.headers as Record<string, string> | undefined)?.[
      "x-router-key"
    ],
    "router-token",
  );
  assert.equal(
    (requests[0]?.init.headers as Record<string, string> | undefined)?.Authorization,
    undefined,
  );
});
