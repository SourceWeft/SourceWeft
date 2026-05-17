import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "../../../shared/database";
import { artifactVersions, artifacts } from "../../../shared/db/schema";

type ArtifactRow = typeof artifacts.$inferSelect;

function mapArtifact(row: ArtifactRow) {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    artifactType: row.artifactType,
    status: row.status,
    title: row.title,
    promptText: row.promptText,
    payloadJson: row.payloadJson ?? {},
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdBy: row.createdBy,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createImageArtifactRecord(input: {
  artifactId: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  title: string;
  prompt: string;
  payload: Record<string, unknown>;
  storageBucket: string;
  storageKey: string;
}) {
  const versionId = randomUUID();
  const now = new Date();

  await db.insert(artifacts).values({
    id: input.artifactId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    artifactType: "image",
    status: "ready",
    title: input.title,
    promptText: input.prompt,
    payloadJson: input.payload,
    storageBucket: input.storageBucket,
    storageKey: input.storageKey,
    createdBy: input.userId,
    completedAt: now,
  });

  await db.insert(artifactVersions).values({
    id: versionId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    versionNo: 1,
    contentJson: input.payload,
    createdBy: input.userId,
  });

  return {
    artifactId: input.artifactId,
    versionId,
  };
}

export async function findArtifactRecord(input: {
  teamId: string;
  workspaceId: string;
  artifactId: string;
}) {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  return row ? mapArtifact(row) : null;
}

export async function listArtifactRecords(input: {
  teamId: string;
  workspaceId: string;
  cursor?: { createdAt: Date; id: string } | null;
  limit?: number;
}) {
  const conditions = [
    eq(artifacts.teamId, input.teamId),
    eq(artifacts.workspaceId, input.workspaceId),
    input.cursor
      ? or(
          lt(artifacts.createdAt, input.cursor.createdAt),
          and(
            eq(artifacts.createdAt, input.cursor.createdAt),
            lt(artifacts.id, input.cursor.id),
          ),
        )
      : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> =>
    Boolean(condition),
  );
  const rows = await db
    .select()
    .from(artifacts)
    .where(and(...conditions))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit((input.limit ?? 100) + 1);

  const limit = input.limit ?? 100;
  const items = rows.slice(0, limit).map(mapArtifact);
  const nextRow = rows[limit] ?? null;
  return {
    items,
    nextCursor: nextRow
      ? Buffer.from(
          JSON.stringify({
            createdAt: nextRow.createdAt.toISOString(),
            id: nextRow.id,
          }),
          "utf8",
        ).toString("base64url")
      : null,
  };
}
