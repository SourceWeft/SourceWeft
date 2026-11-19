import { createHash } from "node:crypto";

/**
 * A fixed offset in `[0, capMs)` derived from `key`: the same key always gets
 * the same offset, and different keys spread across the range.
 */
export function stableOffsetMs(key: string, capMs: number) {
  if (capMs < 1) return 0;
  return (
    createHash("sha256").update(key).digest().readUInt32BE(0) %
    Math.floor(capMs)
  );
}

/**
 * A fixed per-target offset that spreads schedules apart so they do not all
 * fire on the same minute. Capped at ten percent of the interval and at five
 * minutes; the same key always gets the same offset.
 */
export function stableJitterMs(key: string, intervalMinutes: number) {
  return stableOffsetMs(
    key,
    Math.min(5 * 60_000, intervalMinutes * 60_000 * 0.1),
  );
}
