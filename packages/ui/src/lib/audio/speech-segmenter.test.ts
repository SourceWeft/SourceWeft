import { expect, test } from "vitest";
import {
  createSpeechSegmenter,
  SEGMENTER_DEFAULTS,
  type SpeechSegment,
  type SpeechSegmenter,
} from "./speech-segmenter";

// Asserted with vitest's `expect` rather than `node:assert`: this is a browser
// component library, and it declares no `@types/node`.

const SAMPLES_PER_FRAME = (SEGMENTER_DEFAULTS.sampleRate * SEGMENTER_DEFAULTS.frameMs) / 1000;

// A square wave of constant amplitude has an RMS level equal to its peak
// amplitude, so an alternating +/-amplitude pattern gives frames whose
// computed dBFS level matches the requested one exactly (up to rounding the
// amplitude to an integer sample value).
function toneFrame(dbfs: number): Int16Array {
  const amplitude = Math.round(32768 * Math.pow(10, dbfs / 20));
  const frame = new Int16Array(SAMPLES_PER_FRAME);
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    frame[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return frame;
}

function tone(ms: number, dbfs: number): Int16Array[] {
  const frameCount = ms / SEGMENTER_DEFAULTS.frameMs;
  const frame = toneFrame(dbfs);
  return Array.from({ length: frameCount }, () => frame.slice());
}

function quiet(ms: number, dbfs = -70): Int16Array[] {
  return tone(ms, dbfs);
}

function run(segmenter: SpeechSegmenter, frames: Int16Array[]): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  for (const frame of frames) out.push(...segmenter.push(frame));
  return out;
}

test("speech between silences is one segment with pre-roll and post-roll", () => {
  const out = run(createSpeechSegmenter(), [...quiet(1000), ...tone(1000, -20), ...quiet(1000)]);
  expect(out).toHaveLength(1);
  expect(out[0]!.endedBy).toBe("pause");
  expect(out[0]!.durationMs).toBe(240 + 1000 + 200);
});

test("the segment is emitted 600 ms after speech ends, not earlier", () => {
  const s = createSpeechSegmenter();
  run(s, [...quiet(500), ...tone(1000, -20)]);
  expect(run(s, quiet(580))).toHaveLength(0);
  expect(run(s, quiet(20))).toHaveLength(1);
});

test("under 300 ms of speech is dropped", () => {
  expect(run(createSpeechSegmenter(), [...quiet(500), ...tone(200, -20), ...quiet(1000)])).toHaveLength(0);
});

test("a level under -45 dBFS is never speech, however quiet the room", () => {
  expect(
    run(createSpeechSegmenter(), [...quiet(1000, -90), ...tone(1000, -50), ...quiet(1000, -90)]),
  ).toHaveLength(0);
});

test("the floor follows a noisier room", () => {
  // 20 s of -40 dBFS room noise: the floor climbs to it (one junk segment on the way is allowed).
  const s = createSpeechSegmenter();
  run(s, quiet(20000, -40));
  // 5 dB above the room is not speech; 20 dB above it is.
  expect(run(s, [...tone(1000, -35), ...quiet(1000, -40)])).toHaveLength(0);
  expect(run(s, [...tone(1000, -20), ...quiet(1000, -40)])).toHaveLength(1);
});

test("long continuous speech does not raise the floor into the speech", () => {
  const out = run(createSpeechSegmenter(), [...quiet(500), ...tone(12000, -25), ...quiet(1000)]);
  expect(out).toHaveLength(1);
  expect(out[0]!.durationMs).toBe(240 + 12000 + 200);
});

test("continuous speech is cut at 15 s at the quietest point of the last 2 s", () => {
  // 14.2 s loud, 100 ms dip to -30 (still speech), then loud again.
  const s = createSpeechSegmenter();
  const out = run(s, [
    ...quiet(500),
    ...tone(14200, -15),
    ...tone(100, -30),
    ...tone(3000, -15),
    ...quiet(1000),
  ]);
  expect(out[0]!.endedBy).toBe("cut");
  expect(out[0]!.durationMs).toBeLessThanOrEqual(15000);
  expect(out[0]!.durationMs).toBeGreaterThan(14000);
  expect(out).toHaveLength(2);
  expect(out[0]!.durationMs + out[1]!.durationMs).toBe(240 + 17300 + 200);
});

test("flush ends the open segment and reports it", () => {
  const s = createSpeechSegmenter();
  run(s, [...quiet(500), ...tone(800, -20)]);
  expect(s.flush()?.endedBy).toBe("flush");
  expect(s.flush()).toBeNull();
});

test("msSinceSpeech counts silence and resets on speech", () => {
  const s = createSpeechSegmenter();
  run(s, [...quiet(500), ...tone(400, -20), ...quiet(1000)]);
  expect(s.msSinceSpeech()).toBe(1000);
});
