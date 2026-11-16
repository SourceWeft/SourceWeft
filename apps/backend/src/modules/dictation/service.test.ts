import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: async () => ({ id: "w1", organizationId: "team-1" }),
}));
vi.mock("../workspace", () => ({
  workspaceService: {
    resolveBillingOrganizationId: async (input: {
      workspaceOrganizationId: string;
    }) => input.workspaceOrganizationId,
  },
}));
vi.mock("../../shared/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const resolveModelGatewayProfile = vi.fn();
vi.mock("../../shared/model-gateway", () => ({
  resolveModelGatewayProfile: (...args: unknown[]) =>
    resolveModelGatewayProfile(...args),
  withBilledModelGateway: vi.fn(),
}));

import { createRateLimiter } from "../../shared/rate-limit";
import { logger } from "../../shared/logger";
import { dictationAccountKey, type DictationAccrual } from "./accrual";
import { createDictationSlots } from "./limits";
import { transcribeDictationSegment } from "./service";

const PROFILE = {
  gatewayConfigId: "g1",
  profileAlias: "asr-dictation",
  modelAlias: "m1",
};

const KEY = dictationAccountKey({ teamId: "team-1", userId: "u1" });

/** A valid mono / 16 kHz / 16-bit PCM WAV of the requested length. */
function makeWav(seconds: number): Uint8Array {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dataSize = Math.round(seconds * byteRate);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  return bytes;
}

/** An in-memory DictationAccrual, with its store exposed for assertions. */
function memoryAccrual(initial: Record<string, number> = {}) {
  const store = new Map<string, number>(Object.entries(initial));
  const seen = new Set<string>();
  const accrual: DictationAccrual = {
    async markSegment(sessionId, seq) {
      const k = `${sessionId}:${seq}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
    async add(key, seconds) {
      const next = (store.get(key) ?? 0) + seconds;
      store.set(key, next);
      return next;
    },
    async take(key) {
      const value = store.get(key) ?? 0;
      store.delete(key);
      return value;
    },
    async restore(key, seconds) {
      store.set(key, (store.get(key) ?? 0) + seconds);
    },
  };
  return { accrual, store };
}

/** The two Redis commands the fixed-window limiter uses. */
function fakeRateRedis() {
  const counts = new Map<string, number>();
  return {
    async mget(...keys: string[]) {
      return keys.map((key) =>
        counts.has(key) ? String(counts.get(key)) : null,
      );
    },
    multi() {
      const ops: Array<() => void> = [];
      const pipeline = {
        incr(key: string) {
          ops.push(() => counts.set(key, (counts.get(key) ?? 0) + 1));
          return pipeline;
        },
        expire() {
          return pipeline;
        },
        async exec() {
          ops.forEach((op) => op());
          return ops.map(() => [null, 1] as [null, number]);
        },
      };
      return pipeline;
    },
  };
}

/** The INCR/EXPIRE pipeline plus DECR the slot counter uses. */
function fakeSlotsRedis() {
  const counts = new Map<string, number>();
  return {
    counts,
    redis: {
      multi() {
        const ops: Array<() => [null, number]> = [];
        const pipeline = {
          incr(key: string) {
            ops.push(() => {
              counts.set(key, (counts.get(key) ?? 0) + 1);
              return [null, counts.get(key)!];
            });
            return pipeline;
          },
          expire() {
            ops.push(() => [null, 1]);
            return pipeline;
          },
          async exec() {
            return ops.map((op) => op());
          },
        };
        return pipeline;
      },
      async decr(key: string) {
        counts.set(key, (counts.get(key) ?? 0) - 1);
        return counts.get(key)!;
      },
    },
  };
}

async function waitForCalls(
  spy: { mock: { calls: unknown[] } },
  n: number,
): Promise<void> {
  for (let i = 0; i < 500 && spy.mock.calls.length < n; i++) {
    await Promise.resolve();
  }
}

const transcribe = vi.fn();
const admit = vi.fn();
const settle = vi.fn();
const consume = vi.fn();
const release = vi.fn();
const acquire = vi.fn();
let mem = memoryAccrual();

const input = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: "w1",
  userId: "u1",
  sessionId: "s1",
  seq: 0,
  audio: makeWav(10),
  ...overrides,
});

const deps = (overrides: Record<string, unknown> = {}) =>
  ({
    billing: {} as never,
    resolveProfile: async () => PROFILE,
    transcribe,
    admit,
    settle,
    accrual: mem.accrual,
    rateLimiter: { consume },
    slots: { acquire },
    ...overrides,
  }) as never;

beforeEach(() => {
  transcribe.mockReset().mockResolvedValue({ text: "hi" });
  admit
    .mockReset()
    .mockResolvedValue({
      allowed: true,
      availableCredits: 100,
      billingMode: "enforced",
    });
  settle.mockReset().mockResolvedValue({ billingStatus: "metered" });
  consume.mockReset().mockResolvedValue({ allowed: true } as never);
  release.mockReset().mockResolvedValue(undefined);
  acquire.mockReset().mockResolvedValue(release);
  resolveModelGatewayProfile.mockReset().mockResolvedValue(PROFILE);
  (logger.info as ReturnType<typeof vi.fn>).mockClear();
  (logger.warn as ReturnType<typeof vi.fn>).mockClear();
  (logger.error as ReturnType<typeof vi.fn>).mockClear();
  mem = memoryAccrual();
});

test("no asr-dictation profile → 404 DICTATION_UNAVAILABLE and the provider is not called", async () => {
  resolveModelGatewayProfile.mockResolvedValue(null);

  await assert.rejects(
    transcribeDictationSegment(input(), deps({ resolveProfile: undefined })),
    (error: { statusCode?: number; code?: string }) =>
      error.statusCode === 404 && error.code === "DICTATION_UNAVAILABLE",
  );
  assert.equal(transcribe.mock.calls.length, 0);
});

test("a profile lookup never asks for another alias or the default", async () => {
  await transcribeDictationSegment(input(), deps({ resolveProfile: undefined }));

  assert.equal(resolveModelGatewayProfile.mock.calls.length, 1);
  assert.deepEqual(resolveModelGatewayProfile.mock.calls[0]![0], {
    kind: "asr",
    requestedProfileAlias: "asr-dictation",
    defaultRequired: false,
  });
});

test("invalid audio → 400 before any limit or credit is touched", async () => {
  await assert.rejects(
    transcribeDictationSegment(
      input({ audio: new Uint8Array([1, 2, 3]) }),
      deps(),
    ),
    (error: { statusCode?: number; code?: string }) =>
      error.statusCode === 400 && error.code === "DICTATION_INVALID_AUDIO",
  );
  assert.equal(consume.mock.calls.length, 0);
  assert.equal(acquire.mock.calls.length, 0);
  assert.equal(admit.mock.calls.length, 0);
  assert.equal(transcribe.mock.calls.length, 0);
});

test("the 61st request in a minute is limited", async () => {
  admit.mockResolvedValue({
    allowed: true,
    availableCredits: null,
    billingMode: "disabled",
  });
  const fake = fakeRateRedis();
  const limiter = createRateLimiter(
    async () => fake,
    () => 1_000_000_000,
  );
  const d = deps({ rateLimiter: limiter });

  for (let i = 0; i < 60; i++) {
    const r = await transcribeDictationSegment(input({ seq: i }), d);
    assert.equal(r.kind, "ok");
  }
  const r61 = await transcribeDictationSegment(input({ seq: 60 }), d);

  assert.equal(r61.kind, "limited");
  assert.equal(r61.kind === "limited" && r61.retryAfterSeconds > 0, true);
  assert.equal(transcribe.mock.calls.length, 60);
});

test("a third simultaneous request is limited and the slot is freed afterwards", async () => {
  admit.mockResolvedValue({
    allowed: true,
    availableCredits: null,
    billingMode: "disabled",
  });
  const slotRedis = fakeSlotsRedis();
  const slots = createDictationSlots(async () => slotRedis.redis as never);
  const resolvers: Array<() => void> = [];
  const blocking = vi.fn(
    () =>
      new Promise((resolveCall) => {
        resolvers.push(() => resolveCall({ text: "hi" }));
      }),
  );
  const d = deps({
    slots,
    transcribe: blocking,
    rateLimiter: { consume: async () => ({ allowed: true }) },
  });

  const p1 = transcribeDictationSegment(input({ seq: 0 }), d);
  const p2 = transcribeDictationSegment(input({ seq: 1 }), d);
  await waitForCalls(blocking, 2);

  const r3 = await transcribeDictationSegment(input({ seq: 2 }), d);
  assert.deepEqual(r3, { kind: "limited", retryAfterSeconds: 1 });

  resolvers[0]!();
  resolvers[1]!();
  await Promise.all([p1, p2]);

  const p4 = transcribeDictationSegment(input({ seq: 3 }), d);
  await waitForCalls(blocking, 3);
  resolvers[2]!();
  const r4 = await p4;
  assert.equal(r4.kind, "ok");
});

test("no credits → 402 DICTATION_INSUFFICIENT_CREDITS and the provider is not called", async () => {
  admit.mockResolvedValue({
    allowed: false,
    reason: "insufficient_credits",
    availableCredits: 0,
    billingMode: "enforced",
  });

  await assert.rejects(
    transcribeDictationSegment(input(), deps()),
    (error: { statusCode?: number; code?: string }) =>
      error.statusCode === 402 &&
      error.code === "DICTATION_INSUFFICIENT_CREDITS",
  );
  assert.equal(transcribe.mock.calls.length, 0);
  // The slot is released even when admission refuses.
  assert.equal(release.mock.calls.length, 1);
});

test("the call is covered: intent covered by settled_by_dictation_accrual, feature chat.dictation, key dictation:<session>:<seq>", async () => {
  await transcribeDictationSegment(
    input({ sessionId: "sess", seq: 5 }),
    deps(),
  );

  const args = transcribe.mock.calls[0]![0] as {
    context: {
      intent: { mode: string; coveredBy?: string };
      feature: string;
      scopeKind: string;
      scopeId: string;
    };
    idempotencyKey: string;
  };
  assert.equal(args.context.intent.mode, "covered");
  assert.equal(args.context.intent.coveredBy, "settled_by_dictation_accrual");
  assert.equal(args.context.feature, "chat.dictation");
  assert.equal(args.context.scopeKind, "api-request");
  assert.equal(args.context.scopeId, "dictation:sess");
  assert.equal(args.idempotencyKey, "dictation:sess:5");
});

test("below 300 s nothing is settled", async () => {
  const { accrual, store } = memoryAccrual();
  const d = deps({ accrual });

  await transcribeDictationSegment(input({ seq: 0 }), d);
  await transcribeDictationSegment(input({ seq: 1 }), d);
  await transcribeDictationSegment(input({ seq: 2 }), d);

  assert.equal(settle.mock.calls.length, 0);
  assert.equal(store.get(KEY), 30);
});

test("crossing 300 s settles everything accrued as one billed metering", async () => {
  const { accrual, store } = memoryAccrual({ [KEY]: 295 });

  await transcribeDictationSegment(input({ seq: 0 }), deps({ accrual }));

  assert.equal(settle.mock.calls.length, 1);
  const sArg = settle.mock.calls[0]![0] as {
    usage: { inputAudioSeconds: number };
    context: { intent: { mode: string }; feature: string; scopeKind: string; scopeId: string };
    options: {
      operation: string;
      modelKind: string;
      gatewayConfigId: string;
      profileAlias: string;
      modelAlias: string;
    };
    idempotencyKey: string;
    referenceId: string;
  };
  assert.equal(sArg.usage.inputAudioSeconds, 305);
  assert.equal(sArg.context.intent.mode, "billed");
  assert.equal(sArg.context.feature, "chat.dictation");
  assert.equal(sArg.context.scopeKind, "api-request");
  assert.equal(sArg.options.operation, "asr.dictation.settle");
  assert.equal(sArg.options.modelKind, "asr");
  assert.equal(sArg.options.gatewayConfigId, "g1");
  assert.equal(sArg.options.profileAlias, "asr-dictation");
  assert.equal(sArg.options.modelAlias, "m1");
  assert.equal(sArg.idempotencyKey, `dictation-settle:${sArg.context.scopeId}`);
  assert.equal(sArg.referenceId, sArg.idempotencyKey);
  assert.equal(store.get(KEY) ?? 0, 0);
});

test("a failed settlement keeps the seconds and the text is still returned", async () => {
  const { accrual, store } = memoryAccrual({ [KEY]: 295 });
  settle.mockRejectedValue(new Error("meter down"));

  const r = await transcribeDictationSegment(input({ seq: 0 }), deps({ accrual }));

  assert.equal(r.kind, "ok");
  assert.equal(store.get(KEY), 305);
});

test("the same session and sequence sent twice accrues once", async () => {
  const { accrual, store } = memoryAccrual();
  const d = deps({ accrual });

  await transcribeDictationSegment(input({ sessionId: "dup", seq: 7 }), d);
  await transcribeDictationSegment(input({ sessionId: "dup", seq: 7 }), d);

  assert.equal(store.get(KEY), 10);
  assert.equal(settle.mock.calls.length, 0);
});

test("billing not installed: no accrual, no settlement", async () => {
  admit.mockResolvedValue({
    allowed: true,
    availableCredits: null,
    billingMode: "disabled",
  });
  const { accrual, store } = memoryAccrual();
  const markSpy = vi.spyOn(accrual, "markSegment");

  await transcribeDictationSegment(input(), deps({ accrual }));

  assert.equal(settle.mock.calls.length, 0);
  assert.equal(markSpy.mock.calls.length, 0);
  assert.equal(store.size, 0);
});

test("the returned text is trimmed and durationSec is the file's length", async () => {
  transcribe.mockResolvedValue({ text: "  hello world  " });

  const r = await transcribeDictationSegment(
    input({ audio: makeWav(0.5) }),
    deps(),
  );

  assert.equal(r.kind, "ok");
  assert.equal(r.kind === "ok" && r.text, "hello world");
  assert.equal(r.kind === "ok" && r.durationSec, 0.5);
});

test("no log call and no settle metadata contains the transcript", async () => {
  const SECRET = "xyzzy-transcript-should-never-appear";
  transcribe.mockResolvedValue({ text: SECRET });
  const { accrual } = memoryAccrual({ [KEY]: 295 });

  await transcribeDictationSegment(input(), deps({ accrual }));

  const serialized = JSON.stringify([
    ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
    ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
    ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ...settle.mock.calls,
  ]);
  assert.equal(serialized.includes(SECRET), false);
});
