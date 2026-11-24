import { Cron } from "croner";
import {
  isIanaTimeZone,
  type ScheduleRule,
  type ScheduleRuleErrorCode,
} from "@sourceweft/contracts/scheduled-tasks";
import {
  instantToWallTime,
  wallTimeToInstant,
  type WallTimeResolution,
} from "./wall-time";

/**
 * Time rules: when a `manual`, `daily`, `weekly`, `weekdays`, `cron` or `once`
 * rule fires in an IANA time zone. Pure; nothing here reads a clock or a
 * database.
 *
 * Recurring rules are evaluated on wall-clock time and then placed on the real
 * timeline, so daylight saving is decided here and not by the cron library:
 *
 * - a wall time the clock shows twice (autumn) fires on its first occurrence
 *   only;
 * - a wall time the clock skips (spring) fires at the first valid moment after
 *   the jump, unless the rule fires within the skipped span of that moment
 *   anyway (an hourly rule just loses the hour that did not exist).
 */

export class ScheduleRuleError extends Error {
  readonly code: ScheduleRuleErrorCode;

  constructor(code: ScheduleRuleErrorCode, message: string) {
    super(message);
    this.name = "ScheduleRuleError";
    this.code = code;
  }
}

export interface CompiledScheduleRule {
  /** The first fire time strictly after `after`, or null if there is none. */
  next(after: Date): Date | null;
}

const NEVER: CompiledScheduleRule = { next: () => null };

/** Guards the search loops; a valid rule never comes close. */
const MAX_SEARCH_STEPS = 2000;

function cronExpression(rule: ScheduleRule): string | null {
  switch (rule.kind) {
    case "manual":
    case "once":
      return null;
    case "cron":
      return rule.expr.trim();
    case "daily":
    case "weekly":
    case "weekdays": {
      const [hour, minute] = rule.time.split(":").map(Number);
      const days =
        rule.kind === "daily"
          ? "*"
          : rule.kind === "weekdays"
            ? "1-5"
            : // ISO weekdays to cron's: Sunday is 0.
              [...rule.days]
                .map((day) => day % 7)
                .sort((a, b) => a - b)
                .join(",");
      return `${minute} ${hour} * * ${days}`;
    }
  }
}

