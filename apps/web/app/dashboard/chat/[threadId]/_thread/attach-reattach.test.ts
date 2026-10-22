import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ActiveThreadRun } from "../chat-stream-runner-control";
import {
  ATTACH_REATTACH_MAX_ATTEMPTS,
  ATTACH_REATTACH_MAX_DELAY_MS,
  createAttachReattachScheduler,
  resolveAttachReattachDelayMs,
  type AttachReattachDeps,
} from "./attach-reattach";

function run(overrides: Partial<ActiveThreadRun> = {}): ActiveThreadRun {
  return { idempotencyKey: "run-key", status: "running", ...overrides };
}

type DepFns = Required<
  Pick<
    AttachReattachDeps,
    "getActiveRun" | "isRunCurrent" | "reattach" | "settleEndedRun" | "onGiveUp"
  >
>;

function setup(overrides: Partial<DepFns> = {}) {
  const deps = {
    getActiveRun: vi.fn<DepFns["getActiveRun"]>(async () => run()),
    isRunCurrent: vi.fn<DepFns["isRunCurrent"]>(() => true),
    reattach: vi.fn<DepFns["reattach"]>(),
    settleEndedRun: vi.fn<DepFns["settleEndedRun"]>(),
    onGiveUp: vi.fn<DepFns["onGiveUp"]>(),
  };
  // Overrides become the mock's implementation so `.mock` stays typed.
  for (const key of Object.keys(overrides) as (keyof DepFns)[]) {
    const implementation = overrides[key];
    if (implementation) {
      (
        deps[key] as { mockImplementation: (fn: unknown) => void }
      ).mockImplementation(implementation);
    }
  }
  return { deps, scheduler: createAttachReattachScheduler(deps) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("backoff doubles from one second and is capped", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(resolveAttachReattachDelayMs),
    [1_000, 2_000, 4_000, 8_000, 8_000, 8_000],
  );
  assert.equal(resolveAttachReattachDelayMs(99), ATTACH_REATTACH_MAX_DELAY_MS);
});

test("same run still active re-attaches only after the backoff", async () => {
  const { deps, scheduler } = setup();

  assert.equal(
    scheduler.handleAttachFailure("run-key", new Error("x")),
    "scheduled",
  );
  await vi.advanceTimersByTimeAsync(999);
  assert.equal(deps.getActiveRun.mock.calls.length, 0);
  assert.equal(deps.reattach.mock.calls.length, 0);

  await vi.advanceTimersByTimeAsync(1);
  assert.equal(deps.getActiveRun.mock.calls.length, 1);
  assert.equal(deps.reattach.mock.calls.length, 1);
  assert.equal(deps.reattach.mock.calls[0]?.[0].idempotencyKey, "run-key");
  assert.equal(deps.settleEndedRun.mock.calls.length, 0);
  assert.equal(scheduler.hasPending("run-key"), false);
});

