import { sql } from "drizzle-orm";
import type { db } from "@sourceweft/db";

export type ArtifactWriteTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/** First lock for keyed creation/current-run publication, before row locks. */
export async function lockArtifactRequestKey(
  tx: ArtifactWriteTransaction,
  input: {
    teamId: string;
    workspaceId: string;
    artifactType: string;
    requestKey?: string | null;
  },
) {
  if (input.requestKey === undefined || input.requestKey === null) return;
  // Preserve the existing current-run publication lock domain exactly.
  const key = [
    input.teamId,
    input.workspaceId,
    input.artifactType,
    input.requestKey,
  ].join("\u001f");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}
