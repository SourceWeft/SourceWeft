import assert from "node:assert/strict";
import test from "node:test";
import {
  asrSpanToPcmRange,
  buildPcm16WavFile,
  planAsrChunks,
  resolveAsrChunkSec,
  stitchAsrChunks,
} from "../src/asr/chunking";
import type { AsrLimits } from "../src/asr/types";
import type { AsrTranscribeResult } from "../src/types";

const times = (spans: readonly { startSec: number; endSec: number }[]) =>
  spans.map((span) => [span.startSec, span.endSec]);
const span = (startSec: number, endSec: number, endsInSilence = true) => ({
  startSec,
  endSec,
  endsInSilence,
});

const base: AsrLimits = {
  acceptedFormats: ["wav"],
  timestamps: "none",
  chunkSec: 600,
  maxConcurrent: 4,
};

test("chunk length is capped by duration and size limits minus the snap window", () => {
  assert.equal(resolveAsrChunkSec(base, 16_000), 600);
  assert.equal(
    resolveAsrChunkSec({ ...base, chunkSec: 100, maxDurationSec: 120 }, 16_000),
    100,
  );
  assert.equal(
    resolveAsrChunkSec({ ...base, maxDurationSec: 120 }, 16_000),
    110,
  );
  // 8 MiB of 16 kHz mono PCM is 262 s; minus the 10 s window.
  assert.equal(
    resolveAsrChunkSec({ ...base, maxBytes: 8 * 1024 * 1024 }, 16_000),
    252,
  );
});

test("audio shorter than one chunk is a single span", () => {
  assert.deepEqual(
    times(planAsrChunks({ durationSec: 42, chunkSec: 100, silences: [] })),
    [[0, 42]],
  );
  assert.deepEqual(
    planAsrChunks({ durationSec: 0, chunkSec: 100, silences: [] }),
    [],
  );
});

test("without silence, cuts fall on the target and cover the audio exactly", () => {
  const spans = planAsrChunks({
    durationSec: 250,
    chunkSec: 100,
    silences: [],
  });
  assert.deepEqual(times(spans), [
    [0, 100],
    [100, 200],
    [200, 250],
  ]);
  // Cuts with no silence nearby are marked, so stitching can undo the full
  // stop a model adds at a chunk end. The end of the audio is not a cut.
  assert.deepEqual(
    spans.map((item) => item.endsInSilence),
    [false, false, true],
  );
});

test("a cut snaps to the middle of the nearest silence inside the window", () => {
  const spans = planAsrChunks({
    durationSec: 250,
    chunkSec: 100,
    silences: [
      { startSec: 96, endSec: 98 }, // mid 97, within 10 s of 100
      { startSec: 80, endSec: 82 }, // too far
      { startSec: 199, endSec: 200 }, // mid 199.5 for the next target of 197
    ],
  });
  assert.deepEqual(times(spans), [
    [0, 97],
    [97, 199.5],
    [199.5, 250],
  ]);
  assert.deepEqual(
    spans.map((span) => span.endsInSilence),
    [true, true, true],
  );
});

test("a pause up to 10 s from the target is used", () => {
  const spans = planAsrChunks({
    durationSec: 250,
    chunkSec: 100,
    silences: [{ startSec: 91.5, endSec: 92.5 }], // mid 92, 8 s early
  });
  assert.deepEqual(times(spans).slice(0, 1), [[0, 92]]);
});

test("the longest pause in the window wins over a nearer short one", () => {
  // A sentence usually ends on a longer pause than the gap between two items
  // of a list, so the long one is the better place to cut.
  const spans = planAsrChunks({
    durationSec: 250,
    chunkSec: 100,
    silences: [
      { startSec: 99.3, endSec: 99.7 }, // 0.4 s, half a second from target
      { startSec: 93, endSec: 94.2 }, // 1.2 s, further away
    ],
  });
  assert.equal(spans[0]?.endSec, 93.6);
});

test("equally long pauses fall back to the nearest", () => {
  const spans = planAsrChunks({
    durationSec: 250,
    chunkSec: 100,
    silences: [
      { startSec: 92, endSec: 93 },
      { startSec: 101, endSec: 102 },
    ],
  });
  assert.equal(spans[0]?.endSec, 101.5);
});

test("a short tail is folded into the last chunk instead of becoming a sliver", () => {
  const spans = planAsrChunks({
    durationSec: 203,
    chunkSec: 100,
    silences: [],
  });
  assert.deepEqual(times(spans), [
    [0, 100],
    [100, 203],
  ]);
});

test("no chunk exceeds chunk length plus the snap window", () => {
  const spans = planAsrChunks({
    durationSec: 3_600,
    chunkSec: 100,
    silences: Array.from({ length: 700 }, (_, i) => ({
      startSec: i * 5.1,
      endSec: i * 5.1 + 0.4,
    })),
  });
  for (const span of spans) {
    assert.ok(span.endSec - span.startSec <= 110, JSON.stringify(span));
    assert.equal(span.endsInSilence, true);
  }
  assert.equal(spans[0]?.startSec, 0);
  assert.equal(spans.at(-1)?.endSec, 3_600);
  spans.slice(1).forEach((span, index) => {
    assert.equal(span.startSec, spans[index]?.endSec);
  });
});

