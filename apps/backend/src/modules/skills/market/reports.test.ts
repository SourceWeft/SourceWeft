import { describe, expect, test } from "vitest";
import {
  createSkillReportRequestSchema,
  resolveSkillReportRequestSchema,
} from "@sourceweft/contracts";
import {
  SKILL_REPORT_LIMITS,
  decodeSkillReportCursor,
  encodeSkillReportCursor,
  hashSkillReporterIp,
  skillReportRetryAfterSeconds,
} from "./reports";

const now = new Date("2026-09-22T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000);

describe("report request validation", () => {
  test("a reason is required and must be one of the listed ones", () => {
    expect(createSkillReportRequestSchema.safeParse({}).success).toBe(false);
    expect(
      createSkillReportRequestSchema.safeParse({ reason: "boring" }).success,
    ).toBe(false);
    expect(
      createSkillReportRequestSchema.parse({ reason: "copyright" }),
    ).toEqual({ reason: "copyright", details: "" });
  });

  test("details are trimmed and bounded at 4000 characters", () => {
    expect(
      createSkillReportRequestSchema.parse({ reason: "spam", details: "  x  " })
        .details,
    ).toBe("x");
    expect(
      createSkillReportRequestSchema.safeParse({
        reason: "spam",
        details: "a".repeat(4000),
      }).success,
    ).toBe(true);
    expect(
      createSkillReportRequestSchema.safeParse({
        reason: "spam",
        details: "a".repeat(4001),
      }).success,
    ).toBe(false);
  });

  test("an empty email or review id is not given; a malformed email is refused", () => {
    expect(
      createSkillReportRequestSchema.parse({
        reason: "other",
        contactEmail: "  ",
        reviewId: "",
      }),
    ).toEqual({ reason: "other", details: "" });
    expect(
      createSkillReportRequestSchema.safeParse({
        reason: "other",
        contactEmail: "not an email",
      }).success,
    ).toBe(false);
    expect(
      createSkillReportRequestSchema.parse({
        reason: "other",
        contactEmail: " owner@example.com ",
      }).contactEmail,
    ).toBe("owner@example.com");
  });

  test("unknown fields are refused, so a report cannot carry a status", () => {
    expect(
      createSkillReportRequestSchema.safeParse({
        reason: "other",
        status: "actioned",
      }).success,
    ).toBe(false);
  });

  test("a resolution names one of the admin actions", () => {
    expect(
      resolveSkillReportRequestSchema.safeParse({ action: "delete" }).success,
    ).toBe(false);
    for (const action of [
      "dismiss",
      "withdraw_skill",
      "revoke_version",
      "hide_review",
      "none",
    ]) {
      expect(
        resolveSkillReportRequestSchema.safeParse({ action }).success,
      ).toBe(true);
    }
  });
});

describe("report rate limits", () => {
  const [hour, day] = SKILL_REPORT_LIMITS;

  test("under every limit, the sender may report", () => {
    expect(
      skillReportRetryAfterSeconds(
        [
          { count: hour.max - 1, oldestAt: minutesAgo(30) },
          { count: day.max - 1, oldestAt: minutesAgo(600) },
        ],
        now,
      ),
    ).toBeNull();
    expect(skillReportRetryAfterSeconds([], now)).toBeNull();
  });

  test("a full hour waits until its oldest report is an hour old", () => {
    expect(
      skillReportRetryAfterSeconds(
        [
          { count: hour.max, oldestAt: minutesAgo(45) },
          { count: hour.max, oldestAt: minutesAgo(45) },
        ],
        now,
      ),
    ).toBe(15 * 60);
  });

  test("a full day outweighs a free hour", () => {
    expect(
      skillReportRetryAfterSeconds(
        [
          { count: 0, oldestAt: null },
          { count: day.max, oldestAt: minutesAgo(23 * 60) },
        ],
        now,
      ),
    ).toBe(60 * 60);
  });

  test("the wait is never zero", () => {
    expect(
      skillReportRetryAfterSeconds(
        [{ count: hour.max, oldestAt: minutesAgo(60) }],
        now,
      ),
    ).toBe(1);
  });
});

describe("reporter address hashing", () => {
  test("stable per address and secret, and never the address itself", () => {
    const hash = hashSkillReporterIp("203.0.113.9", "secret-a");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("203.0.113.9");
    expect(hashSkillReporterIp(" 203.0.113.9 ", "secret-a")).toBe(hash);
    expect(hashSkillReporterIp("203.0.113.10", "secret-a")).not.toBe(hash);
    expect(hashSkillReporterIp("203.0.113.9", "secret-b")).not.toBe(hash);
  });
});

describe("report queue cursor", () => {
  test("round-trips, and anything else is refused", () => {
    const at = new Date("2026-09-22T10:00:00.123Z");
    expect(decodeSkillReportCursor(encodeSkillReportCursor(at, "r1"))).toEqual({
      createdAt: at,
      id: "r1",
    });
    expect(decodeSkillReportCursor("garbage")).toBeNull();
    expect(decodeSkillReportCursor("")).toBeNull();
  });
});
