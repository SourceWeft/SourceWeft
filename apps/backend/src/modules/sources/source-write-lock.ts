import { and, eq } from "drizzle-orm";
import { db, sources } from "@sourceweft/db";

type SourceWriteTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/** Revision advancement and index replacement serialize on the source row. */
export async function lockSourceForWrite(
  tx: SourceWriteTransaction,
  input: { teamId: string; workspaceId: string; sourceId: string },
) {
  const [source] = await tx
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.id, input.sourceId),
        eq(sources.teamId, input.teamId),
        eq(sources.workspaceId, input.workspaceId),
      ),
    )
    .for("update")
    .limit(1);
  return Boolean(source);
}
