import { and, eq, inArray } from "drizzle-orm";
import { db, sources } from "@sourceweft/db";

/** The part of a version's input snapshot that freshness reads. */
export type FreshnessInputs = {
  sources: readonly { sourceId: string; contentHash: string }[];
};

export type InputFreshness = {
  state: "fresh" | "stale" | "source_deleted";
  changedSourceIds: string[];
  deletedSourceIds: string[];
};

/**
 * Compares a version's input snapshot with the sources as they are now. A
 * deleted source outranks a changed one; nothing is regenerated automatically.
 */
export function compareInputFreshness<I extends FreshnessInputs>(
  inputs: I,
  current: ReadonlyMap<string, string | null>,
): InputFreshness {
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
export async function loadInputFreshness<I extends FreshnessInputs>(input: {
  teamId: string;
  workspaceId: string;
  inputs: I;
}): Promise<InputFreshness> {
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
  return compareInputFreshness(
    input.inputs,
    new Map(rows.map((row) => [row.id, row.contentHash])),
  );
}
