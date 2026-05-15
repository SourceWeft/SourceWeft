import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "../../shared/database";
import {
  connectorActionRuns,
  connectorOAuthAccounts,
  connectorOAuthStates,
  connectorSyncRuns,
  sourceConnectors,
} from "../../shared/db/schema";
import {
  mapActionRun,
  mapOAuthAccount,
  mapOAuthAccountWithSecret,
  mapSourceConnector,
  mapSyncRun,
} from "./mappers";
import type {
  ConnectorActionRiskLevel,
  ConnectorActionRunStatus,
  ConnectorOAuthAccountStatus,
  ConnectorStatus,
  ConnectorSyncRunStatus,
  ConnectorSyncRunTriggerType,
} from "./types";

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
    throw new Error("Failed to create connector OAuth state");
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
    throw new Error("Failed to create connector OAuth account");
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
  ];
  if (input.connectorType) {
    conditions.push(eq(connectorOAuthAccounts.connectorType, input.connectorType));
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

export async function createSourceConnectorRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorType: string;
  name: string;
  configJson?: Record<string, unknown>;
  oauthAccountId?: string | null;
  periodicIndexingEnabled?: boolean;
  indexingFrequencyMinutes?: number | null;
  nextScheduledAt?: Date | null;
  createdBy?: string | null;
}) {
  const [row] = await db
    .insert(sourceConnectors)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorType: input.connectorType,
      name: input.name,
      configJson: input.configJson ?? {},
      oauthAccountId: input.oauthAccountId ?? null,
      status: "active",
      periodicIndexingEnabled: input.periodicIndexingEnabled ?? false,
      indexingFrequencyMinutes: input.indexingFrequencyMinutes ?? null,
      nextScheduledAt: input.nextScheduledAt ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create connector");
  }

  return mapSourceConnector(row);
}

export async function listSourceConnectorRecords(input: {
  teamId: string;
  workspaceId: string;
}) {
  const rows = await db
    .select()
    .from(sourceConnectors)
    .where(
      and(
        eq(sourceConnectors.teamId, input.teamId),
        eq(sourceConnectors.workspaceId, input.workspaceId),
        ne(sourceConnectors.status, "disabled"),
      ),
    )
    .orderBy(desc(sourceConnectors.createdAt));

  return rows.map(mapSourceConnector);
}

export async function findSourceConnectorRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
}) {
  const [row] = await db
    .select()
    .from(sourceConnectors)
    .where(
      and(
        eq(sourceConnectors.id, input.connectorId),
        eq(sourceConnectors.teamId, input.teamId),
        eq(sourceConnectors.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  return row ? mapSourceConnector(row) : null;
}

export async function updateSourceConnectorRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  name?: string;
  configJson?: Record<string, unknown>;
  status?: ConnectorStatus;
  periodicIndexingEnabled?: boolean;
  indexingFrequencyMinutes?: number | null;
  nextScheduledAt?: Date | null;
  lastIndexedAt?: Date | null;
  lastError?: string | null;
}) {
  const updates: Partial<typeof sourceConnectors.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) updates.name = input.name;
  if (input.configJson !== undefined) updates.configJson = input.configJson;
  if (input.status !== undefined) updates.status = input.status;
  if (input.periodicIndexingEnabled !== undefined) {
    updates.periodicIndexingEnabled = input.periodicIndexingEnabled;
  }
  if (input.indexingFrequencyMinutes !== undefined) {
    updates.indexingFrequencyMinutes = input.indexingFrequencyMinutes;
  }
  if (input.nextScheduledAt !== undefined) {
    updates.nextScheduledAt = input.nextScheduledAt;
  }
  if (input.lastIndexedAt !== undefined) {
    updates.lastIndexedAt = input.lastIndexedAt;
  }
  if (input.lastError !== undefined) {
    updates.lastError = input.lastError;
  }

  const [row] = await db
    .update(sourceConnectors)
    .set(updates)
    .where(
      and(
        eq(sourceConnectors.id, input.connectorId),
        eq(sourceConnectors.teamId, input.teamId),
        eq(sourceConnectors.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  return row ? mapSourceConnector(row) : null;
}

export async function listDueScheduledConnectorRecords(input: {
  now: Date;
  limit: number;
}) {
  const rows = await db
    .select()
    .from(sourceConnectors)
    .where(
      and(
        eq(sourceConnectors.status, "active"),
        eq(sourceConnectors.periodicIndexingEnabled, true),
        lte(sourceConnectors.nextScheduledAt, input.now),
      ),
    )
    .orderBy(asc(sourceConnectors.nextScheduledAt))
    .limit(input.limit);

  return rows.map(mapSourceConnector);
}

export async function createSyncRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  triggerType: ConnectorSyncRunTriggerType;
  status: ConnectorSyncRunStatus;
  createdBy?: string | null;
}) {
  const now = new Date();
  const [row] = await db
    .insert(connectorSyncRuns)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      triggerType: input.triggerType,
      status: input.status,
      startedAt: input.status === "running" ? now : null,
      heartbeatAt: input.status === "running" ? now : null,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create connector sync run");
  }

  return mapSyncRun(row);
}

