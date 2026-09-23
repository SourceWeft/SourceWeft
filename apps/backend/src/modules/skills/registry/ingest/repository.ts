import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  db,
  skillRegistrySubmissions,
  type SkillSubmissionOnComplete,
  SkillSubmissionOptions,
  type SkillSubmissionSkillResult,
  type SkillSubmissionStages,
} from "@sourceweft/db";

/**
 * Persistence for `skill_registry_submissions`.
 *
 * Two kinds of writer touch a row: the API (create / retry) and the worker
 * (claim → progress → finish). Every worker write after the claim is FENCED on
 * `(status = 'running', attempts = <the claim's attempts>)`: a run that was
 * superseded — its job stalled and was redelivered, or the row was already
 * closed by the failure boundary — finds zero rows to update and stops, instead
 * of overwriting the progress of the run that replaced it.
 */

export type SkillSubmissionRow = typeof skillRegistrySubmissions.$inferSelect;
export type SkillSubmissionError = {
  code: string;
  message: string;
  /** `GITHUB_RATE_LIMITED`: when the import runs again, ISO 8601. */
  resumeAt?: string;
};

const IN_FLIGHT = ["queued", "running"] as const;

/**
 * Insert a queued submission, or return the caller's in-flight one for the same
 * source. `skill_registry_submissions_inflight_uq` is the arbiter, so two
 * concurrent creates cannot both win.
 */
export async function createOrReuseSubmission(input: {
  scope?: "workspace" | "system";
  teamId: string | null;
  workspaceId: string | null;
  submittedBy: string;
  sourceInput: string;
  repoOwner: string;
  repoName: string;
  ref: string | null;
  subpath: string | null;
  onComplete: SkillSubmissionOnComplete | null;
  options?: SkillSubmissionOptions;
}): Promise<{ submission: SkillSubmissionRow; created: boolean }> {
  // The in-flight row can finish between the conflicting insert and the lookup;
  // the slot is then free, so inserting again succeeds.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Stamped here rather than by `defaultNow()`: the list cursor round-trips
    // `created_at` through a JS Date, and Postgres' microseconds would not
    // survive that — rows sharing a millisecond could be skipped between pages.
    const now = new Date();
    const [created] = await db
      .insert(skillRegistrySubmissions)
      .values({
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        scope: input.scope ?? "workspace",
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        submittedBy: input.submittedBy,
        sourceKind: "github",
        sourceInput: input.sourceInput,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        ref: input.ref,
        subpath: input.subpath,
        onComplete: input.onComplete,
        options: input.options ?? {},
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      return { submission: created, created: true };
    }
    const [existing] = await db
      .select()
      .from(skillRegistrySubmissions)
      .where(
        and(
          eq(skillRegistrySubmissions.scope, input.scope ?? "workspace"),
          eq(skillRegistrySubmissions.submittedBy, input.submittedBy),
          eq(skillRegistrySubmissions.sourceKind, "github"),
          sql`lower(${skillRegistrySubmissions.sourceInput}) = lower(${input.sourceInput})`,
          inArray(skillRegistrySubmissions.status, [...IN_FLIGHT]),
        ),
      )
      .limit(1);
    if (existing) {
      return { submission: existing, created: false };
    }
  }
  throw new Error("Could not create or find the in-flight skill submission");
}

export async function getSubmission(
  id: string,
): Promise<SkillSubmissionRow | null> {
  const [row] = await db
    .select()
    .from(skillRegistrySubmissions)
    .where(eq(skillRegistrySubmissions.id, id))
    .limit(1);
  return row ?? null;
}

