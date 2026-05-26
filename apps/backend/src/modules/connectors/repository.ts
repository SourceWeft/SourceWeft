import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import { logger } from "../../shared/logger";
import { db } from "../../shared/database";
import {
  agentToolTrustRules,
  citations,
  chunks,
  documents,
  connectorActionRuns,
  connectorOAuthAccounts,
  connectorOAuthStates,
  connectorSyncRuns,
  connectorWebhookEvents,
  sourceConnectors,
  sources,
} from "../../shared/db/schema";
import {
  mapAgentToolTrustRule,
  mapActionRun,
  mapOAuthAccount,
  mapOAuthAccountWithSecret,
  mapSourceConnector,
  mapSyncRun,
  mapWebhookEvent,
} from "./mappers";
import { redactConnectorSecrets } from "./security";
import type {
  ConnectorActionRiskLevel,
  ConnectorActionRunStatus,
  AgentToolTrustRuleStatus,
  ConnectorActivityItemRecord,
  ConnectorOAuthAccountStatus,
  ConnectorStatus,
  ConnectorSyncRunStatus,
  ConnectorSyncRunTriggerType,
  ConnectorWebhookEventStatus,
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
  includeDisabled?: boolean;
}) {
  const conditions = [
    eq(sourceConnectors.teamId, input.teamId),
    eq(sourceConnectors.workspaceId, input.workspaceId),
  ];
  if (!input.includeDisabled) {
    conditions.push(ne(sourceConnectors.status, "disabled"));
  }

  const rows = await db
    .select()
    .from(sourceConnectors)
    .where(and(...conditions))
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

export async function findSourceConnectorRecordByName(input: {
  teamId: string;
  workspaceId: string;
  connectorType: string;
  name: string;
}) {
  const [row] = await db
    .select()
    .from(sourceConnectors)
    .where(
      and(
        eq(sourceConnectors.teamId, input.teamId),
        eq(sourceConnectors.workspaceId, input.workspaceId),
        eq(sourceConnectors.connectorType, input.connectorType),
        eq(sourceConnectors.name, input.name),
      ),
    )
    .limit(1);

  return row ? mapSourceConnector(row) : null;
}

export async function findSourceConnectorRecordById(input: {
  connectorId: string;
}) {
  const [row] = await db
    .select()
    .from(sourceConnectors)
    .where(eq(sourceConnectors.id, input.connectorId))
    .limit(1);

  return row ? mapSourceConnector(row) : null;
}

export async function listSourceConnectorRecordsByOAuthAccount(input: {
  connectorType: string;
  oauthAccountId: string;
}) {
  const rows = await db
    .select()
    .from(sourceConnectors)
    .where(
      and(
        eq(sourceConnectors.connectorType, input.connectorType),
        eq(sourceConnectors.oauthAccountId, input.oauthAccountId),
        ne(sourceConnectors.status, "disabled"),
      ),
    )
    .orderBy(desc(sourceConnectors.createdAt));

  return rows.map(mapSourceConnector);
}

export async function listWorkspaceSourceConnectorRecordsByOAuthAccount(input: {
  teamId: string;
  workspaceId: string;
  oauthAccountId: string;
}) {
  const rows = await db
    .select()
    .from(sourceConnectors)
    .where(
      and(
        eq(sourceConnectors.teamId, input.teamId),
        eq(sourceConnectors.workspaceId, input.workspaceId),
        eq(sourceConnectors.oauthAccountId, input.oauthAccountId),
      ),
    )
    .orderBy(desc(sourceConnectors.createdAt));

  return rows.map(mapSourceConnector);
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

function preserveConnectorSourceCitationsSql(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
}) {
  return sql`
    update ${citations} as citation
    set
      external_uri = coalesce(
        citation.external_uri,
        'sourceweft://deleted-connector/' || ${input.connectorId} || '/citation/' || citation.id
      ),
      metadata_json = citation.metadata_json || jsonb_strip_nulls(jsonb_build_object(
        'sourceTitle', coalesce(
          citation.metadata_json->>'sourceTitle',
          (
            select ${sources.title}
            from ${sources}
            where ${sources.id} = citation.source_id
              and ${sources.teamId} = ${input.teamId}
              and ${sources.workspaceId} = ${input.workspaceId}
            limit 1
          ),
          (
            select source_for_chunk.title
            from ${chunks} as chunk_for_citation
            inner join ${sources} as source_for_chunk
              on source_for_chunk.id = chunk_for_citation.source_id
            where chunk_for_citation.id = citation.chunk_id
              and chunk_for_citation.team_id = ${input.teamId}
              and chunk_for_citation.workspace_id = ${input.workspaceId}
            limit 1
          )
        ),
        'chunkNo', (
          select ${chunks.chunkNo}
          from ${chunks}
          where ${chunks.id} = citation.chunk_id
          limit 1
        ),
        'excerpt', coalesce(
          citation.metadata_json->>'excerpt',
          citation.quote_text,
          left((
            select ${chunks.content}
            from ${chunks}
            where ${chunks.id} = citation.chunk_id
            limit 1
          ), 320)
        )
      ))
    where citation.team_id = ${input.teamId}
      and citation.workspace_id = ${input.workspaceId}
      and (
        citation.source_id in (
          select ${sources.id}
          from ${sources}
          where ${sources.teamId} = ${input.teamId}
            and ${sources.workspaceId} = ${input.workspaceId}
            and ${sources.connectorId} = ${input.connectorId}
            and ${sources.ingestKind} = 'connector'
        )
        or citation.chunk_id in (
          select ${chunks.id}
          from ${chunks}
          inner join ${sources}
            on ${sources.id} = ${chunks.sourceId}
          where ${chunks.teamId} = ${input.teamId}
            and ${chunks.workspaceId} = ${input.workspaceId}
            and ${sources.teamId} = ${input.teamId}
            and ${sources.workspaceId} = ${input.workspaceId}
            and ${sources.connectorId} = ${input.connectorId}
            and ${sources.ingestKind} = 'connector'
        )
      )
  `;
}

export async function hardDeleteSourceConnectorRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  oauthAccountId?: string | null;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(preserveConnectorSourceCitationsSql(input));

    const [documentCountRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .innerJoin(sources, eq(documents.sourceId, sources.id))
      .where(
        and(
          eq(documents.teamId, input.teamId),
          eq(documents.workspaceId, input.workspaceId),
          eq(sources.teamId, input.teamId),
          eq(sources.workspaceId, input.workspaceId),
          eq(sources.connectorId, input.connectorId),
          eq(sources.ingestKind, "connector"),
        ),
      );

    const deletedSources = await tx
      .delete(sources)
      .where(
        and(
          eq(sources.teamId, input.teamId),
          eq(sources.workspaceId, input.workspaceId),
          eq(sources.connectorId, input.connectorId),
          eq(sources.ingestKind, "connector"),
        ),
      )
      .returning({ id: sources.id });

    const deletedConnectorRows = await tx
      .delete(sourceConnectors)
      .where(
        and(
          eq(sourceConnectors.id, input.connectorId),
          eq(sourceConnectors.teamId, input.teamId),
          eq(sourceConnectors.workspaceId, input.workspaceId),
        ),
      )
      .returning({
        id: sourceConnectors.id,
        oauthAccountId: sourceConnectors.oauthAccountId,
      });

    const deletedConnector = deletedConnectorRows[0] ?? null;
    let authorizationDeleted = false;
    const accountId =
      input.oauthAccountId ?? deletedConnector?.oauthAccountId ?? null;
    if (accountId) {
      const deletedAccountRows = await tx
        .delete(connectorOAuthAccounts)
        .where(
          and(
            eq(connectorOAuthAccounts.id, accountId),
            eq(connectorOAuthAccounts.teamId, input.teamId),
            eq(connectorOAuthAccounts.workspaceId, input.workspaceId),
          ),
        )
        .returning({ id: connectorOAuthAccounts.id });
      authorizationDeleted = deletedAccountRows.length > 0;
    }

    return {
      connectorDeleted: Boolean(deletedConnector),
      sourcesDeleted: deletedSources.length,
      documentsDeleted: documentCountRow?.count ?? 0,
      authorizationDeleted,
    };
  });
}

