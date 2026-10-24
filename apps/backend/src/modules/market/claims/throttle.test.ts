import { describe, expect, test } from "vitest";
import { CLAIM_THROTTLE, throttleVerdict } from "./throttle";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe("claim throttle", () => {
  test("a first attempt always passes", () => {
    for (const kind of ["start", "verify"] as const) {
      expect(
        throttleVerdict({
          kind,
          now: NOW,
          lastVerifyAt: null,
          attemptsInWindow: 0,
          oldestInWindow: null,
        }),
      ).toEqual({ ok: true });
    }
  });

  test("a verify within 30 s of the last one on the server waits out the rest", () => {
    expect(
      throttleVerdict({
        kind: "verify",
        now: NOW,
        lastVerifyAt: ago(12),
        attemptsInWindow: 1,
        oldestInWindow: ago(12),
      }),
    ).toEqual({ ok: false, reason: "interval", retryAfterSeconds: 18 });
    expect(
      throttleVerdict({
        kind: "verify",
        now: NOW,
        lastVerifyAt: ago(30),
        attemptsInWindow: 1,
        oldestInWindow: ago(30),
      }),
    ).toEqual({ ok: true });
  });

  test("a last verify stamped after this request's own time is too soon, not a pass", () => {
    // Taken before waiting for the member's lock, served after a later stamp.
    expect(
      throttleVerdict({
        kind: "verify",
        now: NOW,
        lastVerifyAt: ago(-3),
        attemptsInWindow: 1,
        oldestInWindow: ago(-3),
      }),
    ).toEqual({ ok: false, reason: "interval", retryAfterSeconds: 30 });
  });

  test("the spacing is for verifies; a start is not held by it", () => {
    expect(
      throttleVerdict({
        kind: "start",
        now: NOW,
        lastVerifyAt: ago(1),
        attemptsInWindow: 1,
        oldestInWindow: ago(1),
      }),
    ).toEqual({ ok: true });
  });

  test("ten attempts in the hour use the budget; it frees when the oldest ages out", () => {
    expect(
      throttleVerdict({
        kind: "start",
        now: NOW,
        lastVerifyAt: null,
        attemptsInWindow: CLAIM_THROTTLE.maxPerWindow - 1,
        oldestInWindow: ago(100),
      }),
    ).toEqual({ ok: true });
    expect(
      throttleVerdict({
        kind: "start",
        now: NOW,
        lastVerifyAt: null,
        attemptsInWindow: CLAIM_THROTTLE.maxPerWindow,
        oldestInWindow: ago(600),
      }),
    ).toEqual({ ok: false, reason: "hourly", retryAfterSeconds: 3000 });
  });

  test("the spacing is reported before the hourly limit when both apply", () => {
    expect(
      throttleVerdict({
        kind: "verify",
        now: NOW,
        lastVerifyAt: ago(5),
        attemptsInWindow: 10,
        oldestInWindow: ago(5),
      }),
    ).toMatchObject({ ok: false, reason: "interval" });
  });
});
