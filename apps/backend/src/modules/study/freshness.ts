import { and, eq, inArray } from "drizzle-orm";
import { db, sources } from "@sourceweft/db";
import type { StudyInputs } from "@sourceweft/contracts/study";

export type StudyFreshness = {
  state: "fresh" | "stale" | "source_deleted";
  changedSourceIds: string[];
  deletedSourceIds: string[];
};

/**
 * Compares a version's input snapshot with the sources as they are now. A
 * deleted source outranks a changed one; nothing is regenerated automatically.
 */
export function compareStudyFreshness(
  inputs: StudyInputs,
  current: ReadonlyMap<string, string | null>,
): StudyFreshness {
  const changedSourceIds: string[] = [];
  const deletedSourceIds: string[] = [];
  for (const source of inputs.sources) {
    if (!current.has(source.sourceId)) {
      deletedSourceIds.push(source.sourceId);
    } else if (current.get(source.sourceId) !== source.contentHash) {
      changedSourceIds.push(source.sourceId);
    }
  }
  return {
    state:
      deletedSourceIds.length > 0
        ? "source_deleted"
        : changedSourceIds.length > 0
          ? "stale"
          : "fresh",
    changedSourceIds,
    deletedSourceIds,
  };
}

/** Freshness of a version's inputs against the sources in its workspace. */
export async function loadStudyFreshness(input: {
  teamId: string;
  workspaceId: string;
  inputs: StudyInputs;
}): Promise<StudyFreshness> {
  const ids = input.inputs.sources.map((source) => source.sourceId);
  const rows = ids.length
    ? await db
        .select({ id: sources.id, contentHash: sources.contentHash })
        .from(sources)
        .where(
          and(
            eq(sources.teamId, input.teamId),
            eq(sources.workspaceId, input.workspaceId),
            inArray(sources.id, ids),
          ),
        )
    : [];
  return compareStudyFreshness(
    input.inputs,
    new Map(rows.map((row) => [row.id, row.contentHash])),
  );
}
