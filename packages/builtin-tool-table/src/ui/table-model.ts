import type {
  TableCell,
  TableColumn,
  TableContent,
  TableFreshness,
  TableRow,
} from "@sourceweft/contracts/table";
import { GROUNDED_EVIDENCE_PLACEHOLDER } from "@sourceweft/grounded-generation/public-evidence";

/**
 * Pure helpers behind the table viewer: sorting, per-column visibility
 * storage, row freshness and the share-surface payload narrowing. No React and
 * no browser globals at import time, so they are unit-tested under plain Node.
 */

/** The first column (the source title) sorts under this id. */
export const SOURCE_COLUMN_ID = "__source";

export type SortDirection = "asc" | "desc";
export type SortState = { columnId: string; direction: SortDirection };

/** None → ascending → descending → none, per column; another column starts ascending. */
export function nextSort(current: SortState | null, columnId: string): SortState | null {
  if (!current || current.columnId !== columnId) return { columnId, direction: "asc" };
  return current.direction === "asc" ? { columnId, direction: "desc" } : null;
}

type SortKey = number | string | boolean;

/**
 * What a cell sorts by: its `normalized` value, else its `value`. Only a
 * `found` cell has one; `not_found`, `unverified` and absent cells are empty.
 */
function cellSortKey(cell: TableCell | undefined): SortKey | null {
  if (!cell || cell.status !== "found") return null;
  return cell.normalized ?? cell.value;
}

function rowSortKey(row: TableRow, columnId: string): SortKey | null {
  if (columnId === SOURCE_COLUMN_ID) return row.title;
  // A failed or skipped row has no answers, whatever its cells hold.
  return row.status === "ok" ? cellSortKey(row.cells[columnId]) : null;
}

function makeCompare(language: string) {
  let collate: (a: string, b: string) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  try {
    "a".localeCompare("b", language, { numeric: true });
    collate = (a, b) => a.localeCompare(b, language, { numeric: true });
  } catch {
    // An unusable language tag falls back to plain code-unit order.
  }
  return (a: SortKey, b: SortKey): number => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
    return collate(String(a), String(b));
  };
}

/**
 * The rows in display order. The sort is stable (ties keep the table's own
 * order in both directions) and rows with nothing to sort by are always last,
 * so flipping the direction never moves an empty cell to the top.
 */
export function sortRows(
  rows: readonly TableRow[],
  sort: SortState | null,
  language: string,
): TableRow[] {
  if (!sort) return [...rows];
  const compare = makeCompare(language);
  const keyed = rows.map((row, index) => ({
    row,
    index,
    key: rowSortKey(row, sort.columnId),
  }));
  const filled = keyed.filter((entry) => entry.key !== null);
  const empty = keyed.filter((entry) => entry.key === null);
  const sign = sort.direction === "asc" ? 1 : -1;
  filled.sort(
    (a, b) => sign * compare(a.key as SortKey, b.key as SortKey) || a.index - b.index,
  );
  return [...filled, ...empty].map((entry) => entry.row);
}

/* --------------------------------------------------------------- visibility */

const HIDDEN_COLUMNS_STORAGE_KEY = "sourceweft:table:hidden-columns";

/**
 * The column ids the viewer chose to hide, remembered per column id (ids never
 * change, so a rename keeps the choice). Anything unreadable means "none".
 */
export function readHiddenColumns(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(HIDDEN_COLUMNS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Best effort: a blocked or full storage just means the choice is not kept. */
export function writeHiddenColumns(hidden: ReadonlySet<string>) {
  try {
    globalThis.localStorage?.setItem(
      HIDDEN_COLUMNS_STORAGE_KEY,
      JSON.stringify([...hidden]),
    );
  } catch {
    // Not remembered; the choice still applies for this view.
  }
}

/* ---------------------------------------------------------------- freshness */

export type RowFreshness = "stale" | "source_deleted" | null;

export function rowFreshness(
  row: TableRow,
  freshness: TableFreshness | undefined,
): RowFreshness {
  if (!freshness) return null;
  if (freshness.deletedSourceIds.includes(row.sourceId)) return "source_deleted";
  if (freshness.changedSourceIds.includes(row.sourceId)) return "stale";
  return null;
}

/* ------------------------------------------------------------------- payload */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stands in for the generation metadata a public payload does not carry. The
 * viewer never reads it; the strict schema requires it.
 */
const NO_GENERATION = {
  promptVersion: "-",
  modelAlias: "-",
  stats: {
    sources: 0,
    columns: 0,
    found: 0,
    notFound: 0,
    unverified: 0,
    reusedCells: 0,
    failedRows: 0,
    skippedRows: 0,
    modelCalls: 0,
    tokensEstimated: 0,
  },
  recipe: { columns: [{ name: "-", type: "text" }], sourceIds: ["-"] },
} as const;

/**
 * Narrows a payload to what a viewer that never shows evidence may hold, so it
 * parses with the strict schema: every found cell's evidence becomes a
 * placeholder and `generation` becomes a placeholder too. The public payload
 * carries neither the quotes nor the recipe (the server strips them, see
 * `publicTableContent`); a viewer that never shows evidence must still open
 * it, and must not be able to show a quote or the owner's instruction that
 * was left in by mistake.
 */
export function withoutEvidence(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.rows)) return payload;
  return {
    ...payload,
    generation: NO_GENERATION,
    rows: payload.rows.map((row: unknown) => {
      if (!isRecord(row) || !isRecord(row.cells)) return row;
      return {
        ...row,
        cells: Object.fromEntries(
          Object.entries(row.cells).map(([columnId, cell]) => [
            columnId,
            isRecord(cell) && cell.status === "found"
              ? { ...cell, evidence: [GROUNDED_EVIDENCE_PLACEHOLDER] }
              : cell,
          ]),
        ),
      };
    }),
  };
}

export function visibleColumns(
  content: TableContent,
  hidden: ReadonlySet<string>,
): TableColumn[] {
  return content.columns.filter((column) => !hidden.has(column.id));
}
