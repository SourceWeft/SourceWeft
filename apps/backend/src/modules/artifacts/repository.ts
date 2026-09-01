import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  artifacts,
  artifactVersions,
  chatThreadRuns,
  db,
} from "@sourceweft/db";
import { visibleContentWhere } from "../workspace/content-visibility";

type ArtifactRow = typeof artifacts.$inferSelect;
type ArtifactStatus = ArtifactRow["status"];
type ArtifactType = ArtifactRow["artifactType"];

function mapArtifact(row: ArtifactRow) {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    artifactType: row.artifactType,
    status: row.status,
    currentVersionNo: row.currentVersionNo,
    requestKey: row.requestKey,
    title: row.title,
    promptText: row.promptText,
    payloadJson: row.payloadJson ?? {},
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    previewStorageKey: row.previewStorageKey,
    previewMetadataJson: row.previewMetadataJson ?? {},
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    visibility: row.visibility,
    createdBy: row.createdBy,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Insert an already-produced artifact row plus its first version. The host
 * owns the row shape (ids, storage pointers, versioning); which artifact type
 * it is and what the payload contains come from the capability that produced
 * it.
 */
export async function createReadyArtifactRecord(input: {
  artifactId: string;
  artifactType: ArtifactType;
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  title: string;
  prompt: string;
  payload: Record<string, unknown>;
  /**
   * Nullable because a file is no longer the centre of an artifact: a
   * client-rendered type publishes a payload and never a stored file. The
   * column has always been nullable; the signature required it only because
   * every caller happened to be a file publisher.
   */
  storageBucket?: string | null;
  storageKey?: string | null;
  previewStorageKey?: string | null;
  previewMetadata?: Record<string, unknown> | null;
  /** Idempotency token, when the caller asked for "the artifact for this request". */
  requestKey?: string | null;
}) {
  const versionId = randomUUID();
  const now = new Date();

  // The row and its first version are one fact, not two. Written separately, a
  // failure between them leaves a status=ready artifact with zero versions —
  // readable by the API, unopenable by any version-based reader.
  await db.transaction(async (tx) => {
    await tx.insert(artifacts).values({
      id: input.artifactId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      artifactType: input.artifactType,
      status: "ready",
      // Written here rather than derived later: the version row inserted below
      // is version 1, and the pointer must agree with it from the first commit.
      currentVersionNo: 1,
      requestKey: input.requestKey ?? null,
      title: input.title,
      promptText: input.prompt,
      payloadJson: input.payload,
      storageBucket: input.storageBucket ?? null,
      storageKey: input.storageKey ?? null,
      previewStorageKey: input.previewStorageKey ?? null,
      previewMetadataJson: input.previewMetadata ?? {},
      // Artifacts inherit their thread's visibility: private thread → private
      // artifact, anything else → workspace-visible. There is no independent
      // per-artifact toggle; the thread is the source of truth.
      visibility: sql`coalesce((select case when t.visibility = 'private' then 'private' else 'workspace' end from threads t where t.id = ${input.threadId}), 'workspace')`,
      createdBy: input.userId,
      completedAt: now,
    });

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

/**
 * Insert a not-yet-produced artifact row. Which artifact type it is, and what
 * goes into the payload, is the caller's (i.e. the capability's) business.
 */
export async function createPendingArtifactRecord(input: {
  artifactId: string;
  artifactType: ArtifactType;
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  title: string;
  prompt: string;
  payload: Record<string, unknown>;
  /** Idempotency token, when the caller asked for "the artifact for this request". */
  requestKey?: string | null;
}) {
  await db.insert(artifacts).values({
    id: input.artifactId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    artifactType: input.artifactType,
    status: "pending",
    // No version has been published yet; markArtifactReady moves it to 1.
    currentVersionNo: 0,
    requestKey: input.requestKey ?? null,
    title: input.title,
    promptText: input.prompt,
    payloadJson: input.payload,
    // Artifacts inherit their thread's visibility: private thread → private
    // artifact, anything else → workspace-visible. There is no independent
    // per-artifact toggle; the thread is the source of truth.
    visibility: sql`coalesce((select case when t.visibility = 'private' then 'private' else 'workspace' end from threads t where t.id = ${input.threadId}), 'workspace')`,
    createdBy: input.userId,
  });
}

/**
 * Find the most recent artifact in a thread a caller may reuse instead of
 * creating a new one. The host scans the thread's rows of the requested type;
 * which statuses qualify and what makes a row a match are supplied by the
 * caller, since both are capability-specific.
 *
 * Every predicate the caller can express is pushed into SQL, and the LIMIT is
 * applied to *matching* rows. It used to fetch the newest 20 rows and filter
 * status/payload in JS, which silently missed a perfectly reusable row as soon
 * as a thread accumulated 20 newer artifacts of the same type — the reuse
 * simply stopped working, quietly, on exactly the busy threads that needed it.
 *
 * `matchesPayload` remains for callers whose match cannot be expressed as a
 * column, but it is a residual filter over SQL-narrowed rows, never the only
 * one; pass `requestKey` when the match is an idempotency token, which is the
 * indexed path.
 */
export async function findReusableArtifactRecord(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  artifactType: ArtifactType;
  statuses: readonly ArtifactStatus[];
  limit?: number;
  requestKey?: string;
  matchesPayload?: (payload: Record<string, unknown>) => boolean;
}) {
  if (input.statuses.length === 0) {
    return null;
  }
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.threadId, input.threadId),
        eq(artifacts.artifactType, input.artifactType),
        inArray(artifacts.status, [...input.statuses]),
        ...(input.requestKey === undefined
          ? []
          : [eq(artifacts.requestKey, input.requestKey)]),
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    // Without a residual JS filter one row is all a caller can use; with one,
    // the limit bounds how many candidates it may inspect.
    .limit(input.matchesPayload ? (input.limit ?? 20) : 1);

  const row = input.matchesPayload
    ? rows.find((candidate) => {
        const payload = candidate.payloadJson;
        return Boolean(
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          input.matchesPayload!(payload as Record<string, unknown>),
        );
      })
    : rows[0];
  return row ? mapArtifact(row) : null;
}

/**
 * Resolve an idempotency token to the artifact it already produced, workspace-
 * wide. Separate from `findReusableArtifactRecord` because idempotency is not
 * thread-scoped: "the artifact for this request" is the same artifact whichever
 * thread asks again.
 *
 * Callers must run this *before* uploading any bytes — a de-duplicated publish
 * that still wrote its objects has left orphans in the bucket for an artifact
 * it did not create.
 */
export async function findArtifactRecordByRequestKey(input: {
  teamId: string;
  workspaceId: string;
  artifactType: ArtifactType;
  requestKey: string;
  statuses: readonly ArtifactStatus[];
}) {
  if (input.statuses.length === 0) {
    return null;
  }
  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.artifactType, input.artifactType),
        eq(artifacts.requestKey, input.requestKey),
        inArray(artifacts.status, [...input.statuses]),
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(1);

  if (!row) {
    return null;
  }
  const [latestVersion] = await db
    .select({ id: artifactVersions.id })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, row.id))
    .orderBy(desc(artifactVersions.versionNo))
    .limit(1);

  return {
    ...mapArtifact(row),
    latestVersionId: latestVersion?.id ?? null,
  };
}

