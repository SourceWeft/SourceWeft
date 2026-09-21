import { describe, expect, test, vi } from "vitest";
import type { SkillSourceType } from "../types";

// The observer is exercised without a database: its write is the `record`
// seam, and the threshold/shape helpers are pure.
const { createSkillRunObserver, fullRunStats, publicRunStats } =
  await import("./run-stats");

function stagedSkills(
  entries: Array<[string, SkillSourceType, string | undefined]>,
) {
  return () =>
    new Map(
      entries.map(([name, sourceType, skillVersionId]) => [
        name,
        { sourceType, skillVersionId },
      ]),
    );
}

describe("createSkillRunObserver", () => {
  const skills = stagedSkills([
    ["ppt-deck", "registry_github", "ver-ppt"],
    ["pdf", "registry_github", "ver-pdf"],
    ["house", "workspace_custom", "ver-house"],
    ["builtin-one", "builtin", "ver-builtin"],
  ]);

  test("records a registry skill's failure with its class, not its text", () => {
    const record = vi.fn();
    createSkillRunObserver({
      workspaceId: "ws-1",
      stagedSkills: skills,
      record,
    }).commandFinished({
      command: "python /skills/ppt-deck/scripts/validate.py secret-file.pptx",
      durationMs: 1234,
      finished: {
        result: {
          exitCode: 1,
          output: "ModuleNotFoundError: No module named 'pptx'",
        },
      },
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      skillVersionIds: ["ver-ppt"],
      exitCode: 1,
      durationMs: 1234,
      classification: {
        errorClass: "missing_dependency",
        errorSubject: "pptx",
      },
    });
    const recorded = JSON.stringify(record.mock.calls);
    expect(recorded).not.toContain("secret-file");
    expect(recorded).not.toContain("validate.py");
    expect(recorded).not.toContain("ModuleNotFoundError");
  });

  test("one event per registry skill referenced; custom and builtin skipped", () => {
    const record = vi.fn();
    createSkillRunObserver({
      workspaceId: "ws-1",
      stagedSkills: skills,
      record,
    }).commandFinished({
      command:
        "cd /skills/house && python /skills/ppt-deck/a.py /skills/pdf/b /skills/builtin-one/c",
      durationMs: 5,
      finished: { result: { exitCode: 0, output: "" } },
    });
    expect(record.mock.calls[0]![0].skillVersionIds).toEqual([
      "ver-ppt",
      "ver-pdf",
    ]);
    expect(record.mock.calls[0]![0].classification.errorClass).toBeNull();
  });

  test("a timeout records a null exit code", () => {
    const record = vi.fn();
    createSkillRunObserver({
      workspaceId: "ws-1",
      stagedSkills: skills,
      record,
    }).commandFinished({
      command: "node /skills/pdf/render.js",
      durationMs: 600_000,
      finished: {
        error: Object.assign(new Error("t"), {
          code: "SANDBOX_OPERATION_TIMED_OUT",
        }),
      },
    });
    expect(record.mock.calls[0]![0]).toMatchObject({
      exitCode: null,
      classification: { errorClass: "timeout" },
    });
  });

  test.each([
    ["no skill referenced", "ls /workspace", { exitCode: 1, output: "" }],
    [
      "only a custom skill",
      "sh /skills/house/x.sh",
      { exitCode: 1, output: "" },
    ],
    [
      "a platform refusal",
      "python /skills/ppt-deck/a.py",
      {
        exitCode: 1,
        output:
          "Diagnostics: toolName=execute commandFingerprint=f failureCode=SANDBOX_SKILL_STAGING_UNAVAILABLE repeatCount=1 runId=r",
      },
    ],
  ])("records nothing for %s", (_label, command, result) => {
    const record = vi.fn();
    createSkillRunObserver({
      workspaceId: "ws-1",
      stagedSkills: skills,
      record,
    }).commandFinished({ command, durationMs: 1, finished: { result } });
    expect(record).not.toHaveBeenCalled();
  });

  test("never throws, even when the staged set cannot be read", () => {
    const record = vi.fn();
    const observer = createSkillRunObserver({
      workspaceId: "ws-1",
      stagedSkills: () => {
        throw new Error("gone");
      },
      record,
    });
    expect(() =>
      observer.commandFinished({
        command: "python /skills/ppt-deck/a.py",
        durationMs: 1,
        finished: { result: { exitCode: 0, output: "" } },
      }),
    ).not.toThrow();
    expect(record).not.toHaveBeenCalled();
  });
});

describe("run stats shapes", () => {
  const row = (runs: number, successes: number, workspaces: number) => ({
    skillId: "s1",
    runs,
    successes,
    workspaces,
    topErrors: [
      {
        errorClass: "missing_dependency" as const,
        subject: "pptx",
        count: runs - successes,
      },
    ],
    computedAt: new Date("2026-09-22T00:00:00.000Z"),
  });

  test("public numbers only past both floors", () => {
    expect(publicRunStats(null)).toEqual({ available: false });
    expect(publicRunStats(row(9, 9, 5))).toEqual({ available: false });
    expect(publicRunStats(row(50, 40, 2))).toEqual({ available: false });
    expect(publicRunStats(row(10, 8, 3))).toEqual({
      available: true,
      runs: 10,
      successRate: 0.8,
      workspaces: 3,
      topErrors: [
        { errorClass: "missing_dependency", subject: "pptx", count: 2 },
      ],
      windowDays: 30,
    });
  });

  test("below the floor nothing leaks, not even the counts", () => {
    expect(Object.keys(publicRunStats(row(9, 1, 2)))).toEqual(["available"]);
  });

  test("full numbers whatever their size", () => {
    expect(fullRunStats("s1", row(2, 1, 1))).toEqual({
      skillId: "s1",
      runs: 2,
      successes: 1,
      successRate: 0.5,
      workspaces: 1,
      topErrors: [
        { errorClass: "missing_dependency", subject: "pptx", count: 1 },
      ],
      windowDays: 30,
      publiclyVisible: false,
      computedAt: "2026-09-22T00:00:00.000Z",
    });
    expect(fullRunStats("s2", null)).toMatchObject({
      runs: 0,
      successRate: null,
      publiclyVisible: false,
      computedAt: null,
    });
  });
});
