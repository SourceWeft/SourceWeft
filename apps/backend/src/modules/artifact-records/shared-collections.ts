import { and, asc, count, eq } from "drizzle-orm";
import { artifactRecords, db } from "@sourceweft/db";
import type { ArtifactSharedCollection } from "@sourceweft/contracts/artifact-records";

/**
 * The collections holding `shared` records for one artifact, with record
 * counts. `user`-scope rows are never listed: they are private to each viewer.
 */
export async function listSharedCollections(
  artifactId: string,
): Promise<ArtifactSharedCollection[]> {
  const rows = await db
    .select({
      collection: artifactRecords.collection,
      count: count(),
    })
    .from(artifactRecords)
    .where(
      and(
        eq(artifactRecords.artifactId, artifactId),
        eq(artifactRecords.scope, "shared"),
      ),
    )
    .groupBy(artifactRecords.collection)
    .orderBy(asc(artifactRecords.collection));
  return rows.map((row) => ({
    collection: row.collection,
    count: Number(row.count),
  }));
}
