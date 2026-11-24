import type {
  AgentTask,
  CreateAgentTaskRequest,
  ScheduleRule,
  ScheduleRuleKind,
} from "@sourceweft/contracts/scheduled-tasks";

/** What the form shows; one value per control, converted on save. */
export type TaskFormState = {
  name: string;
  prompt: string;
  frequency: ScheduleRuleKind;
  /** 24-hour `HH:MM` for daily, weekdays and weekly. */
  time: string;
  /** ISO weekdays, 1 Monday to 7 Sunday, for weekly. */
  days: number[];
  /** `YYYY-MM-DDTHH:mm` wall time in `timezone`, for once. */
  onceLocal: string;
  cron: string;
  timezone: string;
  webAccess: boolean;
  notifyOnSuccess: boolean;
  notifyEmail: boolean;
  mcpInstallIds: string[];
  sourceIds: string[];
  /** Skill selection ids, as the chat sends them. */
  skillIds: string[];
};

export const FREQUENCIES: ScheduleRuleKind[] = [
  "daily",
  "weekdays",
  "weekly",
  "once",
  "cron",
  "manual",
];

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function emptyTaskForm(
  seed: Partial<TaskFormState> = {},
): TaskFormState {
  return {
    name: "",
    prompt: "",
    frequency: "daily",
    time: "08:00",
    days: [1],
    onceLocal: "",
    cron: "0 9 * * 1",
    timezone: browserTimeZone(),
    webAccess: false,
    notifyOnSuccess: true,
    notifyEmail: true,
    mcpInstallIds: [],
    sourceIds: [],
    skillIds: [],
    ...seed,
  };
}

const PART_KEYS = ["year", "month", "day", "hour", "minute", "second"] as const;

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Object.fromEntries(
    PART_KEYS.map((key) => [key, value(key)]),
  ) as Record<(typeof PART_KEYS)[number], number>;
}

/** How far the zone's wall clock is ahead of UTC at that instant. */
function offsetMs(ms: number, timeZone: string) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/** `YYYY-MM-DDTHH:mm` read as wall time in `timeZone`, as an ISO instant. */
export function zonedLocalToIso(local: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset across a daylight-saving boundary.
  let instant = wall - offsetMs(wall, timeZone);
  instant = wall - offsetMs(instant, timeZone);
  return new Date(instant).toISOString();
}

/** An ISO instant as `YYYY-MM-DDTHH:mm` wall time in `timeZone`. */
export function isoToZonedLocal(iso: string, timeZone: string) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const p = zonedParts(ms, timeZone);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** The rule the form describes, or null while it is incomplete. */
export function formToRule(form: TaskFormState): ScheduleRule | null {
  switch (form.frequency) {
    case "manual":
      return { kind: "manual" };
    case "daily":
    case "weekdays":
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)
        ? { kind: form.frequency, time: form.time }
        : null;
    case "weekly":
      return form.days.length > 0 && /^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)
        ? {
            kind: "weekly",
            days: [...form.days].sort((a, b) => a - b),
            time: form.time,
          }
        : null;
    case "cron":
      return form.cron.trim() ? { kind: "cron", expr: form.cron.trim() } : null;
    case "once": {
      const at = zonedLocalToIso(form.onceLocal, form.timezone);
      return at ? { kind: "once", at } : null;
    }
  }
}

export function ruleToFormFields(
  rule: ScheduleRule,
  timezone: string,
): Pick<TaskFormState, "frequency" | "time" | "days" | "onceLocal" | "cron"> {
  const base = emptyTaskForm();
  const fields = {
    frequency: rule.kind,
    time: base.time,
    days: base.days,
    onceLocal: base.onceLocal,
    cron: base.cron,
  };
  switch (rule.kind) {
    case "daily":
    case "weekdays":
      return { ...fields, time: rule.time };
    case "weekly":
      return { ...fields, time: rule.time, days: [...rule.days] };
    case "cron":
      return { ...fields, cron: rule.expr };
    case "once":
      return { ...fields, onceLocal: isoToZonedLocal(rule.at, timezone) };
    case "manual":
      return fields;
  }
}

export function taskToForm(task: AgentTask): TaskFormState {
  return emptyTaskForm({
    name: task.name,
    prompt: task.prompt,
    timezone: task.schedule.timezone,
    webAccess: task.request.webAccess,
    notifyOnSuccess: task.notifyOnSuccess,
    notifyEmail: task.notifyEmail,
    mcpInstallIds: task.request.mcp.installIds,
    sourceIds: task.request.sourceIds,
    skillIds: task.request.skillIds,
    ...ruleToFormFields(task.schedule.rule, task.schedule.timezone),
  });
}

/**
 * The request the form saves. Whatever the form has no control for (the
 * model of a task) carries over from the task being edited, so editing a
 * prompt never drops it.
 */
export function formToRequest(
  form: TaskFormState,
  previous?: AgentTask["request"],
): CreateAgentTaskRequest["request"] {
  return {
    sourceIds: form.sourceIds,
    skillIds: form.skillIds,
    ...(previous?.llm ? { llm: previous.llm } : {}),
    ...(previous?.modelSettings
      ? { modelSettings: previous.modelSettings }
      : {}),
    mcp: { installIds: form.mcpInstallIds },
    webAccess: form.webAccess,
  };
}

export function isFormComplete(form: TaskFormState) {
  return (
    form.name.trim().length > 0 &&
    form.prompt.trim().length > 0 &&
    formToRule(form) !== null
  );
}
