import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  marketMcpClaims,
  marketMcpOwnerOverrides,
  mcpServers,
} from "@sourceweft/db";
import type { McpOwnerOverridesRow } from "./overrides";

/**
 * The claims and owner-overrides tables (Issue #367, W7). Reads here are
 * what the public catalog reads join in; writes are the service's.
 */

export type McpClaimRow = typeof marketMcpClaims.$inferSelect;

/** What the public read layer needs per server, in one pass over a page. */
export type McpOwnerLayerRow = {
  row: McpOwnerOverridesRow | null;
  claimed: boolean;
};

export async function findOwnerLayersByServerIds(
  serverIds: readonly string[],
): Promise<Map<string, McpOwnerLayerRow>> {
  const map = new Map<string, McpOwnerLayerRow>();
  if (serverIds.length === 0) return map;
  const ids = [...serverIds];
  const [overrides, claimed] = await Promise.all([
    db
      .select()
      .from(marketMcpOwnerOverrides)
      .where(inArray(marketMcpOwnerOverrides.serverId, ids)),
    db
      .selectDistinct({ serverId: marketMcpClaims.serverId })
      .from(marketMcpClaims)
      .where(
        and(
          inArray(marketMcpClaims.serverId, ids),
          eq(marketMcpClaims.status, "verified"),
        ),
      ),
  ]);
  const claimedIds = new Set(claimed.map((row) => row.serverId));
  for (const id of ids) {
    map.set(id, { row: null, claimed: claimedIds.has(id) });
  }
  // Corrections apply only while some owner holds a verified claim: a
  // revoked owner's layer stays stored but stops showing.
  for (const row of overrides) {
    if (!claimedIds.has(row.serverId)) continue;
    map.set(row.serverId, { row, claimed: true });
  }
  return map;
}

export type ClaimableServer = {
  id: string;
  identifier: string;
  name: string;
  repoUrl: string | null;
};

/** A published, public server by identifier; the only kind one can claim. */
export async function findClaimableServer(
  identifier: string,
): Promise<ClaimableServer | null> {
  const [row] = await db
    .select({
      id: mcpServers.id,
      identifier: mcpServers.identifier,
      name: mcpServers.name,
      repoUrl: mcpServers.repoUrl,
    })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.identifier, identifier),
        eq(mcpServers.status, "published"),
        eq(mcpServers.visibility, "public"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findServerIdentifier(
  serverId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ identifier: mcpServers.identifier })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId))
    .limit(1);
  return row?.identifier ?? null;
}

export async function findClaimById(claimId: string): Promise<McpClaimRow | null> {
  const [row] = await db
    .select()
    .from(marketMcpClaims)
    .where(eq(marketMcpClaims.id, claimId))
    .limit(1);
  return row ?? null;
}

/** The viewer's claims on a server that are not revoked, newest first. */
export async function listViewerClaims(
  serverId: string,
  userId: string,
): Promise<McpClaimRow[]> {
  return db
    .select()
    .from(marketMcpClaims)
    .where(
      and(
        eq(marketMcpClaims.serverId, serverId),
        eq(marketMcpClaims.userId, userId),
        ne(marketMcpClaims.status, "revoked"),
      ),
    )
    .orderBy(desc(marketMcpClaims.createdAt));
}