test("a run that is no longer active is settled and never retried", async () => {
  const { deps, scheduler } = setup({
    getActiveRun: vi.fn(async () => null),
  });

  scheduler.handleAttachFailure("run-key", new Error("x"));
  await vi.runAllTimersAsync();

  assert.deepEqual(deps.settleEndedRun.mock.calls, [["run-key"]]);
  assert.equal(deps.reattach.mock.calls.length, 0);
  assert.equal(deps.getActiveRun.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("a different active run settles the failed one instead of re-attaching", async () => {
  const { deps, scheduler } = setup({
    getActiveRun: vi.fn(async () => run({ idempotencyKey: "next-run" })),
  });

  scheduler.handleAttachFailure("run-key", new Error("x"));
  await vi.runAllTimersAsync();

  assert.deepEqual(deps.settleEndedRun.mock.calls, [["run-key"]]);
  assert.equal(deps.reattach.mock.calls.length, 0);
});

test("re-attach attempts stop at the cap and give up exactly once", async () => {
  const { deps, scheduler } = setup();
  const delays: number[] = [];

  for (let attempt = 1; attempt <= ATTACH_REATTACH_MAX_ATTEMPTS; attempt += 1) {
    assert.equal(
      scheduler.handleAttachFailure("run-key", new Error("x")),
      "scheduled",
    );
    delays.push(resolveAttachReattachDelayMs(attempt));
    await vi.runAllTimersAsync();
    // The re-attach starts (the reload path) and fails again.
    scheduler.noteStreamStart("run-key", true);
  }
  assert.equal(deps.reattach.mock.calls.length, ATTACH_REATTACH_MAX_ATTEMPTS);

  const finalError = new Error("still down");
  assert.equal(
    scheduler.handleAttachFailure("run-key", finalError),
    "exhausted",
  );
  assert.deepEqual(deps.onGiveUp.mock.calls, [["run-key", finalError]]);
  await vi.runAllTimersAsync();
  assert.equal(deps.reattach.mock.calls.length, ATTACH_REATTACH_MAX_ATTEMPTS);
  assert.equal(vi.getTimerCount(), 0);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
});

test("racing failures for one run schedule a single re-attach", async () => {
  let resolveActive: (value: ActiveThreadRun | null) => void = () => {};
  const { deps, scheduler } = setup({
    getActiveRun: vi.fn(
      () =>
        new Promise<ActiveThreadRun | null>((resolve) => {
          resolveActive = resolve;
        }),
    ),
  });

  assert.equal(
    scheduler.handleAttachFailure("run-key", new Error("a")),
    "scheduled",
  );
  assert.equal(
    scheduler.handleAttachFailure("run-key", new Error("b")),
    "pending",
  );
  await vi.advanceTimersByTimeAsync(1_000);
  // A third failure arrives while the reconcile read is still in flight.
  assert.equal(
    scheduler.handleAttachFailure("run-key", new Error("c")),
    "pending",
  );
  resolveActive(run());
  await vi.runAllTimersAsync();

  assert.equal(deps.getActiveRun.mock.calls.length, 1);
  assert.equal(deps.reattach.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("a failed reconcile read spends another bounded attempt", async () => {
  const { deps, scheduler } = setup({
    getActiveRun: vi
      .fn<() => Promise<ActiveThreadRun | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(run()),
  });

  scheduler.handleAttachFailure("run-key", new Error("x"));
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(deps.reattach.mock.calls.length, 0);
  assert.equal(scheduler.hasPending("run-key"), true);
  await vi.advanceTimersByTimeAsync(2_000);
  assert.equal(deps.getActiveRun.mock.calls.length, 2);
  assert.equal(deps.reattach.mock.calls.length, 1);
});

test("a failure for a run that is no longer current is ignored", async () => {
  const { deps, scheduler } = setup({ isRunCurrent: vi.fn(() => false) });

  assert.equal(
    scheduler.handleAttachFailure("run-key", new Error("x")),
    "ignored",
  );
  await vi.runAllTimersAsync();
  assert.equal(deps.getActiveRun.mock.calls.length, 0);
});

test("a run stopped or replaced during the backoff is left alone", async () => {
  const isRunCurrent = vi.fn<(runKey: string) => boolean>(() => true);
  const { deps, scheduler } = setup({ isRunCurrent });

  scheduler.handleAttachFailure("run-key", new Error("x"));
  isRunCurrent.mockReturnValue(false);
  await vi.runAllTimersAsync();

  assert.equal(deps.reattach.mock.calls.length, 0);
  assert.equal(deps.settleEndedRun.mock.calls.length, 0);
});

test("cancelAll (unmount, thread change, user stop) drops pending and in-flight reattaches", async () => {
  const { deps, scheduler } = setup();
  scheduler.handleAttachFailure("run-key", new Error("x"));
  scheduler.cancelAll();
  await vi.runAllTimersAsync();
  assert.equal(deps.getActiveRun.mock.calls.length, 0);

  let resolveActive: (value: ActiveThreadRun | null) => void = () => {};
  deps.getActiveRun.mockImplementation(
    () =>
      new Promise<ActiveThreadRun | null>((resolve) => {
        resolveActive = resolve;
      }),
  );
  scheduler.handleAttachFailure("run-key", new Error("y"));
  await vi.advanceTimersByTimeAsync(1_000);
  scheduler.cancelAll();
  resolveActive(run());
  await vi.runAllTimersAsync();
  assert.equal(deps.reattach.mock.calls.length, 0);
  assert.equal(deps.settleEndedRun.mock.calls.length, 0);
});

test("a new user run cancels recovery; a clean attach resets the attempt budget", async () => {
  const { deps, scheduler } = setup();
  scheduler.handleAttachFailure("run-key", new Error("x"));
  scheduler.noteStreamStart("other-run", false);
  await vi.runAllTimersAsync();
  assert.equal(deps.getActiveRun.mock.calls.length, 0);

  for (let attempt = 1; attempt <= ATTACH_REATTACH_MAX_ATTEMPTS; attempt += 1) {
    scheduler.handleAttachFailure("run-key", new Error("x"));
    await vi.runAllTimersAsync();
  }
  scheduler.noteAttachSucceeded("run-key");
  assert.equal(
    scheduler.handleAttachFailure("run-key", new Error("x")),
    "scheduled",
  );
  assert.equal(deps.onGiveUp.mock.calls.length, 0);
});

test("a first event resets the streak, so spaced-out drops keep recovering", async () => {
  const { deps, scheduler } = setup();

  // Far more drops than the cap, each after the re-attach received an event.
  for (let drop = 1; drop <= ATTACH_REATTACH_MAX_ATTEMPTS * 3; drop += 1) {
    assert.equal(
      scheduler.handleAttachFailure("run-key", new Error("drop")),
      "scheduled",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.noteStreamStart("run-key", true);
    scheduler.noteAttachProgress("run-key");
  }
  assert.equal(
    deps.reattach.mock.calls.length,
    ATTACH_REATTACH_MAX_ATTEMPTS * 3,
  );
  assert.equal(deps.onGiveUp.mock.calls.length, 0);
});

test("a re-attach whose reload fails spends the next attempt, within the cap", async () => {
  const { deps, scheduler } = setup({ reattach: async () => false });
  const failure = new Error("network error");

  scheduler.handleAttachFailure("run-key", failure);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(deps.reattach.mock.calls.length, 1);
  assert.equal(scheduler.hasPending("run-key"), true);
  await vi.advanceTimersByTimeAsync(2_000);
  assert.equal(deps.reattach.mock.calls.length, 2);

  await vi.runAllTimersAsync();
  assert.equal(deps.reattach.mock.calls.length, ATTACH_REATTACH_MAX_ATTEMPTS);
  assert.deepEqual(deps.onGiveUp.mock.calls, [["run-key", failure]]);
  assert.equal(vi.getTimerCount(), 0);
});

test("a thrown re-attach also counts as a failed attempt", async () => {
  const reloadError = new Error("reload exploded");
  const { deps, scheduler } = setup({
    reattach: async () => {
      throw reloadError;
    },
  });

  scheduler.handleAttachFailure("run-key", new Error("x"));
  await vi.runAllTimersAsync();

  assert.equal(deps.reattach.mock.calls.length, ATTACH_REATTACH_MAX_ATTEMPTS);
  assert.deepEqual(deps.onGiveUp.mock.calls, [["run-key", reloadError]]);
});

test("a failed re-attach resolving after a cancel schedules nothing", async () => {
  let resolveReattach: (started: boolean) => void = () => {};
  const { deps, scheduler } = setup({
    reattach: () =>
      new Promise<boolean>((resolve) => {
        resolveReattach = resolve;
      }),
  });

  scheduler.handleAttachFailure("run-key", new Error("x"));
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(deps.reattach.mock.calls.length, 1);
  scheduler.cancelAll();
  resolveReattach(false);
  await vi.runAllTimersAsync();

  assert.equal(deps.reattach.mock.calls.length, 1);
  assert.equal(scheduler.hasPending("run-key"), false);
});