export async function findSyncRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  runId: string;
}) {
  const [row] = await db
    .select()
    .from(connectorSyncRuns)
    .where(
      and(
        eq(connectorSyncRuns.id, input.runId),
        eq(connectorSyncRuns.teamId, input.teamId),
        eq(connectorSyncRuns.workspaceId, input.workspaceId),
        eq(connectorSyncRuns.connectorId, input.connectorId),
      ),
    )
    .limit(1);

  return row ? mapSyncRun(row) : null;
}

export async function listSyncRunRecords(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
}) {
  const rows = await db
    .select()
    .from(connectorSyncRuns)
    .where(
      and(
        eq(connectorSyncRuns.teamId, input.teamId),
        eq(connectorSyncRuns.workspaceId, input.workspaceId),
        eq(connectorSyncRuns.connectorId, input.connectorId),
      ),
    )
    .orderBy(desc(connectorSyncRuns.createdAt))
    .limit(50);

  return rows.map(mapSyncRun);
}

export async function updateSyncRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  runId: string;
  status?: ConnectorSyncRunStatus;
  discoveredCount?: number;
  indexedCount?: number;
  failedCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadataJson?: Record<string, unknown>;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  heartbeatAt?: Date | null;
}) {
  const updates: Partial<typeof connectorSyncRuns.$inferInsert> = {};
  if (input.status !== undefined) updates.status = input.status;
  if (input.discoveredCount !== undefined) {
    updates.discoveredCount = input.discoveredCount;
  }
  if (input.indexedCount !== undefined) updates.indexedCount = input.indexedCount;
  if (input.failedCount !== undefined) updates.failedCount = input.failedCount;
  if (input.errorCode !== undefined) updates.errorCode = input.errorCode;
  if (input.errorMessage !== undefined) updates.errorMessage = input.errorMessage;
  if (input.metadataJson !== undefined) updates.metadataJson = input.metadataJson;
  if (input.startedAt !== undefined) updates.startedAt = input.startedAt;
  if (input.finishedAt !== undefined) updates.finishedAt = input.finishedAt;
  if (input.heartbeatAt !== undefined) updates.heartbeatAt = input.heartbeatAt;

  const [row] = await db
    .update(connectorSyncRuns)
    .set(updates)
    .where(
      and(
        eq(connectorSyncRuns.id, input.runId),
        eq(connectorSyncRuns.teamId, input.teamId),
        eq(connectorSyncRuns.workspaceId, input.workspaceId),
        eq(connectorSyncRuns.connectorId, input.connectorId),
      ),
    )
    .returning();

  return row ? mapSyncRun(row) : null;
}

export async function createActionRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  connectorType: string;
  actionType: string;
  riskLevel: ConnectorActionRiskLevel;
  status: ConnectorActionRunStatus;
  requestJson: Record<string, unknown>;
  requestPreview: string;
  idempotencyKey: string;
}) {
  const [existing] = await db
    .select()
    .from(connectorActionRuns)
    .where(
      and(
        eq(connectorActionRuns.workspaceId, input.workspaceId),
        eq(connectorActionRuns.connectorId, input.connectorId),
        eq(connectorActionRuns.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    return mapActionRun(existing);
  }

  const [row] = await db
    .insert(connectorActionRuns)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      connectorType: input.connectorType,
      actionType: input.actionType,
      riskLevel: input.riskLevel,
      status: input.status,
      requestJson: input.requestJson,
      requestPreview: input.requestPreview,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create connector action run");
  }

  return mapActionRun(row);
}

export async function findActionRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  actionRunId: string;
}) {
  const [row] = await db
    .select()
    .from(connectorActionRuns)
    .where(
      and(
        eq(connectorActionRuns.id, input.actionRunId),
        eq(connectorActionRuns.teamId, input.teamId),
        eq(connectorActionRuns.workspaceId, input.workspaceId),
        eq(connectorActionRuns.connectorId, input.connectorId),
      ),
    )
    .limit(1);

  return row ? mapActionRun(row) : null;
}

