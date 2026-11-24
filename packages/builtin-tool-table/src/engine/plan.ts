import {
  newTableColumnId,
  tableCellFingerprint,
  tableColumnFingerprint,
  type TableCell,
  type TableColumn,
  type TableColumnInput,
} from "@sourceweft/contracts/table";
import type {
  FillTableInput,
  TableFillPlan,
  TableGenerationMembers,
  TableSourceInput,
} from "@sourceweft/contracts/table-capability";
import {
  assembleCorpus,
  groupCorpus,
  MAX_TOTAL_INPUT_TOKENS,
  SINGLE_PASS_MAX_INPUT_TOKENS,
} from "@sourceweft/grounded-generation";
import { TABLE_PROMPT_VERSION } from "./constants";

/**
 * Gives each column its id and its fingerprint.
 *
 * A column keeps the id it arrives with only when the previous version has a
 * column with that id; anything else is a new column and gets a new id. The
 * fingerprint is always computed from the current name, description and type,
 * so renaming a column or editing its description changes the fingerprint (the
 * column is refilled) while the id (and with it the viewer's per-column
 * settings) stays.
 */
export const resolveColumns: TableGenerationMembers["resolveColumns"] = (
  input: TableColumnInput[],
  previous?: TableColumn[],
) => {
  const known = new Set((previous ?? []).map((column) => column.id));
  return input.map((column) => {
    const name = column.name.trim();
    const description = column.description?.trim();
    const spec = {
      name,
      ...(description ? { description } : {}),
      type: column.type,
    };
    return {
      id: column.id && known.has(column.id) ? column.id : newTableColumnId(),
      ...spec,
      fingerprint: tableColumnFingerprint(spec),
    };
  });
};

/** A source the engine can read: indexed and holding text. */
export function isReadable(source: TableSourceInput): boolean {
  return source.indexed && source.chunks.length > 0;
}

/** What one column of one source must look like to be reused as it is. */
export function cellFingerprintFor(
  column: TableColumn,
  source: Pick<TableSourceInput, "contentHash">,
  language: string,
): string {
  return tableCellFingerprint({
    columnFingerprint: column.fingerprint,
    contentHash: source.contentHash,
    promptVersion: TABLE_PROMPT_VERSION,
    language,
  });
}

export type SourceCallPlan = {
  sourceId: string;
  /** Columns the model has to answer for this source, in column order. */
  missingColumnIds: string[];
  /** Cells copied unchanged from the previous version, by column id. */
  reused: Record<string, TableCell>;
  /** Estimated tokens read for this source; 0 when no call is needed. */
  tokens: number;
  /** Model calls needed to read it (one per group); 0 when none is needed. */
  groups: number;
};

/**
 * Per current source, in selection order: which columns can be reused from the
 * previous version and which need the model. A cell is reused only when the
 * previous row is `ok` and the cell is `found` or `not_found` with the very
 * fingerprint the cell would get now (column, source content, prompt version
 * and language all unchanged). `unverified` cells and every cell of a `failed`
 * row are retried. Sources and columns that are no longer selected appear
 * nowhere. A source that is not indexed (or has no text) needs no call and
 * contributes nothing; its row is `skipped`.
 */
export function planSourceCalls(
  input: Pick<FillTableInput, "columns" | "sources" | "language" | "previous">,
): SourceCallPlan[] {
  const previousRows = new Map(
    (input.previous?.rows ?? []).map((row) => [row.sourceId, row]),
  );
  return input.sources.map((source): SourceCallPlan => {
    if (!isReadable(source)) {
      return { sourceId: source.sourceId, missingColumnIds: [], reused: {}, tokens: 0, groups: 0 };
    }
    const previousRow = previousRows.get(source.sourceId);
    const reused: Record<string, TableCell> = {};
    const missingColumnIds: string[] = [];
    for (const column of input.columns) {
      const cell = previousRow?.status === "ok" ? previousRow.cells[column.id] : undefined;
      if (
        cell &&
        (cell.status === "found" || cell.status === "not_found") &&
        cell.fingerprint === cellFingerprintFor(column, source, input.language)
      ) {
        reused[column.id] = cell;
      } else {
        missingColumnIds.push(column.id);
      }
    }
    if (missingColumnIds.length === 0) {
      return { sourceId: source.sourceId, missingColumnIds, reused, tokens: 0, groups: 0 };
    }
    const corpus = assembleCorpus(source.chunks, {
      maxTotalTokens: Number.POSITIVE_INFINITY,
    });
    const groups =
      corpus.totalTokens <= SINGLE_PASS_MAX_INPUT_TOKENS
        ? 1
        : groupCorpus(corpus.chunks).length;
    return { sourceId: source.sourceId, missingColumnIds, reused, tokens: corpus.totalTokens, groups };
  });
}

/** What a fill would cost, without any model call. */
export const planFill: TableGenerationMembers["planFill"] = (input): TableFillPlan => {
  const perSource = planSourceCalls(input);
  const totalTokens = perSource.reduce((sum, entry) => sum + entry.tokens, 0);
  return {
    calls: perSource.reduce((sum, entry) => sum + entry.groups, 0),
    reusedCells: perSource.reduce((sum, entry) => sum + Object.keys(entry.reused).length, 0),
    cellsToFill: perSource.reduce((sum, entry) => sum + entry.missingColumnIds.length, 0),
    totalTokens,
    exceedsLimit: totalTokens > MAX_TOTAL_INPUT_TOKENS,
  };
};
