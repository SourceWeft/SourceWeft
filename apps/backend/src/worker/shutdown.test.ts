import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { drainWorkerForShutdown } from "./shutdown";

afterEach(() => {
  vi.useRealTimers();
});

test("turns that end within the grace period are not stopped", async () => {
  vi.useFakeTimers();
  const interrupt = vi.fn(() => 0);
  const draining = drainWorkerForShutdown({
    closeWorkers: () => new Promise((resolve) => setTimeout(resolve, 1_000)),
    graceMs: 5_000,
    interruptActiveChatRuns: interrupt,
  });
  await vi.advanceTimersByTimeAsync(1_000);
  await draining;
  assert.equal(interrupt.mock.calls.length, 0);
});

test("turns still running after the grace period are stopped, then drained", async () => {
  vi.useFakeTimers();
  let finishJobs!: () => void;
  const interrupt = vi.fn(() => {
    // A stopped turn commits its failure and its job returns.
    setTimeout(finishJobs, 100);
    return 2;
  });
  const interrupted: number[] = [];
  let drained = false;
  const draining = drainWorkerForShutdown({
    closeWorkers: () =>
      new Promise<void>((resolve) => {
        finishJobs = resolve;
      }),
    graceMs: 5_000,
    interruptActiveChatRuns: interrupt,
    onInterrupted: (count) => interrupted.push(count),
  }).then(() => {
    drained = true;
  });

  await vi.advanceTimersByTimeAsync(4_999);
  assert.equal(interrupt.mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(interrupt.mock.calls.length, 1);
  assert.deepEqual(interrupted, [2]);
  assert.equal(drained, false);
  await vi.advanceTimersByTimeAsync(100);
  await draining;
  assert.equal(drained, true);
});
