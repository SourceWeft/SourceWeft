import assert from "node:assert/strict";
import { test } from "vitest";
import { loadDeepInfraSpeechModels } from "./deepinfra";

const list = [
  {
    model_name: "XiaomiMiMo/MiMo-V2.5-tts",
    type: "text-to-speech",
    pricing: { type: "input_character_length", cents_per_input_chars: 0.0 },
  },
  {
    model_name: "hexgrad/Kokoro-82M",
    type: "text-to-speech",
    pricing: { type: "input_character_length", cents_per_input_chars: 9.9e-5 },
  },
  {
    model_name: "openai/whisper-large-v3-turbo",
    type: "automatic-speech-recognition",
    pricing: { type: "input_length", cents_per_input_sec: 0.000333 },
  },
  {
    // Billed by compute time, not audio length: cannot be priced per second of audio.
    model_name: "openai/whisper-base",
    type: "automatic-speech-recognition",
    pricing: { type: "time", cents_per_sec: 0.05 },
  },
  {
    model_name: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    type: "text-generation",
    pricing: { type: "tokens", cents_per_input_token: 0.0000098 },
  },
];

const respond = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

test("speech models are adapted with DeepInfra's own per-character and per-second prices", async () => {
  const models = await loadDeepInfraSpeechModels({ fetchImpl: respond(list) });
  const byId = new Map(models.map((model) => [model.id, model]));

  assert.deepEqual([...byId.keys()].sort(), [
    "hexgrad/kokoro-82m",
    "openai/whisper-large-v3-turbo",
    "xiaomimimo/mimo-v2.5-tts",
  ]);
  const mimo = byId.get("xiaomimimo/mimo-v2.5-tts");
  assert.equal(mimo?.provider, "deepinfra");
  assert.equal(mimo?.modality, "tts");
  // A listed price of zero is a price, not an unknown.
  assert.deepEqual(mimo?.pricing, { inputPerCharacter: 0 });
  assert.deepEqual(mimo?.sources, ["deepinfra"]);

  // Cents become dollars: 9.9e-5 cents per character is $0.99 per million.
  assert.equal(
    byId.get("hexgrad/kokoro-82m")?.pricing?.inputPerCharacter,
    9.9e-7,
  );
  const whisper = byId.get("openai/whisper-large-v3-turbo");
  assert.equal(whisper?.modality, undefined);
  // 0.000333 cents per second is $0.012 per hour.
  assert.equal(whisper?.pricing?.inputPerSecond, 0.00000333);
});

test("a model billed by compute time or with no usable price is left out", async () => {
  const models = await loadDeepInfraSpeechModels({
    fetchImpl: respond([
      list[3],
      {
        model_name: "some/tts",
        type: "text-to-speech",
        pricing: {
          type: "input_character_length",
          cents_per_input_chars: null,
        },
      },
      { model_name: "other/tts", type: "text-to-speech" },
    ]),
  });
  assert.deepEqual(models, []);
});

test("an HTTP error rejects instead of returning an empty list", async () => {
  await assert.rejects(
    () => loadDeepInfraSpeechModels({ fetchImpl: respond({}, 503) }),
    /DeepInfra model list/,
  );
});

test("a body that is not a list of models rejects", async () => {
  await assert.rejects(
    () => loadDeepInfraSpeechModels({ fetchImpl: respond({ data: [] }) }),
    /DeepInfra model list/,
  );
  await assert.rejects(
    () => loadDeepInfraSpeechModels({ fetchImpl: respond(["nope"]) }),
    /DeepInfra model list/,
  );
});
