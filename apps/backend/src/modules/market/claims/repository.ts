import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import {
  db,
  marketMcpClaimAttempts,
  marketMcpClaimBlocks,
  marketMcpClaims,
  marketMcpOwnerOverrides,
  mcpServers,
} from "@sourceweft/db";
import { McpClaimError } from "./errors";
import {
  clearAuthoredBy,
  visibleOwnerOverrides,
  type AuthorMap,
  type McpOwnerOverridesRow,
} from "./overrides";
import { CLAIM_THROTTLE, throttleVerdict } from "./throttle";

/**
 * The claims, blocks, attempts and owner-overrides tables (Issue #367, W7).
 * Reads here are what the public catalog reads join in; writes are the
 * service's.
 */

export type McpClaimRow = typeof marketMcpClaims.$inferSelect;

/** What the public read layer needs per server, in one pass over a page. */
export type McpOwnerLayerRow = {
  /** The stored layer filtered to what the verified members wrote. */
  row: McpOwnerOverridesRow | null;
  claimed: boolean;
};

export async function findOwnerLayersByServerIds(
  serverIds: readonly string[],
): Promise<Map<string, McpOwnerLayerRow>> {
  const map = new Map<string, McpOwnerLayerRow>();
  if (serverIds.length === 0) return map;
  const ids = [...serverIds];
  const [overrides, verified] = await Promise.all([
    db
      .select()
      .from(marketMcpOwnerOverrides)
      .where(inArray(marketMcpOwnerOverrides.serverId, ids)),
    db
      .selectDistinct({
        serverId: marketMcpClaims.serverId,
        userId: marketMcpClaims.userId,
      })
      .from(marketMcpClaims)
      .where(
        and(
          inArray(marketMcpClaims.serverId, ids),
          eq(marketMcpClaims.status, "verified"),
        ),
      ),
  ]);
  const holders = new Map<string, Set<string>>();
  for (const claim of verified) {
    const set = holders.get(claim.serverId) ?? new Set<string>();
    set.add(claim.userId);
    holders.set(claim.serverId, set);
  }
  for (const id of ids) {
    map.set(id, { row: null, claimed: holders.has(id) });
  }
  // A field shows only while the member who wrote it holds a verified claim
  // (a revoked or blocked member's work is quarantined or cleared; a
  // co-owner's stays).
  for (const row of overrides) {
    const members = holders.get(row.serverId);
    if (!members) continue;
    map.set(row.serverId, {
      row: visibleOwnerOverrides(row, members),
      claimed: true,
    });
  }
  return map;
}

export type ClaimableServer = {
  id: string;
  identifier: string;
  name: string;
  repoUrl: string | null;
};

const serverColumns = {
  id: mcpServers.id,
  identifier: mcpServers.identifier,
  name: mcpServers.name,
  repoUrl: mcpServers.repoUrl,
};

