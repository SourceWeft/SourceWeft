import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, sourceRevisions } from "@sourceweft/db";
import { mapSourceRevision } from "./mappers";
import { lockSourceForWrite } from "./source-write-lock";

export async function listSourceRevisionRecords(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const rows = await db
    .select()
    .from(sourceRevisions)
    .where(
      and(
        eq(sourceRevisions.teamId, input.teamId),
        eq(sourceRevisions.workspaceId, input.workspaceId),
        eq(sourceRevisions.sourceId, input.sourceId),
      ),
    )
    .orderBy(desc(sourceRevisions.revisionNo), desc(sourceRevisions.createdAt));

  return rows.map(mapSourceRevision);
}

export async function findLatestSourceRevisionRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}) {
  const [row] = await db
    .select()
    .from(sourceRevisions)
    .where(
      and(
        eq(sourceRevisions.teamId, input.teamId),
        eq(sourceRevisions.workspaceId, input.workspaceId),
        eq(sourceRevisions.sourceId, input.sourceId),
        eq(sourceRevisions.isLatest, true),
      ),
    )
    .limit(1);

  return row ? mapSourceRevision(row) : null;
}

export async function isLatestSourceRevision(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  sourceRevisionId: string;
}) {
  const [row] = await db
    .select({ id: sourceRevisions.id })
    .from(sourceRevisions)
    .where(
      and(
        eq(sourceRevisions.id, input.sourceRevisionId),
        eq(sourceRevisions.teamId, input.teamId),
        eq(sourceRevisions.workspaceId, input.workspaceId),
        eq(sourceRevisions.sourceId, input.sourceId),
        eq(sourceRevisions.isLatest, true),
      ),
    )
    .limit(1);

  return Boolean(row);
}

export async function createSourceRevisionRecord(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  contentHash?: string | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  parserVersion?: string | null;
  externalUpdatedAt?: Date | null;
}) {
  return db.transaction(async (tx) => {
    if (!(await lockSourceForWrite(tx, input))) {
      throw new Error("Cannot create revision for a missing source");
    }
    const [latest] = await tx
      .select({ revisionNo: sourceRevisions.revisionNo })
      .from(sourceRevisions)
      .where(
        and(
          eq(sourceRevisions.teamId, input.teamId),
          eq(sourceRevisions.workspaceId, input.workspaceId),
          eq(sourceRevisions.sourceId, input.sourceId),
          eq(sourceRevisions.isLatest, true),
        ),
      )
      .limit(1);

    await tx
      .update(sourceRevisions)
      .set({ isLatest: false })
      .where(
        and(
          eq(sourceRevisions.teamId, input.teamId),
          eq(sourceRevisions.workspaceId, input.workspaceId),
          eq(sourceRevisions.sourceId, input.sourceId),
          eq(sourceRevisions.isLatest, true),
        ),
      );

    const [row] = await tx
      .insert(sourceRevisions)
      .values({
        id: randomUUID(),
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        revisionNo: (latest?.revisionNo ?? 0) + 1,
        contentHash: input.contentHash ?? null,
        storageBucket: input.storageBucket ?? null,
        storageKey: input.storageKey ?? null,
        externalUpdatedAt: input.externalUpdatedAt ?? null,
        parserVersion: input.parserVersion ?? null,
        isLatest: true,
        createdAt: new Date(),
      })
      .returning();

    if (!row) {
      throw new Error("Failed to create source revision");
    }

    return mapSourceRevision(row);
  });
}