/**
 * Publish a new ready version. Returns null when `expectedStatuses` or
 * `expectedVersionNo` is given and no longer matches — i.e. another writer got
 * there first. Callers that pass either must treat null as "lost the race",
 * not failure.
 */
export async function markArtifactReady(input: {
  artifactId: string;
  teamId: string;
  workspaceId: string;
  userId: string;
  payload: Record<string, unknown>;
  /**
   * Set by pipelines that produce their own thumbnail. Omitted means "keep
   * whatever preview the artifact already has".
   */
  previewStorageKey?: string;
  previewMetadata?: Record<string, unknown>;
  /**
   * Set by a two-phase completion that produced the artifact's own stored file
   * only in its second phase. Omitted means "keep whatever the row already
   * points at", which is what every pre-existing caller wants.
   */
  storageBucket?: string;
  storageKey?: string;
  expectedStatuses?: ArtifactStatus[];
  /**
   * Optimistic lock for a run that republishes an artifact which is already
   * `ready` (an edit). Status cannot separate two concurrent edits — both see
   * `ready` — so the run carries the `current_version_no` it read when it
   * loaded the payload, and the CAS fails if anything published since.
   */
  expectedVersionNo?: number;
  /**
   * Optional durable-run fence for a deliverable owned by a chat turn. The run
   * row is locked in this same transaction so cancellation and publication
   * have one serialization point.
   */
  publishRunFence?: {
    runId: string;
    teamId: string;
    workspaceId: string;
  };
}) {
  const versionId = randomUUID();

  // Status flip and version insert are one publish. Split across two
  // statements, a crash in between leaves status=ready with the previous
  // version as the newest row — the payload and the version history disagree
  // forever.
  return db.transaction(async (tx) => {
    if (input.publishRunFence) {
      const [run] = await tx
        .select({ status: chatThreadRuns.status })
        .from(chatThreadRuns)
        .where(
          and(
            eq(chatThreadRuns.id, input.publishRunFence.runId),
            eq(chatThreadRuns.teamId, input.publishRunFence.teamId),
            eq(chatThreadRuns.workspaceId, input.publishRunFence.workspaceId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !run ||
        (run.status !== "queued" &&
          run.status !== "running" &&
          run.status !== "waiting_for_approval")
      ) {
        return null;
      }
    }

    const [current] = await tx
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
      .limit(1)
      // Take the row lock before deciding what to carry forward, so a
      // concurrent publisher cannot swap storage pointers underneath us.
      .for("update");

    // Compare-and-swap on status, matching markArtifactRunning/markArtifactFailed.
    // Without it two concurrent completions of the same artifact both race to
    // insert the next versionNo; the unique index
    // artifact_versions_artifact_version_uq means the loser dies on an opaque
    // constraint violation instead of a legible "someone else finished this".
    const updated = await tx
      .update(artifacts)
      .set({
        status: "ready",
        payloadJson: input.payload,
        errorCode: null,
        errorMessage: null,
        completedAt: new Date(),
        updatedAt: new Date(),
        storageBucket: input.storageBucket ?? current?.storageBucket ?? null,
        storageKey: input.storageKey ?? current?.storageKey ?? null,
        previewStorageKey:
          input.previewStorageKey ?? current?.previewStorageKey ?? null,
        previewMetadataJson:
          input.previewStorageKey && input.previewMetadata
            ? input.previewMetadata
            : (current?.previewMetadataJson ?? {}),
      })
      .where(
        and(
          ...[
            eq(artifacts.id, input.artifactId),
            eq(artifacts.teamId, input.teamId),
            eq(artifacts.workspaceId, input.workspaceId),
            input.expectedStatuses && input.expectedStatuses.length > 0
              ? or(
                  ...input.expectedStatuses.map((status) =>
                    eq(artifacts.status, status),
                  ),
                )
              : undefined,
            input.expectedVersionNo === undefined
              ? undefined
              : eq(artifacts.currentVersionNo, input.expectedVersionNo),
          ].filter((condition): condition is NonNullable<typeof condition> =>
            Boolean(condition),
          ),
        ),
      )
      .returning({ id: artifacts.id });

    if (updated.length === 0) {
      return null;
    }

    // Read max(versionNo) only after the CAS succeeded and inside the same
    // transaction: reading it earlier put it outside the window the CAS
    // protects, so two publishers could compute the same next version.
    const [latestVersion] = await tx
      .select({
        versionNo: artifactVersions.versionNo,
      })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, input.artifactId))
      .orderBy(desc(artifactVersions.versionNo))
      .limit(1);

    const versionNo = (latestVersion?.versionNo ?? 0) + 1;

    await tx.insert(artifactVersions).values({
      id: versionId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      versionNo,
      contentJson: input.payload,
      createdBy: input.userId,
    });

    // The pointer is advanced here and nowhere else: same transaction, after
    // the CAS, to the number this transaction's version insert actually used.
    // Moved outside the transaction it would disagree with artifact_versions in
    // precisely the race the CAS exists to catch, and moved before the CAS it
    // would be computed from a number two publishers can both read.
    await tx
      .update(artifacts)
      .set({ currentVersionNo: versionNo })
      .where(eq(artifacts.id, input.artifactId))
      .returning({ id: artifacts.id });

    return { artifactId: input.artifactId, versionId, versionNo };
  });
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

/**
 * Read the immutable version currently published by one ready artifact.
 *
 * The join on `currentVersionNo` is the important part of this query. Looking
 * up the maximum version independently can race publication and can also pick
 * an orphan/history row that the artifact has never made current. Tenant,
 * workspace, status, and type predicates stay in the same statement so callers
 * never receive a version before all host-owned structural checks have passed.
 * Row visibility is actor-specific and remains in the application service.
 */
export async function findCurrentReadyArtifactVersionRecord(input: {
  teamId: string;
  workspaceId: string;
  artifactId: string;
  expectedArtifactType: string;
}) {
  const [row] = await db
    .select({
      artifactId: artifacts.id,
      artifactType: artifacts.artifactType,
      currentVersionNo: artifacts.currentVersionNo,
      visibility: artifacts.visibility,
      createdBy: artifacts.createdBy,
      storageBucket: artifacts.storageBucket,
      previewStorageKey: artifacts.previewStorageKey,
      versionId: artifactVersions.id,
      versionNo: artifactVersions.versionNo,
      contentJson: artifactVersions.contentJson,
    })
    .from(artifacts)
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.teamId, artifacts.teamId),
        eq(artifactVersions.workspaceId, artifacts.workspaceId),
        eq(artifactVersions.versionNo, artifacts.currentVersionNo),
      ),
    )
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.artifactType, input.expectedArtifactType as ArtifactType),
        eq(artifacts.status, "ready"),
        gt(artifacts.currentVersionNo, 0),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function listCurrentReadyArtifactVersionRecords(input: {
  teamId: string;
  workspaceId: string;
  artifactIds: readonly string[];
}) {
  if (input.artifactIds.length === 0) return [];
  return db
    .select({
      artifactId: artifacts.id,
      artifactType: artifacts.artifactType,
      currentVersionNo: artifacts.currentVersionNo,
      visibility: artifacts.visibility,
      createdBy: artifacts.createdBy,
      storageBucket: artifacts.storageBucket,
      previewStorageKey: artifacts.previewStorageKey,
      versionId: artifactVersions.id,
      versionNo: artifactVersions.versionNo,
      contentJson: artifactVersions.contentJson,
    })
    .from(artifacts)
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.teamId, artifacts.teamId),
        eq(artifactVersions.workspaceId, artifacts.workspaceId),
        eq(artifactVersions.versionNo, artifacts.currentVersionNo),
      ),
    )
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        inArray(artifacts.id, [...input.artifactIds]),
        eq(artifacts.status, "ready"),
        gt(artifacts.currentVersionNo, 0),
      ),
    );
}

