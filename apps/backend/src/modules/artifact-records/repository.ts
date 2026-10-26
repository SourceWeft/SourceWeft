import { randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, isNull, sql, sum, type SQL } from "drizzle-orm";
import {
  artifactCapabilityApprovals,
  artifactRecordConsents,
  artifactRecords,
  artifactVersions,
  database,
  db,
} from "@sourceweft/db";
import type {
  ArtifactRecord,
  ArtifactRecordFilter,
  ArtifactRecordOrder,
  ArtifactRecordScope,
} from "@sourceweft/contracts/artifact-records";
import {
  cursorCondition,
  filterCondition,
  orderClauses,
  sortValueSelections,
  type QueryCursor,
} from "./query";

/** One viewer's (or the shared) slice of one artifact's records. */
export type RecordPartition = {
  artifactId: string;
  scope: ArtifactRecordScope;
  /** Set for `user`, null for `shared`. Always derived from the session. */
  ownerUserId: string | null;
};

export type RecordKey = RecordPartition & {
  collection: string;
  recordId: string;
};

export function partitionWhere(partition: RecordPartition): SQL {
  return and(
    eq(artifactRecords.artifactId, partition.artifactId),
    eq(artifactRecords.scope, partition.scope),
    partition.ownerUserId === null
      ? isNull(artifactRecords.ownerUserId)
      : eq(artifactRecords.ownerUserId, partition.ownerUserId),
  )!;
}

function keyWhere(key: RecordKey): SQL {
  return and(
    partitionWhere(key),
    eq(artifactRecords.collection, key.collection),
    eq(artifactRecords.recordId, key.recordId),
  )!;
}

const recordColumns = {
  id: artifactRecords.recordId,
  data: artifactRecords.data,
  etag: artifactRecords.etag,
  sizeBytes: artifactRecords.sizeBytes,
  createdAt: artifactRecords.createdAt,
  updatedAt: artifactRecords.updatedAt,
};

