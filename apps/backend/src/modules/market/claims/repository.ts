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
import {
  McpClaimError,
  claimBlockedError,
  claimRequiredError,
} from "./errors";
import {
  TOOLS_AUTHOR_KEY,
  clearAuthoredBy,
  mergeAuthoredFields,
  visibleOwnerOverrides,
  type AuthorMap,
  type McpOwnerOverridesRow,
} from "./overrides";
import {
  purgeToolRevisions,
  recordToolRevision,
  withdrawToolRevision,
} from "../tool-revisions";
import { CLAIM_THROTTLE, throttleVerdict } from "./throttle";

/**
 * The claims, blocks, attempts and owner-overrides tables (Issue #367, W7).
 * Reads here are what the public catalog reads join in; writes are the
 * service's.
 */

export type McpClaimRow = typeof marketMcpClaims.$inferSelect;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Two transaction-scoped advisory locks keep the writes that depend on a
 * member's standing from interleaving with an admin's block. Always taken in
 * this order — the member's, then the listing's — so they cannot deadlock:
 *
 * - the member's on one server: verifying a claim, saving corrections and
 *   blocking all serialize on it, so a block cannot land between a check of
 *   the member's standing and the write that relies on it;
 * - the server's listing: corrections from different owners (and a block's
 *   clearing) take turns, which also covers a listing with no row yet.
 */
async function lockMember(tx: Tx, serverId: string, userId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`mcp-claim-member:${serverId}:${userId}`}))`,
  );
}
async function lockListing(tx: Tx, serverId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`mcp-claim-listing:${serverId}`}))`,
  );
}
async function assertNotBlocked(tx: Tx, serverId: string, userId: string) {
  const [blocked] = await tx
    .select({ one: sql`1` })
    .from(marketMcpClaimBlocks)
    .where(
      and(
        eq(marketMcpClaimBlocks.serverId, serverId),
        eq(marketMcpClaimBlocks.userId, userId),
      ),
    )
    .limit(1);
  if (blocked) throw claimBlockedError();
}

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

/**
 * Records a verified claim. A block that landed while the slow lookup behind
 * it (GitHub, DNS, the publisher's domain) was running is honoured: the check
 * runs inside the member's lock, in the transaction that writes the claim.
 */
export async function insertVerifiedClaim(
  values: typeof marketMcpClaims.$inferInsert,
): Promise<McpClaimRow> {
  return db.transaction(async (tx) => {
    await lockMember(tx, values.serverId, values.userId);
    await assertNotBlocked(tx, values.serverId, values.userId);
    const [row] = await tx.insert(marketMcpClaims).values(values).returning();
    return row!;
  });
}