/** Read one immutable published version without falling forward to current. */
export async function findReadyArtifactVersionRecord(input: {
  teamId: string;
  workspaceId: string;
  artifactId: string;
  artifactVersionId: string;
}) {
  const [row] = await db
    .select({
      artifact: artifacts,
      versionId: artifactVersions.id,
      versionNo: artifactVersions.versionNo,
      contentJson: artifactVersions.contentJson,
    })
    .from(artifacts)
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.id, input.artifactVersionId),
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.teamId, artifacts.teamId),
        eq(artifactVersions.workspaceId, artifacts.workspaceId),
      ),
    )
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.status, "ready"),
        gt(artifacts.currentVersionNo, 0),
        lte(artifactVersions.versionNo, artifacts.currentVersionNo),
      ),
    )
    .limit(1);

  return row
    ? {
        ...mapArtifact(row.artifact),
        versionId: row.versionId,
        versionNo: row.versionNo,
        contentJson: row.contentJson,
      }
    : null;
}

export async function findLatestArtifactVersionId(input: {
  teamId: string;
  workspaceId: string;
  artifactId: string;
}) {
  const [artifact] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!artifact) {
    return null;
  }
  const [latestVersion] = await db
    .select({ id: artifactVersions.id })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifact.id))
    .orderBy(desc(artifactVersions.versionNo))
    .limit(1);
  return latestVersion?.id ?? null;
}