export async function listActionRunRecords(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
}) {
  const rows = await db
    .select()
    .from(connectorActionRuns)
    .where(
      and(
        eq(connectorActionRuns.teamId, input.teamId),
        eq(connectorActionRuns.workspaceId, input.workspaceId),
        eq(connectorActionRuns.connectorId, input.connectorId),
      ),
    )
    .orderBy(desc(connectorActionRuns.createdAt))
    .limit(50);

  return rows.map(mapActionRun);
}

export async function updateActionRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  actionRunId: string;
  status?: ConnectorActionRunStatus;
  resultJson?: Record<string, unknown>;
  externalId?: string | null;
  approvedBy?: string | null;
  executedBy?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const updates: Partial<typeof connectorActionRuns.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.status !== undefined) updates.status = input.status;
  if (input.resultJson !== undefined) updates.resultJson = input.resultJson;
  if (input.externalId !== undefined) updates.externalId = input.externalId;
  if (input.approvedBy !== undefined) updates.approvedBy = input.approvedBy;
  if (input.executedBy !== undefined) updates.executedBy = input.executedBy;
  if (input.errorCode !== undefined) updates.errorCode = input.errorCode;
  if (input.errorMessage !== undefined) updates.errorMessage = input.errorMessage;

  const [row] = await db
    .update(connectorActionRuns)
    .set(updates)
    .where(
      and(
        eq(connectorActionRuns.id, input.actionRunId),
        eq(connectorActionRuns.teamId, input.teamId),
        eq(connectorActionRuns.workspaceId, input.workspaceId),
        eq(connectorActionRuns.connectorId, input.connectorId),
      ),
    )
    .returning();

  return row ? mapActionRun(row) : null;
}

export async function touchConnectorScheduleAfterSync(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  lastIndexedAt: Date;
  frequencyMinutes: number | null;
  status: ConnectorStatus;
  lastError?: string | null;
}) {
  const nextScheduledAt = input.frequencyMinutes
    ? new Date(input.lastIndexedAt.getTime() + input.frequencyMinutes * 60_000)
    : null;

  await db
    .update(sourceConnectors)
    .set({
      status: input.status,
      lastIndexedAt: input.lastIndexedAt,
      nextScheduledAt,
      lastError: input.lastError ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sourceConnectors.id, input.connectorId),
        eq(sourceConnectors.teamId, input.teamId),
        eq(sourceConnectors.workspaceId, input.workspaceId),
      ),
    );
}

export async function incrementSyncRunCounts(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  runId: string;
  discoveredDelta?: number;
  indexedDelta?: number;
  failedDelta?: number;
  metadataPatch?: Record<string, unknown>;
}) {
  const [row] = await db
    .update(connectorSyncRuns)
    .set({
      discoveredCount: sql`${connectorSyncRuns.discoveredCount} + ${input.discoveredDelta ?? 0}`,
      indexedCount: sql`${connectorSyncRuns.indexedCount} + ${input.indexedDelta ?? 0}`,
      failedCount: sql`${connectorSyncRuns.failedCount} + ${input.failedDelta ?? 0}`,
      metadataJson: input.metadataPatch
        ? sql`${connectorSyncRuns.metadataJson} || ${input.metadataPatch}::jsonb`
        : connectorSyncRuns.metadataJson,
      heartbeatAt: new Date(),
    })
    .where(
      and(
        eq(connectorSyncRuns.id, input.runId),
        eq(connectorSyncRuns.teamId, input.teamId),
        eq(connectorSyncRuns.workspaceId, input.workspaceId),
        eq(connectorSyncRuns.connectorId, input.connectorId),
      ),
    )
    .returning();

  return row ? mapSyncRun(row) : null;
}
