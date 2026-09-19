import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, workingFiles } from "@sourceweft/db";
import { ContentError } from "../content/errors";
import type { WorkingFilePurpose, WorkingFileRecord } from "../content/types";

type WorkingFileRow = typeof workingFiles.$inferSelect;

function mapWorkingFile(row: WorkingFileRow): WorkingFileRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    path: row.path,
    contentText: row.contentText,
    payloadKind: row.payloadKind,
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    contentHash: row.contentHash,
    origin: row.origin,
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
  signal?: AbortSignal;
  object?: { bucket: string; key: string; contentHash: string };
  origin?: WorkingFileRecord["origin"];
  expectedRevision?: string;
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
  const payload = {
    payloadKind: input.object ? ("object" as const) : ("inline_text" as const),
    storageBucket: input.object?.bucket ?? null,
    storageKey: input.object?.key ?? null,
    contentHash:
      input.object?.contentHash ??
      createHash("sha256").update(input.contentText).digest("hex"),
    origin: input.origin ?? ("unknown" as const),
  };
  input.signal?.throwIfAborted();
  const row = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.teamId, input.workspaceId, input.threadId])}, 0))`,
    );
    const scope = and(
      eq(workingFiles.teamId, input.teamId),
      eq(workingFiles.workspaceId, input.workspaceId),
      eq(workingFiles.threadId, input.threadId),
    );
    const [existing] = await tx
      .select({ id: workingFiles.id })
      .from(workingFiles)
      .where(and(scope, eq(workingFiles.path, input.path)))
      .limit(1);
    if (!existing) {
      const [count] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(workingFiles)
        .where(scope);
      if (Number(count?.value ?? 0) >= 200)
        throw new ContentError(
          409,
          "WORKING_FILE_LIMIT_EXCEEDED",
          "This conversation has reached its file limit.",
        );
    }
    input.signal?.throwIfAborted();
    const [saved] = await tx
      .insert(workingFiles)
      .values({
        ...payload,
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
          ...payload,
          contentText: input.contentText,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          purpose: input.purpose ?? null,
          updatedAt: now,
        },
        setWhere: input.expectedRevision
          ? eq(
              workingFiles.contentHash,
              input.expectedRevision.replace(/^sha256:/, ""),
            )
          : sql`false`,
      })
      .returning();
    input.signal?.throwIfAborted();
    return saved;
  });

  if (!row) {
    throw new ContentError(
      409,
      "FILE_CHANGED",
      "Read the current file before replacing it.",
      {
        details: {
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
        },
      },
    );
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
      throw new ContentError(
        500,
        "WORKING_FILE_TOUCH_FAILED",
        "Failed to touch working file",
        {
          details: {
            teamId: input.teamId,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
          },
        },
      );
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