export async function listArtifactVersionContentRecords(input: {
  teamId: string;
  workspaceId: string;
  artifactId: string;
}) {
  return db
    .select({
      versionId: artifactVersions.id,
      contentJson: artifactVersions.contentJson,
    })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.teamId, input.teamId),
        eq(artifactVersions.workspaceId, input.workspaceId),
        eq(artifactVersions.artifactId, input.artifactId),
      ),
    );
}

/**
 * Delete the artifact row. Versions and artifact-source rows go with it via
 * `ON DELETE CASCADE`; stored object cleanup is the caller's business, since
 * the repository never touches object storage. Returns false when the row was
 * already gone (or belongs to another tenant), which callers report as 404.
 */
export async function deleteArtifactRecord(input: {
  teamId: string;
  workspaceId: string;
  artifactId: string;
}) {
  const rows = await db
    .delete(artifacts)
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: artifacts.id });

  return rows.length > 0;
}

/**
 * Re-label every artifact of a thread to the thread's visibility. Artifacts do
 * not carry an independent toggle; they inherit their thread, so when the thread
 * is re-shared or hidden its artifacts move with it. `private` maps to private,
 * anything else to workspace-visible. Returns the number of rows updated.
 */
export async function updateArtifactsVisibilityForThread(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  threadVisibility: "private" | "workspace" | "public_link";
}) {
  const mapped = input.threadVisibility === "private" ? "private" : "workspace";
  const rows = await db
    .update(artifacts)
    .set({ visibility: mapped, updatedAt: new Date() })
    .where(
      and(
        eq(artifacts.teamId, input.teamId),
        eq(artifacts.workspaceId, input.workspaceId),
        eq(artifacts.threadId, input.threadId),
      ),
    )
    .returning();

  return rows.length;
}

