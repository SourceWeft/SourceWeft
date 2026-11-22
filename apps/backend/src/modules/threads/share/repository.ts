import { eq } from "drizzle-orm";
import { db, threadShareSnapshots } from "@sourceweft/db";
import type { ChatSnapshot } from "./snapshot";

export type ThreadShareSnapshotRow = {
  shareLinkId: string;
  teamId: string;
  workspaceId: string;
  threadId: string;
  snapshot: ChatSnapshot;
  takenAt: Date;
};

/**
 * Stores the frozen snapshot behind a thread share, replacing the one the
 * same link held before (re-sharing keeps the token, refreshes the content).
 */
export async function upsertThreadShareSnapshot(row: ThreadShareSnapshotRow) {
  // The column is typed as a plain record because the db package cannot see
  // the backend's `ChatSnapshot`; this module is the one place that casts.
  const snapshot = row.snapshot as unknown as Record<string, unknown>;
  await db
    .insert(threadShareSnapshots)
    .values({ ...row, snapshot })
    .onConflictDoUpdate({
      target: threadShareSnapshots.shareLinkId,
      set: { snapshot, takenAt: row.takenAt },
    });
}

export async function findThreadShareSnapshot(
  shareLinkId: string,
): Promise<ThreadShareSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(threadShareSnapshots)
    .where(eq(threadShareSnapshots.shareLinkId, shareLinkId))
    .limit(1);
  return row
    ? { ...row, snapshot: row.snapshot as unknown as ChatSnapshot }
    : null;
}

export async function deleteThreadShareSnapshot(shareLinkId: string) {
  await db
    .delete(threadShareSnapshots)
    .where(eq(threadShareSnapshots.shareLinkId, shareLinkId));
}
