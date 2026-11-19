import {
  AGENT_TASK_LIMITS,
  SCHEDULE_RULE_SPEC_VERSION,
  scheduleRuleSchema,
  type PreviewAgentTaskScheduleResponse,
  type ScheduleRule,
} from "@sourceweft/contracts/scheduled-tasks";
import {
  nextFireTimes,
  planDueSlot,
  stableOffsetMs,
  validateScheduleRule,
  type DueSlotPlan,
  type ScheduleRow,
} from "../schedules";

/** Two fire times of one task are never closer than this. */
export const AGENT_TASK_MIN_INTERVAL_MS =
  AGENT_TASK_LIMITS.minIntervalMinutes * 60_000;

/**
 * Upper bound of a task's fixed offset: half its period, at most five
 * minutes. No task fires more often than the minimum interval, so the bound
 * is the same for all of them.
 */
export const AGENT_TASK_MAX_OFFSET_MS = Math.min(
  AGENT_TASK_MIN_INTERVAL_MS / 2,
  5 * 60_000,
);

/**
 * How long after its nominal time a task starts. Fixed per task, so one task
 * always runs at the same minute while different tasks spread out instead of
 * all starting on the hour.
 */
export function agentTaskOffsetMs(taskId: string) {
  return stableOffsetMs(`agent_task:${taskId}`, AGENT_TASK_MAX_OFFSET_MS);
}

/** Throws `ScheduleRuleError` unless the rule may be saved on a task. */
export function assertAgentTaskSchedule(
  rule: ScheduleRule,
  timezone: string,
  now: Date,
) {
  validateScheduleRule(rule, timezone, {
    now,
    minIntervalMs: AGENT_TASK_MIN_INTERVAL_MS,
  });
}

/** The next fire times a form shows before the task is saved. */
export function previewAgentTaskSchedule(input: {
  rule: ScheduleRule;
  timezone: string;
  now: Date;
}): PreviewAgentTaskScheduleResponse {
  assertAgentTaskSchedule(input.rule, input.timezone, input.now);
  return {
    fireTimes: nextFireTimes(
      input.rule,
      input.timezone,
      input.now,
      AGENT_TASK_LIMITS.previewFireTimes,
    ).map((time) => time.toISOString()),
    maxOffsetSeconds: AGENT_TASK_MAX_OFFSET_MS / 1000,
  };
}

/**
 * The time columns of a task's `task_schedules` row for a rule that has just
 * been saved, enabled or resumed. Slots before `now` are not made up for: the
 * schedule starts from the next fire time. A manual rule, and a rule with no
 * fire time left, is stored disabled with nothing due.
 */
export function agentTaskScheduleState(input: {
  taskId: string;
  rule: ScheduleRule;
  timezone: string;
  enabled: boolean;
  now: Date;
}) {
  const [next] = input.enabled
    ? nextFireTimes(input.rule, input.timezone, input.now, 1)
    : [];
  return {
    specVersion: SCHEDULE_RULE_SPEC_VERSION,
    specJson: input.rule as Record<string, unknown>,
    timezone: input.timezone,
    enabled: next !== undefined,
    nextDueAt: next
      ? new Date(next.getTime() + agentTaskOffsetMs(input.taskId))
      : null,
  };
}

/** Reads the rule back from a schedule row; throws on a shape it does not know. */
export function agentTaskRule(
  schedule: Pick<ScheduleRow, "specVersion" | "specJson">,
): ScheduleRule {
  if (schedule.specVersion !== SCHEDULE_RULE_SPEC_VERSION) {
    throw new Error(
      `Unsupported schedule rule version: ${schedule.specVersion}`,
    );
  }
  return scheduleRuleSchema.parse(schedule.specJson);
}

/**
 * What a due task schedule does now: which slot to materialize, when it is
 * due next, and which older slots were missed. Null when nothing is due.
 */
export function planAgentTaskSlot(
  schedule: Pick<
    ScheduleRow,
    "agentTaskId" | "specVersion" | "specJson" | "timezone" | "nextDueAt"
  >,
  now: Date,
): DueSlotPlan | null {
  if (!schedule.agentTaskId) {
    throw new Error("The schedule does not belong to a scheduled task");
  }
  if (!schedule.nextDueAt) return null;
  return planDueSlot({
    rule: agentTaskRule(schedule),
    timeZone: schedule.timezone,
    offsetMs: agentTaskOffsetMs(schedule.agentTaskId),
    dueAt: schedule.nextDueAt,
    now,
  });
}
