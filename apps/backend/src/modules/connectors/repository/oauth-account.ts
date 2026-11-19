/**
 * Persistence for connector OAuth accounts — the stored authorizations
 * (encrypted tokens, scopes, status) that connectors run against.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { connectorOAuthAccounts, db, sourceConnectors } from "@sourceweft/db";
import { ConnectorError } from "../errors";
import { mapOAuthAccount, mapOAuthAccountWithSecret } from "../mappers";
import type { ConnectorOAuthAccountSecretRecord } from "../types";

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

/**
 * The stored authorization that a fresh authorization for the same provider
 * account should replace, in any status. A provider account may have several
 * rows from before authorizations were refreshed in place, so prefer the one a
 * live connector runs against, then one a disabled connector holds, then the
 * newest.
 */
export async function findReauthorizableOAuthAccountRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorType: string;
  providerAccountId: string;
}) {
  const [row] = await db
    .select({ account: connectorOAuthAccounts })
    .from(connectorOAuthAccounts)
    .leftJoin(
      sourceConnectors,
      and(
        eq(sourceConnectors.oauthAccountId, connectorOAuthAccounts.id),
        eq(sourceConnectors.teamId, connectorOAuthAccounts.teamId),
        eq(sourceConnectors.workspaceId, connectorOAuthAccounts.workspaceId),
      ),
    )
    .where(
      and(
        eq(connectorOAuthAccounts.teamId, input.teamId),
        eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
        eq(connectorOAuthAccounts.connectorType, input.connectorType),
        eq(connectorOAuthAccounts.providerAccountId, input.providerAccountId),
      ),
    )
    .orderBy(
      sql`case when ${sourceConnectors.id} is null then 2 when ${sourceConnectors.status} = 'disabled' then 1 else 0 end`,
      desc(connectorOAuthAccounts.createdAt),
    )
    .limit(1);

  return row ? mapOAuthAccount(row.account) : null;
}

/**
 * Replace a stored authorization's tokens after the provider account
 * authorized again, and make it usable again. An omitted refresh token or
 * email keeps the stored value: providers do not reissue them every time. A
 * reconnect stores fresh tokens, so `lastRefreshAt` is stamped now — otherwise
 * a just-reconnected old account would be swept by the keep-alive pass within
 * the hour.
 */
