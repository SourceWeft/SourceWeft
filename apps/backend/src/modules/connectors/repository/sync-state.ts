import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { connectorSyncState, db, sources } from "@sourceweft/db";

export async function getOrResetConnectorSyncState(input: {
  connectorId: string;
  scopeHash: string;
}) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(connectorSyncState)
      .where(eq(connectorSyncState.connectorId, input.connectorId))
      .for("update");
    if (current?.scopeHash === input.scopeHash) return current;
    if (current) {
      const [row] = await tx
        .update(connectorSyncState)
        .set({
          scopeHash: input.scopeHash,
          generation: current.generation + 1,
          committedCursorJson: null,
          pageCursorJson: null,
          updatedAt: new Date(),
        })
        .where(eq(connectorSyncState.connectorId, input.connectorId))
        .returning();
      return row!;
    }
    const [row] = await tx
      .insert(connectorSyncState)
      .values({ connectorId: input.connectorId, scopeHash: input.scopeHash })
      .returning();
    return row!;
  });
}

export async function commitConnectorSyncPage(input: {
  connectorId: string;
  scopeHash: string;
  expectedGeneration: number;
  continuation?: Record<string, unknown> | null;
  checkpoint?: Record<string, unknown> | null;
  complete: boolean;
}) {
  const [row] = await db
    .update(connectorSyncState)
    .set({
      generation: input.expectedGeneration + 1,
      pageCursorJson: input.complete ? null : (input.continuation ?? null),
      ...(input.complete
        ? { committedCursorJson: input.checkpoint ?? null }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connectorSyncState.connectorId, input.connectorId),
        eq(connectorSyncState.scopeHash, input.scopeHash),
        eq(connectorSyncState.generation, input.expectedGeneration),
      ),
    )
    .returning();
  if (!row || row.scopeHash !== input.scopeHash) {
    throw new Error("Connector sync state changed while a page was applying");
  }
  return row;
}

/** An expired provider cursor forces the next run to start a full scan. */
export async function resetConnectorSyncState(input: {
  connectorId: string;
  scopeHash: string;
}) {
  await db
    .update(connectorSyncState)
    .set({
      committedCursorJson: null,
      pageCursorJson: null,
      generation: sql`${connectorSyncState.generation} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connectorSyncState.connectorId, input.connectorId),
        eq(connectorSyncState.scopeHash, input.scopeHash),
      ),
    );
}

/** Archive missing source records only after an authoritative full scan. */
export async function archiveConnectorSourcesNotSeenInRun(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
  runId: string;
}) {
  const rows = await db
    .update(sources)
    .set({ status: "archived", updatedAt: new Date() })
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        eq(sources.connectorId, input.connectorId),
        eq(sources.sourceType, "connector"),
        ne(sources.status, "archived"),
        or(isNull(sources.syncRunId), ne(sources.syncRunId, input.runId)),
      ),
    )
    .returning({ id: sources.id });
  return rows.length;
}

/** Hide retained connector sources from retrieval when a mode is disabled. */
export async function archiveConnectorSources(input: {
  teamId: string;
  workspaceId: string;
  connectorId: string;
}) {
  const rows = await db
    .update(sources)
    .set({ status: "archived", updatedAt: new Date() })
    .where(
      and(
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        eq(sources.connectorId, input.connectorId),
        eq(sources.sourceType, "connector"),
        ne(sources.status, "archived"),
      ),
    )
    .returning({ id: sources.id });
  return rows.length;
}
