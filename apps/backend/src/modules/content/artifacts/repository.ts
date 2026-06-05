import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../../../shared/database";
import { artifactVersions, artifacts } from "../../../shared/db/schema";

type ArtifactRow = typeof artifacts.$inferSelect;
type ArtifactStatus = ArtifactRow["status"];

const STALE_VIDEO_PRESENTATION_ARTIFACT_MS = 10 * 60_000;
const STALE_VIDEO_PRESENTATION_ERROR_CODE = "VIDEO_PRESENTATION_RENDER_STALE";
const STALE_VIDEO_PRESENTATION_ERROR_MESSAGE =
  "Video presentation project generation did not complete. Please retry.";

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
  storageBucket?: string | null;
  storageKey?: string | null;
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
    storageBucket: input.storageBucket ?? null,
    storageKey: input.storageKey ?? null,
    createdBy: input.userId,
  });

  return {
    artifactId: input.artifactId,
  };
}

export async function findReusableVideoPresentationArtifactRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  requestKey: string;
}) {
  const staleBefore = new Date(
    Date.now() - STALE_VIDEO_PRESENTATION_ARTIFACT_MS,
  );
  await markStaleVideoPresentationArtifactsFailed({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    requestKey: input.requestKey,
    staleBefore,
  });

  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.threadId, input.threadId),
        eq(artifacts.artifactType, "video_presentation"),
        or(
          eq(artifacts.status, "ready"),
          and(
            or(
              eq(artifacts.status, "pending"),
              eq(artifacts.status, "running"),
            ),
            gt(artifacts.updatedAt, staleBefore),
          ),
        ),
        sql`${artifacts.payloadJson}->>'requestKey' = ${input.requestKey}`,
      ),
    )
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(1);

  return row ? mapArtifact(row) : null;
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

export async function markStaleVideoPresentationArtifactsFailed(input: {
  artifactId?: string;
  teamId: string;
  workspaceId: string;
  threadId?: string | null;
  requestKey?: string;
  staleBefore?: Date;
}) {
  const now = new Date();
  const staleBefore =
    input.staleBefore ??
    new Date(now.getTime() - STALE_VIDEO_PRESENTATION_ARTIFACT_MS);
  const conditions = [
    input.artifactId ? eq(artifacts.id, input.artifactId) : undefined,
    eq(artifacts.teamId, input.teamId),
    eq(artifacts.workspaceId, input.workspaceId),
    eq(artifacts.artifactType, "video_presentation"),
    or(eq(artifacts.status, "pending"), eq(artifacts.status, "running")),
    lte(artifacts.updatedAt, staleBefore),
    input.threadId ? eq(artifacts.threadId, input.threadId) : undefined,
    input.requestKey
      ? sql`${artifacts.payloadJson}->>'requestKey' = ${input.requestKey}`
      : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> =>
    Boolean(condition),
  );

  const rows = await db
    .update(artifacts)
    .set({
      status: "failed",
      errorCode: STALE_VIDEO_PRESENTATION_ERROR_CODE,
      errorMessage: STALE_VIDEO_PRESENTATION_ERROR_MESSAGE,
      payloadJson: sql`${artifacts.payloadJson} || ${JSON.stringify({
        generation: {
          status: "failed",
          stage: "failed",
          errorCode: STALE_VIDEO_PRESENTATION_ERROR_CODE,
          errorMessage: STALE_VIDEO_PRESENTATION_ERROR_MESSAGE,
        },
      })}::jsonb`,
      updatedAt: now,
      completedAt: now,
    })
    .where(and(...conditions))
    .returning({ id: artifacts.id });

  return rows.length;
}

export async function markVideoPresentationArtifactReady(input: {
  artifactId: string;
  teamId: string;
  workspaceId: string;
  userId: string;
  payload: Record<string, unknown>;
  storageBucket?: string | null;
  storageKey?: string | null;
}) {
  const versionId = randomUUID();
  const now = new Date();

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(artifacts)
      .set({
        status: "ready",
        payloadJson: input.payload,
        storageBucket: input.storageBucket ?? null,
        storageKey: input.storageKey ?? null,
        errorCode: null,
        errorMessage: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.teamId, input.teamId),
          eq(artifacts.workspaceId, input.workspaceId),
          or(eq(artifacts.status, "pending"), eq(artifacts.status, "running")),
        ),
      )
      .returning({ id: artifacts.id });

    if (!updated) {
      throw new Error("Video presentation artifact is no longer pending.");
    }

    await tx.insert(artifactVersions).values({
      id: versionId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      versionNo: 1,
      contentJson: input.payload,
      createdBy: input.userId,
    });
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
