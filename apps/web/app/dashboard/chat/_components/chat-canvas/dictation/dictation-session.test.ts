import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";

import { PcmCaptureFailure } from "@sourceweft/ui-web/lib/audio/pcm-capture";
import { createSpeechSegmenter } from "@sourceweft/ui-web/lib/audio/speech-segmenter";

import { createDictationSession, type DictationSession } from "./dictation-session";
import { SegmentSendError } from "./segment-transport";

const SAMPLES_PER_FRAME = 320;

// A loud frame reads well above the speech threshold; a quiet one is silence.
const loud = () => new Int16Array(SAMPLES_PER_FRAME).fill(10000);
const quiet = () => new Int16Array(SAMPLES_PER_FRAME);

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type PendingSend = {
  sessionId: string;
  seq: number;
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
};

function fakeSend() {
  const pending: PendingSend[] = [];
  const calls: Array<{ sessionId: string; seq: number }> = [];
  const send = (_wav: Uint8Array, seq: number, sessionId: string) => {
    calls.push({ sessionId, seq });
    return new Promise<{ text: string }>((resolve, reject) => {
      pending.push({
        sessionId,
        seq,
        resolve: (text) => resolve({ text }),
        reject,
      });
    });
  };
  return { send, pending, calls };
}

function fakeCapture() {
  let onFrame: ((frame: Int16Array) => void) | null = null;
  let onEnded: (() => void) | null = null;
  let stopped = false;
  let failure: PcmCaptureFailure | null = null;
  const startCapture = (async (input: {
    onFrame: (frame: Int16Array) => void;
    onEnded?: () => void;
  }) => {
    if (failure) {
      throw failure;
    }
    onFrame = input.onFrame;
    onEnded = input.onEnded ?? null;
    return { stop: () => {
      stopped = true;
    } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return {
    startCapture,
    push: (frame: Int16Array) => onFrame?.(frame),
    end: () => onEnded?.(),
    isStopped: () => stopped,
    failWith: (value: PcmCaptureFailure) => {
      failure = value;
    },
  };
}

function pushN(cap: ReturnType<typeof fakeCapture>, make: () => Int16Array, n: number) {
  for (let i = 0; i < n; i += 1) cap.push(make());
}

// One spoken phrase followed by a pause: a single "pause" segment.
function sentence(cap: ReturnType<typeof fakeCapture>) {
  pushN(cap, loud, 30);
  pushN(cap, quiet, 40);
}

let clock = 0;
let nextId = 0;
const now = () => clock;
const newSessionId = () => `s${(nextId += 1)}`;

let session: DictationSession | null = null;

beforeEach(() => {
  clock = 0;
  nextId = 0;
});

afterEach(() => {
  session?.dispose();
  session = null;
});

function build(
  cap: ReturnType<typeof fakeCapture>,
  snd: ReturnType<typeof fakeSend>,
  inserted: string[],
  insertText: (text: string) => boolean = (text) => {
    inserted.push(text);
    return true;
  },
) {
  session = createDictationSession({
    startCapture: cap.startCapture,
    createSegmenter: createSpeechSegmenter,
    send: snd.send,
    insertText,
    now,
    newSessionId,
  });
  return session;
}

test("a spoken sentence followed by a pause is inserted once its text arrives", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  sentence(cap);
  assert.equal(snd.calls.length, 1);
  assert.deepEqual(inserted, []);

  snd.pending[0]!.resolve("Hello world.");
  await tick();
  assert.deepEqual(inserted, ["Hello world."]);
});

test("two sentences are inserted in order and joined by the joining rule", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  sentence(cap);
  sentence(cap);
  assert.equal(snd.calls.length, 2);

  snd.pending[0]!.resolve("Hello world.");
  await tick();
  snd.pending[1]!.resolve("Next one.");
  await tick();
  assert.deepEqual(inserted, ["Hello world.", " Next one."]);
});

test("stop sends the open segment and resolves after its text is inserted", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  pushN(cap, loud, 30); // open, no pause yet
  assert.equal(snd.calls.length, 0);

  const stopped = s.stop();
  assert.equal(snd.calls.length, 1);
  assert.equal(s.snapshot().status, "finishing");

  snd.pending[0]!.resolve("Open words");
  await stopped;
  assert.deepEqual(inserted, ["Open words"]);
  assert.deepEqual(s.snapshot(), { status: "idle", notice: null });
  assert.ok(cap.isStopped());
});

