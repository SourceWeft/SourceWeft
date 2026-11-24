import { TABLE_LIMITS, type TableColumnInput } from "@sourceweft/contracts/table";

/**
 * The column list a person edits before generating or regenerating a table.
 * Pure helpers, shared by the column editor and the app's dialog.
 */

/** What keeps a column list from being sent, or null when it can be. */
export type ColumnsProblem = "none" | "nameMissing" | "tooMany";

export function blankTableColumn(): TableColumnInput {
  return { name: "", type: "text" };
}

function nameKey(name: string) {
  return name.trim().toLocaleLowerCase();
}

export function columnsProblem(
  columns: readonly TableColumnInput[],
  max: number = TABLE_LIMITS.maxColumns,
): ColumnsProblem | null {
  if (columns.length === 0) return "none";
  if (columns.length > max) return "tooMany";
  if (columns.some((column) => column.name.trim() === "")) return "nameMissing";
  return null;
}

/**
 * Suggested columns added to what the person already typed: their named
 * columns stay first and unchanged (ids included), blank rows are dropped, a
 * suggestion whose name is already there is skipped, and the list stops at
 * `max`. A suggestion never brings an id: it is a new column.
 */
export function mergeSuggestedColumns(
  current: readonly TableColumnInput[],
  suggested: readonly TableColumnInput[],
  max: number = TABLE_LIMITS.maxColumns,
): TableColumnInput[] {
  const merged = current.filter((column) => column.name.trim() !== "").slice(0, max);
  const names = new Set(merged.map((column) => nameKey(column.name)));
  for (const suggestion of suggested) {
    if (merged.length >= max) break;
    const key = nameKey(suggestion.name);
    if (!key || names.has(key)) continue;
    names.add(key);
    merged.push({
      name: suggestion.name.trim(),
      ...(suggestion.description?.trim() ? { description: suggestion.description.trim() } : {}),
      type: suggestion.type,
    });
  }
  return merged;
}

/** The columns as a request carries them: trimmed, ids kept, no empty description. */
export function cleanColumns(columns: readonly TableColumnInput[]): TableColumnInput[] {
  return columns.map((column) => {
    const description = column.description?.trim();
    return {
      ...(column.id ? { id: column.id } : {}),
      name: column.name.trim(),
      ...(description ? { description } : {}),
      type: column.type,
    };
  });
}
