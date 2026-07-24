import assert from "node:assert/strict";
import { test } from "vitest";
import { metrics } from "./index";

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
