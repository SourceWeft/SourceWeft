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
