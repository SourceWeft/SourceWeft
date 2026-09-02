/**
 * Persistence for connector OAuth accounts — the stored authorizations
 * (encrypted tokens, scopes, status) that connectors run against.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { connectorOAuthAccounts, db } from "@sourceweft/db";
import { ConnectorError } from "../errors";
import { mapOAuthAccount, mapOAuthAccountWithSecret } from "../mappers";
import type { ConnectorOAuthAccountStatus } from "../types";

export async function createOAuthAccountRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorType: string;
  providerAccountId?: string | null;
  providerAccountEmail?: string | null;
  displayName: string;
  scopes: string[];
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string | null;
  expiresAt?: Date | null;
  createdBy?: string | null;
}) {
  const [row] = await db
    .insert(connectorOAuthAccounts)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorType: input.connectorType,
      providerAccountId: input.providerAccountId ?? null,
      providerAccountEmail: input.providerAccountEmail ?? null,
      displayName: input.displayName,
      scopes: input.scopes,
      accessTokenEncrypted: input.accessTokenEncrypted,
      refreshTokenEncrypted: input.refreshTokenEncrypted ?? null,
      expiresAt: input.expiresAt ?? null,
      status: "active",
      createdBy: input.createdBy ?? null,
    })
    .returning();

  if (!row) {
    throw new ConnectorError(
      500,
      "CONNECTOR_OAUTH_ACCOUNT_CREATE_FAILED",
      "Failed to create connector OAuth account",
      { teamId: input.teamId, workspaceId: input.workspaceId },
    );
  }

  return mapOAuthAccount(row);
}

export async function listOAuthAccountRecords(input: {
  teamId: string;
  workspaceId: string;
  connectorType?: string;
}) {
  const conditions = [
    eq(connectorOAuthAccounts.teamId, input.teamId),
    eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
    eq(connectorOAuthAccounts.status, "active"),
  ];
  if (input.connectorType) {
    conditions.push(
      eq(connectorOAuthAccounts.connectorType, input.connectorType),
    );
  }

  const rows = await db
    .select()
    .from(connectorOAuthAccounts)
    .where(and(...conditions))
    .orderBy(desc(connectorOAuthAccounts.createdAt));

  return rows.map(mapOAuthAccount);
}

export async function findOAuthAccountRecord(input: {
  teamId: string;
  workspaceId: string;
  accountId: string;
}) {
  const [row] = await db
    .select()
    .from(connectorOAuthAccounts)
    .where(
      and(
        eq(connectorOAuthAccounts.id, input.accountId),
        eq(connectorOAuthAccounts.teamId, input.teamId),
        eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  return row ? mapOAuthAccountWithSecret(row) : null;
}

export async function listOAuthAccountRecordsByProviderAccount(input: {
  connectorType: string;
  providerAccountId: string;
}) {
  const rows = await db
    .select()
    .from(connectorOAuthAccounts)
    .where(
      and(
        eq(connectorOAuthAccounts.connectorType, input.connectorType),
        eq(connectorOAuthAccounts.providerAccountId, input.providerAccountId),
        eq(connectorOAuthAccounts.status, "active"),
      ),
    );

  return rows.map(mapOAuthAccount);
}

export async function deleteOAuthAccountRecord(input: {
  teamId: string;
  workspaceId: string;
  accountId: string;
}) {
  const rows = await db
    .delete(connectorOAuthAccounts)
    .where(
      and(
        eq(connectorOAuthAccounts.id, input.accountId),
        eq(connectorOAuthAccounts.teamId, input.teamId),
        eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: connectorOAuthAccounts.id });

  return rows.length > 0;
}

export async function updateOAuthAccountTokenRecord(input: {
  teamId: string;
  workspaceId: string;
  accountId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
}) {
  const updates: Partial<typeof connectorOAuthAccounts.$inferInsert> = {
    accessTokenEncrypted: input.accessTokenEncrypted,
    expiresAt: input.expiresAt ?? null,
    status: "active",
    lastRefreshAt: new Date(),
    lastError: null,
    updatedAt: new Date(),
  };
  if (input.refreshTokenEncrypted !== undefined) {
    updates.refreshTokenEncrypted = input.refreshTokenEncrypted;
  }
  if (input.scopes !== undefined) {
    updates.scopes = input.scopes;
  }

  const [row] = await db
    .update(connectorOAuthAccounts)
    .set(updates)
    .where(
      and(
        eq(connectorOAuthAccounts.id, input.accountId),
        eq(connectorOAuthAccounts.teamId, input.teamId),
        eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  return row ? mapOAuthAccount(row) : null;
}

export async function updateOAuthAccountStatusRecord(input: {
  teamId: string;
  workspaceId: string;
  accountId: string;
  status: ConnectorOAuthAccountStatus;
  lastError?: string | null;
}) {
  const [row] = await db
    .update(connectorOAuthAccounts)
    .set({
      status: input.status,
      lastError: input.lastError ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connectorOAuthAccounts.id, input.accountId),
        eq(connectorOAuthAccounts.teamId, input.teamId),
        eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  return row ? mapOAuthAccount(row) : null;
}