export async function listArtifactRecords(input: {
  teamId: string;
  workspaceId: string;
  cursor?: { createdAt: Date; id: string } | null;
  limit?: number;
  viewerUserId?: string;
}) {
  const conditions = [
    eq(artifacts.teamId, input.teamId),
    eq(artifacts.workspaceId, input.workspaceId),
    // A generation that failed leaves a `failed` row so the originating thread
    // can still surface the error inline (that path queries by threadId, not
    // this list). The workspace-wide Artifacts gallery, however, should not
    // carry dead entries — exclude them here so a failed run is not browsable
    // as an artifact.
    ne(artifacts.status, "failed"),
    input.viewerUserId
      ? visibleContentWhere(
          { userId: input.viewerUserId },
          { visibility: artifacts.visibility, createdBy: artifacts.createdBy },
        )
      : undefined,
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

/**
 * Gallery read model. Keep this projection deliberately independent of
 * `mapArtifact`: that mapper includes payload_json, while collection size must
 * remain bounded by row count rather than generated artifact content.
 */
export async function listArtifactSummaryRecords(input: {
  teamId: string;
  workspaceId: string;
  cursor?: { createdAt: Date; id: string } | null;
  limit?: number;
  viewerUserId?: string;
}) {
  const conditions = [
    eq(artifacts.teamId, input.teamId),
    eq(artifacts.workspaceId, input.workspaceId),
    ne(artifacts.status, "failed"),
    input.viewerUserId
      ? visibleContentWhere(
          { userId: input.viewerUserId },
          { visibility: artifacts.visibility, createdBy: artifacts.createdBy },
        )
      : undefined,
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
    .select({
      id: artifacts.id,
      workspaceId: artifacts.workspaceId,
      threadId: artifacts.threadId,
      artifactType: artifacts.artifactType,
      status: artifacts.status,
      title: artifacts.title,
      promptExcerpt: sql<
        string | null
      >`nullif(left(${artifacts.promptText}, 300), '')`,
      visibility: artifacts.visibility,
      createdAt: artifacts.createdAt,
      completedAt: artifacts.completedAt,
      updatedAt: artifacts.updatedAt,
      hasPrimaryFile: sql<boolean>`${artifacts.status} = 'ready' and ${artifacts.storageKey} is not null`,
      hasPreviewImage: sql<boolean>`${artifacts.status} = 'ready' and ${artifacts.previewStorageKey} is not null`,
      previewAltText: sql<
        string | null
      >`nullif(left(${artifacts.previewMetadataJson} ->> 'altText', 300), '')`,
    })
    .from(artifacts)
    .where(and(...conditions))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit((input.limit ?? 100) + 1);

  const limit = input.limit ?? 100;
  const visibleRows = rows.slice(0, limit);
  const nextRow = rows[limit] ?? null;
  return {
    items: visibleRows.map((row) => ({
      ...row,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
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
