import assert from "node:assert/strict";
import { test } from "vitest";
import { isContentError } from "../content/errors";
import {
  createRunCancellationGate,
  guardCancellableWrite,
} from "./run-cancellation";

/**
 * The gate is what stops an in-flight tool from persisting output after the
 * user pressed Stop. These pin the two behaviors that matter: a cancelled run
 * blocks the write (with the CLIENT_CANCELLED code the stream loop already
 * treats as a cancel), and a live run is a pure pass-through.
 */

test("throwIfCancelled rejects with CLIENT_CANCELLED when the run is cancelled", async () => {
  const gate = createRunCancellationGate({
    shouldCancel: async () => true,
  });

  await assert.rejects(gate.throwIfCancelled("publishing the artifact"), (error) => {
    assert.ok(isContentError(error));
    assert.equal(error.statusCode, 499);
    assert.equal(error.code, "CLIENT_CANCELLED");
    return true;
  });
});

test("throwIfCancelled resolves while the run is still live", async () => {
  const gate = createRunCancellationGate({
    shouldCancel: async () => false,
  });

  await assert.doesNotReject(gate.throwIfCancelled("publishing the artifact"));
});

test("throwIfCancelled trips on an already-aborted signal without polling", async () => {
  const controller = new AbortController();
  controller.abort();
  let polled = false;
  const gate = createRunCancellationGate({
    signal: controller.signal,
    shouldCancel: async () => {
      polled = true;
      return false;
    },
  });

  await assert.rejects(gate.throwIfCancelled());
  assert.equal(polled, false, "an aborted signal short-circuits the poll");
});

test("guardCancellableWrite returns the function untouched when no gate is wired", () => {
  const write = async (value: number) => value + 1;
  assert.equal(guardCancellableWrite(undefined, "writing", write), write);
});

test("guardCancellableWrite blocks the write on a cancelled run and never calls it", async () => {
  let called = false;
  const write = async (value: number) => {
    called = true;
    return value + 1;
  };
  const guarded = guardCancellableWrite(
    createRunCancellationGate({ shouldCancel: async () => true }),
    "writing",
    write,
  );

  await assert.rejects(guarded(1));
  assert.equal(called, false, "a cancelled run must not reach the write");
});

test("guardCancellableWrite forwards args and result while the run is live", async () => {
  const guarded = guardCancellableWrite(
    createRunCancellationGate({ shouldCancel: async () => false }),
    "writing",
    async (a: number, b: number) => a * b,
  );

  assert.equal(await guarded(3, 4), 12);
});
