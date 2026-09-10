import type { ThreadSourceSelection } from "@sourceweft/contracts";
import { ContentError } from "../content/errors";

export function resolveTurnSourceSelection(
  requested: string[] | undefined,
  persisted: ThreadSourceSelection,
): string[] {
  const selected = new Set(persisted.selectedSourceIds);
  if (requested?.some((id) => !selected.has(id))) {
    throw new ContentError(
      403,
      "SOURCE_NOT_SELECTED",
      "Add the source to this conversation's selection before using it.",
    );
  }
  return [
    ...new Set(
      requested === undefined ? persisted.selectedSourceIds : requested,
    ),
  ];
}

/** Mentions narrow the selected scope; they never grant additional access. */
export function selectedSourceAnchors(
  selected: readonly string[],
  mentioned: readonly string[],
): string[] {
  const allowed = new Set(selected);
  return [...new Set(mentioned)].filter((id) => allowed.has(id));
}
