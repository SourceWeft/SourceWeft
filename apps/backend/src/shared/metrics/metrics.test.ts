import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: {
    debug: vi.fn(),
    info: mocks.info,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { metrics } from "./index";

afterEach(() => {
  metrics.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

test("inc accumulates, gauge is last-write, observe tracks count/sum/max/avg", () => {
  metrics.inc("t.counter", { label: "a" });
  metrics.inc("t.counter", { label: "a" }, 2);
  metrics.gauge("t.gauge", 5);
  metrics.gauge("t.gauge", 9);
  metrics.observe("t.obs", 2);
  metrics.observe("t.obs", 4);

  const snap = metrics.snapshot();
  assert.equal(snap.counters["t.counter{label=a}"], 3);
  assert.equal(snap.gauges["t.gauge"], 9);
  assert.deepEqual(snap.observations["t.obs"], {
    count: 2,
    sum: 6,
    max: 4,
    avg: 3,
  });
});

test("labels are order-independent in the metric key", () => {
  metrics.inc("t.labeled", { b: 2, a: 1 });
  metrics.inc("t.labeled", { a: 1, b: 2 });
  assert.equal(metrics.snapshot().counters["t.labeled{a=1,b=2}"], 2);
});

test("the periodic flush logs one metrics.snapshot line and resets deltas", () => {
  vi.useFakeTimers();
  metrics.inc("t.flushed", { status: "completed" });
  metrics.observe("t.flushed_ms", 250, { status: "completed" });

  // The worker and the API both call this once at startup; a second call is a
  // no-op rather than a second timer.
  metrics.startPeriodicFlush(1_000);
  metrics.startPeriodicFlush(1_000);
  vi.advanceTimersByTime(1_000);

  const snapshotCalls = mocks.info.mock.calls.filter(
    (call) => call[0] === "metrics.snapshot",
  );
  assert.equal(snapshotCalls.length, 1);
  const snapshot = snapshotCalls[0]?.[1] as ReturnType<typeof metrics.snapshot>;
  assert.equal(snapshot.counters["t.flushed{status=completed}"], 1);
  assert.equal(snapshot.observations["t.flushed_ms{status=completed}"]?.max, 250);

  // Deltas are cleared after the flush (gauges persist by design), so the next
  // interval does not report the same count again.
  assert.equal("t.flushed{status=completed}" in metrics.snapshot().counters, false);
  vi.advanceTimersByTime(1_000);
  const later = mocks.info.mock.calls
    .filter((call) => call[0] === "metrics.snapshot")
    .map((call) => call[1] as ReturnType<typeof metrics.snapshot>);
  for (const snap of later.slice(1)) {
    assert.equal("t.flushed{status=completed}" in snap.counters, false);
  }
});
