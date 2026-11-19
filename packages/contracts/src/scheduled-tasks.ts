import { z } from "zod";
import {
  MAX_SELECTED_SKILLS_PER_TURN,
  llmExecutionConfigSchema,
} from "./stream";
import { threadModelSettingsInputSchema } from "./threads";

/**
 * Scheduled tasks: a saved prompt that runs as an ordinary chat turn in its
 * owner's workspace, on a time rule or on demand.
 *
 * A task is one `agent_tasks` row plus one `task_schedules` row holding the
 * time rule; every run is one `schedule_occurrences` row.
 */

export const AGENT_TASK_LIMITS = {
  nameChars: 80,
  /** Same ceiling as the chat input. */
  promptChars: 20000,
  maxSources: 100,
  maxMcpInstalls: 10,
  /** Shortest allowed gap between two fire times of one task. */
  minIntervalMinutes: 60,
  /** Fire times returned by a schedule preview. */
  previewFireTimes: 5,
  cronChars: 120,
} as const satisfies Record<string, number>;

// ── Time rules ──────────────────────────────────────────────────────────────

/** Version of the `spec_json` shape stored on a task's schedule row. */
export const SCHEDULE_RULE_SPEC_VERSION = 1;

/** A zone name the runtime knows. Bare UTC offsets such as "+08:00" are not names. */
export function isIanaTimeZone(value: string) {
  if (!/^[A-Za-z]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const scheduleTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isIanaTimeZone, { message: "Unknown IANA time zone" });

/** Wall-clock time of day in the task's time zone, 24-hour `HH:MM`. */
export const scheduleTimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour HH:MM time");

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export const scheduleWeekdaySchema = z.number().int().min(1).max(7);

/** No time rule: the task only runs when someone asks it to. */
export const manualScheduleRuleSchema = z
  .object({ kind: z.literal("manual") })
  .strict();

export const dailyScheduleRuleSchema = z
  .object({ kind: z.literal("daily"), time: scheduleTimeOfDaySchema })
  .strict();

export const weeklyScheduleRuleSchema = z
  .object({
    kind: z.literal("weekly"),
    days: z
      .array(scheduleWeekdaySchema)
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, {
        message: "Weekdays must not repeat",
      }),
    time: scheduleTimeOfDaySchema,
  })
  .strict();

/** Monday to Friday. Equal to weekly 1-5; kept apart for the form's wording. */
export const weekdaysScheduleRuleSchema = z
  .object({ kind: z.literal("weekdays"), time: scheduleTimeOfDaySchema })
  .strict();

/**
 * A five-field cron expression, always evaluated in the task's time zone.
 * The shape is checked here; whether it parses and respects the minimum
 * interval is decided by the backend, which owns the evaluator.
 */
export const cronScheduleRuleSchema = z
  .object({
    kind: z.literal("cron"),
    expr: z.string().trim().min(1).max(AGENT_TASK_LIMITS.cronChars),
  })
  .strict();

/** Runs once at an absolute instant. */
export const onceScheduleRuleSchema = z
  .object({
    kind: z.literal("once"),
    at: z.string().datetime({ offset: true }),
  })
  .strict();

export const scheduleRuleSchema = z.discriminatedUnion("kind", [
  manualScheduleRuleSchema,
  dailyScheduleRuleSchema,
  weeklyScheduleRuleSchema,
  weekdaysScheduleRuleSchema,
  cronScheduleRuleSchema,
  onceScheduleRuleSchema,
]);
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;
export type ScheduleRuleKind = ScheduleRule["kind"];

/** Why a rule was refused. Stable codes; the client owns the wording. */
export const scheduleRuleErrorCodeSchema = z.enum([
  "invalid_timezone",
  "invalid_cron",
  "interval_too_short",
  "once_in_past",
  "never_fires",
]);
export type ScheduleRuleErrorCode = z.infer<typeof scheduleRuleErrorCodeSchema>;

// ── Task definition ─────────────────────────────────────────────────────────

export const agentTaskStatusSchema = z.enum([
  /** Saved but never enabled; only "run now" can start it. */
  "draft",
  "active",
  "paused",
  /** Cannot run until something outside the task changes (see the reason). */
  "blocked",
  /** A one-time task that has run. */
  "completed",
  "archived",
]);
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;

