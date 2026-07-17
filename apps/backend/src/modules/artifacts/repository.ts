import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { artifacts, artifactVersions, db } from "@sourceweft/db";

type ArtifactRow = typeof artifacts.$inferSelect;
type ArtifactStatus = ArtifactRow["status"];

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
    previewStorageKey: row.previewStorageKey,
    previewMetadataJson: row.previewMetadataJson ?? {},
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

export async function createSlidesArtifactRecord(input: {
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
  previewStorageKey?: string | null;
  previewMetadata?: Record<string, unknown> | null;
}) {
  const versionId = randomUUID();
  const now = new Date();

  await db.insert(artifacts).values({
    id: input.artifactId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    artifactType: "slides",
    status: "ready",
    title: input.title,
    promptText: input.prompt,
    payloadJson: input.payload,
    storageBucket: input.storageBucket,
    storageKey: input.storageKey,
    previewStorageKey: input.previewStorageKey ?? null,
    previewMetadataJson: input.previewMetadata ?? {},
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

export async function createFileArtifactRecord(input: {
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
    artifactType: "file",
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

export async function createPendingVideoPresentationArtifactRecord(input: {
  artifactId: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  title: string;
  prompt: string;
  payload: Record<string, unknown>;
}) {
  await db.insert(artifacts).values({
    id: input.artifactId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    artifactType: "video_presentation",
    status: "pending",
    title: input.title,
    promptText: input.prompt,
    payloadJson: input.payload,
    createdBy: input.userId,
  });
}

export async function findReusableVideoPresentationArtifactRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  requestKey: string;
}) {
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.threadId, input.threadId),
        eq(artifacts.artifactType, "video_presentation"),
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(20);

  const row = rows.find((candidate) => {
    if (
      candidate.status !== "pending" &&
      candidate.status !== "running" &&
      candidate.status !== "ready"
    ) {
      return false;
    }
    const payload = candidate.payloadJson;
    return (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).requestKey === input.requestKey
    );
  });
  return row ? mapArtifact(row) : null;
}

export async function markArtifactReady(input: {
  artifactId: string;
  teamId: string;
  workspaceId: string;
  userId: string;
  payload: Record<string, unknown>;
}) {
  const [current] = await db
    .select({
      storageBucket: artifacts.storageBucket,
      storageKey: artifacts.storageKey,
      previewMetadataJson: artifacts.previewMetadataJson,
      previewStorageKey: artifacts.previewStorageKey,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  const [latestVersion] = await db
    .select({
      versionNo: artifactVersions.versionNo,
    })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, input.artifactId))
    .orderBy(desc(artifactVersions.versionNo))
    .limit(1);

  const versionId = randomUUID();

  await db
    .update(artifacts)
    .set({
      status: "ready",
      payloadJson: input.payload,
      errorCode: null,
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date(),
      storageBucket: current?.storageBucket ?? null,
      storageKey: current?.storageKey ?? null,
      previewStorageKey: current?.previewStorageKey ?? null,
      previewMetadataJson: current?.previewMetadataJson ?? {},
    })
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
      ),
    );

  await db.insert(artifactVersions).values({
    id: versionId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    versionNo: (latestVersion?.versionNo ?? 0) + 1,
    contentJson: input.payload,
    createdBy: input.userId,
  });

  return { artifactId: input.artifactId, versionId };
}

export async function markArtifactRunning(input: {
  artifactId: string;
  teamId?: string;
  workspaceId?: string;
  expectedStatuses?: ArtifactStatus[];
  payload?: Record<string, unknown>;
}) {
  const conditions = [
    eq(artifacts.id, input.artifactId),
    input.teamId ? eq(artifacts.teamId, input.teamId) : undefined,
    input.workspaceId
      ? eq(artifacts.workspaceId, input.workspaceId)
      : undefined,
    input.expectedStatuses && input.expectedStatuses.length > 0
      ? or(
          ...input.expectedStatuses.map((status) =>
            eq(artifacts.status, status),
          ),
        )
      : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> =>
    Boolean(condition),
  );
  const rows = await db
    .update(artifacts)
    .set({
      status: "running",
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      ...(input.payload ? { payloadJson: input.payload } : {}),
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning({ id: artifacts.id });

  return rows.length > 0;
}

export async function markArtifactFailed(input: {
  artifactId: string;
  teamId?: string;
  workspaceId?: string;
  expectedStatuses?: ArtifactStatus[];
  errorCode: string;
  errorMessage: string;
  payload?: Record<string, unknown>;
}) {
  const conditions = [
    eq(artifacts.id, input.artifactId),
    input.teamId ? eq(artifacts.teamId, input.teamId) : undefined,
    input.workspaceId
      ? eq(artifacts.workspaceId, input.workspaceId)
      : undefined,
    input.expectedStatuses && input.expectedStatuses.length > 0
      ? or(
          ...input.expectedStatuses.map((status) =>
            eq(artifacts.status, status),
          ),
        )
      : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> =>
    Boolean(condition),
  );

  const rows = await db
    .update(artifacts)
    .set({
      status: "failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      completedAt: new Date(),
      ...(input.payload ? { payloadJson: input.payload } : {}),
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning({ id: artifacts.id });

  return rows.length > 0;
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