export async function hasSourceConnectorOAuthAccountReferences(input: {
  teamId: string;
  workspaceId: string;
  accountId: string;
}) {
  const [row] = await db
    .select({ id: sourceConnectors.id })
    .from(sourceConnectors)
    .where(
      and(
        eq(sourceConnectors.teamId, input.teamId),
        eq(sourceConnectors.workspaceId, input.workspaceId),
        eq(sourceConnectors.oauthAccountId, input.accountId),
      ),
    )
    .limit(1);

  return Boolean(row);
}

export async function hasOtherSourceConnectorOAuthAccountReferences(input: {
  teamId: string;
  workspaceId: string;
  accountId: string;
  connectorId: string;
}) {
  const [row] = await db
    .select({ id: sourceConnectors.id })
    .from(sourceConnectors)
    .where(
      and(
        eq(sourceConnectors.teamId, input.teamId),
        eq(sourceConnectors.workspaceId, input.workspaceId),
        eq(sourceConnectors.oauthAccountId, input.accountId),
        ne(sourceConnectors.id, input.connectorId),
      ),
    )
    .limit(1);

  return Boolean(row);
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
  metadataJson?: Record<string, unknown>;
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
      metadataJson: input.metadataJson ?? {},
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create connector sync run");
  }

  return mapSyncRun(row);
}

