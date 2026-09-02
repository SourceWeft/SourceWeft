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
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(connectorOAuthStates.id, row.id),
          isNull(connectorOAuthStates.consumedAt),
        ),
      )
      .returning();

    return consumed ?? null;
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
