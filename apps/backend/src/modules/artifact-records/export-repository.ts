import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { artifactRecords, db } from "@sourceweft/db";
import type { ArtifactRecord } from "@sourceweft/contracts/artifact-records";
import { partitionWhere, type RecordPartition } from "./repository";

export type ExportedRecordRow = ArtifactRecord & { collection: string };

/** Where a page resumes: the last `(collection, id)` already written. */
export type ExportCursor = { collection: string; id: string };

function selection(partition: RecordPartition, collection?: string): SQL[] {
  const conditions = [partitionWhere(partition)];
  if (collection) conditions.push(eq(artifactRecords.collection, collection));
  return conditions;
}

/**
 * One keyset page in `(collection, record_id)` order. Both columns are in the
 * unique key's index, and the row comparison runs in the database, so the order
 * the page is cut by and the order it is compared by always agree.
 */
export async function listRecordPage(input: {
  partition: RecordPartition;
  collection?: string;
  after: ExportCursor | null;
  limit: number;
}): Promise<ExportedRecordRow[]> {
  const conditions = selection(input.partition, input.collection);
  if (input.after)
    conditions.push(
      sql`(${artifactRecords.collection}, ${artifactRecords.recordId}) > (${input.after.collection}, ${input.after.id})`,
    );
  const rows = await db
    .select({
      collection: artifactRecords.collection,
      id: artifactRecords.recordId,
      data: artifactRecords.data,
      etag: artifactRecords.etag,
      createdAt: artifactRecords.createdAt,
      updatedAt: artifactRecords.updatedAt,
    })
    .from(artifactRecords)
    .where(and(...conditions))
    .orderBy(asc(artifactRecords.collection), asc(artifactRecords.recordId))
    .limit(input.limit);
  return rows.map((row) => ({
    collection: row.collection,
    id: row.id,
    data: row.data,
    etag: row.etag,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Deletes one partition (or one collection of it) and says how many rows went.
 * The count comes from the statement itself, so a large partition is never
 * pulled back into memory just to be counted.
 */
export async function clearRecords(input: {
  partition: RecordPartition;
  collection?: string;
}): Promise<number> {
  const result = await db.execute<{ removed: number }>(sql`
    with removed as (
      delete from ${artifactRecords}
      where ${and(...selection(input.partition, input.collection))}
      returning 1
    )
    select count(*)::int as removed from removed
  `);
  return Number(result.rows[0]?.removed ?? 0);
}
