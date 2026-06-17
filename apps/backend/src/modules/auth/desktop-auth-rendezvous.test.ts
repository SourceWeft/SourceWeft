import assert from "node:assert/strict";
import { test } from "vitest";
import { desktopAuthRendezvous } from "./desktop-auth-rendezvous";

// ── complete ────────────────────────────────────────────────────────

test("complete accepts a valid state and token", () => {
  const result = desktopAuthRendezvous.complete({
    state: "auth-state-abc-1234567890",
    token: "token-data-here",
  });
  assert.equal(result, "ok");
});

test("complete rejects a state that is too short", () => {
  const result = desktopAuthRendezvous.complete({
    state: "short",
    token: "token-data-here",
  });
  assert.equal(result, "invalid");
});

test("complete rejects a state with invalid characters", () => {
  const result = desktopAuthRendezvous.complete({
    state: "invalid state with spaces",
    token: "token-data-here",
  });
  assert.equal(result, "invalid");
});

test("complete rejects an empty token", () => {
  const result = desktopAuthRendezvous.complete({
    state: "auth-state-abc-1234567890",
    token: "",
  });
  assert.equal(result, "invalid");
});

test("complete rejects a whitespace-only token", () => {
  const result = desktopAuthRendezvous.complete({
    state: "auth-state-abc-1234567890",
    token: "   ",
  });
  assert.equal(result, "invalid");
});

// ── consume ─────────────────────────────────────────────────────────

test("consume returns 'pending' for an unknown state", () => {
  const result = desktopAuthRendezvous.consume("unknown-state-12345678");
  assert.equal(result.status, "pending");
});

test("consume returns 'invalid' for a state with invalid chars", () => {
  const result = desktopAuthRendezvous.consume("bad state!");
  assert.equal(result.status, "invalid");
});

test("consume returns 'invalid' for a state that is too short", () => {
  const result = desktopAuthRendezvous.consume("x");
  assert.equal(result.status, "invalid");
});

test("complete then consume returns the token", () => {
  const state = "test-state-abcdef-1234567890";
  const token = "secret-token-value";

  const completeResult = desktopAuthRendezvous.complete({ state, token });
  assert.equal(completeResult, "ok");

  const consumeResult = desktopAuthRendezvous.consume(state);
  assert.equal(consumeResult.status, "complete");
  if (consumeResult.status === "complete") {
    assert.equal(consumeResult.token, token);
  }
});

test("consume is one-shot — second consume returns pending", () => {
  const state = "test-state-abcdef-9876543210";

  desktopAuthRendezvous.complete({ state, token: "token-one" });
  const first = desktopAuthRendezvous.consume(state);
  assert.equal(first.status, "complete");

  const second = desktopAuthRendezvous.consume(state);
  assert.equal(second.status, "pending");
});