function toRecord(row: {
  id: string;
  data: unknown;
  etag: string;
  createdAt: Date;
  updatedAt: Date;
}): ArtifactRecord {
  return {
    id: row.id,
    data: row.data,
    etag: row.etag,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function newEtag() {
  return randomBytes(12).toString("base64url");
}

export async function readRecord(
  key: RecordKey,
): Promise<ArtifactRecord | null> {
  const [row] = await db
    .select(recordColumns)
    .from(artifactRecords)
    .where(keyWhere(key))
    .limit(1);
  return row ? toRecord(row) : null;
}

export type RecordWriteLimits = {
  recordsPerCollection: number;
  collectionsPerPartition: number;
  partitionBytes: number;
};

export type RecordWriteResult =
  | { kind: "written"; etag: string; updatedAt: string; created: boolean }
  | { kind: "conflict" }
  | { kind: "quota_exceeded"; reason: string };

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serializes writes to one artifact so the quota sums and the etag check see a
 * stable partition. Writes are rate-limited per viewer well below what this
 * lock could bottleneck.
 */
async function lockArtifact(tx: Transaction, artifactId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`artifact-records:${artifactId}`}, 0))`,
  );
}

export async function writeRecord(input: {
  key: RecordKey;
  teamId: string;
  workspaceId: string;
  actorUserId: string;
  /**
   * The validated JSON text, bound as `jsonb`. Passing the parsed value would
   * make a top-level `null` a SQL NULL, which the NOT NULL column refuses.
   */
  dataJson: string;
  sizeBytes: number;
  ifMatch?: string;
  limits: RecordWriteLimits;
}): Promise<RecordWriteResult> {
  return db.transaction(async (tx) => {
    await lockArtifact(tx, input.key.artifactId);
    const [existing] = await tx
      .select({
        id: artifactRecords.id,
        etag: artifactRecords.etag,
        sizeBytes: artifactRecords.sizeBytes,
      })
      .from(artifactRecords)
      .where(keyWhere(input.key))
      .for("update")
      .limit(1);
    if (input.ifMatch !== undefined && existing?.etag !== input.ifMatch)
      return { kind: "conflict" };

    if (!existing) {
      const [collection] = await tx
        .select({ value: count() })
        .from(artifactRecords)
        .where(
          and(
            partitionWhere(input.key),
            eq(artifactRecords.collection, input.key.collection),
          ),
        );
      const collectionSize = Number(collection?.value ?? 0);
      if (collectionSize >= input.limits.recordsPerCollection)
        return {
          kind: "quota_exceeded",
          reason: `A collection holds at most ${input.limits.recordsPerCollection} records`,
        };
      if (collectionSize === 0) {
        const [collections] = await tx
          .select({
            value: sql<number>`count(distinct ${artifactRecords.collection})`,
          })
          .from(artifactRecords)
          .where(partitionWhere(input.key));
        if (
          Number(collections?.value ?? 0) >=
          input.limits.collectionsPerPartition
        )
          return {
            kind: "quota_exceeded",
            reason: `At most ${input.limits.collectionsPerPartition} collections are allowed`,
          };
      }
    }

    const [usage] = await tx
      .select({ value: sum(artifactRecords.sizeBytes) })
      .from(artifactRecords)
      .where(partitionWhere(input.key));
    const used = Number(usage?.value ?? 0) - (existing?.sizeBytes ?? 0);
    if (used + input.sizeBytes > input.limits.partitionBytes)
      return {
        kind: "quota_exceeded",
        reason: `Storage for this artifact is limited to ${input.limits.partitionBytes} bytes`,
      };

    const etag = newEtag();
    const now = new Date();
    if (existing) {
      await tx
        .update(artifactRecords)
        .set({
          data: sql`${input.dataJson}::jsonb`,
          sizeBytes: input.sizeBytes,
          etag,
          updatedBy: input.actorUserId,
          updatedAt: now,
        })
        .where(eq(artifactRecords.id, existing.id));
    } else {
      await tx.insert(artifactRecords).values({
        id: randomUUID(),
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        artifactId: input.key.artifactId,
        scope: input.key.scope,
        ownerUserId: input.key.ownerUserId,
        collection: input.key.collection,
        recordId: input.key.recordId,
        data: sql`${input.dataJson}::jsonb`,
        sizeBytes: input.sizeBytes,
        etag,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      kind: "written",
      etag,
      updatedAt: now.toISOString(),
      created: !existing,
    };
  });
}

export async function deleteRecord(input: {
  key: RecordKey;
  ifMatch?: string;
}): Promise<{ kind: "deleted" | "missing" } | { kind: "conflict" }> {
  return db.transaction(async (tx) => {
    await lockArtifact(tx, input.key.artifactId);
    const [existing] = await tx
      .select({ id: artifactRecords.id, etag: artifactRecords.etag })
      .from(artifactRecords)
      .where(keyWhere(input.key))
      .for("update")
      .limit(1);
    if (input.ifMatch !== undefined && existing?.etag !== input.ifMatch)
      return { kind: "conflict" };
    if (!existing) return { kind: "missing" };
    await tx.delete(artifactRecords).where(eq(artifactRecords.id, existing.id));
    return { kind: "deleted" };
  });
}

export class RecordQueryTimeoutError extends Error {
  constructor() {
    super("The query took too long");
    this.name = "RecordQueryTimeoutError";
  }
}

function isStatementTimeout(error: unknown) {
  for (
    let cause: unknown = error;
    cause;
    cause = (cause as { cause?: unknown }).cause
  ) {
    if ((cause as { code?: unknown }).code === "57014") return true;
  }
  return false;
}

export type RecordQueryRow = ArtifactRecord & {
  sizeBytes: number;
  sortValues: unknown[];
};

export async function queryRecords(input: {
  partition: RecordPartition;
  collection: string;
  where: readonly ArtifactRecordFilter[];
  orderBy: readonly ArtifactRecordOrder[];
  idPrefix?: string;
  cursor: QueryCursor | null;
  /** Rows to fetch; callers ask for one more than they return. */
  fetch: number;
  timeoutMs: number;
}): Promise<RecordQueryRow[]> {
  const sortSelections = sortValueSelections(input.orderBy);
  const conditions: SQL[] = [
    partitionWhere(input.partition),
    eq(artifactRecords.collection, input.collection),
    ...input.where.map(filterCondition),
  ];
  if (input.idPrefix)
    conditions.push(
      sql`starts_with(${artifactRecords.recordId}, ${input.idPrefix})`,
    );
  if (input.cursor)
    conditions.push(cursorCondition(input.orderBy, input.cursor));
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`set local statement_timeout = ${Math.trunc(input.timeoutMs)}`),
      );
      const rows = await tx
        .select({
          ...recordColumns,
          sortValues: sortSelections.length
            ? sql<
                unknown[]
              >`jsonb_build_array(${sql.join(sortSelections, sql`, `)})`
            : sql<unknown[]>`'[]'::jsonb`,
        })
        .from(artifactRecords)
        .where(and(...conditions))
        .orderBy(...orderClauses(input.orderBy))
        .limit(input.fetch);
      return rows.map((row) => ({
        ...toRecord(row),
        sizeBytes: row.sizeBytes,
        sortValues: row.sortValues,
      }));
    });
  } catch (error) {
    if (isStatementTimeout(error)) throw new RecordQueryTimeoutError();
    throw error;
  }
}

export async function findVersionAuthor(versionId: string) {
  const [row] = await db
    .select({ createdBy: artifactVersions.createdBy })
    .from(artifactVersions)
    .where(eq(artifactVersions.id, versionId))
    .limit(1);
  return row?.createdBy ?? null;
}

export async function findActiveSharedApproval(versionId: string) {
  const [row] = await db
    .select({
      approvedBy: artifactCapabilityApprovals.approvedBy,
      approvedAt: artifactCapabilityApprovals.approvedAt,
    })
    .from(artifactCapabilityApprovals)
    .where(
      and(
        eq(artifactCapabilityApprovals.versionId, versionId),
        eq(artifactCapabilityApprovals.capability, "storage.shared"),
        isNull(artifactCapabilityApprovals.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function approveShared(input: {
  versionId: string;
  artifactId: string;
  teamId: string;
  userId: string;
}) {
  const now = new Date();
  await db
    .insert(artifactCapabilityApprovals)
    .values({
      versionId: input.versionId,
      artifactId: input.artifactId,
      teamId: input.teamId,
      capability: "storage.shared",
      approvedBy: input.userId,
      approvedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        artifactCapabilityApprovals.versionId,
        artifactCapabilityApprovals.capability,
      ],
      set: {
        approvedBy: input.userId,
        approvedAt: now,
        revokedBy: null,
        revokedAt: null,
      },
    });
  return { approvedBy: input.userId, approvedAt: now };
}

export async function revokeShared(input: {
  versionId: string;
  userId: string;
}) {
  const rows = await db
    .update(artifactCapabilityApprovals)
    .set({ revokedBy: input.userId, revokedAt: new Date() })
    .where(
      and(
        eq(artifactCapabilityApprovals.versionId, input.versionId),
        eq(artifactCapabilityApprovals.capability, "storage.shared"),
        isNull(artifactCapabilityApprovals.revokedAt),
      ),
    )
    .returning({ versionId: artifactCapabilityApprovals.versionId });
  return rows.length > 0;
}

export async function hasSharedConsent(input: {
  userId: string;
  versionId: string;
}) {
  const [row] = await db
    .select({ userId: artifactRecordConsents.userId })
    .from(artifactRecordConsents)
    .where(
      and(
        eq(artifactRecordConsents.userId, input.userId),
        eq(artifactRecordConsents.versionId, input.versionId),
        eq(artifactRecordConsents.capability, "storage.shared"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function grantSharedConsent(input: {
  userId: string;
  versionId: string;
  artifactId: string;
}) {
  await db
    .insert(artifactRecordConsents)
    .values({
      userId: input.userId,
      versionId: input.versionId,
      artifactId: input.artifactId,
      capability: "storage.shared",
    })
    .onConflictDoNothing();
}

/** Account deletion: a viewer's own records and consents go with them. */
export async function deleteUserRecordData(userId: string) {
  await db.transaction(async (tx) => {
    await tx
      .delete(artifactRecords)
      .where(
        and(
          eq(artifactRecords.scope, "user"),
          eq(artifactRecords.ownerUserId, userId),
        ),
      );
    await tx
      .delete(artifactRecordConsents)
      .where(eq(artifactRecordConsents.userId, userId));
  });
}

export async function findUserNames(userIds: readonly string[]) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map<string, string | null>();
  const result = await database.query<{ id: string; name: string | null }>(
    `select id, name from "user" where id = any($1::text[])`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row.name]));
}
