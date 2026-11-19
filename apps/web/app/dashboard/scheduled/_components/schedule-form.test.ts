import { expect, test } from "vitest";
import type { AgentTask } from "@sourceweft/contracts/scheduled-tasks";
import {
  emptyTaskForm,
  formToRequest,
  formToRule,
  isFormComplete,
  isoToZonedLocal,
  taskToForm,
  zonedLocalToIso,
} from "./schedule-form";

test("a wall time in a zone converts to the right instant and back", () => {
  expect(zonedLocalToIso("2026-12-01T08:30", "Asia/Shanghai")).toBe(
    "2026-12-01T00:30:00.000Z",
  );
  expect(zonedLocalToIso("2026-12-01T08:30", "America/New_York")).toBe(
    "2026-12-01T13:30:00.000Z",
  );
  // Summer time: New York is UTC-4.
  expect(zonedLocalToIso("2026-07-01T08:30", "America/New_York")).toBe(
    "2026-07-01T12:30:00.000Z",
  );
  expect(isoToZonedLocal("2026-07-01T12:30:00.000Z", "America/New_York")).toBe(
    "2026-07-01T08:30",
  );
  expect(zonedLocalToIso("not a time", "UTC")).toBeNull();
});

test("each frequency builds its rule, and an incomplete form builds none", () => {
  const base = emptyTaskForm({ timezone: "UTC" });
  expect(formToRule({ ...base, frequency: "daily", time: "07:05" })).toEqual({
    kind: "daily",
    time: "07:05",
  });
  expect(
    formToRule({ ...base, frequency: "weekly", days: [5, 1], time: "09:00" }),
  ).toEqual({ kind: "weekly", days: [1, 5], time: "09:00" });
  expect(formToRule({ ...base, frequency: "weekly", days: [] })).toBeNull();
  expect(formToRule({ ...base, frequency: "daily", time: "" })).toBeNull();
  expect(
    formToRule({ ...base, frequency: "cron", cron: " 0 9 * * 1 " }),
  ).toEqual({ kind: "cron", expr: "0 9 * * 1" });
  expect(formToRule({ ...base, frequency: "once", onceLocal: "" })).toBeNull();
  expect(formToRule({ ...base, frequency: "manual" })).toEqual({
    kind: "manual",
  });
});

test("the form is complete only with a name, a prompt and a rule", () => {
  const base = emptyTaskForm({ timezone: "UTC" });
  expect(isFormComplete(base)).toBe(false);
  expect(isFormComplete({ ...base, name: "Digest", prompt: "Summarize" })).toBe(
    true,
  );
});

test("editing keeps the sources, skills and model the form has no control for", () => {
  const task = {
    name: "Digest",
    prompt: "Summarize",
    schedule: {
      rule: { kind: "weekly", days: [2, 4], time: "06:00" },
      timezone: "Europe/Berlin",
      enabled: true,
      nextDueAt: null,
    },
    request: {
      sourceIds: ["s1"],
      skillIds: ["k1"],
      llm: { model: "m" },
      mcp: { installIds: ["i1"] },
      webAccess: true,
    },
    notifyOnSuccess: false,
    notifyEmail: true,
  } as unknown as AgentTask;
  const form = taskToForm(task);
  expect(form).toMatchObject({
    frequency: "weekly",
    days: [2, 4],
    time: "06:00",
    timezone: "Europe/Berlin",
    webAccess: true,
    notifyOnSuccess: false,
    mcpInstallIds: ["i1"],
  });
  expect(formToRequest({ ...form, webAccess: false }, task.request)).toEqual({
    sourceIds: ["s1"],
    skillIds: ["k1"],
    llm: { model: "m" },
    mcp: { installIds: ["i1"] },
    webAccess: false,
  });
});
