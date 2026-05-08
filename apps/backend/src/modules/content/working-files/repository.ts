import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../shared/database";
import { workingFiles } from "../../../shared/db/schema";
import type { WorkingFilePurpose, WorkingFileRecord } from "../types";

type WorkingFileRow = typeof workingFiles.$inferSelect;

function mapWorkingFile(row: WorkingFileRow): WorkingFileRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    path: row.path,
    contentText: row.contentText,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    purpose: row.purpose ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function countWorkingFileRecords(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workingFiles)
    .where(
      and(
        eq(workingFiles.teamId, input.teamId),
        eq(workingFiles.workspaceId, input.workspaceId),
        eq(workingFiles.threadId, input.threadId),
      ),
    );

  return Number(row?.count ?? 0);
}

export async function listWorkingFileRecords(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}) {
  const rows = await db
    .select()
    .from(workingFiles)
    .where(
      and(
        eq(workingFiles.teamId, input.teamId),
        eq(workingFiles.workspaceId, input.workspaceId),
        eq(workingFiles.threadId, input.threadId),
      ),
    )
    .orderBy(asc(workingFiles.path));

  return rows.map(mapWorkingFile);
}

export async function listWorkingFileRecordsByUpdatedAt(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}) {
  const rows = await db
    .select()
    .from(workingFiles)
    .where(
      and(
        eq(workingFiles.teamId, input.teamId),
        eq(workingFiles.workspaceId, input.workspaceId),
        eq(workingFiles.threadId, input.threadId),
      ),
    )
    .orderBy(desc(workingFiles.updatedAt), asc(workingFiles.path));

  return rows.map(mapWorkingFile);
}

export async function findWorkingFileRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  path: string;
}) {
  const [row] = await db
    .select()
    .from(workingFiles)
    .where(
      and(
        eq(workingFiles.teamId, input.teamId),
        eq(workingFiles.workspaceId, input.workspaceId),
        eq(workingFiles.threadId, input.threadId),
        eq(workingFiles.path, input.path),
      ),
    )
    .limit(1);

  return row ? mapWorkingFile(row) : null;
}

export async function upsertWorkingFileRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  path: string;
  contentText: string;
  mimeType: string;
  sizeBytes: number;
  purpose?: WorkingFilePurpose | null;
  createdBy?: string | null;
}) {
  const id = randomUUID();
  const now = new Date();
  const [row] = await db
    .insert(workingFiles)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      path: input.path,
      contentText: input.contentText,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      purpose: input.purpose ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        workingFiles.teamId,
        workingFiles.workspaceId,
        workingFiles.threadId,
        workingFiles.path,
      ],
      set: {
        contentText: input.contentText,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        purpose: input.purpose ?? null,
        updatedAt: now,
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to upsert working file");
  }

  return mapWorkingFile(row);
}

export async function touchWorkingFileRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  path: string;
  mimeType: string;
  purpose?: WorkingFilePurpose | null;
  createdBy?: string | null;
}) {
  const existing = await findWorkingFileRecord(input);
  if (existing) {
    const [row] = await db
      .update(workingFiles)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(workingFiles.teamId, input.teamId),
          eq(workingFiles.workspaceId, input.workspaceId),
          eq(workingFiles.threadId, input.threadId),
          eq(workingFiles.path, input.path),
        ),
      )
      .returning();
    if (!row) {
      throw new Error("Failed to touch working file");
    }
    return mapWorkingFile(row);
  }

  return upsertWorkingFileRecord({
    ...input,
    contentText: "",
    sizeBytes: 0,
  });
}

export async function deleteWorkingFileRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  path: string;
}) {
  const [row] = await db
    .delete(workingFiles)
    .where(
      and(
        eq(workingFiles.teamId, input.teamId),
        eq(workingFiles.workspaceId, input.workspaceId),
        eq(workingFiles.threadId, input.threadId),
        eq(workingFiles.path, input.path),
      ),
    )
    .returning({ path: workingFiles.path });

  return row?.path ?? null;
}
