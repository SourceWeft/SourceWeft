/**
 * Persistence for connector OAuth handshake state — the short-lived,
 * single-use records that tie an authorization redirect back to the team,
 * workspace and user that started it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
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
