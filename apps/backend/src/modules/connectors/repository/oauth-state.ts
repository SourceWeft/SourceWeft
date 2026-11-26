/**
 * Persistence for connector OAuth handshake state — the short-lived,
 * single-use records that tie an authorization redirect back to the team,
 * workspace and user that started it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { connectorOAuthStates, db } from "@sourceweft/db";
import { ConnectorError } from "../errors";

export async function createOAuthStateRecord(input: {
  stateHash: string;
  teamId: string;
  workspaceId: string;
  userId: string;
  connectorType: string;
  redirectAfter?: string | null;
  expiresAt: Date;
  attemptRef?: string | null;
}) {
  const [row] = await db
    .insert(connectorOAuthStates)
    .values({
      id: randomUUID(),
      stateHash: input.stateHash,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      connectorType: input.connectorType,
      redirectAfter: input.redirectAfter ?? null,
      expiresAt: input.expiresAt,
      attemptRef: input.attemptRef ?? null,
    })
    .returning();

  if (!row) {
    throw new ConnectorError(
      500,
      "CONNECTOR_OAUTH_STATE_CREATE_FAILED",
      "Failed to create connector OAuth state",
      { teamId: input.teamId },
    );
  }

  return row;
}

export async function consumeOAuthStateRecord(input: {
  stateHash: string;
  connectorType: string;
  now: Date;
}) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(connectorOAuthStates)
      .where(
        and(
          eq(connectorOAuthStates.stateHash, input.stateHash),
          eq(connectorOAuthStates.connectorType, input.connectorType),
          isNull(connectorOAuthStates.consumedAt),
        ),
      )
      .limit(1);

    if (!row || row.expiresAt.getTime() <= input.now.getTime()) {
      return null;
    }

    const [consumed] = await tx
      .update(connectorOAuthStates)
      // Clear the attempt reference in the same single-use UPDATE: once the
      // handshake is consumed the broker's connected-account id has no further
      // use here, and leaving it in plain text would outlive the encrypted
      // credential it points at. The `isNull(consumedAt)` guard still makes
      // this atomic and single-use.
      .set({ consumedAt: input.now, attemptRef: null })
      .where(
        and(
          eq(connectorOAuthStates.id, row.id),
          isNull(connectorOAuthStates.consumedAt),
        ),
      )
      .returning();

    if (!consumed) {
      return null;
    }

    // The caller still receives the attempt reference read before the update,
    // so the adapter can finish the authorization; only the stored row is
    // cleared.
    return { ...consumed, attemptRef: row.attemptRef };
  });
}

export async function findOAuthStateRecord(input: {
  stateHash: string;
  connectorType: string;
  now: Date;
}) {
  const [row] = await db
    .select()
    .from(connectorOAuthStates)
    .where(
      and(
        eq(connectorOAuthStates.stateHash, input.stateHash),
        eq(connectorOAuthStates.connectorType, input.connectorType),
        isNull(connectorOAuthStates.consumedAt),
      ),
    )
    .limit(1);

  if (!row || row.expiresAt.getTime() <= input.now.getTime()) {
    return null;
  }

  return row;
}

// ---------------------------------------------------------------------------
// Credential login-flow records
//
// A credential connector's `flow: "login_flow"` pending state reuses this same
// `connector_oauth_states` table (no migration): one row per in-progress login,
// `attemptRef` holding the encrypted pending blob, keyed by the SHA-256 hash of
// the opaque flow id. The helpers below are the credential-flow service's own
// lifecycle operations — a per-user/type live count for the attempt cap, an
// atomic single-consume claim, an owner-scoped cancel, and an opportunistic
// cleanup of expired rows. Creation and the non-consuming read reuse
// `createOAuthStateRecord` / `findOAuthStateRecord` above.
// ---------------------------------------------------------------------------

/**
 * How many live (unconsumed, unexpired) login-flow rows a user already has for
 * one connector type, for the per-user attempt cap.
 */
export async function countLiveCredentialFlowRecords(input: {
  userId: string;
  workspaceId: string;
  connectorType: string;
  now: Date;
}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(connectorOAuthStates)
    .where(
      and(
        eq(connectorOAuthStates.userId, input.userId),
        eq(connectorOAuthStates.workspaceId, input.workspaceId),
        eq(connectorOAuthStates.connectorType, input.connectorType),
        isNull(connectorOAuthStates.consumedAt),
        gt(connectorOAuthStates.expiresAt, input.now),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Atomically claim a login-flow row: mark it consumed and clear its attempt
 * reference in a single `consumedAt IS NULL` UPDATE, so two concurrent
 * completions — in this process or another — have exactly one of them win and
 * create exactly one connector. Returns whether this caller won the claim. The
 * caller has already read and decrypted `attemptRef` before claiming, so
 * clearing it here (rather than leaving ciphertext that outlives the flow) loses
 * nothing.
 */
export async function claimCredentialFlowRecord(input: {
  stateHash: string;
  connectorType: string;
  now: Date;
}): Promise<boolean> {
  const rows = await db
    .update(connectorOAuthStates)
    .set({ consumedAt: input.now, attemptRef: null })
    .where(
      and(
        eq(connectorOAuthStates.stateHash, input.stateHash),
        eq(connectorOAuthStates.connectorType, input.connectorType),
        isNull(connectorOAuthStates.consumedAt),
        gt(connectorOAuthStates.expiresAt, input.now),
      ),
    )
    .returning({ id: connectorOAuthStates.id });
  return rows.length > 0;
}

/**
 * Cancel a login flow: delete the owner's own unconsumed row. Scoped by user
 * and workspace so another member cannot delete a flow, and limited to
 * unconsumed rows so a cancel never races a completion. Returns whether a row
 * was removed (the caller returns the same answer regardless, to avoid an
 * existence oracle).
 */
export async function deleteCredentialFlowRecord(input: {
  stateHash: string;
  connectorType: string;
  userId: string;
  workspaceId: string;
}): Promise<boolean> {
  const rows = await db
    .delete(connectorOAuthStates)
    .where(
      and(
        eq(connectorOAuthStates.stateHash, input.stateHash),
        eq(connectorOAuthStates.connectorType, input.connectorType),
        eq(connectorOAuthStates.userId, input.userId),
        eq(connectorOAuthStates.workspaceId, input.workspaceId),
        isNull(connectorOAuthStates.consumedAt),
      ),
    )
    .returning({ id: connectorOAuthStates.id });
  return rows.length > 0;
}

/**
 * Opportunistic cleanup of a connector type's expired login-flow rows (consumed
 * or not), run at the start of a new flow so stale rows do not accumulate
 * without a dedicated sweep. Returns how many rows were removed.
 */
export async function deleteExpiredCredentialFlowRecords(input: {
  connectorType: string;
  now: Date;
}): Promise<number> {
  const rows = await db
    .delete(connectorOAuthStates)
    .where(
      and(
        eq(connectorOAuthStates.connectorType, input.connectorType),
        lte(connectorOAuthStates.expiresAt, input.now),
      ),
    )
    .returning({ id: connectorOAuthStates.id });
  return rows.length;
}