/** Pending → verified, with the same block check as `insertVerifiedClaim`. */
export async function markClaimVerified(input: {
  claimId: string;
  serverId: string;
  userId: string;
  now: Date;
}): Promise<McpClaimRow | null> {
  return db.transaction(async (tx) => {
    await lockMember(tx, input.serverId, input.userId);
    await assertNotBlocked(tx, input.serverId, input.userId);
    const [row] = await tx
      .update(marketMcpClaims)
      .set({ status: "verified", verifiedAt: input.now, lastError: null })
      .where(
        and(
          eq(marketMcpClaims.id, input.claimId),
          eq(marketMcpClaims.status, "pending"),
        ),
      )
      .returning();
    return row ?? null;
  });
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
    await lockMember(tx, input.serverId, input.userId);
    await lockListing(tx, input.serverId);
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
      // The blocked member's list is gone, and so is the history of it: it
      // would otherwise stay public beside whatever another owner submits.
      if (cleared.clearTools) {
        await purgeToolRevisions(
          { itemId: input.serverId, source: "owner" },
          { tx },
        );
      }
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

/**
 * Saves a verified owner's corrections: the whole read-merge-write is one
 * transaction under the member's and the listing's locks, with the owner's
 * claim checked inside it — so a block cannot slip between the check and the
 * write and leave the blocked member's values behind under their name.
 * Returns the stored row and who holds a verified claim.
 */
export async function saveOwnerFields(input: {
  serverId: string;
  userId: string;
  next: Record<string, unknown>;
  now: Date;
}): Promise<{ row: McpOwnerOverridesRow; verified: string[] }> {
  return db.transaction(async (tx) => {
    const { verified } = await lockedOwner(tx, input);
    const [previous] = await tx
      .select()
      .from(marketMcpOwnerOverrides)
      .where(eq(marketMcpOwnerOverrides.serverId, input.serverId))
      .for("update");
    const merged = mergeAuthoredFields({
      previousValues: previous?.overridesJson ?? {},
      previousAuthors: previous?.authorsJson ?? {},
      next: input.next,
      userId: input.userId,
      verified: new Set(verified),
    });
    const [row] = await tx
      .insert(marketMcpOwnerOverrides)
      .values({
        serverId: input.serverId,
        updatedBy: input.userId,
        overridesJson: merged.values,
        authorsJson: merged.authors,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: marketMcpOwnerOverrides.serverId,
        set: {
          updatedBy: input.userId,
          overridesJson: merged.values,
          authorsJson: merged.authors,
          updatedAt: input.now,
        },
      })
      .returning();
    return { row: row!, verified };
  });
}

/**
 * Saves (or, with no tools, removes) the owner's tool list, under the same
 * locks and claim check as `saveOwnerFields`. The saver becomes the list's
 * author. The tool-revision history is written in the same transaction: a
 * list is recorded as an `owner` revision (a new one only when it differs from
 * the previous), and removing the list records a withdrawal.
 */
export async function saveOwnerTools(input: {
  serverId: string;
  userId: string;
  tools: unknown[] | null;
  meta: Record<string, unknown> | null;
  /** The server's own version string from the submission, context only. */
  serverVersion?: string | null;
  now: Date;
}): Promise<{ row: McpOwnerOverridesRow; verified: string[] }> {
  return db.transaction(async (tx) => {
    const { verified } = await lockedOwner(tx, input);
    const [previous] = await tx
      .select()
      .from(marketMcpOwnerOverrides)
      .where(eq(marketMcpOwnerOverrides.serverId, input.serverId))
      .for("update");
    const authors: AuthorMap = { ...(previous?.authorsJson ?? {}) };
    if (input.tools) authors[TOOLS_AUTHOR_KEY] = input.userId;
    else delete authors[TOOLS_AUTHOR_KEY];
    const submittedAt = input.tools ? input.now : null;
    const [row] = await tx
      .insert(marketMcpOwnerOverrides)
      .values({
        serverId: input.serverId,
        updatedBy: input.userId,
        overridesJson: {},
        authorsJson: authors,
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
          authorsJson: authors,
          toolsJson: input.tools,
          toolsMetaJson: input.meta,
          toolsSubmittedAt: submittedAt,
          updatedAt: input.now,
        },
      })
      .returning();
    if (input.tools) {
      await recordToolRevision(
        {
          itemId: input.serverId,
          source: "owner",
          tools: input.tools,
          serverVersion: input.serverVersion ?? null,
          observedAt: input.now,
        },
        { tx },
      );
    } else {
      await withdrawToolRevision(
        { itemId: input.serverId, source: "owner", observedAt: input.now },
        { tx },
      );
    }
    return { row: row!, verified };
  });
}

/**
 * Takes the member's and the listing's locks, then confirms — inside them —
 * that the member still holds a verified claim and is not blocked.
 */
async function lockedOwner(
  tx: Tx,
  input: { serverId: string; userId: string },
): Promise<{ verified: string[] }> {
  await lockMember(tx, input.serverId, input.userId);
  await lockListing(tx, input.serverId);
  await assertNotBlocked(tx, input.serverId, input.userId);
  const holders = await tx
    .selectDistinct({ userId: marketMcpClaims.userId })
    .from(marketMcpClaims)
    .where(
      and(
        eq(marketMcpClaims.serverId, input.serverId),
        eq(marketMcpClaims.status, "verified"),
      ),
    );
  const verified = holders.map((holder) => holder.userId);
  if (!verified.includes(input.userId)) throw claimRequiredError();
  return { verified };
}
