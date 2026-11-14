import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db, sourceGuides } from "@sourceweft/db";
import type {
  SourceGuide,
  SourceGuideContent,
} from "@sourceweft/contracts/sources";

type GuideRow = typeof sourceGuides.$inferSelect;
type GuideStatus = GuideRow["status"];
type GuideTrigger = GuideRow["trigger"];
type GuideErrorCode = NonNullable<GuideRow["errorCode"]>;

type Scope = { teamId: string; workspaceId: string; sourceId: string };

export async function findGuideRecord(input: Scope) {
  const [row] = await db
    .select()
    .from(sourceGuides)
    .where(
      and(
        eq(sourceGuides.sourceId, input.sourceId),
        eq(sourceGuides.teamId, input.teamId),
        eq(sourceGuides.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Creates the source's guide row or moves the existing one to `status`.
 * `content` is kept across a regeneration until a new result replaces it, so a
 * reader keeps the previous guide while the next one is being made.
 */
export async function upsertGuideRecord(
  input: Scope & {
    status: GuideStatus;
    trigger: GuideTrigger;
    errorCode?: GuideErrorCode | null;
    payerUserId?: string | null;
    content?: SourceGuideContent;
    contentHash?: string | null;
  },
) {
  const now = new Date();
  const set = {
    status: input.status,
    trigger: input.trigger,
    errorCode: input.errorCode ?? null,
    ...(input.payerUserId !== undefined
      ? { payerUserId: input.payerUserId }
      : {}),
    ...(input.content !== undefined ? { contentJson: input.content } : {}),
    ...(input.contentHash !== undefined
      ? { contentHash: input.contentHash }
      : {}),
    updatedAt: now,
  };
  await db
    .insert(sourceGuides)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      ...set,
      contentJson: input.content ?? null,
      payerUserId: input.payerUserId ?? null,
      contentHash: input.contentHash ?? null,
    })
    .onConflictDoUpdate({ target: sourceGuides.sourceId, set });
}

export function toSourceGuide(
  row: GuideRow,
  currentContentHash: string | null,
): SourceGuide {
  return {
    sourceId: row.sourceId,
    status: row.status,
    content: row.contentJson ?? null,
    errorCode: row.errorCode ?? null,
    trigger: row.trigger,
    stale:
      row.contentHash !== null &&
      currentContentHash !== null &&
      row.contentHash !== currentContentHash,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Guides that are waiting on something that may have changed (no credits, no
 * one to charge) or whose job was lost mid-run. `updated_at` is the throttle:
 * every attempt rewrites it, so a guide that is still blocked is not picked
 * again until the interval has passed. Across all workspaces by design: this
 * is the scheduler's sweep.
 */
export async function listResumableGuides(input: {
  pausedBefore: Date;
  generatingBefore: Date;
  limit: number;
}) {
  return db
    .select({
      teamId: sourceGuides.teamId,
      workspaceId: sourceGuides.workspaceId,
      sourceId: sourceGuides.sourceId,
      trigger: sourceGuides.trigger,
      status: sourceGuides.status,
      errorCode: sourceGuides.errorCode,
      payerUserId: sourceGuides.payerUserId,
      updatedAt: sourceGuides.updatedAt,
    })
    .from(sourceGuides)
    .where(
      or(
        and(
          eq(sourceGuides.status, "pending"),
          inArray(sourceGuides.errorCode, ["QUOTA", "NO_PAYER"]),
          lt(sourceGuides.updatedAt, input.pausedBefore),
        ),
        // Queued or running, but silent for too long: the job was lost.
        and(
          or(
            eq(sourceGuides.status, "generating"),
            and(
              eq(sourceGuides.status, "pending"),
              isNull(sourceGuides.errorCode),
            ),
          ),
          lt(sourceGuides.updatedAt, input.generatingBefore),
        ),
      ),
    )
    .orderBy(asc(sourceGuides.updatedAt))
    .limit(input.limit);
}