export const agentTaskStatusReasonSchema = z.enum([
  "user_paused",
  "owner_left",
  "repeated_failure",
  "insufficient_credits",
  "tools_unavailable",
  "auth_expired",
]);
export type AgentTaskStatusReason = z.infer<typeof agentTaskStatusReasonSchema>;

export const agentTaskResultTargetSchema = z.enum(["new_thread"]);
export type AgentTaskResultTarget = z.infer<typeof agentTaskResultTargetSchema>;

const idSchema = z.string().trim().min(1).max(128);

/**
 * What a run is started with, frozen when the task is saved. A closed list on
 * purpose: unlike the chat request's open tool map, nothing a task does not
 * name here can reach a scheduled run.
 */
export const agentTaskRequestSchema = z
  .object({
    sourceIds: z.array(idSchema).max(AGENT_TASK_LIMITS.maxSources).default([]),
    /** Model choice for the run; the thinking setting travels inside it. */
    llm: llmExecutionConfigSchema.optional(),
    modelSettings: threadModelSettingsInputSchema.optional(),
    skillIds: z.array(idSchema).max(MAX_SELECTED_SKILLS_PER_TURN).default([]),
    mcp: z
      .object({
        installIds: z
          .array(idSchema)
          .max(AGENT_TASK_LIMITS.maxMcpInstalls)
          .default([]),
      })
      .strict()
      .default({ installIds: [] }),
    webAccess: z.boolean().default(false),
  })
  .strict();
export type AgentTaskRequest = z.infer<typeof agentTaskRequestSchema>;

export const agentTaskNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_TASK_LIMITS.nameChars);
export const agentTaskPromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_TASK_LIMITS.promptChars);

export const agentTaskScheduleSchema = z.object({
  rule: scheduleRuleSchema,
  timezone: z.string(),
  enabled: z.boolean(),
  /** When the task is next due, including its fixed offset; null if never. */
  nextDueAt: z.string().nullable(),
});
export type AgentTaskSchedule = z.infer<typeof agentTaskScheduleSchema>;

