import type { ScheduleRule } from "@sourceweft/contracts/scheduled-tasks";
import { describe, expect, it } from "vitest";
import {
  CATCH_UP_GRACE_MS,
  ScheduleRuleError,
  compileScheduleRule,
  nextFireTimes,
  planDueSlot,
  validateScheduleRule,
} from "./rules";

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string) => new Date(iso);
const iso = (dates: Date[]) => dates.map((date) => date.toISOString());
const fires = (
  rule: ScheduleRule,
  timeZone: string,
  after: string,
  count: number,
) => iso(nextFireTimes(rule, timeZone, at(after), count));
const cron = (expr: string): ScheduleRule => ({ kind: "cron", expr });

const NEW_YORK = "America/New_York";
const BERLIN = "Europe/Berlin";
const SHANGHAI = "Asia/Shanghai";

describe("fire times by rule kind", () => {
  it("never fires a manual rule", () => {
    expect(fires({ kind: "manual" }, "UTC", "2027-01-01T00:00:00Z", 3)).toEqual(
      [],
    );
  });

  it("fires a daily rule at the zone's wall time, strictly after the cursor", () => {
    const rule: ScheduleRule = { kind: "daily", time: "08:00" };
    expect(fires(rule, SHANGHAI, "2026-12-31T23:59:59.999Z", 2)).toEqual([
      "2027-01-01T00:00:00.000Z",
      "2027-01-02T00:00:00.000Z",
    ]);
    // Exactly on a fire time: that one is not repeated.
    expect(fires(rule, SHANGHAI, "2027-01-01T00:00:00.000Z", 1)).toEqual([
      "2027-01-02T00:00:00.000Z",
    ]);
    expect(fires(rule, SHANGHAI, "2027-01-01T00:00:00.001Z", 1)).toEqual([
      "2027-01-02T00:00:00.000Z",
    ]);
  });

  it("fires a weekly rule on its ISO weekdays, whatever order they were given in", () => {
    // 2027-01-01 is a Friday; 7 is Sunday, 1 is Monday.
    const expected = [
      "2027-01-03T14:30:00.000Z",
      "2027-01-04T14:30:00.000Z",
      "2027-01-10T14:30:00.000Z",
    ];
    for (const days of [
      [1, 7],
      [7, 1],
    ])
      expect(
        fires(
          { kind: "weekly", days, time: "09:30" },
          NEW_YORK,
          "2027-01-01T00:00:00Z",
          3,
        ),
      ).toEqual(expected);
  });

  it("treats weekdays as Monday to Friday, like weekly 1-5 and the equal cron", () => {
    const after = "2027-01-01T12:00:00Z";
    const weekdays = fires(
      { kind: "weekdays", time: "08:00" },
      BERLIN,
      after,
      7,
    );
    expect(weekdays).toEqual([
      "2027-01-04T07:00:00.000Z",
      "2027-01-05T07:00:00.000Z",
      "2027-01-06T07:00:00.000Z",
      "2027-01-07T07:00:00.000Z",
      "2027-01-08T07:00:00.000Z",
      "2027-01-11T07:00:00.000Z",
      "2027-01-12T07:00:00.000Z",
    ]);
    expect(
      fires(
        { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
        BERLIN,
        after,
        7,
      ),
    ).toEqual(weekdays);
    expect(fires(cron("0 8 * * 1-5"), BERLIN, after, 7)).toEqual(weekdays);
  });

  it("evaluates a cron in the rule's zone, never in UTC", () => {
    expect(
      fires(cron("0 8 * * *"), SHANGHAI, "2027-01-01T00:00:01Z", 1),
    ).toEqual(["2027-01-02T00:00:00.000Z"]);
    expect(fires(cron("0 8 * * *"), "UTC", "2027-01-01T00:00:01Z", 1)).toEqual([
      "2027-01-01T08:00:00.000Z",
    ]);
  });

  it("handles month ends and leap days", () => {
    expect(fires(cron("0 9 31 * *"), "UTC", "2027-01-01T00:00:00Z", 4)).toEqual(
      [
        "2027-01-31T09:00:00.000Z",
        "2027-03-31T09:00:00.000Z",
        "2027-05-31T09:00:00.000Z",
        "2027-07-31T09:00:00.000Z",
      ],
    );
    expect(fires(cron("0 9 L * *"), "UTC", "2027-01-31T10:00:00Z", 3)).toEqual([
      "2027-02-28T09:00:00.000Z",
      "2027-03-31T09:00:00.000Z",
      "2027-04-30T09:00:00.000Z",
    ]);
    expect(fires(cron("0 0 29 2 *"), "UTC", "2027-01-01T00:00:00Z", 1)).toEqual(
      ["2028-02-29T00:00:00.000Z"],
    );
    // A daily rule crosses the month end without skipping or repeating a day.
    expect(
      fires({ kind: "daily", time: "23:30" }, "UTC", "2027-02-27T00:00:00Z", 3),
    ).toEqual([
      "2027-02-27T23:30:00.000Z",
      "2027-02-28T23:30:00.000Z",
      "2027-03-01T23:30:00.000Z",
    ]);
  });

  it("fires a one-time rule once, and never when it is already past", () => {
    const rule: ScheduleRule = {
      kind: "once",
      at: "2027-01-01T08:00:00+08:00",
    };
    expect(fires(rule, SHANGHAI, "2026-12-31T00:00:00Z", 5)).toEqual([
      "2027-01-01T00:00:00.000Z",
    ]);
    expect(fires(rule, SHANGHAI, "2027-01-01T00:00:00Z", 5)).toEqual([]);
    expect(fires(rule, SHANGHAI, "2027-06-01T00:00:00Z", 5)).toEqual([]);
  });
});

describe("daylight saving", () => {
  // New York: 2027-03-14 02:00 EST jumps to 03:00 EDT (07:00Z);
  //           2027-11-07 02:00 EDT falls back to 01:00 EST (06:00Z).
  // Berlin:   2027-03-28 02:00 CET jumps to 03:00 CEST (01:00Z);
  //           2027-10-31 03:00 CEST falls back to 02:00 CET (01:00Z).

  it("runs a skipped wall time at the first valid moment after the jump", () => {
    const rule: ScheduleRule = { kind: "daily", time: "02:30" };
    expect(fires(rule, NEW_YORK, "2027-03-12T12:00:00Z", 4)).toEqual([
      "2027-03-13T07:30:00.000Z",
      "2027-03-14T07:00:00.000Z",
      "2027-03-15T06:30:00.000Z",
      "2027-03-16T06:30:00.000Z",
    ]);
    expect(fires(rule, BERLIN, "2027-03-26T12:00:00Z", 3)).toEqual([
      "2027-03-27T01:30:00.000Z",
      "2027-03-28T01:00:00.000Z",
      "2027-03-29T00:30:00.000Z",
    ]);
    // The cron spelling of the same rule behaves the same.
    expect(
      fires(cron("30 2 * * *"), NEW_YORK, "2027-03-13T12:00:00Z", 2),
    ).toEqual(["2027-03-14T07:00:00.000Z", "2027-03-15T06:30:00.000Z"]);
  });

  it("keeps the shifted run once, even when asked again from the jump itself", () => {
    const compiled = compileScheduleRule(
      { kind: "daily", time: "02:30" },
      NEW_YORK,
    );
    const jump = compiled.next(at("2027-03-14T06:59:59Z"))!;
    expect(jump.toISOString()).toBe("2027-03-14T07:00:00.000Z");
    expect(compiled.next(jump)!.toISOString()).toBe("2027-03-15T06:30:00.000Z");
  });

  it("drops a skipped hour of an hourly rule instead of bunching runs", () => {
    const hourly = fires(
      cron("30 * * * *"),
      NEW_YORK,
      "2027-03-14T05:00:00Z",
      4,
    );
    expect(hourly).toEqual([
      "2027-03-14T05:30:00.000Z",
      "2027-03-14T06:30:00.000Z",
      // 02:30 does not exist; 03:30 EDT is the next real run.
      "2027-03-14T07:30:00.000Z",
      "2027-03-14T08:30:00.000Z",
    ]);
    // A rule that fires at the jump anyway does not fire twice there.
    expect(
      fires(cron("0 2,3 * * *"), NEW_YORK, "2027-03-13T12:00:00Z", 3),
    ).toEqual([
      "2027-03-14T07:00:00.000Z",
      "2027-03-15T06:00:00.000Z",
      "2027-03-15T07:00:00.000Z",
    ]);
    // Nor does a skipped time run half an hour after the previous real one.
    expect(
      fires(cron("30 1,2 * * *"), NEW_YORK, "2027-03-14T00:00:00Z", 2),
    ).toEqual(["2027-03-14T06:30:00.000Z", "2027-03-15T05:30:00.000Z"]);
  });

  it("fires a repeated wall time on its first occurrence only", () => {
    expect(
      fires(
        { kind: "daily", time: "01:30" },
        NEW_YORK,
        "2027-11-05T12:00:00Z",
        4,
      ),
    ).toEqual([
      "2027-11-06T05:30:00.000Z",
      "2027-11-07T05:30:00.000Z",
      "2027-11-08T06:30:00.000Z",
      "2027-11-09T06:30:00.000Z",
    ]);
    expect(
      fires(
        { kind: "daily", time: "02:30" },
        BERLIN,
        "2027-10-29T12:00:00Z",
        3,
      ),
    ).toEqual([
      "2027-10-30T00:30:00.000Z",
      "2027-10-31T00:30:00.000Z",
      "2027-11-01T01:30:00.000Z",
    ]);
    expect(
      fires(cron("30 * * * *"), NEW_YORK, "2027-11-07T04:00:00Z", 4),
    ).toEqual([
      "2027-11-07T04:30:00.000Z",
      "2027-11-07T05:30:00.000Z",
      // The second 01:30 (06:30Z) is not a new slot.
      "2027-11-07T07:30:00.000Z",
      "2027-11-07T08:30:00.000Z",
    ]);
  });

  it("never returns a time at or before the cursor inside the repeated hour", () => {
    const compiled = compileScheduleRule(cron("30 * * * *"), NEW_YORK);
    // 06:45Z is 01:45 EST, the second pass through the 01:00 hour.
    expect(compiled.next(at("2027-11-07T06:45:00Z"))!.toISOString()).toBe(
      "2027-11-07T07:30:00.000Z",
    );
  });

  it("always moves forward, about a day at a time, across a whole year", () => {
    for (const zone of [NEW_YORK, BERLIN, "Australia/Lord_Howe"]) {
      const compiled = compileScheduleRule(cron("15 2 * * *"), zone);
      let cursor = compiled.next(at("2027-01-01T00:00:00Z"))!;
      for (let index = 0; index < 400; index += 1) {
        const next = compiled.next(cursor)!;
        const gap = next.getTime() - cursor.getTime();
        expect(gap).toBeGreaterThanOrEqual(22.5 * HOUR);
        expect(gap).toBeLessThanOrEqual(25.5 * HOUR);
        cursor = next;
      }
    }
  });
});

describe("validateScheduleRule", () => {
  const options = { now: at("2027-01-01T00:00:00Z"), minIntervalMs: HOUR };
  const codeOf = (rule: ScheduleRule, timeZone = "UTC") => {
    try {
      validateScheduleRule(rule, timeZone, options);
      return null;
    } catch (error) {
      if (error instanceof ScheduleRuleError) return error.code;
      throw error;
    }
  };

  it("accepts every rule kind that respects the minimum interval", () => {
    for (const rule of [
      { kind: "manual" },
      { kind: "daily", time: "08:00" },
      { kind: "weekly", days: [1, 2, 3, 4, 5, 6, 7], time: "08:00" },
      { kind: "weekdays", time: "08:00" },
      { kind: "once", at: "2027-01-01T00:00:01Z" },
      cron("0 * * * *"),
      cron("15 */2 * * *"),
      cron("30 8 * * 1-5"),
      cron("0 0,1 1 1 *"),
      cron("0 9 * * MON-FRI"),
    ] satisfies ScheduleRule[])
      expect(codeOf(rule, NEW_YORK)).toBeNull();
  });

  it("rejects rules that fire more often than the minimum interval", () => {
    for (const expr of [
      "* * * * *",
      "*/30 * * * *",
      "0,59 * * * *",
      "0,30 9 * * *",
      "0-1 8 * * *",
      "0,30 0 1 1 *",
    ])
      expect(codeOf(cron(expr))).toBe("interval_too_short");
    // The limit is the caller's: a looser one admits the same rule.
    expect(() =>
      validateScheduleRule(cron("*/30 * * * *"), "UTC", {
        ...options,
        minIntervalMs: 30 * MIN,
      }),
    ).not.toThrow();
  });

  it("rejects cron expressions that do not parse as five fields", () => {
    for (const expr of [
      "nope",
      "* * * *",
      "*/30 * * * * *",
      "0 0 * * * * 2027",
      "61 * * * *",
      "0 24 * * *",
      "0 0 * * 8",
      "0 0 32 * *",
      "? * * * *",
    ])
      expect(codeOf(cron(expr))).toBe("invalid_cron");
  });

  it("rejects a cron that can never fire", () => {
    expect(codeOf(cron("0 0 30 2 *"))).toBe("never_fires");
  });

  it("rejects a one-time rule that is not in the future", () => {
    expect(codeOf({ kind: "once", at: "2027-01-01T00:00:00Z" })).toBe(
      "once_in_past",
    );
    expect(codeOf({ kind: "once", at: "2020-06-01T00:00:00Z" })).toBe(
      "once_in_past",
    );
  });

  it("rejects an unknown time zone for every kind", () => {
    for (const rule of [
      { kind: "manual" },
      { kind: "daily", time: "08:00" },
      { kind: "once", at: "2028-01-01T00:00:00Z" },
      cron("0 8 * * *"),
    ] satisfies ScheduleRule[]) {
      expect(codeOf(rule, "Mars/Olympus")).toBe("invalid_timezone");
      expect(codeOf(rule, "+08:00")).toBe("invalid_timezone");
    }
  });
});

describe("planDueSlot", () => {
  const offsetMs = 3 * MIN;
  const daily: ScheduleRule = { kind: "daily", time: "08:00" };
  const hourly = cron("0 * * * *");
  const plan = (rule: ScheduleRule, dueAt: string, now: string) =>
    planDueSlot({
      rule,
      timeZone: "UTC",
      offsetMs,
      dueAt: at(dueAt),
      now: at(now),
    });

  it("has nothing to do before the due time or for a manual rule", () => {
    expect(
      plan(daily, "2027-01-01T08:03:00Z", "2027-01-01T08:02:59Z"),
    ).toBeNull();
    expect(
      plan({ kind: "manual" }, "2027-01-01T08:03:00Z", "2027-01-02T00:00:00Z"),
    ).toBeNull();
  });

  it("materializes the nominal slot and keeps the offset on the next due time", () => {
    expect(plan(daily, "2027-01-01T08:03:00Z", "2027-01-01T08:03:20Z")).toEqual(
      {
        scheduledFor: at("2027-01-01T08:00:00Z"),
        nextDueAt: at("2027-01-02T08:03:00Z"),
        isCatchUp: false,
        expired: false,
        missed: [],
        missedEarlier: false,
      },
    );
  });

  it("does not count a slot as elapsed until its offset has passed", () => {
    const result = plan(
      hourly,
      "2027-01-01T09:03:00Z",
      "2027-01-01T10:01:00Z",
    )!;
    expect(result.scheduledFor).toEqual(at("2027-01-01T09:00:00Z"));
    expect(result.nextDueAt).toEqual(at("2027-01-01T10:03:00Z"));
    expect(result.missed).toEqual([]);
    expect(result.expired).toBe(false);
    // 58 minutes late is past the grace, so the owner is told.
    expect(result.isCatchUp).toBe(true);
  });

  it("offers only the newest slot after an outage and lists the older ones as missed", () => {
    const result = plan(
      hourly,
      "2027-01-01T09:03:00Z",
      "2027-01-01T14:13:00Z",
    )!;
    expect(result.scheduledFor).toEqual(at("2027-01-01T14:00:00Z"));
    expect(iso(result.missed)).toEqual([
      "2027-01-01T09:00:00.000Z",
      "2027-01-01T10:00:00.000Z",
      "2027-01-01T11:00:00.000Z",
      "2027-01-01T12:00:00.000Z",
      "2027-01-01T13:00:00.000Z",
    ]);
    expect(result.nextDueAt).toEqual(at("2027-01-01T15:03:00Z"));
    expect(result.missedEarlier).toBe(false);
    // The newest slot itself is only ten minutes late: an ordinary run.
    expect(result).toMatchObject({ isCatchUp: false, expired: false });
  });

  it("marks a late but still fresh slot as a catch-up", () => {
    const late = at("2027-01-01T08:03:00Z").getTime() + CATCH_UP_GRACE_MS;
    expect(
      plan(daily, "2027-01-01T08:03:00Z", new Date(late).toISOString()),
    ).toMatchObject({ isCatchUp: false, expired: false });
    expect(
      plan(daily, "2027-01-01T08:03:00Z", new Date(late + 1000).toISOString()),
    ).toMatchObject({ isCatchUp: true, expired: false });
    expect(plan(daily, "2027-01-01T08:03:00Z", "2027-01-01T13:00:00Z")).toEqual(
      {
        scheduledFor: at("2027-01-01T08:00:00Z"),
        nextDueAt: at("2027-01-02T08:03:00Z"),
        isCatchUp: true,
        expired: false,
        missed: [],
        missedEarlier: false,
      },
    );
  });

  it("gives up on a slot older than one period, at most a day", () => {
    // Weekly on Monday; 2027-01-04 is a Monday. Thirty hours late.
    const weekly: ScheduleRule = { kind: "weekly", days: [1], time: "08:00" };
    expect(
      plan(weekly, "2027-01-04T08:03:00Z", "2027-01-05T14:03:00Z"),
    ).toEqual({
      scheduledFor: at("2027-01-04T08:00:00Z"),
      nextDueAt: at("2027-01-11T08:03:00Z"),
      isCatchUp: false,
      expired: true,
      missed: [],
      missedEarlier: false,
    });
    // Twenty-three hours late is still inside the window.
    expect(
      plan(weekly, "2027-01-04T08:03:00Z", "2027-01-05T07:03:00Z"),
    ).toMatchObject({ isCatchUp: true, expired: false });
  });

  it("bounds how far back it looks after a very long outage", () => {
    const result = plan(daily, "2027-01-01T08:03:00Z", "2027-01-10T10:03:00Z")!;
    expect(result.scheduledFor).toEqual(at("2027-01-10T08:00:00Z"));
    expect(iso(result.missed)).toEqual(["2027-01-09T08:00:00.000Z"]);
    expect(result.missedEarlier).toBe(true);
    expect(result).toMatchObject({ isCatchUp: true, expired: false });

    // Nothing fired inside the lookback: the stored slot is reported, expired.
    const yearly = cron("0 8 1 1 *");
    expect(
      plan(yearly, "2027-01-01T08:03:00Z", "2027-01-20T00:00:00Z"),
    ).toEqual({
      scheduledFor: at("2027-01-01T08:00:00Z"),
      nextDueAt: at("2028-01-01T08:03:00Z"),
      isCatchUp: false,
      expired: true,
      missed: [],
      missedEarlier: true,
    });
  });

  it("runs a missed one-time rule within a day and never schedules it again", () => {
    const once: ScheduleRule = { kind: "once", at: "2027-01-01T08:00:00Z" };
    expect(plan(once, "2027-01-01T08:03:00Z", "2027-01-01T08:03:05Z")).toEqual({
      scheduledFor: at("2027-01-01T08:00:00Z"),
      nextDueAt: null,
      isCatchUp: false,
      expired: false,
      missed: [],
      missedEarlier: false,
    });
    expect(
      plan(once, "2027-01-01T08:03:00Z", "2027-01-01T20:00:00Z"),
    ).toMatchObject({ isCatchUp: true, expired: false, nextDueAt: null });
    expect(
      plan(once, "2027-01-01T08:03:00Z", "2027-01-02T08:03:01Z"),
    ).toMatchObject({ isCatchUp: false, expired: true, nextDueAt: null });
  });
});
