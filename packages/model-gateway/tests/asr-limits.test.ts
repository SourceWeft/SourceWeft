import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway, ModelGatewayError } from "../src/index";
import type { AsrAudioPreparer, AsrSilence } from "../src/index";

type Call = { url: string; fileName: string; size: number; form: FormData };

const SAMPLE_RATE = 16_000;

function fakePreparer(options: {
  durationSec: number;
  probe?: number | null;
  silences?: AsrSilence[];
}) {
  const state = { probes: 0, normalizes: 0, disposed: 0 };
  const pcmByteLength = options.durationSec * SAMPLE_RATE * 2;
  const preparer: AsrAudioPreparer = {
    async probeDurationSec() {
      state.probes += 1;
      return options.probe === undefined ? options.durationSec : options.probe;
    },
    async normalize() {
      state.normalizes += 1;
      return {
        sampleRate: SAMPLE_RATE,
        pcmByteLength,
        silences: options.silences ?? [],
        async readPcm(start, end) {
          return new Uint8Array(end - start);
        },
        async dispose() {
          state.disposed += 1;
        },
      };
    },
  };
  return { preparer, state };
}

function build(input: {
  kind: "deepseek" | "siliconflow-cn" | "deepinfra" | "openai";
  model: string;
  preparer?: AsrAudioPreparer;
  respond: (call: Call, index: number) => Response | Promise<Response>;
}) {
  const calls: Call[] = [];
  const gateway = createModelGateway({
    fetch: async (url, init) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const call = {
        url: String(url),
        fileName: file.name,
        size: file.size,
        form,
      };
      calls.push(call);
      return input.respond(call, calls.length - 1);
    },
    asrAudioPreparer: input.preparer,
    maxRetries: 0,
    providers: {
      p: { kind: input.kind, baseUrl: "https://api.example.com", apiKey: "k" },
    },
    modelRoutes: {
      asr: {
        strategy: "priority",
        targets: [{ provider: "p", model: input.model, priority: 1 }],
      },
    },
  });
  return { calls, gateway };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const request = (fileName: string, bytes = 10) => ({
  model: "asr",
  audio: new Uint8Array(bytes),
  fileName,
  responseFormat: "verbose_json" as const,
  timestampGranularities: ["segment" as const],
});

test("deepseek: every input is decoded and cut into chunks that fit 120 s", async () => {
  const { preparer, state } = fakePreparer({ durationSec: 250 });
  const { calls, gateway } = build({
    kind: "deepseek",
    model: "deepseek-asr",
    preparer,
    respond: (call) =>
      json({ request_id: "r", text: `t:${call.fileName}`, duration_ms: 1 }),
  });

  const result = await gateway.asr.transcribe(request("talk.mp3"));

  assert.equal(state.normalizes, 1);
  assert.equal(state.disposed, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, "https://api.example.com/v1/tools/asr");
  for (const call of calls) {
    assert.match(call.fileName, /^talk\.part-00\d\.wav$/);
    assert.ok(call.size <= 8 * 1024 * 1024);
    assert.ok((call.size - 44) / 32_000 <= 120);
    assert.equal(call.form.get("model"), null);
  }
  assert.equal(
    result.text,
    "t:talk.part-001.wav\nt:talk.part-002.wav\nt:talk.part-003.wav",
  );
  assert.deepEqual(
    result.segments?.map((segment) => [segment.start, segment.end]),
    [
      [0, 100],
      [100, 200],
      [200, 250],
    ],
  );
  assert.equal(result.duration, 250);
});

test("deepseek: a short wav is still normalized, as one chunk", async () => {
  const { preparer, state } = fakePreparer({ durationSec: 30 });
  const { calls, gateway } = build({
    kind: "deepseek",
    model: "deepseek-asr",
    preparer,
    respond: () => json({ text: "hi", duration_ms: 30_000 }),
  });
  const result = await gateway.asr.transcribe(request("a.wav"));
  assert.equal(state.normalizes, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.segments, [{ start: 0, end: 30, text: "hi" }]);
});

