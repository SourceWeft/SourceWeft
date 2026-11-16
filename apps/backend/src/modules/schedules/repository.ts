import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { db, scheduleOccurrences, taskSchedules } from "@sourceweft/db";
import type { ScheduleSlot } from "./slots";

export type ScheduleRow = typeof taskSchedules.$inferSelect;
export type OccurrenceRow = typeof scheduleOccurrences.$inferSelect;
export type ScheduleTaskKind = ScheduleRow["taskKind"];
export type ScheduleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ClaimedOccurrence = {
  occurrence: OccurrenceRow;
  schedule: ScheduleRow;
};

/** How long a dispatcher may hold an occurrence before another may take it. */
export const DISPATCH_LEASE_MS = 5 * 60_000;
/** Dispatch attempts after which an occurrence fails instead of retrying. */
export const MAX_DISPATCH_ATTEMPTS = 5;

/**
 * Materializes one occurrence for every due, enabled schedule of one kind.
 * Only the newest due slot is kept, so long outages coalesce. `computeSlot`
 * is the kind's time policy (null skips the schedule); `onMaterialized` runs in
 * the same transaction for kind-specific projections.
 */
export async function materializeDueSchedules(input: {
  taskKind: ScheduleTaskKind;
  now: Date;
  limit: number;
  computeSlot: (schedule: ScheduleRow, now: Date) => ScheduleSlot | null;
  onMaterialized?: (
    tx: ScheduleTx,
    schedule: ScheduleRow,
    slot: ScheduleSlot,
  ) => Promise<void>;
}) {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(taskSchedules)
      .where(
        and(
          eq(taskSchedules.enabled, true),
          eq(taskSchedules.taskKind, input.taskKind),
          lte(taskSchedules.nextDueAt, input.now),
        ),
      )
      .orderBy(asc(taskSchedules.nextDueAt))
      .limit(input.limit)
      .for("update", { skipLocked: true });
    for (const schedule of due) {
      const slot = input.computeSlot(schedule, input.now);
      if (!slot) continue;
      const [pending] = await tx
        .select()
        .from(scheduleOccurrences)
        .where(
          and(
            eq(scheduleOccurrences.scheduleId, schedule.id),
            eq(scheduleOccurrences.status, "pending"),
          ),
        )
        .limit(1)
        .for("update");
      if (pending) {
        await tx
          .update(scheduleOccurrences)
          .set({ scheduledFor: slot.scheduledFor, updatedAt: input.now })
          .where(eq(scheduleOccurrences.id, pending.id));
      } else {
        await tx
          .insert(scheduleOccurrences)
          .values({
            id: randomUUID(),
            scheduleId: schedule.id,
            scheduledFor: slot.scheduledFor,
          })
          .onConflictDoNothing();
      }
      await tx
        .update(taskSchedules)
        .set({ nextDueAt: slot.nextDueAt, updatedAt: input.now })
        .where(eq(taskSchedules.id, schedule.id));
      await input.onMaterialized?.(tx, schedule, slot);
    }
    return due.length;
  });
}

/**
 * Leases pending (or lease-expired) occurrences of one kind to the caller.
 * `isTargetBusy` is the kind's overlap rule: a busy target keeps its
 * occurrence pending without consuming an attempt.
 */