export async function reauthorizeOAuthAccountRecord(input: {
  teamId: string;
  workspaceId: string;
  accountId: string;
  providerAccountEmail?: string | null;
  displayName: string;
  scopes: string[];
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
  expiresAt: Date | null;
}) {
  const updates: Partial<typeof connectorOAuthAccounts.$inferInsert> = {
    displayName: input.displayName,
    scopes: input.scopes,
    accessTokenEncrypted: input.accessTokenEncrypted,
    expiresAt: input.expiresAt,
    status: "active",
    lastError: null,
    lastRefreshAt: new Date(),
    updatedAt: new Date(),
  };
  if (input.providerAccountEmail) {
    updates.providerAccountEmail = input.providerAccountEmail;
  }
  if (input.refreshTokenEncrypted !== undefined) {
    updates.refreshTokenEncrypted = input.refreshTokenEncrypted;
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

/**
 * Mark an active authorization as needing reauthorization. Only an `active`
 * row is changed, so a concurrent reconnect that already made the account
 * usable again is never reverted by a late failure report. Returns whether a
 * row changed.
 */
export async function markOAuthAccountReauthRequiredRecord(input: {
  teamId: string;
  workspaceId: string;
  accountId: string;
  lastError: string;
}) {
  const rows = await db
    .update(connectorOAuthAccounts)
    .set({
      status: "reauth_required",
      lastError: input.lastError,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connectorOAuthAccounts.id, input.accountId),
        eq(connectorOAuthAccounts.teamId, input.teamId),
        eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
        eq(connectorOAuthAccounts.status, "active"),
      ),
    )
    .returning({ id: connectorOAuthAccounts.id });

  return rows.length > 0;
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

/**
 * Column values for a successful token refresh: the access token always
 * changes, an omitted refresh token or scopes list keeps the stored value
 * (providers do not always reissue them), and the account comes back
 * `active` with its error cleared. Used for the `"token"` write applied under
 * `withOAuthAccountRefreshLock`.
 */
function oauthAccountTokenWriteColumns(input: {
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
}): Partial<typeof connectorOAuthAccounts.$inferInsert> {
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
  return updates;
}

export type OAuthAccountRefreshWrite =
  | { kind: "none" }
  | {
      kind: "token";
      accessTokenEncrypted: string;
      refreshTokenEncrypted?: string | null; // undefined keeps, null clears
      expiresAt: Date | null;
      scopes?: string[];
    }
  | { kind: "status"; status: "reauth_required"; lastError: string };

const LOCK_TIMEOUT_PG_ERROR_CODE = "55P03";

/**
 * drizzle-orm 0.45.2 throws a `DrizzleQueryError` for a failed query and puts
 * the driver (pg) error — which carries the `55P03` lock_timeout code — on its
 * `cause`. A lock-timeout can therefore reach us either as the pg error itself
 * or wrapped, so check the error and its `cause`.
 */
function isLockTimeoutError(error: unknown): boolean {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const pg = candidate as { code?: string } | null | undefined;
    if (pg?.code === LOCK_TIMEOUT_PG_ERROR_CODE) {
      return true;
    }
  }
  return false;
}

/**
 * Lock one OAuth account's row for the duration of `decide`, which calls out
 * to the provider to refresh the token. Providers rotate single-use refresh
 * tokens, so two processes refreshing the same account at once would
 * invalidate each other; holding the row lock serializes them instead.
 * `decide` sees the row as read under the lock (`null` when it no longer
 * exists), and its returned write is applied and committed in the same
 * transaction before `result` is returned. If `decide` throws, the
 * transaction rolls back and nothing is written. A lock wait that exceeds
 * `lockTimeoutMs` is reported as `ConnectorError(503,
 * "CONNECTOR_OAUTH_REFRESH_BUSY")` so a caller can retry later instead of
 * hanging.
 *
 * The row is locked `FOR NO KEY UPDATE`, not `FOR UPDATE`: it still conflicts
 * with itself and with this function's own row updates, so two refreshers
 * serialize, but it does not conflict with the `FOR KEY SHARE` lock that a
 * foreign-key check takes from a row referencing this account. Creating a
 * connector that points at the account therefore does not block for up to
 * `lockTimeoutMs` while a refresh holds the lock.
 */
export async function withOAuthAccountRefreshLock<T>(
  input: {
    teamId: string;
    workspaceId: string;
    accountId: string;
    lockTimeoutMs: number;
  },
  decide: (
    account: ConnectorOAuthAccountSecretRecord | null,
  ) => Promise<{ write: OAuthAccountRefreshWrite; result: T }>,
): Promise<T> {
  if (!Number.isInteger(input.lockTimeoutMs) || input.lockTimeoutMs <= 0) {
    throw new Error(
      "withOAuthAccountRefreshLock: lockTimeoutMs must be a positive finite integer",
    );
  }

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('lock_timeout', ${`${input.lockTimeoutMs}ms`}, true)`,
      );

      const [row] = await tx
        .select()
        .from(connectorOAuthAccounts)
        .where(
          and(
            eq(connectorOAuthAccounts.id, input.accountId),
            eq(connectorOAuthAccounts.teamId, input.teamId),
            eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
          ),
        )
        .for("no key update");

      const { write, result } = await decide(
        row ? mapOAuthAccountWithSecret(row) : null,
      );

      if (write.kind === "token") {
        await tx
          .update(connectorOAuthAccounts)
          .set(oauthAccountTokenWriteColumns(write))
          .where(
            and(
              eq(connectorOAuthAccounts.id, input.accountId),
              eq(connectorOAuthAccounts.teamId, input.teamId),
              eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
            ),
          );
      } else if (write.kind === "status") {
        await tx
          .update(connectorOAuthAccounts)
          .set({
            status: write.status,
            lastError: write.lastError,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(connectorOAuthAccounts.id, input.accountId),
              eq(connectorOAuthAccounts.teamId, input.teamId),
              eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
            ),
          );
      }

      return result;
    });
  } catch (error) {
    if (isLockTimeoutError(error)) {
      throw new ConnectorError(
        503,
        "CONNECTOR_OAUTH_REFRESH_BUSY",
        "Connector token refresh is busy",
      );
    }
    throw error;
  }
}

/**
 * Active accounts with a refresh token AND a non-null expiry whose last refresh
 * (or creation, if never refreshed) is older than `refreshedBefore`, restricted
 * to the given `connectorTypes` — candidates for a background keep-alive
 * refresh, oldest first. Accounts without an expiry are never refreshed (spec
 * B5), and accounts of a connector type not in `connectorTypes` (e.g. a
 * switched-off connector) are excluded so they cannot occupy the oldest-first
 * batch forever. An empty `connectorTypes` matches nothing and returns `[]`
 * without querying.
 */
export async function listOAuthAccountsDueForKeepAlive(input: {
  refreshedBefore: Date;
  limit: number;
  connectorTypes: string[];
}): Promise<
  Array<{
    id: string;
    teamId: string;
    workspaceId: string;
    connectorType: string;
  }>
> {
  if (input.connectorTypes.length === 0) {
    return [];
  }

  const lastActivityAt = sql`coalesce(${connectorOAuthAccounts.lastRefreshAt}, ${connectorOAuthAccounts.createdAt})`;

  return db
    .select({
      id: connectorOAuthAccounts.id,
      teamId: connectorOAuthAccounts.teamId,
      workspaceId: connectorOAuthAccounts.workspaceId,
      connectorType: connectorOAuthAccounts.connectorType,
    })
    .from(connectorOAuthAccounts)
    .where(
      and(
        eq(connectorOAuthAccounts.status, "active"),
        isNotNull(connectorOAuthAccounts.refreshTokenEncrypted),
        isNotNull(connectorOAuthAccounts.expiresAt),
        inArray(connectorOAuthAccounts.connectorType, input.connectorTypes),
        sql`${lastActivityAt} < ${input.refreshedBefore}`,
      ),
    )
    .orderBy(sql`${lastActivityAt} asc`, asc(connectorOAuthAccounts.id))
    .limit(input.limit);
}
