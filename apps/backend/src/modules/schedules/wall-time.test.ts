import { describe, expect, it } from "vitest";
import { stableJitterMs, stableOffsetMs } from "./jitter";
import {
  instantToWallTime,
  wallTimeToInstant,
  zoneOffsetMs,
} from "./wall-time";

const MIN = 60_000;
const HOUR = 60 * MIN;
const utc = (iso: string) => new Date(iso).getTime();

describe("zone offsets", () => {
  it("follows daylight saving and fractional offsets", () => {
    expect(zoneOffsetMs(utc("2027-01-15T12:00:00Z"), "UTC")).toBe(0);
    expect(zoneOffsetMs(utc("2027-01-15T12:00:00Z"), "Asia/Shanghai")).toBe(
      8 * HOUR,
    );
    expect(zoneOffsetMs(utc("2027-01-15T12:00:00Z"), "America/New_York")).toBe(
      -5 * HOUR,
    );
    expect(zoneOffsetMs(utc("2027-07-15T12:00:00Z"), "America/New_York")).toBe(
      -4 * HOUR,
    );
    expect(zoneOffsetMs(utc("2027-07-15T12:00:00Z"), "Asia/Kolkata")).toBe(
      5.5 * HOUR,
    );
    // The last second before the jump and the jump itself.
    expect(zoneOffsetMs(utc("2027-03-14T06:59:59Z"), "America/New_York")).toBe(
      -5 * HOUR,
    );
    expect(zoneOffsetMs(utc("2027-03-14T07:00:00Z"), "America/New_York")).toBe(
      -4 * HOUR,
    );
  });

  it("shows the zone's clock as a floating wall time", () => {
    expect(
      instantToWallTime(utc("2027-01-01T00:00:00.250Z"), "Asia/Shanghai"),
    ).toBe(utc("2027-01-01T08:00:00.250Z"));
  });
});

describe("wallTimeToInstant", () => {
  it("places an ordinary wall time", () => {
    expect(
      wallTimeToInstant(utc("2027-01-01T08:00:00Z"), "Asia/Shanghai"),
    ).toEqual({ kind: "instant", instantMs: utc("2027-01-01T00:00:00Z") });
    expect(
      wallTimeToInstant(utc("2027-07-01T09:30:00Z"), "America/New_York"),
    ).toEqual({ kind: "instant", instantMs: utc("2027-07-01T13:30:00Z") });
  });

  it("resolves a skipped wall time to the moment the clock jumps", () => {
    for (const wall of [
      "2027-03-14T02:00:00Z",
      "2027-03-14T02:30:00Z",
      "2027-03-14T02:59:59Z",
    ])
      expect(wallTimeToInstant(utc(wall), "America/New_York")).toEqual({
        kind: "gap",
        instantMs: utc("2027-03-14T07:00:00Z"),
        gapMs: HOUR,
      });
    // Either side of the skipped hour is ordinary.
    expect(
      wallTimeToInstant(utc("2027-03-14T01:59:59Z"), "America/New_York"),
    ).toEqual({ kind: "instant", instantMs: utc("2027-03-14T06:59:59Z") });
    expect(
      wallTimeToInstant(utc("2027-03-14T03:00:00Z"), "America/New_York"),
    ).toEqual({ kind: "instant", instantMs: utc("2027-03-14T07:00:00Z") });
    expect(
      wallTimeToInstant(utc("2027-03-28T02:30:00Z"), "Europe/Berlin"),
    ).toEqual({
      kind: "gap",
      instantMs: utc("2027-03-28T01:00:00Z"),
      gapMs: HOUR,
    });
  });

  it("handles a half-hour jump", () => {
    // Lord Howe Island moves 02:00 +10:30 to 02:30 +11:00 on 2027-10-03.
    expect(
      wallTimeToInstant(utc("2027-10-03T02:15:00Z"), "Australia/Lord_Howe"),
    ).toEqual({
      kind: "gap",
      instantMs: utc("2027-10-02T15:30:00Z"),
      gapMs: 30 * MIN,
    });
  });

  it("resolves a repeated wall time to its first occurrence", () => {
    expect(
      wallTimeToInstant(utc("2027-11-07T01:30:00Z"), "America/New_York"),
    ).toEqual({ kind: "instant", instantMs: utc("2027-11-07T05:30:00Z") });
    expect(
      wallTimeToInstant(utc("2027-10-31T02:30:00Z"), "Europe/Berlin"),
    ).toEqual({ kind: "instant", instantMs: utc("2027-10-31T00:30:00Z") });
    // After the repeated hour the standard offset applies.
    expect(
      wallTimeToInstant(utc("2027-11-07T02:00:00Z"), "America/New_York"),
    ).toEqual({ kind: "instant", instantMs: utc("2027-11-07T07:00:00Z") });
  });
});

describe("stableOffsetMs", () => {
  it("is fixed per key, below the cap, and spread across keys", () => {
    const cap = 5 * MIN;
    expect(stableOffsetMs("task-a", cap)).toBe(stableOffsetMs("task-a", cap));
    const offsets = Array.from({ length: 200 }, (_, index) =>
      stableOffsetMs(`task-${index}`, cap),
    );
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(cap);
    }
    expect(new Set(offsets).size).toBeGreaterThan(190);
    // Not all bunched in one half of the range.
    expect(offsets.filter((offset) => offset < cap / 2).length).toBeGreaterThan(
      60,
    );
    expect(
      offsets.filter((offset) => offset >= cap / 2).length,
    ).toBeGreaterThan(60);
  });

  it("is zero without room to spread, and backs the interval jitter unchanged", () => {
    expect(stableOffsetMs("task-a", 0)).toBe(0);
    expect(stableOffsetMs("task-a", 0.5)).toBe(0);
    expect(stableJitterMs("connector-1", 60)).toBe(
      stableOffsetMs("connector-1", 5 * MIN),
    );
    expect(stableJitterMs("connector-1", 30)).toBe(
      stableOffsetMs("connector-1", 3 * MIN),
    );
  });
});