function parseCron(expression: string) {
  // `?` means "the time the pattern was created", which is not a rule.
  if (expression.includes("?")) {
    throw new ScheduleRuleError(
      "invalid_cron",
      "The cron expression must not use '?'",
    );
  }
  try {
    // Evaluated on floating wall time: the pattern itself has no time zone.
    return new Cron(expression, { timezone: "UTC", mode: "5-part" });
  } catch (error) {
    throw new ScheduleRuleError(
      "invalid_cron",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function recurringRule(cron: Cron, timeZone: string): CompiledScheduleRule {
  const nextWall = (wallMs: number) =>
    cron.nextRun(new Date(wallMs))?.getTime() ?? null;

  /** Whether a skipped wall time should run at the jump or be dropped. */
  const runsAtJump = (
    wallMs: number,
    gap: Extract<WallTimeResolution, { kind: "gap" }>,
  ) => {
    // The skipped span, in wall time, and the real fires on either side.
    let earlier = cron.previousRuns(1, new Date(wallMs))[0]?.getTime();
    for (let step = 0; earlier !== undefined; step += 1) {
      const resolved = wallTimeToInstant(earlier, timeZone);
      if (resolved.kind === "instant") {
        if (gap.instantMs - resolved.instantMs < gap.gapMs) return false;
        break;
      }
      if (step > MAX_SEARCH_STEPS) break;
      earlier = cron.previousRuns(1, new Date(earlier))[0]?.getTime();
    }
    let later = nextWall(wallMs);
    for (let step = 0; later !== null; step += 1) {
      const resolved = wallTimeToInstant(later, timeZone);
      if (resolved.kind === "instant") {
        if (resolved.instantMs - gap.instantMs < gap.gapMs) return false;
        break;
      }
      if (step > MAX_SEARCH_STEPS) break;
      later = nextWall(later);
    }
    return true;
  };

  return {
    next(after) {
      const afterMs = after.getTime();
      // Wall times and their instants rise together, so the search can start
      // at the wall time `after` shows.
      let cursor =
        Math.floor(instantToWallTime(afterMs, timeZone) / 1000) * 1000;
      for (let step = 0; step < MAX_SEARCH_STEPS; step += 1) {
        const wallMs = nextWall(cursor);
        if (wallMs === null) return null;
        cursor = wallMs;
        const resolved = wallTimeToInstant(wallMs, timeZone);
        if (resolved.instantMs <= afterMs) continue;
        if (resolved.kind === "gap" && !runsAtJump(wallMs, resolved)) continue;
        return new Date(resolved.instantMs);
      }
      throw new Error("Schedule rule search did not converge");
    },
  };
}

/**
 * Turns a rule into something that can be asked for fire times.
 * Throws `ScheduleRuleError` for an unknown zone or an unparseable cron.
 */
export function compileScheduleRule(
  rule: ScheduleRule,
  timeZone: string,
): CompiledScheduleRule {
  if (!isIanaTimeZone(timeZone)) {
    throw new ScheduleRuleError(
      "invalid_timezone",
      `Unknown time zone: ${timeZone}`,
    );
  }
  if (rule.kind === "manual") return NEVER;
  if (rule.kind === "once") {
    const at = new Date(rule.at);
    return { next: (after) => (at.getTime() > after.getTime() ? at : null) };
  }
  return recurringRule(parseCron(cronExpression(rule)!), timeZone);
}

/** Up to `count` nominal fire times strictly after `after`, soonest first. */
export function nextFireTimes(
  rule: ScheduleRule,
  timeZone: string,
  after: Date,
  count: number,
): Date[] {
  const compiled = compileScheduleRule(rule, timeZone);
  const times: Date[] = [];
  let cursor = after;
  while (times.length < count) {
    const next = compiled.next(cursor);
    if (!next) break;
    times.push(next);
    cursor = next;
  }
  return times;
}

/** Wall-clock fire times sampled to measure a rule's shortest interval. */
const INTERVAL_SAMPLE_SIZE = 50;

/**
 * Checks a rule before it is saved. Throws `ScheduleRuleError` when the zone
 * is unknown, the cron does not parse, two fire times are closer than
 * `minIntervalMs`, a one-time rule is not in the future, or a recurring rule
 * can never fire.
 *
 * The interval is measured on wall-clock time, where it is a property of the
 * rule alone. Within a five-field cron every active day repeats the same
 * hours and minutes, so the first sampled days already contain the shortest
 * interval the rule will ever produce.
 */
export function validateScheduleRule(
  rule: ScheduleRule,
  timeZone: string,
  options: { now: Date; minIntervalMs: number },
) {
  const compiled = compileScheduleRule(rule, timeZone);
  if (rule.kind === "manual") return;
  if (rule.kind === "once") {
    if (!compiled.next(options.now)) {
      throw new ScheduleRuleError(
        "once_in_past",
        "A one-time schedule must be in the future",
      );
    }
    return;
  }
  const cron = parseCron(cronExpression(rule)!);
  const first = cron.nextRun(
    new Date(instantToWallTime(options.now.getTime(), timeZone)),
  );
  if (!first) {
    throw new ScheduleRuleError("never_fires", "The schedule never fires");
  }
  const sample = [first, ...cron.nextRuns(INTERVAL_SAMPLE_SIZE - 1, first)];
  for (let index = 1; index < sample.length; index += 1) {
    const interval = sample[index]!.getTime() - sample[index - 1]!.getTime();
    if (interval < options.minIntervalMs) {
      throw new ScheduleRuleError(
        "interval_too_short",
        `The schedule fires more often than every ${Math.round(options.minIntervalMs / 60_000)} minutes`,
      );
    }
  }
}

/** How far back a due schedule looks for slots it missed. */
const MISSED_LOOKBACK_MS = 48 * 60 * 60_000;
/** The longest a missed slot stays worth running. */
const MAX_CATCH_UP_WINDOW_MS = 24 * 60 * 60_000;
/** A slot that starts later than this is announced as a catch-up run. */
export const CATCH_UP_GRACE_MS = 15 * 60_000;

export interface DueSlotPlan {
  /** The nominal time of the slot to materialize: the newest one elapsed. */
  scheduledFor: Date;
  /** When the schedule is due again, offset included; null if never. */
  nextDueAt: Date | null;
  /** The slot is still worth running but late enough to tell the owner. */
  isCatchUp: boolean;
  /** The slot is too old to run and should be recorded as missed. */
  expired: boolean;
  /**
   * Older elapsed slots that will not run, oldest first. Only those within
   * the lookback are listed; `missedEarlier` says whether more came before.
   */
  missed: Date[];
  missedEarlier: boolean;
}

/**
 * Decides what a due schedule does now.
 *
 * `dueAt` is the schedule's stored due time, which is a nominal fire time
 * plus the schedule's fixed `offsetMs`. However long the schedule has been
 * overdue, only the newest elapsed slot is offered, and only while it is
 * younger than one period (at most 24 hours); everything older is reported as
 * missed. Returns null when nothing is due.
 */
export function planDueSlot(input: {
  rule: ScheduleRule;
  timeZone: string;
  offsetMs: number;
  dueAt: Date;
  now: Date;
}): DueSlotPlan | null {
  const nowMs = input.now.getTime();
  if (input.rule.kind === "manual" || input.dueAt.getTime() > nowMs) {
    return null;
  }
  const compiled = compileScheduleRule(input.rule, input.timeZone);
  const nominalDueMs = input.dueAt.getTime() - input.offsetMs;
  // A slot has elapsed once its nominal time plus the offset has passed.
  const limitMs = nowMs - input.offsetMs;
  const lookbackMs = Math.max(nominalDueMs, limitMs - MISSED_LOOKBACK_MS);

  const elapsed: Date[] = [];
  let cursor = new Date(lookbackMs - 1);
  for (let step = 0; ; step += 1) {
    const next = compiled.next(cursor);
    if (!next || next.getTime() > limitMs) break;
    if (step >= MAX_SEARCH_STEPS) {
      throw new Error("Schedule rule fires too often to plan a due slot");
    }
    elapsed.push(next);
    cursor = next;
  }

  const missedEarlier = nominalDueMs < lookbackMs;
  const newest = elapsed.at(-1) ?? new Date(nominalDueMs);
  const following = compiled.next(
    new Date(Math.max(newest.getTime(), limitMs)),
  );
  const periodMs = following
    ? following.getTime() - newest.getTime()
    : MAX_CATCH_UP_WINDOW_MS;
  const latenessMs = limitMs - newest.getTime();
  const expired =
    elapsed.length === 0 ||
    latenessMs > Math.min(periodMs, MAX_CATCH_UP_WINDOW_MS);
  return {
    scheduledFor: newest,
    nextDueAt: following
      ? new Date(following.getTime() + input.offsetMs)
      : null,
    isCatchUp: !expired && latenessMs > CATCH_UP_GRACE_MS,
    expired,
    missed: elapsed.slice(0, -1),
    missedEarlier,
  };
}
