import assert from "node:assert/strict";
import { test } from "vitest";
import { createApiProcessGuards } from "./process-guards";

function fixture(drain: () => Promise<unknown>, drainTimeoutMs = 50) {
  const events: string[] = [];
  const exits: number[] = [];
  const guards = createApiProcessGuards({
    logger: { error: (message) => events.push(`log:${message}`) },
    count: (name) => events.push(`count:${name}`),
    drain: async () => {
      events.push("drain");
      return drain();
    },
    exit: (code) => exits.push(code),
    drainTimeoutMs,
  });
  return { guards, events, exits };
}
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// One rejected promise nobody awaited — a failed tool call, once — must not
// take the API down for everyone.
test("an unhandled rejection is logged and counted, and the process keeps serving", async () => {
  const { guards, events, exits } = fixture(async () => undefined);
  guards.onUnhandledRejection(new Error("SANDBOX_NOT_READY_OR_UNHEALTHY"));
  await settle();
  assert.deepEqual(exits, []);
  assert.equal(events.includes("drain"), false);
  assert.ok(events.includes("count:process.unhandled_rejection"));
  assert.ok(events.some((event) => event.startsWith("log:Unhandled promise")));
});

// A synchronous throw that escaped everything: state is suspect, so restart.
test("an uncaught exception drains and then exits non-zero", async () => {
  const { guards, events, exits } = fixture(async () => undefined);
  guards.onUncaughtException(new Error("boom"));
  assert.deepEqual(exits, [], "must drain before exiting");
  await settle();
  assert.ok(events.includes("drain"));
  assert.deepEqual(exits, [1]);
});

test("a drain that hangs is cut off at the deadline", async () => {
  const { guards, exits } = fixture(() => new Promise(() => undefined), 30);
  guards.onUncaughtException(new Error("boom"));
  await settle(10);
  assert.deepEqual(exits, []);
  await settle(60);
  assert.deepEqual(exits, [1]);
});

test("a drain that throws still ends in an exit", async () => {
  const { guards, exits } = fixture(async () => {
    throw new Error("pool already closed");
  });
  guards.onUncaughtException(new Error("boom"));
  await settle();
  assert.deepEqual(exits, [1]);
});

test("a second uncaught exception while draining exits immediately", async () => {
  const { guards, events, exits } = fixture(
    () => new Promise(() => undefined),
    5_000,
  );
  guards.onUncaughtException(new Error("first"));
  guards.onUncaughtException(new Error("second"));
  // Exits at once, without waiting for the first drain…
  assert.deepEqual(exits, [1]);
  await settle();
  // …and never starts a second one.
  assert.equal(events.filter((event) => event === "drain").length, 1);
});