test("60 s without speech stops with silence-timeout", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  // 3000 silent frames * 20 ms = 60_000 ms since speech.
  pushN(cap, quiet, 3000);
  await tick();

  assert.equal(snd.calls.length, 0);
  assert.deepEqual(s.snapshot(), { status: "idle", notice: "silence-timeout" });
  assert.ok(cap.isStopped());
});

test("10 minutes in total stops with max-duration", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  pushN(cap, loud, 5); // speaking, so silence never trips; < 300 ms so nothing is sent
  clock = 600_000;
  cap.push(loud());
  await tick();

  assert.equal(snd.calls.length, 0);
  assert.deepEqual(s.snapshot(), { status: "idle", notice: "max-duration" });
  assert.ok(cap.isStopped());
});

test("a refused microphone ends idle with permission-denied and no request", async () => {
  const cap = fakeCapture();
  cap.failWith(new PcmCaptureFailure("permission-denied"));
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  assert.deepEqual(s.snapshot(), { status: "idle", notice: "permission-denied" });
  assert.equal(snd.calls.length, 0);
});

test("402 from the server stops capture, keeps inserted text and shows insufficient-credits", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  sentence(cap);
  snd.pending[0]!.resolve("First.");
  await tick();
  assert.deepEqual(inserted, ["First."]);

  sentence(cap);
  snd.pending[1]!.reject(new SegmentSendError(402));
  await tick();
  await tick();

  assert.deepEqual(inserted, ["First."]);
  assert.deepEqual(s.snapshot(), { status: "idle", notice: "insufficient-credits" });
  assert.ok(cap.isStopped());
});

test("a segment cut at 15 s loses its trailing full stop", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  pushN(cap, loud, 770); // past the 15 s (750 frame) hard cut
  assert.equal(snd.calls.length, 1);

  snd.pending[0]!.resolve("Hello world.");
  await tick();
  assert.deepEqual(inserted, ["Hello world"]);
});

test("starting again while the previous run is finishing inserts the late text first, once", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  sentence(cap); // run 1, seq 0
  assert.equal(snd.calls.length, 1);

  const stopped = s.stop();
  assert.equal(s.snapshot().status, "finishing");

  await s.start(); // run 2 begins while run 1 is still finishing
  assert.equal(s.snapshot().status, "listening");
  sentence(cap); // run 2, seq 0
  assert.equal(snd.calls.length, 2);

  // Run 2's text arrives first but must wait for run 1 to finish inserting.
  snd.pending[1]!.resolve("Second run.");
  await tick();
  assert.deepEqual(inserted, []);

  snd.pending[0]!.resolve("First run.");
  await tick();
  await tick();
  assert.deepEqual(inserted, ["First run.", "Second run."]);
  await stopped;
});

test("each run uses a new session id and restarts sequence numbers at 0", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  sentence(cap);
  sentence(cap);
  snd.pending[0]!.resolve("a");
  snd.pending[1]!.resolve("b");
  await tick();
  await s.stop();

  await s.start();
  sentence(cap);
  snd.pending[2]!.resolve("c");
  await tick();
  await s.stop();

  assert.deepEqual(
    snd.calls.map((call) => `${call.sessionId}:${call.seq}`),
    ["s1:0", "s1:1", "s2:0"],
  );
});

test("an unplugged microphone stops with device-lost and keeps the text", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  sentence(cap);
  snd.pending[0]!.resolve("Kept.");
  await tick();
  assert.deepEqual(inserted, ["Kept."]);

  cap.end();
  assert.deepEqual(s.snapshot(), { status: "idle", notice: "device-lost" });
  assert.ok(cap.isStopped());
  assert.deepEqual(inserted, ["Kept."]);
});

test("dispose closes the microphone and inserts nothing afterwards", async () => {
  const cap = fakeCapture();
  const snd = fakeSend();
  const inserted: string[] = [];
  const s = build(cap, snd, inserted);

  await s.start();
  sentence(cap);
  assert.equal(snd.calls.length, 1);

  s.dispose();
  assert.ok(cap.isStopped());

  snd.pending[0]!.resolve("late");
  await tick();
  await tick();
  assert.deepEqual(inserted, []);
});
