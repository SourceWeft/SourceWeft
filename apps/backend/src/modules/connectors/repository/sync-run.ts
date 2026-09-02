/**
 * Persistence for connector sync runs — the per-indexing-pass records that
 * carry status, counters and heartbeats for a connector's ingestion.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { connectorSyncRuns, db, sourceConnectors } from "@sourceweft/db";
import { ConnectorError } from "../errors";
import { mapSyncRun } from "../mappers";
import type {
  ConnectorSyncRunStatus,
  ConnectorSyncRunTriggerType,
} from "../types";

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
    throw new ConnectorError(
      500,
      "CONNECTOR_SYNC_RUN_CREATE_FAILED",
      "Failed to create connector sync run",
      {
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
      },
    );
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
      throw new ConnectorError(
        500,
        "CONNECTOR_SYNC_RUN_CREATE_FAILED",
        "Failed to create connector sync run",
        {
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          connectorId: input.connectorId,
        },
      );
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
