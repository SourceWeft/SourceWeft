export interface ScheduleSlot {
  /** The occurrence to materialize now. */
  scheduledFor: Date;
  /** When the schedule is next due after this slot. */
  nextDueAt: Date;
}

/**
 * Fixed-interval slot policy: the newest slot that has already elapsed, so a
 * long outage or a long-running job coalesces into one occurrence instead of
 * a backlog.
 */
export function intervalSlot(
  due: Date,
  intervalMinutes: number,
  now: Date,
): ScheduleSlot {
  const intervalMs = intervalMinutes * 60_000;
  const steps = Math.max(
    0,
    Math.floor((now.getTime() - due.getTime()) / intervalMs),
  );
  const scheduledFor = new Date(due.getTime() + steps * intervalMs);
  return {
    scheduledFor,
    nextDueAt: new Date(scheduledFor.getTime() + intervalMs),
  };
}
