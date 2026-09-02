/**
 * Persistence for source connectors themselves — creation, lookup, update,
 * hard deletion (including the citation preservation that outlives the deleted
 * sources) and the scheduling fields the periodic indexer reads and writes.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte, ne, sql } from "drizzle-orm";
import {
  chunks,
  citations,
  connectorOAuthAccounts,
  db,
  documents,
  sourceConnectors,
  sources,
} from "@sourceweft/db";
import { ConnectorError } from "../errors";
import { mapSourceConnector } from "../mappers";
import type { ConnectorStatus } from "../types";

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
    throw new ConnectorError(
      500,
      "CONNECTOR_CREATE_FAILED",
      "Failed to create connector",
      { teamId: input.teamId, workspaceId: input.workspaceId },
    );
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
