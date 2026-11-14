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
    115,
  );
  // 8 MiB of 16 kHz mono PCM is 262 s; minus the 5 s window.
  assert.equal(
    resolveAsrChunkSec({ ...base, maxBytes: 8 * 1024 * 1024 }, 16_000),
    257,
  );
});

test("audio shorter than one chunk is a single span", () => {
  assert.deepEqual(
    planAsrChunks({ durationSec: 42, chunkSec: 100, silences: [] }),
    [{ startSec: 0, endSec: 42 }],
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
  assert.deepEqual(spans, [
    { startSec: 0, endSec: 100 },
    { startSec: 100, endSec: 200 },
    { startSec: 200, endSec: 250 },
  ]);
});

test("a cut snaps to the middle of the nearest silence inside the window", () => {
  const spans = planAsrChunks({
    durationSec: 250,
    chunkSec: 100,
    silences: [
      { startSec: 96, endSec: 98 }, // mid 97, within 5 s of 100
      { startSec: 80, endSec: 82 }, // too far
      { startSec: 199, endSec: 200 }, // mid 199.5 for the next target of 197
    ],
  });
  assert.deepEqual(spans, [
    { startSec: 0, endSec: 97 },
    { startSec: 97, endSec: 199.5 },
    { startSec: 199.5, endSec: 250 },
  ]);
});

test("a short tail is folded into the last chunk instead of becoming a sliver", () => {
  const spans = planAsrChunks({
    durationSec: 203,
    chunkSec: 100,
    silences: [],
  });
  assert.deepEqual(spans, [
    { startSec: 0, endSec: 100 },
    { startSec: 100, endSec: 203 },
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
  }
  assert.equal(spans[0]?.startSec, 0);
  assert.equal(spans.at(-1)?.endSec, 3_600);
  spans.slice(1).forEach((span, index) => {
    assert.equal(span.startSec, spans[index]?.endSec);
  });
});

test("span byte ranges are sample-aligned and clamped", () => {
  assert.deepEqual(
    asrSpanToPcmRange({ startSec: 1, endSec: 2.00003 }, 16_000, 1_000_000),
    { byteStart: 32_000, byteEnd: 64_000 },
  );
  assert.deepEqual(
    asrSpanToPcmRange({ startSec: 0, endSec: 99 }, 16_000, 1_000),
    { byteStart: 0, byteEnd: 1_000 },
  );
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
    spans: [
      { startSec: 0, endSec: 100 },
      { startSec: 100, endSec: 180 },
    ],
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
    spans: [
      { startSec: 0, endSec: 100 },
      { startSec: 100, endSec: 200 },
      { startSec: 200, endSec: 250 },
    ],
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
      spans: [{ startSec: 0, endSec: 1 }],
      results: [],
      durationSec: 1,
    }),
  );
});
