import { and, eq, sql } from "drizzle-orm";
import { db, sourceRevisions, sources } from "@sourceweft/db";
import type { SourceMetadata, SourceStatus } from "../content/types";
import { mapSource } from "./mappers";

function buildSourceStatusUpdates(input: {
  status: SourceStatus;
  estimatedPages?: number | null;
  parsedTokens?: number | null;
  indexedAt?: Date | null;
  error?: Record<string, unknown>;
  metadata?: SourceMetadata;
}) {
  const updates: {
    status: SourceStatus;
    indexedAt?: Date | null;
    updatedAt: Date;
    estimatedPages?: number | null;
    parsedTokens?: number | null;
    errorJson?: Record<string, unknown>;
    metadataJson?: SourceMetadata;
  } = {
    status: input.status,
    updatedAt: new Date(),
  };

  if (input.indexedAt !== undefined) updates.indexedAt = input.indexedAt;
  if (input.estimatedPages !== undefined) updates.estimatedPages = input.estimatedPages;
  if (input.parsedTokens !== undefined) updates.parsedTokens = input.parsedTokens;
  if (input.error !== undefined) updates.errorJson = input.error;
  if (input.metadata !== undefined) updates.metadataJson = input.metadata;

  return updates;
}

export async function updateSourceStatus(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  status: SourceStatus;
  estimatedPages?: number | null;
  parsedTokens?: number | null;
  indexedAt?: Date | null;
  error?: Record<string, unknown>;
  metadata?: SourceMetadata;
}) {
  const [row] = await db
    .update(sources)
    .set(buildSourceStatusUpdates(input))
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  if (!row) {
    throw new Error("Failed to update source status");
  }

  return mapSource(row);
}

export async function updateSourceStatusForLatestRevision(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  sourceRevisionId: string;
  status: SourceStatus;
  estimatedPages?: number | null;
  parsedTokens?: number | null;
  indexedAt?: Date | null;
  error?: Record<string, unknown>;
  metadata?: SourceMetadata;
}) {
  const [row] = await db
    .update(sources)
    .set(buildSourceStatusUpdates(input))
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
        sql`exists (
          select 1
          from ${sourceRevisions}
          where ${sourceRevisions.id} = ${input.sourceRevisionId}
            and ${sourceRevisions.teamId} = ${input.teamId}
            and ${sourceRevisions.workspaceId} = ${input.workspaceId}
            and ${sourceRevisions.sourceId} = ${input.sourceId}
            and ${sourceRevisions.isLatest} = true
        )`,
      ),
    )
    .returning();

  return row ? mapSource(row) : null;
}

