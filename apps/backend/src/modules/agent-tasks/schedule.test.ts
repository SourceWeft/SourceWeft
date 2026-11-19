import type { ScheduleRule } from "@sourceweft/contracts/scheduled-tasks";
import { describe, expect, it } from "vitest";
import { ScheduleRuleError } from "../schedules";
import {
  AGENT_TASK_MAX_OFFSET_MS,
  AGENT_TASK_MIN_INTERVAL_MS,
  agentTaskOffsetMs,
  agentTaskRule,
  agentTaskScheduleState,
  assertAgentTaskSchedule,
  planAgentTaskSlot,
  previewAgentTaskSchedule,
} from "./schedule";

const now = new Date("2027-01-01T00:00:00Z");
const daily: ScheduleRule = { kind: "daily", time: "08:00" };
const codeOf = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ScheduleRuleError) return error.code;
    throw error;
  }
};

describe("task schedule limits", () => {
  it("uses a one-hour minimum interval and a five-minute offset cap", () => {
    expect(AGENT_TASK_MIN_INTERVAL_MS).toBe(60 * 60_000);
    expect(AGENT_TASK_MAX_OFFSET_MS).toBe(5 * 60_000);
  });

  it("refuses rules that fire more often than hourly", () => {
    expect(
      codeOf(() =>
        assertAgentTaskSchedule(
          { kind: "cron", expr: "*/30 * * * *" },
          "UTC",
          now,
        ),
      ),
    ).toBe("interval_too_short");
    expect(
      codeOf(() =>
        assertAgentTaskSchedule(
          { kind: "cron", expr: "0 * * * *" },
          "UTC",
          now,
        ),
      ),
    ).toBeNull();
    expect(
      codeOf(() => assertAgentTaskSchedule(daily, "Nowhere/None", now)),
    ).toBe("invalid_timezone");
  });
});

describe("agentTaskOffsetMs", () => {
  it("is the same for one task every time and differs between tasks", () => {
    expect(agentTaskOffsetMs("task-1")).toBe(agentTaskOffsetMs("task-1"));
    const offsets = Array.from({ length: 100 }, (_, index) =>
      agentTaskOffsetMs(`task-${index}`),
    );
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(AGENT_TASK_MAX_OFFSET_MS);
    }
    expect(new Set(offsets).size).toBeGreaterThan(90);
  });
});

describe("previewAgentTaskSchedule", () => {
  it("returns the next five nominal fire times and the largest offset", () => {
    expect(
      previewAgentTaskSchedule({
        rule: { kind: "weekdays", time: "08:00" },
        timezone: "Asia/Shanghai",
        now,
      }),
    ).toEqual({
      // 2027-01-01 08:00 in Shanghai is exactly `now`, so it is not upcoming.
      fireTimes: [
        "2027-01-04T00:00:00.000Z",
        "2027-01-05T00:00:00.000Z",
        "2027-01-06T00:00:00.000Z",
        "2027-01-07T00:00:00.000Z",
        "2027-01-08T00:00:00.000Z",
      ],
      maxOffsetSeconds: 300,
    });
  });

  it("previews fewer times when the rule has fewer left", () => {
    expect(
      previewAgentTaskSchedule({
        rule: { kind: "once", at: "2027-02-01T00:00:00Z" },
        timezone: "UTC",
        now,
      }).fireTimes,
    ).toEqual(["2027-02-01T00:00:00.000Z"]);
    expect(
      previewAgentTaskSchedule({
        rule: { kind: "manual" },
        timezone: "UTC",
        now,
      }).fireTimes,
    ).toEqual([]);
  });

  it("refuses to preview a rule that could not be saved", () => {
    expect(
      codeOf(() =>
        previewAgentTaskSchedule({
          rule: { kind: "cron", expr: "* * * * *" },
          timezone: "UTC",
          now,
        }),
      ),
    ).toBe("interval_too_short");
    expect(
      codeOf(() =>
        previewAgentTaskSchedule({
          rule: { kind: "once", at: "2026-12-31T23:59:59Z" },
          timezone: "UTC",
          now,
        }),
      ),
    ).toBe("once_in_past");
  });
});

describe("agentTaskScheduleState", () => {
  it("is due at the next fire time plus the task's offset", () => {
    const state = agentTaskScheduleState({
      taskId: "task-1",
      rule: daily,
      timezone: "UTC",
      enabled: true,
      now,
    });
    expect(state).toEqual({
      specVersion: 1,
      specJson: daily,
      timezone: "UTC",
      enabled: true,
      nextDueAt: new Date(
        new Date("2027-01-01T08:00:00Z").getTime() +
          agentTaskOffsetMs("task-1"),
      ),
    });
  });

  it("starts from the next slot and does not make up for earlier ones", () => {
    const state = agentTaskScheduleState({
      taskId: "task-1",
      rule: daily,
      timezone: "UTC",
      enabled: true,
      // Resumed three days and one hour after the last slot it ran.
      now: new Date("2027-01-04T09:00:00Z"),
    });
    expect(state.nextDueAt!.getTime()).toBe(
      new Date("2027-01-05T08:00:00Z").getTime() + agentTaskOffsetMs("task-1"),
    );
  });

  it("stores a manual, disabled or exhausted rule with nothing due", () => {
    for (const input of [
      { rule: { kind: "manual" } as ScheduleRule, enabled: true },
      { rule: daily, enabled: false },
      {
        rule: { kind: "once", at: "2026-06-01T00:00:00Z" } as ScheduleRule,
        enabled: true,
      },
    ])
      expect(
        agentTaskScheduleState({
          taskId: "task-1",
          timezone: "UTC",
          now,
          ...input,
        }),
      ).toMatchObject({
        enabled: false,
        nextDueAt: null,
        specJson: input.rule,
      });
  });
});

describe("reading a schedule row", () => {
  it("parses the stored rule and refuses shapes it does not know", () => {
    expect(agentTaskRule({ specVersion: 1, specJson: daily })).toEqual(daily);
    // The connector's interval spec is not a task rule.
    expect(() =>
      agentTaskRule({
        specVersion: 1,
        specJson: { kind: "interval", minutes: 60 },
      }),
    ).toThrow();
    expect(() => agentTaskRule({ specVersion: 2, specJson: daily })).toThrow(
      /Unsupported schedule rule version/,
    );
  });

  it("plans a due task's slot with that task's offset", () => {
    const offset = agentTaskOffsetMs("task-1");
    const row = {
      agentTaskId: "task-1",
      specVersion: 1,
      specJson: daily as Record<string, unknown>,
      timezone: "UTC",
      nextDueAt: new Date(new Date("2027-01-01T08:00:00Z").getTime() + offset),
    };
    expect(planAgentTaskSlot(row, new Date("2027-01-01T07:59:59Z"))).toBeNull();
    expect(planAgentTaskSlot({ ...row, nextDueAt: null }, now)).toBeNull();
    expect(
      planAgentTaskSlot(row, new Date(row.nextDueAt.getTime() + 1000)),
    ).toEqual({
      scheduledFor: new Date("2027-01-01T08:00:00Z"),
      nextDueAt: new Date(new Date("2027-01-02T08:00:00Z").getTime() + offset),
      isCatchUp: false,
      expired: false,
      missed: [],
      missedEarlier: false,
    });
    expect(() => planAgentTaskSlot({ ...row, agentTaskId: null }, now)).toThrow(
      /does not belong to a scheduled task/,
    );
  });
});
