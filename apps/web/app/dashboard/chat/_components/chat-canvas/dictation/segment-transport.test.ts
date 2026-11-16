import assert from "node:assert/strict";
import { test } from "vitest";
import type { SpeechSegment } from "@sourceweft/ui-web/lib/audio/speech-segmenter";
import {
  createSegmentTransport,
  SegmentSendError,
  type SegmentTransportError,
} from "./segment-transport";

function segment(): SpeechSegment {
  return { samples: new Int16Array([1, 2, 3, 4]), durationMs: 100, endedBy: "pause" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending microtask (including ones chained during this flush) settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function failingErrorHandler(): (error: SegmentTransportError) => void {
  return (error) => {
    throw new Error(`unexpected onError: ${error.reason}`);
  };
}

test("text is delivered in sequence order when a later segment answers first", async () => {
  const deferredsBySeq = new Map<number, ReturnType<typeof deferred<{ text: string }>>>();
  const delivered: Array<{ text: string; seq: number }> = [];

  const transport = createSegmentTransport({
    send: (_wav, seq) => {
      const d = deferred<{ text: string }>();
      deferredsBySeq.set(seq, d);
      return d.promise;
    },
    onText: (text, seg) => delivered.push({ text, seq: seg.seq }),
    onError: failingErrorHandler(),
  });

  transport.enqueue(segment());
  transport.enqueue(segment());

  deferredsBySeq.get(1)!.resolve({ text: "two" });
  await tick();
  assert.deepEqual(delivered, []);

  deferredsBySeq.get(0)!.resolve({ text: "one" });
  await tick();
  assert.deepEqual(delivered, [
    { text: "one", seq: 0 },
    { text: "two", seq: 1 },
  ]);
});

test("no more than two requests are in flight", async () => {
  const sends: number[] = [];
  const deferredsBySeq = new Map<number, ReturnType<typeof deferred<{ text: string }>>>();

  const transport = createSegmentTransport({
    send: (_wav, seq) => {
      sends.push(seq);
      const d = deferred<{ text: string }>();
      deferredsBySeq.set(seq, d);
      return d.promise;
    },
    onText: () => {},
    onError: failingErrorHandler(),
  });

  for (let i = 0; i < 4; i++) transport.enqueue(segment());

  assert.deepEqual(sends, [0, 1]);

  deferredsBySeq.get(0)!.resolve({ text: "ok" });
  await tick();

  assert.deepEqual(sends, [0, 1, 2]);
});

test("an empty result is skipped and the next one still arrives", async () => {
  const deferredsBySeq = new Map<number, ReturnType<typeof deferred<{ text: string }>>>();
  const delivered: number[] = [];

  const transport = createSegmentTransport({
    send: (_wav, seq) => {
      const d = deferred<{ text: string }>();
      deferredsBySeq.set(seq, d);
      return d.promise;
    },
    onText: (_text, seg) => delivered.push(seg.seq),
    onError: failingErrorHandler(),
  });

  transport.enqueue(segment());
  transport.enqueue(segment());

  deferredsBySeq.get(0)!.resolve({ text: "" });
  await tick();
  deferredsBySeq.get(1)!.resolve({ text: "hello" });
  await tick();

  assert.deepEqual(delivered, [1]);
  assert.equal(transport.pending(), 0);
});

test("a failed request is retried once and then delivered", async () => {
  let callCount = 0;
  const delivered: string[] = [];

  const transport = createSegmentTransport({
    send: async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new SegmentSendError(500);
      }
      return { text: "ok" };
    },
    onText: (text) => delivered.push(text),
    onError: failingErrorHandler(),
  });

  transport.enqueue(segment());
  await transport.whenIdle();

  assert.equal(callCount, 2);
  assert.deepEqual(delivered, ["ok"]);
});

test("a second failure reports failed once and stops delivering", async () => {
  const errors: SegmentTransportError[] = [];
  const delivered: string[] = [];

  const transport = createSegmentTransport({
    send: async () => {
      throw new SegmentSendError(500);
    },
    onText: (text) => delivered.push(text),
    onError: (error) => errors.push(error),
  });

  transport.enqueue(segment());
  transport.enqueue(segment());
  await tick();
  await tick();

  assert.deepEqual(errors, [{ reason: "failed" }]);
  assert.deepEqual(delivered, []);
});

test("402 is not retried and reports insufficient-credits", async () => {
  let callCount = 0;
  const errors: SegmentTransportError[] = [];

  const transport = createSegmentTransport({
    send: async () => {
      callCount += 1;
      throw new SegmentSendError(402);
    },
    onText: () => {},
    onError: (error) => errors.push(error),
  });

  transport.enqueue(segment());
  await tick();

  assert.equal(callCount, 1);
  assert.deepEqual(errors, [{ reason: "insufficient-credits" }]);
});

test("404 reports unavailable", async () => {
  const errors: SegmentTransportError[] = [];

  const transport = createSegmentTransport({
    send: async () => {
      throw new SegmentSendError(404);
    },
    onText: () => {},
    onError: (error) => errors.push(error),
  });

  transport.enqueue(segment());
  await tick();

  assert.deepEqual(errors, [{ reason: "unavailable" }]);
});

test("429 waits for Retry-After, capped at 5 s, then retries once", async () => {
  let callCount = 0;
  const waitCalls: number[] = [];

  const transport = createSegmentTransport({
    send: async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new SegmentSendError(429, 20);
      }
      return { text: "ok" };
    },
    onText: () => {},
    onError: failingErrorHandler(),
    wait: async (ms) => {
      waitCalls.push(ms);
    },
  });

  transport.enqueue(segment());
  await tick();

  assert.deepEqual(waitCalls, [5000]);
  assert.equal(callCount, 2);
});