export async function createSyncRunRecordIfNoActiveRun(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  triggerType: ConnectorSyncRunTriggerType;
  status: ConnectorSyncRunStatus;
  createdBy?: string | null;
  metadataJson?: Record<string, unknown>;
}) {
  return db.transaction(async (tx) => {
    const [connector] = await tx
      .select({ id: sourceConnectors.id })
      .from(sourceConnectors)
      .where(
        and(
          eq(sourceConnectors.id, input.connectorId),
          eq(sourceConnectors.teamId, input.teamId),
          eq(sourceConnectors.workspaceId, input.workspaceId),
        ),
      )
      .limit(1)
      .for("update");

    if (!connector) {
      return { run: null, existing: false };
    }

    const [activeRun] = await tx
      .select()
      .from(connectorSyncRuns)
      .where(
        and(
          eq(connectorSyncRuns.teamId, input.teamId),
          eq(connectorSyncRuns.workspaceId, input.workspaceId),
          eq(connectorSyncRuns.connectorId, input.connectorId),
          inArray(connectorSyncRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(connectorSyncRuns.createdAt))
      .limit(1);

    if (activeRun) {
      return { run: mapSyncRun(activeRun), existing: true };
    }

    const now = new Date();
    const [created] = await tx
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
        metadataJson: input.metadataJson ?? {},
      })
      .returning();

    if (!created) {
      throw new Error("Failed to create connector sync run");
    }

    return { run: mapSyncRun(created), existing: false };
  });
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

export async function insertWebhookEventRecord(input: {
  teamId?: string | null;
  workspaceId?: string | null;
  connectorId?: string | null;
  connectorType: string;
  providerEventId: string;
  eventType: string;
  status: ConnectorWebhookEventStatus;
  objectId?: string | null;
  objectType?: string | null;
  payloadMetadataJson?: Record<string, unknown>;
}) {
  const existing = await findWebhookEventByProviderEventId({
    connectorType: input.connectorType,
    providerEventId: input.providerEventId,
  });
  if (existing) {
    return existing;
  }

  const [row] = await db
    .insert(connectorWebhookEvents)
    .values({
      id: randomUUID(),
      teamId: input.teamId ?? null,
      workspaceId: input.workspaceId ?? null,
      connectorId: input.connectorId ?? null,
      connectorType: input.connectorType,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      status: input.status,
      objectId: input.objectId ?? null,
      objectType: input.objectType ?? null,
      payloadMetadataJson: input.payloadMetadataJson ?? {},
    })
    .returning();

  if (!row) {
    throw new Error("Failed to insert connector webhook event");
  }

  return mapWebhookEvent(row);
}

export async function findWebhookEventByProviderEventId(input: {
  connectorType: string;
  providerEventId: string;
}) {
  const [row] = await db
    .select()
    .from(connectorWebhookEvents)
    .where(
      and(
        eq(connectorWebhookEvents.connectorType, input.connectorType),
        eq(connectorWebhookEvents.providerEventId, input.providerEventId),
      ),
    )
    .limit(1);

  return row ? mapWebhookEvent(row) : null;
}

export async function listWebhookEventRecords(input: {
  teamId: string;
  workspaceId: string;
  connectorType?: string;
  connectorId?: string;
}) {
  const conditions = [
    eq(connectorWebhookEvents.teamId, input.teamId),
    eq(connectorWebhookEvents.workspaceId, input.workspaceId),
  ];
  if (input.connectorType) {
    conditions.push(
      eq(connectorWebhookEvents.connectorType, input.connectorType),
    );
  }
  if (input.connectorId) {
    conditions.push(eq(connectorWebhookEvents.connectorId, input.connectorId));
  }

  const rows = await db
    .select()
    .from(connectorWebhookEvents)
    .where(and(...conditions))
    .orderBy(desc(connectorWebhookEvents.createdAt))
    .limit(50);

  return rows.map(mapWebhookEvent);
}

export async function updateWebhookEventRecord(input: {
  webhookEventId: string;
  status?: ConnectorWebhookEventStatus;
  attemptsDelta?: number;
  teamId?: string | null;
  workspaceId?: string | null;
  connectorId?: string | null;
  syncRunId?: string | null;
  payloadMetadataJson?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  processedAt?: Date | null;
}) {
  const updates: Partial<typeof connectorWebhookEvents.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.status !== undefined) updates.status = input.status;
  if (input.teamId !== undefined) updates.teamId = input.teamId;
  if (input.workspaceId !== undefined) updates.workspaceId = input.workspaceId;
  if (input.connectorId !== undefined) updates.connectorId = input.connectorId;
  if (input.syncRunId !== undefined) updates.syncRunId = input.syncRunId;
  if (input.payloadMetadataJson !== undefined) {
    updates.payloadMetadataJson = input.payloadMetadataJson;
  }
  if (input.errorCode !== undefined) updates.errorCode = input.errorCode;
  if (input.errorMessage !== undefined)
    updates.errorMessage = input.errorMessage;
  if (input.processedAt !== undefined) updates.processedAt = input.processedAt;

  const setValues: Record<string, unknown> = { ...updates };
  if (input.attemptsDelta !== undefined) {
    setValues.attempts = sql`${connectorWebhookEvents.attempts} + ${input.attemptsDelta}`;
  }

  const [row] = await db
    .update(connectorWebhookEvents)
    .set(setValues)
    .where(eq(connectorWebhookEvents.id, input.webhookEventId))
    .returning();

  return row ? mapWebhookEvent(row) : null;
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

export async function listWorkspaceSyncRunRecords(input: {
  teamId: string;
  workspaceId: string;
  status?: "active";
}) {
  const conditions = [
    eq(connectorSyncRuns.teamId, input.teamId),
    eq(connectorSyncRuns.workspaceId, input.workspaceId),
  ];
  if (input.status === "active") {
    conditions.push(inArray(connectorSyncRuns.status, ["queued", "running"]));
  }

  const rows = await db
    .select()
    .from(connectorSyncRuns)
    .where(and(...conditions))
    .orderBy(desc(connectorSyncRuns.createdAt))
    .limit(100);

  return rows.map(mapSyncRun);
}

function parseActivityCursor(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.kind === "string" &&
      typeof parsed.id === "string"
    ) {
      const createdAt = new Date(parsed.createdAt);
      if (!Number.isNaN(createdAt.getTime())) {
        return {
          createdAt: parsed.createdAt,
          createdAtMs: createdAt.getTime(),
          kind: parsed.kind,
          id: parsed.id,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function makeActivityCursor(item: ConnectorActivityItemRecord) {
  return Buffer.from(
    JSON.stringify({
      createdAt: item.createdAt,
      kind: item.kind,
      id: item.id,
    }),
    "utf8",
  ).toString("base64url");
}

function dateMs(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function durationMs(startedAt: string | null, finishedAt: string | null) {
  const start = dateMs(startedAt);
  const finish = dateMs(finishedAt);
  if (start === null || finish === null || finish < start) {
    return null;
  }
  return finish - start;
}

function redactedJson(value: Record<string, unknown>) {
  return redactConnectorSecrets(value) as Record<string, unknown>;
}

function isActivityBeforeCursor(
  item: ConnectorActivityItemRecord,
  cursor: ReturnType<typeof parseActivityCursor>,
) {
  if (!cursor) return true;
  const itemMs = dateMs(item.createdAt);
  if (itemMs === null) return false;
  if (itemMs < cursor.createdAtMs) return true;
  if (itemMs > cursor.createdAtMs) return false;
  const itemKey = `${item.kind}:${item.id}`;
  const cursorKey = `${cursor.kind}:${cursor.id}`;
  return itemKey < cursorKey;
}

function toSyncActivityItem(
  run: ReturnType<typeof mapSyncRun>,
): ConnectorActivityItemRecord {
  const summaryJson = {
    triggerType: run.triggerType,
    eventType: run.metadataJson.eventType ?? null,
    discoveredCount: run.discoveredCount,
    indexedCount: run.indexedCount,
    failedCount: run.failedCount,
    heartbeatAt: run.heartbeatAt,
    createdBy: run.createdBy,
    targetExternalIds: run.metadataJson.targetExternalIds ?? null,
    targetExternalIdCount: Array.isArray(run.metadataJson.targetExternalIds)
      ? run.metadataJson.targetExternalIds.length
      : null,
    targeted: run.metadataJson.targeted ?? null,
    fullResync: run.metadataJson.fullResync ?? null,
    reason: run.metadataJson.reason ?? run.metadataJson.readinessReason ?? null,
    providerEventId: run.metadataJson.providerEventId ?? null,
  };
  return {
    id: run.id,
    kind: "sync",
    status: run.status,
    title: `${run.triggerType} sync ${run.status}`,
    summaryJson: redactedJson(summaryJson),
    resultJson: redactedJson(run.metadataJson),
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: durationMs(run.startedAt, run.finishedAt),
    linkedRunId: run.id,
    linkedActionId:
      typeof run.metadataJson.actionRunId === "string"
        ? run.metadataJson.actionRunId
        : null,
    linkedWebhookEventId:
      typeof run.metadataJson.webhookEventId === "string"
        ? run.metadataJson.webhookEventId
        : typeof run.metadataJson.eventId === "string"
          ? run.metadataJson.eventId
          : null,
  };
}

function toActionActivityItem(
  action: ReturnType<typeof mapActionRun>,
): ConnectorActivityItemRecord {
  const postActionSyncRunId =
    typeof action.resultJson.postActionSyncRunId === "string"
      ? action.resultJson.postActionSyncRunId
      : null;
  return {
    id: action.id,
    kind: "action",
    status: action.status,
    title: `${action.actionType} ${action.status}`,
    summaryJson: redactedJson({
      actionType: action.actionType,
      riskLevel: action.riskLevel,
      requestPreview: action.requestPreview,
      externalId: action.externalId,
      approvedBy: action.approvedBy,
      executedBy: action.executedBy,
    }),
    resultJson: redactedJson(action.resultJson),
    errorCode: action.errorCode,
    errorMessage: action.errorMessage,
    createdAt: action.createdAt,
    startedAt: action.status === "running" ? action.updatedAt : null,
    finishedAt: ["succeeded", "failed", "canceled", "rejected"].includes(
      action.status,
    )
      ? action.updatedAt
      : null,
    durationMs: null,
    linkedRunId: postActionSyncRunId,
    linkedActionId: action.id,
    linkedWebhookEventId: null,
  };
}

function toWebhookActivityItem(
  event: ReturnType<typeof mapWebhookEvent>,
): ConnectorActivityItemRecord {
  return {
    id: event.id,
    kind: "webhook",
    status: event.status,
    title: `${event.eventType} ${event.status}`,
    summaryJson: redactedJson({
      eventType: event.eventType,
      objectType: event.objectType,
      objectId: event.objectId,
      attempts: event.attempts,
      providerEventId: event.providerEventId,
      syncRunId: event.syncRunId,
    }),
    resultJson: redactedJson(event.payloadMetadataJson),
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    createdAt: event.receivedAt,
    startedAt: event.receivedAt,
    finishedAt: event.processedAt,
    durationMs: durationMs(event.receivedAt, event.processedAt),
    linkedRunId: event.syncRunId,
    linkedActionId: null,
    linkedWebhookEventId: event.id,
  };
}

function connectorActivityQueryFailureItem(input: {
  kind: "sync" | "action" | "webhook";
  error: unknown;
}): ConnectorActivityItemRecord {
  const rawMessage = input.error instanceof Error ? input.error.message : "";
  const missingTable =
    /relation .*connector_webhook_events.* does not exist/i.test(rawMessage) ||
    /connector_webhook_events/i.test(rawMessage);
  const message =
    input.kind === "webhook" && missingTable
      ? "Webhook activity storage is not ready. Run backend migrations through 0025_connector_webhook_events."
      : `Failed to load ${input.kind} activity records. Check backend logs for details.`;
  const errorCode =
    input.kind === "webhook" && missingTable
      ? "CONNECTOR_WEBHOOK_MIGRATION_REQUIRED"
      : "CONNECTOR_ACTIVITY_QUERY_FAILED";
  const now = new Date().toISOString();
  return {
    id: `${input.kind}:activity-query-failed`,
    kind: input.kind,
    status: "failed",
    title: `${input.kind} activity unavailable`,
    summaryJson: {
      source: input.kind,
      reason:
        input.kind === "webhook" && missingTable
          ? "migration_required"
          : "query_failed",
    },
    resultJson: {},
    errorCode,
    errorMessage: message,
    createdAt: now,
    startedAt: null,
    finishedAt: now,
    durationMs: null,
    linkedRunId: null,
    linkedActionId: null,
    linkedWebhookEventId: null,
  };
}

export async function listConnectorActivityRecords(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  kind?: "all" | "sync" | "action" | "webhook";
  limit: number;
  cursor?: string | null;
}) {
  const effectiveKind = input.kind ?? "all";
  const fetchLimit = Math.min(Math.max(input.limit, 1), 100) + 1;
  const items: ConnectorActivityItemRecord[] = [];

  if (effectiveKind === "all" || effectiveKind === "sync") {
    try {
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
        .limit(fetchLimit);
      items.push(...rows.map((row) => toSyncActivityItem(mapSyncRun(row))));
    } catch (error) {
      logger.warn("Failed to list connector sync activity", {
        error,
        connectorId: input.connectorId,
        workspaceId: input.workspaceId,
      });
      items.push(connectorActivityQueryFailureItem({ kind: "sync", error }));
    }
  }

  if (effectiveKind === "all" || effectiveKind === "action") {
    try {
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
        .limit(fetchLimit);
      items.push(...rows.map((row) => toActionActivityItem(mapActionRun(row))));
    } catch (error) {
      logger.warn("Failed to list connector action activity", {
        error,
        connectorId: input.connectorId,
        workspaceId: input.workspaceId,
      });
      items.push(connectorActivityQueryFailureItem({ kind: "action", error }));
    }
  }

  if (effectiveKind === "all" || effectiveKind === "webhook") {
    try {
      const rows = await db
        .select()
        .from(connectorWebhookEvents)
        .where(
          and(
            eq(connectorWebhookEvents.teamId, input.teamId),
            eq(connectorWebhookEvents.workspaceId, input.workspaceId),
            eq(connectorWebhookEvents.connectorId, input.connectorId),
          ),
        )
        .orderBy(desc(connectorWebhookEvents.receivedAt))
        .limit(fetchLimit);
      items.push(
        ...rows.map((row) => toWebhookActivityItem(mapWebhookEvent(row))),
      );
    } catch (error) {
      logger.warn("Failed to list connector webhook activity", {
        error,
        connectorId: input.connectorId,
        workspaceId: input.workspaceId,
      });
      items.push(connectorActivityQueryFailureItem({ kind: "webhook", error }));
    }
  }

  const cursor = parseActivityCursor(input.cursor);
  const filtered = items
    .filter((item) => isActivityBeforeCursor(item, cursor))
    .sort((a, b) => {
      const timeDelta = (dateMs(b.createdAt) ?? 0) - (dateMs(a.createdAt) ?? 0);
      if (timeDelta !== 0) return timeDelta;
      return `${b.kind}:${b.id}`.localeCompare(`${a.kind}:${a.id}`);
    });
  const page = filtered.slice(0, input.limit);
  const hasMore = filtered.length > input.limit;
  return {
    items: page,
    nextCursor:
      hasMore && page.length
        ? makeActivityCursor(page[page.length - 1]!)
        : null,
  };
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
  if (input.indexedCount !== undefined)
    updates.indexedCount = input.indexedCount;
  if (input.failedCount !== undefined) updates.failedCount = input.failedCount;
  if (input.errorCode !== undefined) updates.errorCode = input.errorCode;
  if (input.errorMessage !== undefined)
    updates.errorMessage = input.errorMessage;
  if (input.metadataJson !== undefined)
    updates.metadataJson = input.metadataJson;
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
  agentToolName?: string | null;
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
      agentToolName: input.agentToolName ?? null,
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

export async function findActionRunRecordById(input: {
  teamId: string;
  workspaceId: string;
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
      ),
    )
    .limit(1);

  return row ? mapActionRun(row) : null;
}

export async function findActionRunRecord(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  actionRunId?: string;
  idempotencyKey?: string;
}) {
  const identityCondition = input.actionRunId
    ? eq(connectorActionRuns.id, input.actionRunId)
    : input.idempotencyKey
      ? eq(connectorActionRuns.idempotencyKey, input.idempotencyKey)
      : null;
  if (!identityCondition) {
    return null;
  }

  const [row] = await db
    .select()
    .from(connectorActionRuns)
    .where(
      and(
        identityCondition,
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
  requestJson?: Record<string, unknown>;
  requestPreview?: string;
  agentToolName?: string | null;
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
  if (input.errorMessage !== undefined)
    updates.errorMessage = input.errorMessage;
  if (input.requestJson !== undefined) updates.requestJson = input.requestJson;
  if (input.requestPreview !== undefined)
    updates.requestPreview = input.requestPreview;
  if (input.agentToolName !== undefined)
    updates.agentToolName = input.agentToolName;

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

export async function findAgentToolTrustRuleRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  domain: string;
  toolName: string;
  connectorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  riskLevel: ConnectorActionRiskLevel;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(agentToolTrustRules)
    .where(
      and(
        eq(agentToolTrustRules.teamId, input.teamId),
        eq(agentToolTrustRules.workspaceId, input.workspaceId),
        eq(agentToolTrustRules.userId, input.userId),
        eq(agentToolTrustRules.domain, input.domain),
        eq(agentToolTrustRules.toolName, input.toolName),
        eq(agentToolTrustRules.status, "active"),
      ),
    )
    .orderBy(desc(agentToolTrustRules.createdAt))
    .limit(50);

  const connectorId = input.connectorId ?? null;
  const targetType = input.targetType ?? null;
  const targetId = input.targetId ?? null;
  const match = rows.find((row) => {
    if (row.connectorId !== connectorId) return false;
    if ((row.targetType ?? null) !== targetType) return false;
    if ((row.targetId ?? null) !== targetId) return false;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
      return false;
    }
    return Array.isArray(row.allowedRiskLevels)
      ? row.allowedRiskLevels.includes(input.riskLevel)
      : false;
  });

  return match ? mapAgentToolTrustRule(match) : null;
}

export async function createAgentToolTrustRuleRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  domain: string;
  toolName: string;
  connectorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  allowedRiskLevels: ConnectorActionRiskLevel[];
  status?: AgentToolTrustRuleStatus;
  expiresAt?: Date | null;
  createdFromConfirmationId?: string | null;
}) {
  const [row] = await db
    .insert(agentToolTrustRules)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      domain: input.domain,
      toolName: input.toolName,
      connectorId: input.connectorId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      allowedRiskLevels: input.allowedRiskLevels,
      status: input.status ?? "active",
      expiresAt: input.expiresAt ?? null,
      createdFromConfirmationId: input.createdFromConfirmationId ?? null,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create agent tool trust rule");
  }

  return mapAgentToolTrustRule(row);
}

export async function touchAgentToolTrustRuleRecord(input: {
  teamId: string;
  workspaceId: string;
  trustRuleId: string;
  lastUsedAt?: Date;
}) {
  const [row] = await db
    .update(agentToolTrustRules)
    .set({
      lastUsedAt: input.lastUsedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentToolTrustRules.id, input.trustRuleId),
        eq(agentToolTrustRules.teamId, input.teamId),
        eq(agentToolTrustRules.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  return row ? mapAgentToolTrustRule(row) : null;
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
