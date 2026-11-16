/**
 * Shared four-way item state logic for connectors whose selected items are
 * shown as rows with a single state badge (Google Drive, Dropbox). Kept free
 * of React and SDK imports, and free of any connector's id/prefix logic: each
 * connector computes its own `externalId` (its own prefix convention) and
 * passes it in here.
 */

export type ConnectorFileState =
  | { kind: "skipped"; reason: string }
  | { kind: "indexed" }
  | { kind: "processing" }
  | { kind: "failed" }
  | { kind: "unavailable" }
  | { kind: "waiting" };

/** True when a run that could have seen the current selection has run: the run
 * started after the selection last changed in this session. When the selection
 * was not changed in this session (`null`), any run qualifies. */
function runCouldHaveSeenSelection(
  runStartedAt: Date | null,
  selectionChangedAt: Date | null,
): boolean {
  if (selectionChangedAt === null) {
    return true;
  }
  if (runStartedAt === null) {
    return false;
  }
  return runStartedAt.getTime() > selectionChangedAt.getTime();
}

/**
 * Decide the single state shown for one selected item, in priority order:
 *
 *  1. `skipped` — the latest sync run's skipped items name this item. This wins
 *     even over an active source, because an item that was indexed and later
 *     skipped has had its source archived; the skip is the current truth.
 *  2. the active source's own state (`indexed` / `processing` / `failed`) when a
 *     non-archived source exists for this item.
 *  3. `unavailable` — no active source and not skipped, but the latest run has
 *     finished successfully AND started after the selection last changed in this
 *     session, so reconciliation would have archived a source that was deleted
 *     upstream or lost access.
 *  4. `waiting` — otherwise: no run yet, a run still in progress, a run that did
 *     not finish successfully, or a run that started before an item was just
 *     added, so we cannot yet say the item is gone.
 *
 * `source` is a source returned by `listSources` (archived sources are already
 * excluded upstream), or `null`/`undefined` when no active source matches.
 * `selectionChangedAt` is when this browser session last submitted an add or a
 * remove, or `null` when it has not. Known residual gap: a selection changed
 * from another browser while a run was in flight can still read `unavailable`
 * until the next sync.
 */
export function connectorFileState(input: {
  externalId: string;
  source: { status: string } | null | undefined;
  latestRun: {
    status: string;
    startedAt: Date | null;
    skippedItems: ReadonlyArray<{ externalId: string; reason: string }>;
  } | null;
  selectionChangedAt: Date | null;
}): ConnectorFileState {
  const skipped = input.latestRun?.skippedItems.find(
    (entry) => entry.externalId === input.externalId,
  );
  if (skipped) {
    return { kind: "skipped", reason: skipped.reason };
  }
  if (input.source) {
    if (input.source.status === "indexed") {
      return { kind: "indexed" };
    }
    if (input.source.status === "failed") {
      return { kind: "failed" };
    }
    return { kind: "processing" };
  }
  if (
    input.latestRun &&
    input.latestRun.status === "succeeded" &&
    runCouldHaveSeenSelection(
      input.latestRun.startedAt,
      input.selectionChangedAt,
    )
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "waiting" };
}
