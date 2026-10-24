/**
 * The claim throttle (Issue #367, W7). Every start or verify can make an
 * outbound request (GitHub, DNS, or the publisher's own domain), so a member
 * gets a small budget, derived from a log of their recent attempts
 * (`market_mcp_claim_attempts`) with no counter service:
 *
 * - at most one verify per member and server every 30 seconds;
 * - at most 10 attempts (start or verify, any server) per member per hour.
 *
 * Pure: ./repository.ts reads the log and writes the attempt.
 */

export const CLAIM_THROTTLE = Object.freeze({
  verifyIntervalMs: 30_000,
  windowMs: 60 * 60 * 1000,
  maxPerWindow: 10,
});

export type ThrottleVerdict =
  | { ok: true }
  | { ok: false; reason: "interval" | "hourly"; retryAfterSeconds: number };

export function throttleVerdict(input: {
  kind: "start" | "verify";
  now: Date;
  /** This member's latest verify on this server, if any. */
  lastVerifyAt: Date | null;
  /** This member's attempts in the last hour, across servers. */
  attemptsInWindow: number;
  /** The oldest of those attempts; null when there are none. */
  oldestInWindow: Date | null;
}): ThrottleVerdict {
  const now = input.now.getTime();
  if (input.kind === "verify" && input.lastVerifyAt) {
    const elapsed = now - input.lastVerifyAt.getTime();
    if (elapsed >= 0 && elapsed < CLAIM_THROTTLE.verifyIntervalMs) {
      return {
        ok: false,
        reason: "interval",
        retryAfterSeconds: Math.ceil(
          (CLAIM_THROTTLE.verifyIntervalMs - elapsed) / 1000,
        ),
      };
    }
  }
  if (input.attemptsInWindow >= CLAIM_THROTTLE.maxPerWindow) {
    const frees = (input.oldestInWindow?.getTime() ?? now) + CLAIM_THROTTLE.windowMs;
    return {
      ok: false,
      reason: "hourly",
      retryAfterSeconds: Math.max(1, Math.ceil((frees - now) / 1000)),
    };
  }
  return { ok: true };
}