export async function findVerifiedClaim(
  serverId: string,
  userId: string,
): Promise<McpClaimRow | null> {
  const [row] = await db
    .select()
    .from(marketMcpClaims)
    .where(
      and(
        eq(marketMcpClaims.serverId, serverId),
        eq(marketMcpClaims.userId, userId),
        eq(marketMcpClaims.status, "verified"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function hasVerifiedClaim(serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql`1` })
    .from(marketMcpClaims)
    .where(
      and(
        eq(marketMcpClaims.serverId, serverId),
        eq(marketMcpClaims.status, "verified"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** A new pending claim replaces the member's previous pending one. */
export async function replacePendingClaim(
  values: typeof marketMcpClaims.$inferInsert,
): Promise<McpClaimRow> {
  return db.transaction(async (tx) => {
    await tx
      .delete(marketMcpClaims)
      .where(
        and(
          eq(marketMcpClaims.serverId, values.serverId),
          eq(marketMcpClaims.userId, values.userId),
          eq(marketMcpClaims.status, "pending"),
        ),
      );
    const [row] = await tx.insert(marketMcpClaims).values(values).returning();
    return row!;
  });
}

export async function insertVerifiedClaim(
  values: typeof marketMcpClaims.$inferInsert,
): Promise<McpClaimRow> {
  const [row] = await db.insert(marketMcpClaims).values(values).returning();
  return row!;
}

export async function markClaimVerified(
  claimId: string,
  now: Date,
): Promise<McpClaimRow | null> {
  const [row] = await db
    .update(marketMcpClaims)
    .set({ status: "verified", verifiedAt: now, lastError: null })
    .where(
      and(eq(marketMcpClaims.id, claimId), eq(marketMcpClaims.status, "pending")),
    )
    .returning();
  return row ?? null;
}

export async function recordClaimError(
  claimId: string,
  error: string,
): Promise<void> {
  await db
    .update(marketMcpClaims)
    .set({ lastError: error })
    .where(eq(marketMcpClaims.id, claimId));
}

export async function markClaimRevoked(input: {
  claimId: string;
  revokedBy: string;
  now: Date;
}): Promise<McpClaimRow | null> {
  const [row] = await db
    .update(marketMcpClaims)
    .set({
      status: "revoked",
      revokedAt: input.now,
      revokedBy: input.revokedBy,
    })
    .where(
      and(
        eq(marketMcpClaims.id, input.claimId),
        ne(marketMcpClaims.status, "revoked"),
      ),
    )
    .returning();
  return row ?? null;
}

export async function listClaimsForAdmin(input: {
  serverId?: string | null;
  limit: number;
}): Promise<McpClaimRow[]> {
  return db
    .select()
    .from(marketMcpClaims)
    .where(input.serverId ? eq(marketMcpClaims.serverId, input.serverId) : undefined)
    .orderBy(desc(marketMcpClaims.createdAt))
    .limit(input.limit);
}

// --- Overrides -------------------------------------------------------------

export async function findOwnerOverridesRow(
  serverId: string,
): Promise<McpOwnerOverridesRow | null> {
  const [row] = await db
    .select()
    .from(marketMcpOwnerOverrides)
    .where(eq(marketMcpOwnerOverrides.serverId, serverId))
    .limit(1);
  return row ?? null;
}

export async function upsertOwnerOverrideValues(input: {
  serverId: string;
  userId: string;
  values: Record<string, unknown>;
  now: Date;
}): Promise<McpOwnerOverridesRow> {
  const [row] = await db
    .insert(marketMcpOwnerOverrides)
    .values({
      serverId: input.serverId,
      updatedBy: input.userId,
      overridesJson: input.values,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: marketMcpOwnerOverrides.serverId,
      set: {
        updatedBy: input.userId,
        overridesJson: input.values,
        updatedAt: input.now,
      },
    })
    .returning();
  return row!;
}

export async function upsertOwnerTools(input: {
  serverId: string;
  userId: string;
  tools: unknown[] | null;
  meta: Record<string, unknown> | null;
  now: Date;
}): Promise<McpOwnerOverridesRow> {
  const submittedAt = input.tools ? input.now : null;
  const [row] = await db
    .insert(marketMcpOwnerOverrides)
    .values({
      serverId: input.serverId,
      updatedBy: input.userId,
      overridesJson: {},
      toolsJson: input.tools,
      toolsMetaJson: input.meta,
      toolsSubmittedAt: submittedAt,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: marketMcpOwnerOverrides.serverId,
      set: {
        updatedBy: input.userId,
        toolsJson: input.tools,
        toolsMetaJson: input.meta,
        toolsSubmittedAt: submittedAt,
        updatedAt: input.now,
      },
    })
    .returning();
  return row!;
}
