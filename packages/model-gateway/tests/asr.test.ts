import assert from "node:assert/strict";
import test from "node:test";
import { ModelGatewayError, createModelGateway } from "../src/index";
import { createJsonResponse } from "./helpers";

function audioBlob() {
  return new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });
}

test("asr.transcribe sends DeepInfra OpenAI-compatible multipart request", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return createJsonResponse({
        text: "Hello world",
        language: "en",
        duration: 5,
        input_length_ms: 5000,
        segments: [{ id: 0, start: 0, end: 5, text: "Hello world" }],
        request_id: "req_asr",
        inference_status: {
          tokens_input: 11,
          tokens_generated: 2,
        },
      });
    },
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "deepinfra-key",
      },
    },
    modelRoutes: {
      "asr-default": {
        strategy: "priority",
        targets: [
          {
            provider: "deepinfra",
            model: "openai/whisper-large-v3",
            priority: 1,
          },
        ],
      },
    },
  });

  const result = await gateway.asr.transcribe({
    model: "asr-default",
    audio: audioBlob(),
    fileName: "voice.mp3",
    mimeType: "audio/mpeg",
  });

  assert.equal(
    requests[0]?.url,
    "https://api.deepinfra.com/v1/openai/audio/transcriptions",
  );
  assert.equal(requests[0]?.init.method, "POST");
  assert.equal(
    (requests[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer deepinfra-key",
  );
  assert.equal(
    "Content-Type" in ((requests[0]?.init.headers as Record<string, string>) ?? {}),
    false,
  );
  assert.ok(requests[0]?.init.body instanceof FormData);
  const form = requests[0]?.init.body as FormData;
  assert.equal(form.get("model"), "openai/whisper-large-v3");
  assert.equal(form.get("response_format"), "verbose_json");
  assert.deepEqual(form.getAll("timestamp_granularities[]"), ["segment"]);
  assert.ok(form.get("file") instanceof File);
  assert.equal(result.text, "Hello world");
  assert.equal(result.language, "en");
  assert.equal(result.duration, 5);
  assert.equal(result.inputLengthMs, 5000);
  assert.deepEqual(result.segments, [
    { id: 0, start: 0, end: 5, text: "Hello world" },
  ]);
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 2,
    totalTokens: 13,
  });
});

test("asr.transcribe supports word timestamp opt-in", async () => {
  const forms: FormData[] = [];
  const gateway = createModelGateway({
    fetch: async (_url, init) => {
      forms.push(init?.body as FormData);
      return createJsonResponse({
        text: "Hello",
        words: [{ start: 0, end: 1, text: "Hello" }],
      });
    },
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "deepinfra-key",
      },
    },
    modelRoutes: {
      "asr-default": {
        strategy: "priority",
        targets: [
          {
            provider: "deepinfra",
            model: "openai/whisper-large-v3",
            priority: 1,
          },
        ],
      },
    },
  });

  const result = await gateway.asr.transcribe({
    model: "asr-default",
    audio: audioBlob(),
    fileName: "voice.mp3",
    timestampGranularities: ["segment", "word"],
  });

  assert.deepEqual(forms[0]?.getAll("timestamp_granularities[]"), [
    "segment",
    "word",
  ]);
  assert.deepEqual(result.words, [{ start: 0, end: 1, text: "Hello" }]);
});

test("asr.transcribe rejects unsupported provider-aware formats before request", async () => {
  let called = false;
  const gateway = createModelGateway({
    fetch: async () => {
      called = true;
      return createJsonResponse({ text: "unexpected" });
    },
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "deepinfra-key",
      },
    },
    modelRoutes: {
      "asr-default": {
        strategy: "priority",
        targets: [
          {
            provider: "deepinfra",
            model: "openai/whisper-large-v3",
            priority: 1,
          },
        ],
      },
    },
  });

  await assert.rejects(
    () =>
      gateway.asr.transcribe({
        model: "asr-default",
        audio: new Blob([new Uint8Array([1])], { type: "audio/aac" }),
        fileName: "voice.aac",
        mimeType: "audio/aac",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "BAD_REQUEST");
      assert.match(error.message, /Supported formats: flac, mp3/);
      return true;
    },
  );

  assert.equal(called, false);
});

test("asr.transcribe rejects explicit MIME conflicts", async () => {
  const gateway = createModelGateway({
    fetch: async () => createJsonResponse({ text: "unexpected" }),
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "deepinfra-key",
      },
    },
    modelRoutes: {
      "asr-default": {
        strategy: "priority",
        targets: [
          {
            provider: "deepinfra",
            model: "openai/whisper-large-v3",
            priority: 1,
          },
        ],
      },
    },
  });

  await assert.rejects(
    () =>
      gateway.asr.transcribe({
        model: "asr-default",
        audio: audioBlob(),
        fileName: "voice.mp3",
        mimeType: "application/pdf",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "BAD_REQUEST");
      assert.match(error.message, /does not match extension/);
      return true;
    },
  );
});
