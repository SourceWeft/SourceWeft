import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { artifacts, db, shareLinks } from "@sourceweft/db";
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
 * Revokes every live artifact share belonging to one thread, returning the
 * affected artifact ids. Backs the private-flip revoke: exposure was granted
 * while the artifacts were workspace-visible, and the flip withdraws it — a
 * later flip back must not silently re-arm the old tokens.
 */
export async function revokeShareLinksForThreadArtifacts(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}): Promise<string[]> {
  const rows = await db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(shareLinks.teamId, input.teamId),
        eq(shareLinks.targetType, "artifact"),
        isNull(shareLinks.revokedAt),
        inArray(
          shareLinks.targetId,
          db
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(
              and(
                eq(artifacts.teamId, input.teamId),
                eq(artifacts.workspaceId, input.workspaceId),
                eq(artifacts.threadId, input.threadId),
              ),
            ),
        ),
      ),
    )
    .returning({ targetId: shareLinks.targetId });

  return rows.map((row) => row.targetId);
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