test("abort cancels in-flight requests and delivers nothing afterwards", async () => {
  const delivered: string[] = [];
  let capturedSignal: AbortSignal | undefined;
  let resolveSend!: (value: { text: string }) => void;

  const transport = createSegmentTransport({
    send: (_wav, _seq, signal) => {
      capturedSignal = signal;
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    },
    onText: (text) => delivered.push(text),
    onError: failingErrorHandler(),
  });

  transport.enqueue(segment());
  transport.abort();

  assert.equal(capturedSignal?.aborted, true);

  resolveSend({ text: "late" });
  await tick();

  assert.deepEqual(delivered, []);
});

test("whenIdle resolves after the last delivery", async () => {
  const order: string[] = [];

  const transport = createSegmentTransport({
    send: async () => ({ text: "hi" }),
    onText: () => {
      order.push("text");
    },
    onError: failingErrorHandler(),
  });

  transport.enqueue(segment());
  await transport.whenIdle();
  order.push("idle");

  assert.deepEqual(order, ["text", "idle"]);
});

test("pending counts enqueued minus delivered", async () => {
  const resolvers: Array<(value: { text: string }) => void> = [];

  const transport = createSegmentTransport({
    send: () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    onText: () => {},
    onError: failingErrorHandler(),
  });

  transport.enqueue(segment());
  assert.equal(transport.pending(), 1);

  transport.enqueue(segment());
  assert.equal(transport.pending(), 2);

  resolvers[0]!({ text: "a" });
  await tick();

  assert.equal(transport.pending(), 1);
});

test("whenIdle resolves after abort with a segment in flight", { timeout: 2000 }, async () => {
  const pendingChanges: number[] = [];

  const transport = createSegmentTransport({
    send: () => new Promise<{ text: string }>(() => {}),
    onText: () => {},
    onError: failingErrorHandler(),
    onPendingChange: (count) => pendingChanges.push(count),
  });

  transport.enqueue(segment());
  const idle = transport.whenIdle();
  transport.abort();

  await idle;

  assert.equal(transport.pending(), 0);
  assert.deepEqual(pendingChanges, [1, 0]);
});

test(
  "whenIdle resolves after a terminal failure with a second segment still in flight",
  { timeout: 2000 },
  async () => {
    const errors: SegmentTransportError[] = [];

    const transport = createSegmentTransport({
      send: async (_wav, seq) => {
        if (seq === 0) {
          throw new SegmentSendError(402);
        }
        return new Promise<{ text: string }>(() => {});
      },
      onText: () => {},
      onError: (error) => errors.push(error),
    });

    transport.enqueue(segment());
    transport.enqueue(segment());

    await transport.whenIdle();

    assert.deepEqual(errors, [{ reason: "insufficient-credits" }]);
    assert.equal(transport.pending(), 0);
  },
);

test("enqueue after abort sends nothing", async () => {
  const sends: number[] = [];

  const transport = createSegmentTransport({
    send: (_wav, seq) => {
      sends.push(seq);
      return new Promise<{ text: string }>(() => {});
    },
    onText: () => {},
    onError: failingErrorHandler(),
  });

  transport.enqueue(segment());
  assert.deepEqual(sends, [0]);

  transport.abort();
  transport.enqueue(segment());
  await tick();

  assert.deepEqual(sends, [0]);
  assert.equal(transport.pending(), 0);
});

test("a 429 whose retry also fails ends as rate-limited", async () => {
  let callCount = 0;
  const waitCalls: number[] = [];
  const errors: SegmentTransportError[] = [];

  const transport = createSegmentTransport({
    send: async () => {
      callCount += 1;
      throw new SegmentSendError(429, 20);
    },
    onText: () => {},
    onError: (error) => errors.push(error),
    wait: async (ms) => {
      waitCalls.push(ms);
    },
  });

  transport.enqueue(segment());
  await tick();
  await tick();

  assert.equal(callCount, 2);
  assert.deepEqual(waitCalls, [5000]);
  assert.deepEqual(errors, [{ reason: "rate-limited" }]);
});

test("a 429 whose retry fails with 402 reports insufficient-credits", async () => {
  let callCount = 0;
  const errors: SegmentTransportError[] = [];

  const transport = createSegmentTransport({
    send: async () => {
      callCount += 1;
      // First attempt is a 429; the one retry hits a hard credit wall.
      throw new SegmentSendError(callCount === 1 ? 429 : 402, 20);
    },
    onText: () => {},
    onError: (error) => errors.push(error),
    wait: async () => {},
  });

  transport.enqueue(segment());
  await tick();
  await tick();

  assert.equal(callCount, 2);
  assert.deepEqual(errors, [{ reason: "insufficient-credits" }]);
});

test("a 429 whose retry fails with 404 reports unavailable", async () => {
  let callCount = 0;
  const errors: SegmentTransportError[] = [];

  const transport = createSegmentTransport({
    send: async () => {
      callCount += 1;
      throw new SegmentSendError(callCount === 1 ? 429 : 404, 20);
    },
    onText: () => {},
    onError: (error) => errors.push(error),
    wait: async () => {},
  });

  transport.enqueue(segment());
  await tick();
  await tick();

  assert.equal(callCount, 2);
  assert.deepEqual(errors, [{ reason: "unavailable" }]);
});
