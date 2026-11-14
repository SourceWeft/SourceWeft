import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../src/index";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function build(
  respond: (call: Call, index: number) => Response,
  baseUrl = "https://api.deepseek.com",
) {
  const calls: Call[] = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      const call: Call = {
        url: String(url),
        init: init ?? {},
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      calls.push(call);
      return respond(call, calls.length - 1);
    },
    providers: {
      deepseek: { kind: "deepseek", baseUrl, apiKey: "ds-key" },
    },
    modelRoutes: {
      "tts-default": {
        strategy: "priority",
        targets: [{ provider: "deepseek", model: "deepseek-tts", priority: 1 }],
      },
    },
  });
  return { calls, gateway };
}

const wav = () =>
  new Response(new Uint8Array([82, 73, 70, 70]), {
    headers: { "Content-Type": "audio/wav" },
  });

test("deepseek tts posts text and voice_id with bearer auth and returns wav", async () => {
  const { calls, gateway } = build(wav);
  const result = await gateway.tts.speech({
    model: "tts-default",
    input: "Hello there",
  });

  assert.equal(calls[0]?.url, "https://api.deepseek.com/v1/tools/tts");
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer ds-key");
  assert.deepEqual(calls[0]?.body, {
    text: "Hello there",
    voice_id: "stella",
    format: "wav",
  });
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.audio.byteLength, 4);
});

test("deepseek tts maps voice, explicit wav/pcm and passes filter_markdown", async () => {
  const { calls, gateway } = build(wav);
  await gateway.tts.speech({
    model: "tts-default",
    input: "Hi",
    voice: "tide",
    responseFormat: "pcm",
    extraBody: { filter_markdown: true },
  });
  assert.deepEqual(calls[0]?.body, {
    text: "Hi",
    voice_id: "tide",
    format: "pcm",
    filter_markdown: true,
  });
});

test("a base URL that already ends in /v1 does not double the segment", async () => {
  const { calls, gateway } = build(wav, "https://api.deepseek.com/v1/");
  await gateway.tts.speech({ model: "tts-default", input: "Hi" });
  assert.equal(calls[0]?.url, "https://api.deepseek.com/v1/tools/tts");
});

for (const [label, extra] of [
  ["speed", { speed: 1.2 }],
  ["instructions", { instructions: "whisper" }],
  ["mp3 output", { responseFormat: "mp3" }],
  ["opus output", { responseFormat: "opus" }],
] as const) {
  test(`unsupported ${label} fails instead of being ignored`, async () => {
    const { calls, gateway } = build(wav);
    await assert.rejects(
      () => gateway.tts.speech({ model: "tts-default", input: "Hi", ...extra }),
      (error: { code?: string; message: string }) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.match(error.message, /DeepSeek TTS/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });
}

test("text over 10,000 billed units fails before any request; Chinese counts double", async () => {
  const { calls, gateway } = build(wav);
  await gateway.tts.speech({ model: "tts-default", input: "a".repeat(10_000) });
  assert.equal(calls.length, 1);

  await assert.rejects(
    () =>
      gateway.tts.speech({ model: "tts-default", input: "你".repeat(5_001) }),
    /10,000/,
  );
  await assert.rejects(
    () =>
      gateway.tts.speech({ model: "tts-default", input: "a".repeat(10_001) }),
    /10,000/,
  );
  assert.equal(calls.length, 1);
});

test("billed units are exposed in raw", async () => {
  const { gateway } = build(wav);
  const result = await gateway.tts.speech({
    model: "tts-default",
    input: "你好ab",
  });
  assert.equal(result.raw.billedUnits, 6);
});

test("HTTP errors become gateway errors without leaking the key", async () => {
  const { gateway } = build(
    () =>
      new Response(JSON.stringify({ error: { message: "insufficient" } }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      }),
  );
  await assert.rejects(
    () => gateway.tts.speech({ model: "tts-default", input: "Hi" }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /ds-key/);
      return true;
    },
  );
});

test("a JSON body on a 200 is an upstream error, not audio", async () => {
  const { gateway } = build(
    () =>
      new Response(
        JSON.stringify({ error: { message: "synthesis crashed" } }),
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
  );
  await assert.rejects(
    () => gateway.tts.speech({ model: "tts-default", input: "Hi" }),
    /synthesis crashed/,
  );
});

test("a missing API key fails as BAD_REQUEST", async () => {
  const gateway = createModelGateway({
    fetch: async () => wav(),
    providers: {
      deepseek: { kind: "deepseek", baseUrl: "https://api.deepseek.com" },
    },
    modelRoutes: {
      "tts-default": {
        strategy: "priority",
        targets: [{ provider: "deepseek", model: "deepseek-tts", priority: 1 }],
      },
    },
  });
  await assert.rejects(
    () => gateway.tts.speech({ model: "tts-default", input: "Hi" }),
    (error: { code?: string }) => {
      assert.equal(error.code, "BAD_REQUEST");
      return true;
    },
  );
});
