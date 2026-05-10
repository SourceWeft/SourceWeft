import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
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
  limit?: number;
}) {
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(input.limit ?? 100);

  return rows.map(mapArtifact);
}
