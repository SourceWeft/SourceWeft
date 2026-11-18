/**
 * Wall-clock time in an IANA time zone.
 *
 * A wall time is carried as a "floating" epoch: the milliseconds a UTC clock
 * would show for the same year, month, day, hour and minute. Rules are
 * evaluated on floating time, where there is no daylight saving, and each
 * result is then placed on the real timeline by `wallTimeToInstant`.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Milliseconds the zone's clock is ahead of UTC at `instantMs`. */
export function zoneOffsetMs(instantMs: number, timeZone: string) {
  const seconds = Math.floor(instantMs / 1000) * 1000;
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(seconds))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return wall - seconds;
}

/** The floating wall time the zone's clock shows at `instantMs`. */
export function instantToWallTime(instantMs: number, timeZone: string) {
  return instantMs + zoneOffsetMs(instantMs, timeZone);
}

export type WallTimeResolution =
  /** The wall time happens once, or twice and this is the first time. */
  | { kind: "instant"; instantMs: number }
  /**
   * The clock skips this wall time (spring forward). `instantMs` is the first
   * valid moment after the jump; `gapMs` is how far the clock jumped.
   */
  | { kind: "gap"; instantMs: number; gapMs: number };

const DAY_MS = 24 * 60 * 60_000;

/**
 * Places a floating wall time on the real timeline.
 *
 * A wall time the clock shows twice (autumn) resolves to its first occurrence.
 * One the clock never shows (spring) resolves to the moment the clock jumps.
 * Assumes at most one offset change within a day either side, which holds for
 * every zone's current rules.
 */
export function wallTimeToInstant(
  wallMs: number,
  timeZone: string,
): WallTimeResolution {
  const before = zoneOffsetMs(wallMs - DAY_MS, timeZone);
  const after = zoneOffsetMs(wallMs + DAY_MS, timeZone);
  const candidates = [wallMs - before, wallMs - after].filter(
    (instantMs) => instantMs + zoneOffsetMs(instantMs, timeZone) === wallMs,
  );
  if (candidates.length > 0) {
    return { kind: "instant", instantMs: Math.min(...candidates) };
  }
  // Nothing maps to this wall time, so the clock jumped over it. The jump is
  // between the two failed candidates; find the first moment on its far side.
  let low = Math.min(wallMs - before, wallMs - after);
  let high = Math.max(wallMs - before, wallMs - after);
  const offsetAfterJump = zoneOffsetMs(high, timeZone);
  while (high - low > 1000) {
    const middle = low + Math.floor((high - low) / 2000) * 1000;
    if (zoneOffsetMs(middle, timeZone) === offsetAfterJump) high = middle;
    else low = middle;
  }
  return {
    kind: "gap",
    instantMs: Math.ceil(high / 1000) * 1000,
    gapMs: Math.abs(after - before),
  };
}
