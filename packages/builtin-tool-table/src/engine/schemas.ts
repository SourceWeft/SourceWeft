import {
  TABLE_COLUMN_TYPES,
  type TableColumnType,
} from "@sourceweft/contracts/table";

/**
 * What the model is asked to return, as strict JSON Schema: every object
 * closed and fully required, optional values as `null` unions, no `$ref`.
 * Bounds the strict mode cannot carry are enforced on the Zod side, where each
 * entry is read on its own so one bad entry is dropped instead of failing the
 * whole answer.
 */

const nullableString = (description: string) =>
  ({ type: ["string", "null"], description }) as const;

export const SUGGEST_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["columns"],
  properties: {
    columns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "type"],
        properties: {
          name: { type: "string", description: "A short column title." },
          description: nullableString(
            "One sentence telling a reader what this column holds, or null.",
          ),
          type: { type: "string", enum: [...TABLE_COLUMN_TYPES] },
        },
      },
    },
  },
} as const;

export const SUGGEST_SCHEMA = {
  name: "table_columns",
  description: "Suggested columns for a comparison table of the given sources.",
  schema: SUGGEST_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entries of the model's `columns` array; anything else reads as none. */
export function readSuggestedEntries(raw: unknown): unknown[] {
  return isRecord(raw) && Array.isArray(raw.columns) ? raw.columns : [];
}

export type SuggestedColumn = {
  name: string;
  description: string | null;
  type: TableColumnType;
};

/** One suggested column, or null when the entry is not well formed. */
export function readSuggestedColumn(entry: unknown): SuggestedColumn | null {
  if (!isRecord(entry) || typeof entry.name !== "string") return null;
  const type = (TABLE_COLUMN_TYPES as readonly unknown[]).includes(entry.type)
    ? (entry.type as TableColumnType)
    : null;
  if (!type) return null;
  return {
    name: entry.name,
    description: typeof entry.description === "string" ? entry.description : null,
    type,
  };
}

/* ------------------------------------------------------------------- fill */

export const FILL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cells"],
  properties: {
    cells: {
      type: "array",
      description: "Exactly one entry for every requested column.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["columnId", "found", "value", "chunk", "quote"],
        properties: {
          columnId: { type: "string", description: "The id of the column, as given." },
          found: {
            type: "boolean",
            description: "False when the chunks do not state it.",
          },
          value: nullableString("The value, at most 300 characters; null when not found."),
          chunk: nullableString(
            "The handle (for example \"c12\") of the one chunk that states it; null when not found.",
          ),
          quote: nullableString(
            "A passage copied word for word from that chunk, at most 300 characters; null when not found.",
          ),
        },
      },
    },
  },
} as const;

export const FILL_SCHEMA = {
  name: "table_cells",
  description: "The values of the requested columns for one source document.",
  schema: FILL_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
};

export const MERGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["choice"],
  properties: {
    choice: {
      type: "integer",
      description: "Zero-based index of the candidate the passages support best.",
    },
  },
} as const;

export const MERGE_SCHEMA = {
  name: "table_cell_choice",
  description: "Which candidate value of one cell is best supported.",
  schema: MERGE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
};

/** One answer entry of the fill call, as far as it is well formed. */
export type RawCell = {
  columnId: string;
  found: boolean;
  value: string | null;
  chunk: string | null;
  quote: string | null;
};

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * The entries of a fill answer, one per column (the first wins if a column is
 * repeated). Null when the answer is not an object with a `cells` array, which
 * the caller treats as a failed call. An entry that is not well formed is
 * dropped; the column then reads as unanswered.
 */
export function readFillAnswer(raw: unknown): RawCell[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.cells)) return null;
  const cells = new Map<string, RawCell>();
  for (const entry of raw.cells) {
    if (!isRecord(entry) || typeof entry.columnId !== "string") continue;
    if (typeof entry.found !== "boolean" || cells.has(entry.columnId)) continue;
    cells.set(entry.columnId, {
      columnId: entry.columnId,
      found: entry.found,
      value: stringOrNull(entry.value),
      chunk: stringOrNull(entry.chunk),
      quote: stringOrNull(entry.quote),
    });
  }
  return [...cells.values()];
}

/** The index the merge call picked, or null when the answer has none. */
export function readMergeChoice(raw: unknown): number | null {
  return isRecord(raw) && Number.isInteger(raw.choice) ? (raw.choice as number) : null;
}
