import assert from "node:assert/strict";
import test from "node:test";
import {
  createHttpGatewayError,
  createModelGateway,
  ModelGatewayError,
  TTS_UNSUPPORTED_VOICE_REASON,
} from "../src/index";

type Call = { url: string; body: Record<string, unknown> };

function build(target: { kind: "deepinfra" | "deepseek"; model: string }) {
  const calls: Call[] = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "Content-Type": "audio/wav" },
      });
    },
    providers: {
      speech: {
        kind: target.kind,
        baseUrl:
          target.kind === "deepinfra"
            ? "https://api.deepinfra.com/v1"
            : "https://api.deepseek.com",
        apiKey: "key",
      },
    },
    modelRoutes: {
      "tts-default": {
        strategy: "priority",
        targets: [{ provider: "speech", model: target.model, priority: 1 }],
      },
    },
  });
  return { calls, gateway };
}

const MIMO = { kind: "deepinfra", model: "XiaomiMiMo/MiMo-V2.5-tts" } as const;

async function rejection(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    assert.ok(ModelGatewayError.isInstance(error));
    return error;
  }
  assert.fail("expected the call to be rejected");
}

test("a voice the model does not have is rejected before the provider is called", async () => {
  const { calls, gateway } = build(MIMO);

  const error = await rejection(() =>
    gateway.tts.speech({
      model: "tts-default",
      input: "Hello",
      voice: "neutral, clear, calm",
    }),
  );

  assert.equal(calls.length, 0);
  assert.equal(error.code, "BAD_REQUEST");
  assert.equal(error.retryable, false);
  assert.equal(error.metadata?.reason, TTS_UNSUPPORTED_VOICE_REASON);
  assert.match(error.message, /'neutral, clear, calm' is not available/);
  assert.match(error.message, /mimo_default, Mia, Chloe, Milo, Dean/);
  assert.match(error.message, /Leave the voice out/);
});

test("voice ids are exact: a different case is not accepted", async () => {
  const { calls, gateway } = build(MIMO);

  await rejection(() =>
    gateway.tts.speech({ model: "tts-default", input: "Hello", voice: "mia" }),
  );

  assert.equal(calls.length, 0);
});

test("a listed voice and an omitted voice both reach the provider", async () => {
  const { calls, gateway } = build(MIMO);

  await gateway.tts.speech({
    model: "tts-default",
    input: "Hello",
    voice: "茉莉",
  });
  await gateway.tts.speech({ model: "tts-default", input: "Hello" });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.body.voice, "茉莉");
  assert.equal("voice" in (calls[1]?.body ?? {}), false);
});

test("a model without a known voice list takes any voice as given", async () => {
  const { calls, gateway } = build({
    kind: "deepinfra",
    model: "hexgrad/Kokoro-82M",
  });

  await gateway.tts.speech({
    model: "tts-default",
    input: "Hello",
    voice: "af_bella",
  });

  assert.equal(calls[0]?.body.voice, "af_bella");
});

test("deepseek tts accepts its two voices and rejects any other", async () => {
  const { calls, gateway } = build({ kind: "deepseek", model: "deepseek-tts" });

  await gateway.tts.speech({
    model: "tts-default",
    input: "Hello",
    voice: "tide",
  });
  const error = await rejection(() =>
    gateway.tts.speech({ model: "tts-default", input: "Hello", voice: "Mia" }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body.voice_id, "tide");
  assert.match(error.message, /Available voices: stella, tide/);
});

test("a provider's `detail` text becomes the error message", () => {
  const error = createHttpGatewayError({
    statusCode: 500,
    body: { detail: "TTS request failed, please try again later" },
  });

  assert.equal(error.code, "UPSTREAM");
  assert.equal(error.message, "TTS request failed, please try again later");
});
