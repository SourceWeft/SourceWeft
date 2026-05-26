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

test("tts.speech rejects unsupported non-OpenRouter TTS providers", async () => {
  const gateway = createModelGateway({
    fetch: async () => audioResponse(),
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
      },
    },
    modelRoutes: {
      "tts-default": {
        strategy: "priority",
        targets: [
          {
            provider: "openai",
            model: "gpt-4o-mini-tts",
            priority: 1,
          },
        ],
      },
    },
  });

  await assert.rejects(
    () =>
      gateway.tts.speech({
        model: "tts-default",
        input: "Hello from SourceWeft",
      }),
    /does not support TTS/,
  );
});