test("span byte ranges are sample-aligned and clamped", () => {
  assert.deepEqual(asrSpanToPcmRange(span(1, 2.00003), 16_000, 1_000_000), {
    byteStart: 32_000,
    byteEnd: 64_000,
  });
  assert.deepEqual(asrSpanToPcmRange(span(0, 99), 16_000, 1_000), {
    byteStart: 0,
    byteEnd: 1_000,
  });
});

test("the WAV header describes mono 16-bit PCM of the right length", () => {
  const wav = buildPcm16WavFile(new Uint8Array([1, 2, 3, 4]), 16_000);
  const view = new DataView(wav.buffer);
  const text = (from: number) =>
    String.fromCharCode(...wav.subarray(from, from + 4));
  assert.equal(wav.byteLength, 48);
  assert.equal(text(0), "RIFF");
  assert.equal(view.getUint32(4, true), 40);
  assert.equal(text(8), "WAVE");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 4);
  assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4]);
});

function result(overrides: Partial<AsrTranscribeResult>): AsrTranscribeResult {
  return { model: "m", text: "", raw: {}, ...overrides };
}

test("stitching shifts provider segments onto the original timeline", () => {
  const stitched = stitchAsrChunks({
    spans: [span(0, 100), span(100, 180)],
    results: [
      result({
        text: " first ",
        segments: [{ start: 0, end: 4, text: "first" }],
        usage: { inputAudioTokens: 10 },
      }),
      result({
        text: "second",
        segments: [{ start: 1, end: 3, text: "second" }],
        usage: { inputAudioTokens: 5 },
      }),
    ],
    durationSec: 180,
  });
  assert.equal(stitched.text, "first\nsecond");
  assert.deepEqual(stitched.segments, [
    { start: 0, end: 4, text: "first" },
    { start: 101, end: 103, text: "second" },
  ]);
  assert.equal(stitched.duration, 180);
  assert.equal(stitched.inputLengthMs, 180_000);
  assert.deepEqual(stitched.usage, { inputAudioTokens: 15 });
  assert.equal(stitched.raw.chunkCount, 2);
});

test("a provider without timestamps gets one segment per chunk; silent chunks are skipped", () => {
  const stitched = stitchAsrChunks({
    spans: [span(0, 100), span(100, 200), span(200, 250)],
    results: [
      result({ text: "a" }),
      result({ text: "  " }),
      result({ text: "c" }),
    ],
    durationSec: 250,
  });
  assert.equal(stitched.text, "a\nc");
  assert.deepEqual(stitched.segments, [
    { start: 0, end: 100, text: "a" },
    { start: 200, end: 250, text: "c" },
  ]);
});

test("stitching refuses results that do not match the plan", () => {
  assert.throws(() =>
    stitchAsrChunks({
      spans: [span(0, 1)],
      results: [],
      durationSec: 1,
    }),
  );
});

test("a cut that found no pause drops the full stop the model added and joins the text", () => {
  // "废弃耕地" split across two chunks: each chunk is transcribed as its own
  // sentence, so the first comes back ending in a full stop that was never said.
  const stitched = stitchAsrChunks({
    spans: [span(0, 100, false), span(100, 200, false), span(200, 250)],
    results: [
      result({ text: "每年被洪水淹没的废弃。" }),
      result({ text: "耕地和稻田. " }),
      result({ text: "这是最后一句。" }),
    ],
    durationSec: 250,
  });
  assert.equal(stitched.text, "每年被洪水淹没的废弃耕地和稻田这是最后一句。");
  assert.deepEqual(
    stitched.segments?.map((segment) => segment.text),
    ["每年被洪水淹没的废弃", "耕地和稻田", "这是最后一句。"],
  );
});

test("a cut on a pause keeps the chunk's punctuation and starts a new line", () => {
  const stitched = stitchAsrChunks({
    spans: [span(0, 100), span(100, 200)],
    results: [result({ text: "第一句。" }), result({ text: "第二句。" })],
    durationSec: 200,
  });
  assert.equal(stitched.text, "第一句。\n第二句。");
});

test("only a single trailing full stop is dropped, never other punctuation", () => {
  const stitched = stitchAsrChunks({
    spans: [span(0, 100, false), span(100, 200, false), span(200, 300)],
    results: [
      result({ text: "真的吗？" }),
      result({ text: "等一下……" }),
      result({ text: "好。" }),
    ],
    durationSec: 300,
  });
  assert.equal(stitched.text, "真的吗？等一下……好。");
});

test("an English hard cut joins with a space", () => {
  const stitched = stitchAsrChunks({
    spans: [span(0, 100, false), span(100, 200)],
    results: [
      result({ text: "we must expect that." }),
      result({ text: "As soon as stability is reached" }),
    ],
    durationSec: 200,
  });
  assert.equal(
    stitched.text,
    "we must expect that As soon as stability is reached",
  );
});
