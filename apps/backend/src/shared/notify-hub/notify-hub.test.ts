import assert from "node:assert/strict";
import { test } from "vitest";
import { NotifyHub } from "./hub";
import { serializeThreadEvent } from "./publisher";
import type { ThreadEventPayload } from "./types";

function payload(overrides: Partial<ThreadEventPayload> = {}): ThreadEventPayload {
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    kind: "run_started",
    ...overrides,
  };
}

test("dispatch reaches only subscribers of the event's thread", () => {
  const hub = new NotifyHub();
  const threadOne: ThreadEventPayload[] = [];
  const threadTwo: ThreadEventPayload[] = [];
  hub.subscribe("thread-1", { id: "a", onEvent: (p) => threadOne.push(p) });
  hub.subscribe("thread-2", { id: "b", onEvent: (p) => threadTwo.push(p) });

  hub.dispatch(payload({ threadId: "thread-1" }));

  assert.equal(threadOne.length, 1);
  assert.equal(threadTwo.length, 0);
});

test("unsubscribe removes the subscriber and drops the empty thread set", () => {
  const hub = new NotifyHub();
  const unsubscribe = hub.subscribe("thread-1", {
    id: "a",
    onEvent: () => undefined,
  });
  assert.equal(hub.subscriberCount("thread-1"), 1);

  unsubscribe();
  assert.equal(hub.subscriberCount("thread-1"), 0);
  // Idempotent: a second call must not throw or go negative.
  unsubscribe();
  assert.equal(hub.subscriberCount("thread-1"), 0);
});

test("a throwing subscriber does not break fan-out to the others", () => {
  const hub = new NotifyHub();
  const delivered: string[] = [];
  hub.subscribe("thread-1", {
    id: "bad",
    onEvent: () => {
      throw new Error("boom");
    },
  });
  hub.subscribe("thread-1", {
    id: "good",
    onEvent: () => delivered.push("ok"),
  });

  hub.dispatch(payload({ threadId: "thread-1" }));

  assert.deepEqual(delivered, ["ok"]);
});

test("dispatch to a thread with no subscribers is a no-op", () => {
  const hub = new NotifyHub();
  assert.doesNotThrow(() => hub.dispatch(payload({ threadId: "nobody" })));
});

test("serializeThreadEvent round-trips a normal payload", () => {
  const input = payload({ runId: "run-1", status: "running" });
  assert.deepEqual(JSON.parse(serializeThreadEvent(input)), input);
});

test("reserve holds a slot, attach swaps it in, release frees it (idempotent)", () => {
  const hub = new NotifyHub();
  const result = hub.reserve("thread-1");
  assert.ok(result.ok);
  // The placeholder holds the counted slot before the real subscriber attaches.
  assert.equal(hub.subscriberCount("thread-1"), 1);

  const delivered: string[] = [];
  result.reservation.attach({ id: "real", onEvent: () => delivered.push("x") });
  // Swap keeps the count constant.
  assert.equal(hub.subscriberCount("thread-1"), 1);

  hub.dispatch(payload({ threadId: "thread-1" }));
  assert.deepEqual(delivered, ["x"]);

  result.reservation.release();
  assert.equal(hub.subscriberCount("thread-1"), 0);
  // Double release must not go negative or throw.
  result.reservation.release();
  assert.equal(hub.subscriberCount("thread-1"), 0);
});

test("reserve rejects a thread once it hits the per-thread cap (default 200)", () => {
  const hub = new NotifyHub();
  for (let i = 0; i < 200; i += 1) {
    assert.ok(hub.reserve("thread-1").ok);
  }
  const over = hub.reserve("thread-1");
  assert.equal(over.ok, false);
  if (!over.ok) {
    assert.equal(over.reason, "per_thread");
  }
  // A different thread is unaffected by another thread's saturation.
  assert.ok(hub.reserve("thread-2").ok);
});

test("serializeThreadEvent rejects an over-limit payload", () => {
  // A payload should never carry content; if one ever does, fail loudly rather
  // than let Postgres truncate/reject it silently.
  const oversized = payload({ status: "x".repeat(8100) });
  assert.throws(() => serializeThreadEvent(oversized), /NOTIFY limit/);
});