/** A published, public server by identifier; the only kind one can claim. */
export async function findClaimableServer(
  identifier: string,
): Promise<ClaimableServer | null> {
  const [row] = await db
    .select(serverColumns)
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

/** Any catalog server by identifier, for a market admin. */
export async function findServerByIdentifier(
  identifier: string,
): Promise<ClaimableServer | null> {
  const [row] = await db
    .select(serverColumns)
    .from(mcpServers)
    .where(eq(mcpServers.identifier, identifier))
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

/** The members holding a verified claim on the server. */
export async function listVerifiedUserIds(serverId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: marketMcpClaims.userId })
    .from(marketMcpClaims)
    .where(
      and(
        eq(marketMcpClaims.serverId, serverId),
        eq(marketMcpClaims.status, "verified"),
      ),
    );
  return rows.map((row) => row.userId);
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

/** Ends a pending or verified claim; an already ended one is left alone. */
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
        inArray(marketMcpClaims.status, ["pending", "verified"]),
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

// --- Blocks ----------------------------------------------------------------

export type McpClaimBlockRow = typeof marketMcpClaimBlocks.$inferSelect;

/** A market admin blocked this member on this server (whatever their claims). */
export async function isMemberBlocked(
  serverId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql`1` })
    .from(marketMcpClaimBlocks)
    .where(
      and(
        eq(marketMcpClaimBlocks.serverId, serverId),
        eq(marketMcpClaimBlocks.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Blocks the member on the server, in one transaction: the block is
 * recorded whatever state their claims are in (a claim they gave up first
 * does not shield them), every open claim of theirs there ends, and what
 * they wrote on the listing — their fields and, if theirs, the tool list —
 * is cleared while a co-owner's stays.
 */
export async function blockMember(input: {
  serverId: string;
  userId: string;
  adminUserId: string;
  now: Date;
}): Promise<McpClaimBlockRow> {
  return db.transaction(async (tx) => {
    const [block] = await tx
      .insert(marketMcpClaimBlocks)
      .values({
        serverId: input.serverId,
        userId: input.userId,
        blockedBy: input.adminUserId,
        createdAt: input.now,
      })
      .onConflictDoUpdate({
        target: [marketMcpClaimBlocks.serverId, marketMcpClaimBlocks.userId],
        // Already blocked: keep the first block's author and time.
        set: { serverId: input.serverId },
      })
      .returning();
    await tx
      .update(marketMcpClaims)
      .set({
        status: "revoked",
        revokedAt: input.now,
        revokedBy: input.adminUserId,
      })
      .where(
        and(
          eq(marketMcpClaims.serverId, input.serverId),
          eq(marketMcpClaims.userId, input.userId),
          inArray(marketMcpClaims.status, ["pending", "verified"]),
        ),
      );
    const [layer] = await tx
      .select()
      .from(marketMcpOwnerOverrides)
      .where(eq(marketMcpOwnerOverrides.serverId, input.serverId))
      .for("update");
    const cleared = layer ? clearAuthoredBy(layer, input.userId) : null;
    if (layer && cleared) {
      await tx
        .update(marketMcpOwnerOverrides)
        .set({
          overridesJson: cleared.overridesJson,
          authorsJson: cleared.authorsJson,
          ...(cleared.clearTools
            ? { toolsJson: null, toolsMetaJson: null, toolsSubmittedAt: null }
            : {}),
          updatedAt: input.now,
        })
        .where(eq(marketMcpOwnerOverrides.serverId, input.serverId));
    }
    return block!;
  });
}

export async function unblockMember(input: {
  serverId: string;
  userId: string;
}): Promise<boolean> {
  const rows = await db
    .delete(marketMcpClaimBlocks)
    .where(
      and(
        eq(marketMcpClaimBlocks.serverId, input.serverId),
        eq(marketMcpClaimBlocks.userId, input.userId),
      ),
    )
    .returning({ userId: marketMcpClaimBlocks.userId });
  return rows.length > 0;
}

export async function listBlocksForAdmin(input: {
  serverId?: string | null;
  limit: number;
}): Promise<McpClaimBlockRow[]> {
  return db
    .select()
    .from(marketMcpClaimBlocks)
    .where(
      input.serverId ? eq(marketMcpClaimBlocks.serverId, input.serverId) : undefined,
    )
    .orderBy(desc(marketMcpClaimBlocks.createdAt))
    .limit(input.limit);
}

// --- Throttle --------------------------------------------------------------

function rateLimited(retryAfterSeconds: number, reason: "interval" | "hourly") {
  return new McpClaimError(
    429,
    "MCP_CLAIM_RATE_LIMITED",
    `Too many claim attempts (${reason === "interval" ? "wait between verifications" : "hourly limit"}); try again in ${retryAfterSeconds} s`,
    { retryAfterSeconds, reason },
  );
}

/**
 * Takes one attempt from the member's budget (`./throttle.ts`) or throws
 * 429 `MCP_CLAIM_RATE_LIMITED`. Read and write happen under one advisory
 * lock per member, so parallel requests cannot all pass the same count.
 * Attempts older than a day are dropped as they are passed.
 */
export async function reserveClaimAttempt(input: {
  userId: string;
  serverId: string;
  kind: "start" | "verify";
  now: Date;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`mcp-claim-attempts:${input.userId}`}))`,
    );
    const windowStart = new Date(input.now.getTime() - CLAIM_THROTTLE.windowMs);
    const recent = await tx
      .select({
        serverId: marketMcpClaimAttempts.serverId,
        kind: marketMcpClaimAttempts.kind,
        attemptedAt: marketMcpClaimAttempts.attemptedAt,
      })
      .from(marketMcpClaimAttempts)
      .where(
        and(
          eq(marketMcpClaimAttempts.userId, input.userId),
          gt(marketMcpClaimAttempts.attemptedAt, windowStart),
        ),
      );
    const lastVerifyAt = recent
      .filter(
        (attempt) =>
          attempt.kind === "verify" && attempt.serverId === input.serverId,
      )
      .reduce<Date | null>(
        (latest, attempt) =>
          !latest || attempt.attemptedAt > latest ? attempt.attemptedAt : latest,
        null,
      );
    const oldestInWindow = recent.reduce<Date | null>(
      (oldest, attempt) =>
        !oldest || attempt.attemptedAt < oldest ? attempt.attemptedAt : oldest,
      null,
    );
    const verdict = throttleVerdict({
      kind: input.kind,
      now: input.now,
      lastVerifyAt,
      attemptsInWindow: recent.length,
      oldestInWindow,
    });
    if (!verdict.ok) throw rateLimited(verdict.retryAfterSeconds, verdict.reason);
    await tx.insert(marketMcpClaimAttempts).values({
      id: randomUUID(),
      userId: input.userId,
      serverId: input.serverId,
      kind: input.kind,
      attemptedAt: input.now,
    });
    await tx
      .delete(marketMcpClaimAttempts)
      .where(
        and(
          eq(marketMcpClaimAttempts.userId, input.userId),
          lt(
            marketMcpClaimAttempts.attemptedAt,
            new Date(input.now.getTime() - 24 * 60 * 60 * 1000),
          ),
        ),
      );
  });
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
  authors: AuthorMap;
  now: Date;
}): Promise<McpOwnerOverridesRow> {
  const [row] = await db
    .insert(marketMcpOwnerOverrides)
    .values({
      serverId: input.serverId,
      updatedBy: input.userId,
      overridesJson: input.values,
      authorsJson: input.authors,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: marketMcpOwnerOverrides.serverId,
      set: {
        updatedBy: input.userId,
        overridesJson: input.values,
        authorsJson: input.authors,
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
  /** The authors map with the tool list's author set or removed. */
  authors: AuthorMap;
  now: Date;
}): Promise<McpOwnerOverridesRow> {
  const submittedAt = input.tools ? input.now : null;
  const [row] = await db
    .insert(marketMcpOwnerOverrides)
    .values({
      serverId: input.serverId,
      updatedBy: input.userId,
      overridesJson: {},
      authorsJson: input.authors,
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
        authorsJson: input.authors,
        toolsJson: input.tools,
        toolsMetaJson: input.meta,
        toolsSubmittedAt: submittedAt,
        updatedAt: input.now,
      },
    })
    .returning();
  return row!;
}