test("deepseek: without a preparer the call fails as CONFIGURATION, nothing is sent", async () => {
  const { calls, gateway } = build({
    kind: "deepseek",
    model: "deepseek-asr",
    respond: () => json({ text: "x" }),
  });
  await assert.rejects(
    () => gateway.asr.transcribe(request("a.mp3")),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "CONFIGURATION");
      assert.match(error.message, /ffmpeg/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("deepseek: a failed chunk fails the whole call and names the chunk", async () => {
  const { preparer, state } = fakePreparer({ durationSec: 250 });
  const { gateway } = build({
    kind: "deepseek",
    model: "deepseek-asr",
    preparer,
    respond: (call) =>
      call.fileName.includes("part-002")
        ? json({ error: { message: "bad audio" } }, 400)
        : json({ text: "ok" }),
  });
  await assert.rejects(
    () => gateway.asr.transcribe(request("talk.mp3")),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.match(error.message, /chunk 2\/3 \(01:40-03:20\).*bad audio/);
      return true;
    },
  );
  assert.equal(state.disposed, 1);
});

test("deepseek: language, prompt and temperature are rejected, not dropped", async () => {
  for (const extra of [
    { language: "zh" },
    { prompt: "x" },
    { temperature: 0 },
  ]) {
    const { preparer } = fakePreparer({ durationSec: 10 });
    const { calls, gateway } = build({
      kind: "deepseek",
      model: "deepseek-asr",
      preparer,
      respond: () => json({ text: "x" }),
    });
    await assert.rejects(
      () => gateway.asr.transcribe({ ...request("a.wav"), ...extra }),
      /DeepSeek ASR/,
    );
    assert.equal(calls.length, 0);
  }
});

test("deepseek: a 200 without text is an upstream error", async () => {
  const { preparer } = fakePreparer({ durationSec: 10 });
  const { gateway } = build({
    kind: "deepseek",
    model: "deepseek-asr",
    preparer,
    respond: () => json({ error: { message: "decode failed" } }),
  });
  await assert.rejects(
    () => gateway.asr.transcribe(request("a.wav")),
    /decode failed/,
  );
});

test("deepseek: chunk requests never exceed the concurrency bound", async () => {
  const { preparer } = fakePreparer({ durationSec: 3_000 });
  let active = 0;
  let maxActive = 0;
  const { calls, gateway } = build({
    kind: "deepseek",
    model: "deepseek-asr",
    preparer,
    respond: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      return json({ text: "x" });
    },
  });
  await gateway.asr.transcribe(request("long.mp3"));
  assert.equal(calls.length, 30);
  assert.equal(maxActive, 8);
});

test("siliconflow: a file within one hour goes up whole, exactly as before", async () => {
  const { preparer, state } = fakePreparer({ durationSec: 3_000 });
  const { calls, gateway } = build({
    kind: "siliconflow-cn",
    model: "FunAudioLLM/SenseVoiceSmall",
    preparer,
    respond: () => json({ text: "whole" }),
  });
  const result = await gateway.asr.transcribe(request("meeting.mp3"));
  assert.equal(state.probes, 1);
  assert.equal(state.normalizes, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.fileName, "meeting.mp3");
  assert.equal(result.text, "whole");
  assert.equal(result.segments, undefined);
});

test("siliconflow: audio over one hour is split into 20 minute chunks", async () => {
  const { preparer } = fakePreparer({ durationSec: 5_400 });
  const { calls, gateway } = build({
    kind: "siliconflow-cn",
    model: "FunAudioLLM/SenseVoiceSmall",
    preparer,
    respond: () => json({ text: "part" }),
  });
  const result = await gateway.asr.transcribe(request("lecture.mp3"));
  assert.equal(calls.length, 5);
  for (const call of calls) assert.ok(call.size <= 50_000_000);
  assert.deepEqual(
    result.segments?.map((segment) => segment.start),
    [0, 1_200, 2_400, 3_600, 4_800],
  );
});

test("whisper providers: a file over 25 MB is split and segment times are shifted", async () => {
  const { preparer, state } = fakePreparer({ durationSec: 1_500 });
  const { calls, gateway } = build({
    kind: "openai",
    model: "whisper-1",
    preparer,
    respond: () =>
      json({ text: "seg", segments: [{ start: 1, end: 2, text: "seg" }] }),
  });
  const result = await gateway.asr.transcribe(request("big.mp3", 26_000_000));
  assert.equal(state.probes, 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    result.segments?.map((segment) => segment.start),
    [1, 601, 1_201],
  );
});

test("whisper providers: a small file is sent untouched without probing", async () => {
  const { preparer, state } = fakePreparer({ durationSec: 9_000 });
  const { calls, gateway } = build({
    kind: "openai",
    model: "whisper-1",
    preparer,
    respond: () => json({ text: "x" }),
  });
  await gateway.asr.transcribe(request("small.mp3"));
  assert.deepEqual(state, { probes: 0, normalizes: 0, disposed: 0 });
  assert.equal(calls[0]?.fileName, "small.mp3");
});

test("an unknown duration is treated as over the limit and normalized", async () => {
  const { preparer, state } = fakePreparer({ durationSec: 100, probe: null });
  const { calls, gateway } = build({
    kind: "deepinfra",
    model: "openai/whisper-large-v3",
    preparer,
    respond: () => json({ text: "x" }),
  });
  await gateway.asr.transcribe(request("odd.mp3"));
  assert.equal(state.normalizes, 1);
  assert.equal(calls.length, 1);
});

test("an unsupported container is decoded instead of rejected when a preparer exists", async () => {
  const { preparer } = fakePreparer({ durationSec: 60 });
  const { calls, gateway } = build({
    kind: "deepinfra",
    model: "openai/whisper-large-v3",
    preparer,
    respond: () => json({ text: "x" }),
  });
  await gateway.asr.transcribe(request("voice.aac"));
  assert.equal(calls[0]?.fileName, "voice.part-001.wav");
});

test("word timestamps on audio that must be split fail instead of being invented", async () => {
  const { preparer } = fakePreparer({ durationSec: 250 });
  const { calls, gateway } = build({
    kind: "deepseek",
    model: "deepseek-asr",
    preparer,
    respond: () => json({ text: "x" }),
  });
  await assert.rejects(
    () =>
      gateway.asr.transcribe({
        ...request("a.mp3"),
        timestampGranularities: ["word"],
      }),
    /Word timestamps/,
  );
  assert.equal(calls.length, 0);
});

test("an aborted call stops and still disposes the decoded audio", async () => {
  const { preparer, state } = fakePreparer({ durationSec: 1_000 });
  const controller = new AbortController();
  const { calls, gateway } = build({
    kind: "deepseek",
    model: "deepseek-asr",
    preparer,
    respond: async () => {
      controller.abort(new Error("cancelled"));
      return json({ text: "x" });
    },
  });
  await assert.rejects(() =>
    gateway.asr.transcribe(request("a.mp3"), { signal: controller.signal }),
  );
  assert.ok(calls.length <= 8);
  assert.equal(state.disposed, 1);
});