export async function claimDispatchableOccurrences(input: {
  taskKind: ScheduleTaskKind;
  now: Date;
  limit: number;
  isTargetBusy: (
    tx: ScheduleTx,
    candidate: ClaimedOccurrence,
  ) => Promise<boolean>;
}) {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ occurrence: scheduleOccurrences, schedule: taskSchedules })
      .from(scheduleOccurrences)
      .innerJoin(
        taskSchedules,
        eq(scheduleOccurrences.scheduleId, taskSchedules.id),
      )
      .where(
        and(
          eq(taskSchedules.enabled, true),
          eq(taskSchedules.taskKind, input.taskKind),
          or(
            and(
              eq(scheduleOccurrences.status, "pending"),
              or(
                isNull(scheduleOccurrences.retryAt),
                lte(scheduleOccurrences.retryAt, input.now),
              ),
            ),
            and(
              eq(scheduleOccurrences.status, "dispatching"),
              lte(scheduleOccurrences.leaseUntil, input.now),
            ),
          ),
        ),
      )
      .orderBy(asc(scheduleOccurrences.scheduledFor))
      .limit(input.limit)
      .for("update", { skipLocked: true });
    const claimed: typeof candidates = [];
    for (const candidate of candidates) {
      if (await input.isTargetBusy(tx, candidate)) continue;
      await tx
        .update(scheduleOccurrences)
        .set({
          status: "dispatching",
          leaseUntil: new Date(input.now.getTime() + DISPATCH_LEASE_MS),
          attempts: candidate.occurrence.attempts + 1,
          updatedAt: input.now,
        })
        .where(eq(scheduleOccurrences.id, candidate.occurrence.id));
      claimed.push(candidate);
    }
    return claimed;
  });
}

export async function markOccurrenceQueued(occurrenceId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(scheduleOccurrences)
      .set({ status: "queued", leaseUntil: null, updatedAt: now })
      .where(
        and(
          eq(scheduleOccurrences.id, occurrenceId),
          eq(scheduleOccurrences.status, "dispatching"),
        ),
      )
      .returning({ scheduleId: scheduleOccurrences.scheduleId });
    if (row) {
      await tx
        .update(taskSchedules)
        .set({ lastAttemptAt: now, retryAt: null, updatedAt: now })
        .where(eq(taskSchedules.id, row.scheduleId));
    }
  });
}

export async function markOccurrenceSkipped(input: {
  occurrenceId: string;
  reason: string;
}) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(scheduleOccurrences)
      .set({
        status: "skipped",
        leaseUntil: null,
        lastError: input.reason.slice(0, 500),
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduleOccurrences.id, input.occurrenceId),
          eq(scheduleOccurrences.status, "dispatching"),
        ),
      )
      .returning({ scheduleId: scheduleOccurrences.scheduleId });
    if (row) {
      await tx
        .update(taskSchedules)
        .set({
          lastAttemptAt: now,
          lastErrorCode: input.reason.slice(0, 200),
          updatedAt: now,
        })
        .where(eq(taskSchedules.id, row.scheduleId));
    }
  });
}

/**
 * Returns a dispatching occurrence to pending with exponential backoff, or
 * fails it once `MAX_DISPATCH_ATTEMPTS` is reached. `onFinalFailure` runs in
 * the same transaction so the kind can fail the run it created for the slot.
 */
export async function retryOccurrence(input: {
  occurrenceId: string;
  error: string;
  attempts: number;
  /** Stored on the schedule as its last error code. */
  errorCode: string;
  onFinalFailure?: (tx: ScheduleTx, occurrence: OccurrenceRow) => Promise<void>;
}) {
  const delayMs = Math.min(
    60 * 60_000,
    30_000 * 2 ** Math.min(input.attempts, 7),
  );
  const exhausted = input.attempts >= MAX_DISPATCH_ATTEMPTS;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(scheduleOccurrences)
      .set({
        status: exhausted ? "failed" : "pending",
        retryAt: exhausted ? null : new Date(Date.now() + delayMs),
        leaseUntil: null,
        lastError: input.error.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scheduleOccurrences.id, input.occurrenceId),
          eq(scheduleOccurrences.status, "dispatching"),
        ),
      )
      .returning();
    if (row && exhausted) await input.onFinalFailure?.(tx, row);
    if (row) {
      await tx
        .update(taskSchedules)
        .set({
          lastAttemptAt: new Date(),
          retryAt: row.retryAt,
          lastErrorCode: input.errorCode,
          updatedAt: new Date(),
        })
        .where(eq(taskSchedules.id, row.scheduleId));
    }
  });
}
