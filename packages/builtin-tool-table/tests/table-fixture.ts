import {
  parseTableContent,
  type TableCell,
  type TableContent,
} from "@sourceweft/contracts/table";

/** Small inline table data for the export and read-side tests. */

export const COLUMN_PRICE = `col_${"1".repeat(32)}`;
export const COLUMN_DATE = `col_${"2".repeat(32)}`;
export const COLUMN_NOTE = `col_${"3".repeat(32)}`;

const FP = "0123456789abcdef";

export function evidence(quote: string, sourceId = "s1") {
  return {
    kind: "chunk" as const,
    sourceId,
    documentId: `doc-${sourceId}`,
    chunkId: `chunk-${sourceId}`,
    quote,
    quoteHash: `sha256:${"a".repeat(64)}`,
  };
}

export function found(
  value: string,
  quotes: string[] = [`quote for ${value}`],
  normalized?: number | string | boolean,
): TableCell {
  return {
    status: "found",
    value,
    ...(normalized === undefined ? {} : { normalized }),
    evidence: quotes.map((quote) => evidence(quote)),
    fingerprint: FP,
  };
}

export const notFound: TableCell = { status: "not_found", fingerprint: FP };
export const unverified: TableCell = { status: "unverified", fingerprint: FP };

export type RowSpec = {
  n: number;
  title: string;
  status?: "ok" | "failed" | "skipped";
  cells?: Record<string, TableCell>;
};

export function makeTable(rows: RowSpec[], columnNames?: Partial<Record<string, string>>) {
  return parseTableContent({
    schemaVersion: 1,
    kind: "table",
    language: "en",
    columns: [
      { id: COLUMN_PRICE, name: columnNames?.[COLUMN_PRICE] ?? "Price", type: "number", fingerprint: FP },
      { id: COLUMN_DATE, name: columnNames?.[COLUMN_DATE] ?? "Date", type: "date", fingerprint: FP },
      { id: COLUMN_NOTE, name: columnNames?.[COLUMN_NOTE] ?? "Note", type: "text", fingerprint: FP },
    ],
    rows: rows.map((row) => ({
      id: `r_${String(row.n).repeat(32).slice(0, 32)}`,
      sourceId: `s${row.n}`,
      documentId: `doc-s${row.n}`,
      title: row.title,
      contentHash: `hash-${row.n}`,
      status: row.status ?? "ok",
      cells: row.cells ?? {},
    })),
    generation: {
      promptVersion: "table-v1",
      modelAlias: "m",
      stats: {
        sources: rows.length,
        columns: 3,
        found: 0,
        notFound: 0,
        unverified: 0,
        reusedCells: 0,
        failedRows: 0,
        skippedRows: 0,
        modelCalls: 0,
        tokensEstimated: 0,
      },
      recipe: {
        columns: [{ name: "Price", type: "number" }],
        // The recipe needs at least one id even when every row was dropped.
        sourceIds: rows.length > 0 ? rows.map((row) => `s${row.n}`) : ["s0"],
      },
    },
  }) satisfies TableContent;
}

/** One ok row whose note cell holds `value`. */
export function withNote(value: string, title = "Plain title") {
  return makeTable([{ n: 1, title, cells: { [COLUMN_NOTE]: found(value) } }]);
}