/** Newest first; `before` is the keyset position of the previous page's last row. */
export async function listSubmissions(input: {
  workspaceId: string;
  submittedBy: string;
  limit: number;
  before?: { createdAt: Date; id: string };
}): Promise<SkillSubmissionRow[]> {
  return db
    .select()
    .from(skillRegistrySubmissions)
    .where(
      and(
        eq(skillRegistrySubmissions.scope, "workspace"),
        eq(skillRegistrySubmissions.workspaceId, input.workspaceId),
        eq(skillRegistrySubmissions.submittedBy, input.submittedBy),
        input.before
          ? or(
              lt(skillRegistrySubmissions.createdAt, input.before.createdAt),
              and(
                eq(skillRegistrySubmissions.createdAt, input.before.createdAt),
                lt(skillRegistrySubmissions.id, input.before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(skillRegistrySubmissions.createdAt),
      desc(skillRegistrySubmissions.id),
    )
    .limit(input.limit);
}

/**
 * Take the submission for one processor run. Progress from an earlier attempt
 * is cleared — the stages run again from the top — and `attempts` is bumped,
 * which is the fence every later write of this run checks.
 *
 * Returns null when there is nothing to run: the row is gone, or it already
 * reached a terminal state (a duplicate delivery of a finished job).
 */
export async function claimSubmission(
  id: string,
): Promise<SkillSubmissionRow | null> {
  const [row] = await db
    .update(skillRegistrySubmissions)
    .set({
      status: "running",
      stage: null,
      stages: {},
      error: null,
      attempts: sql`${skillRegistrySubmissions.attempts} + 1`,
      startedAt: sql`coalesce(${skillRegistrySubmissions.startedAt}, now())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(skillRegistrySubmissions.id, id),
        inArray(skillRegistrySubmissions.status, [...IN_FLIGHT]),
      ),
    )
    .returning();
  return row ?? null;
}

export type SubmissionFence = { id: string; attempts: number };

export type SubmissionProgressPatch = {
  stage?: string | null;
  stages?: SkillSubmissionStages;
  results?: SkillSubmissionSkillResult[];
  commitSha?: string;
  commitCommittedAt?: Date | null;
  status?: "queued" | "succeeded" | "failed";
  error?: SkillSubmissionError | null;
  finishedAt?: Date;
};

/** Fenced write by the run that holds the claim. False = superseded. */
export async function writeSubmissionProgress(
  fence: SubmissionFence,
  patch: SubmissionProgressPatch,
): Promise<boolean> {
  const rows = await db
    .update(skillRegistrySubmissions)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(skillRegistrySubmissions.id, fence.id),
        eq(skillRegistrySubmissions.status, "running"),
        eq(skillRegistrySubmissions.attempts, fence.attempts),
      ),
    )
    .returning({ id: skillRegistrySubmissions.id });
  return rows.length > 0;
}

/**
 * Close a submission from OUTSIDE a run (the worker's failure boundary, or an
 * enqueue that never reached Redis). Only in-flight rows are touched, so a
 * result the processor already recorded is never overwritten.
 */
export async function failSubmissionIfInFlight(
  id: string,
  error: SkillSubmissionError,
): Promise<boolean> {
  const rows = await db
    .update(skillRegistrySubmissions)
    .set({
      status: "failed",
      error,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(skillRegistrySubmissions.id, id),
        inArray(skillRegistrySubmissions.status, [...IN_FLIGHT]),
      ),
    )
    .returning({ id: skillRegistrySubmissions.id });
  return rows.length > 0;
}

/**
 * Put a failed submission back in the queue. Returns null when it is not
 * `failed` (anymore). Throws the unique violation when the submitter meanwhile
 * started another ingest of the same source — the caller turns that into a 409.
 */
export async function requeueFailedSubmission(
  id: string,
): Promise<SkillSubmissionRow | null> {
  const [row] = await db
    .update(skillRegistrySubmissions)
    .set({
      status: "queued",
      stage: null,
      stages: {},
      results: [],
      error: null,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(skillRegistrySubmissions.id, id),
        eq(skillRegistrySubmissions.status, "failed"),
      ),
    )
    .returning();
  return row ?? null;
}

/** Verify database connectivity and the required scope migration, without writes. */
export async function assertSystemSubmissionStorage() {
  await db
    .select({ scope: skillRegistrySubmissions.scope })
    .from(skillRegistrySubmissions)
    .limit(0);
}