export const agentTaskSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  /** Whose identity the task runs as, and who pays for it. */
  ownerUserId: z.string(),
  name: z.string(),
  prompt: z.string(),
  request: agentTaskRequestSchema,
  schedule: agentTaskScheduleSchema,
  status: agentTaskStatusSchema,
  statusReason: agentTaskStatusReasonSchema.nullable(),
  statusChangedAt: z.string(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** When the latest "run now" finished; null if the task was never tried. */
  trialRunAt: z.string().nullable(),
  notifyOnSuccess: z.boolean(),
  notifyEmail: z.boolean(),
  resultTarget: agentTaskResultTargetSchema,
  /** Bumped whenever the prompt, the request or the time rule changes. */
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;

// ── Runs ────────────────────────────────────────────────────────────────────

export const scheduleOccurrenceStatusSchema = z.enum([
  "pending",
  "dispatching",
  "queued",
  "succeeded",
  "failed",
  "skipped",
  /** The payer could not be charged or was no longer available. */
  "blocked",
  "cancelled",
]);
export type ScheduleOccurrenceStatus = z.infer<
  typeof scheduleOccurrenceStatusSchema
>;

/** What started a run. Only `schedule` and `manual` are produced today. */
export const scheduleTriggerKindSchema = z.enum([
  "schedule",
  "manual",
  "api",
  "event",
]);
export type ScheduleTriggerKind = z.infer<typeof scheduleTriggerKindSchema>;

/** Why a slot did not run. Set only on `skipped` and `blocked` runs. */
export const scheduleSkipReasonSchema = z.enum([
  "missed_platform_down",
  "previous_run_active",
  "user_concurrency_limit",
  "user_daily_cap",
  "insufficient_credits",
  "owner_left",
  "tools_unavailable",
  "auth_expired",
  "rate_limited",
]);
export type ScheduleSkipReason = z.infer<typeof scheduleSkipReasonSchema>;

export const agentTaskRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  /** The slot's nominal time, before the task's fixed offset. */
  scheduledFor: z.string(),
  status: scheduleOccurrenceStatusSchema,
  triggerKind: scheduleTriggerKindSchema,
  skipReason: scheduleSkipReasonSchema.nullable(),
  /** The task version that ran; null for a slot that never started. */
  taskVersion: z.number().int().positive().nullable(),
  /** True when this run made up for a slot missed while the platform was down. */
  isCatchUp: z.boolean(),
  threadId: z.string().nullable(),
  chatRunId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentTaskRun = z.infer<typeof agentTaskRunSchema>;

// ── Requests and responses ──────────────────────────────────────────────────

export const createAgentTaskRequestSchema = z
  .object({
    name: agentTaskNameSchema,
    prompt: agentTaskPromptSchema,
    request: agentTaskRequestSchema,
    rule: scheduleRuleSchema,
    timezone: scheduleTimeZoneSchema,
    notifyOnSuccess: z.boolean().optional(),
    notifyEmail: z.boolean().optional(),
    /** False saves a draft; true enables the schedule straight away. */
    activate: z.boolean().default(false),
  })
  .strict();
export type CreateAgentTaskRequest = z.infer<
  typeof createAgentTaskRequestSchema
>;

export const updateAgentTaskRequestSchema = z
  .object({
    /** The version the edit was made against; a stale one is refused. */
    version: z.number().int().positive(),
    name: agentTaskNameSchema.optional(),
    prompt: agentTaskPromptSchema.optional(),
    request: agentTaskRequestSchema.optional(),
    rule: scheduleRuleSchema.optional(),
    timezone: scheduleTimeZoneSchema.optional(),
    notifyOnSuccess: z.boolean().optional(),
    notifyEmail: z.boolean().optional(),
  })
  .strict()
  .refine(
    ({ version: _version, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: "At least one field must change" },
  );
export type UpdateAgentTaskRequest = z.infer<
  typeof updateAgentTaskRequestSchema
>;

export const runAgentTaskNowRequestSchema = z
  .object({
    /** Minted per click so a repeated request starts one run. */
    idempotencyKey: z.string().trim().min(1).max(256),
  })
  .strict();
export type RunAgentTaskNowRequest = z.infer<
  typeof runAgentTaskNowRequestSchema
>;

export const agentTaskResponseSchema = z.object({ task: agentTaskSchema });
export type AgentTaskResponse = z.infer<typeof agentTaskResponseSchema>;

export const listAgentTasksResponseSchema = z.object({
  tasks: z.array(agentTaskSchema),
});
export type ListAgentTasksResponse = z.infer<
  typeof listAgentTasksResponseSchema
>;

export const runAgentTaskNowResponseSchema = z.object({
  run: agentTaskRunSchema,
});
export type RunAgentTaskNowResponse = z.infer<
  typeof runAgentTaskNowResponseSchema
>;

export const listAgentTaskRunsRequestSchema = z.object({
  cursor: z.string().trim().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListAgentTaskRunsRequest = z.infer<
  typeof listAgentTaskRunsRequestSchema
>;

export const listAgentTaskRunsResponseSchema = z.object({
  runs: z.array(agentTaskRunSchema),
  nextCursor: z.string().nullable(),
});
export type ListAgentTaskRunsResponse = z.infer<
  typeof listAgentTaskRunsResponseSchema
>;

export const previewAgentTaskScheduleRequestSchema = z
  .object({ rule: scheduleRuleSchema, timezone: scheduleTimeZoneSchema })
  .strict();
export type PreviewAgentTaskScheduleRequest = z.infer<
  typeof previewAgentTaskScheduleRequestSchema
>;

export const previewAgentTaskScheduleResponseSchema = z.object({
  /**
   * The next nominal fire times, soonest first. A run starts up to
   * `maxOffsetSeconds` later than the time shown.
   */
  fireTimes: z.array(z.string()).max(AGENT_TASK_LIMITS.previewFireTimes),
  maxOffsetSeconds: z.number().int().nonnegative(),
});
export type PreviewAgentTaskScheduleResponse = z.infer<
  typeof previewAgentTaskScheduleResponseSchema
>;
