import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, shareLinks } from "@sourceweft/db";
import type { ShareAccessLevel, ShareTargetType } from "@sourceweft/contracts";
import { generateShareToken } from "./token";

export type ShareLinkRow = typeof shareLinks.$inferSelect;

/** The single live (non-revoked) share for a target, if any. */
export async function findActiveShareByTarget(input: {
  targetType: ShareTargetType;
  targetId: string;
}) {
  const [row] = await db
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.targetType, input.targetType),
        eq(shareLinks.targetId, input.targetId),
        isNull(shareLinks.revokedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * A live share resolved by its public token — the read path for `/s/:token`.
 * Returns null when the token is unknown, revoked, or expired, so callers never
 * have to special-case those separately from "not found".
 */
export async function findLiveShareByToken(token: string) {
  const [row] = await db
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.token, token),
        isNull(shareLinks.revokedAt),
        sql`(${shareLinks.expiresAt} is null or ${shareLinks.expiresAt} > now())`,
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Creates a live share, or returns the existing one for the target. The partial
 * unique index (one live share per target) is the backstop: on a race the
 * insert conflicts and we fall back to the existing row.
 */
export async function createShareLink(input: {
  teamId: string;
  workspaceId: string;
  targetType: ShareTargetType;
  targetId: string;
  accessLevel: ShareAccessLevel;
  isPublic: boolean;
  noindex: boolean;
  expiresAt: Date | null;
  createdBy: string;
}): Promise<ShareLinkRow> {
  const existing = await findActiveShareByTarget(input);
  if (existing) {
    return existing;
  }

  const [row] = await db
    .insert(shareLinks)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      targetType: input.targetType,
      targetId: input.targetId,
      accessLevel: input.accessLevel,
      isPublic: input.isPublic,
      noindex: input.noindex,
      token: generateShareToken(),
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    })
    // No target needed: the only unique constraint an insert can hit here is
    // the partial "one live share per target" index, and on that race we fall
    // back to the row the winner created.
    .onConflictDoNothing()
    .returning();

  return row ?? (await findActiveShareByTarget(input))!;
}

export async function updateShareLink(input: {
  targetType: ShareTargetType;
  targetId: string;
  noindex?: boolean;
  expiresAt?: Date | null;
}) {
  const set: Partial<ShareLinkRow> = {};
  if (input.noindex !== undefined) {
    set.noindex = input.noindex;
  }
  if (input.expiresAt !== undefined) {
    set.expiresAt = input.expiresAt;
  }
  if (Object.keys(set).length === 0) {
    return findActiveShareByTarget(input);
  }

  const [row] = await db
    .update(shareLinks)
    .set(set)
    .where(
      and(
        eq(shareLinks.targetType, input.targetType),
        eq(shareLinks.targetId, input.targetId),
        isNull(shareLinks.revokedAt),
      ),
    )
    .returning();

  return row ?? null;
}

export async function revokeShareLink(input: {
  targetType: ShareTargetType;
  targetId: string;
}) {
  const rows = await db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(shareLinks.targetType, input.targetType),
        eq(shareLinks.targetId, input.targetId),
        isNull(shareLinks.revokedAt),
      ),
    )
    .returning({ id: shareLinks.id });

  return rows.length > 0;
}

/**
 * Records a public view. Best-effort and non-blocking for the caller: a bumped
 * counter must never delay or fail serving the shared page.
 */
export async function incrementShareViewCount(token: string) {
  await db
    .update(shareLinks)
    .set({ viewCount: sql`${shareLinks.viewCount} + 1` })
    .where(eq(shareLinks.token, token));
}
