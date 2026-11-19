import { z } from "zod";
import { groundedEvidenceSchema } from "./grounded-evidence";
import { normalizeFingerprintText } from "./grounded-generation";
import { sha256Hex } from "./sha256";

/**
 * Data tables: one row per source, one column per question, every filled cell
 * backed by a quote from that source.
 *
 * The generated content is stored as an ordinary artifact payload, so these
 * schemas describe `artifact_versions.content_json` of a `table` artifact.
 *
 * Column and row ids are minted once (`newTableColumnId`, `newTableRowId`) and
 * never change, so a viewer's per-column settings survive a rename. Renaming a
 * column or editing its description changes the column `fingerprint`, which is
 * what makes regeneration refill that column. A cell's `fingerprint` ties it to
 * the column fingerprint, the source content, the prompt version and the output
 * language; a regeneration reuses a `found` or `not_found` cell whose
 * fingerprint is unchanged and never calls the model for it.
 */

export const TABLE_LIMITS = {
  maxSources: 50,
  maxColumns: 12,
  /** Sources × columns of one request; checked before anything is queued. */
  maxCells: 400,
  instructionChars: 300,
  columnNameChars: 60,
  columnDescriptionChars: 200,
  cellChars: 300,
  evidencePerCell: 2,
  quoteChars: 300,
} as const satisfies Record<string, number>;

/** Serialized size ceiling of one table payload (artifact content). */
export const TABLE_PAYLOAD_MAX_BYTES = 1024 * 1024;

export const TABLE_SCHEMA_VERSION = 1;

export const TABLE_COLUMN_TYPES = ["text", "number", "date", "boolean"] as const;
export const tableColumnTypeSchema = z.enum(TABLE_COLUMN_TYPES);
export type TableColumnType = z.infer<typeof tableColumnTypeSchema>;

export const tableVisibilitySchema = z.enum(["private", "workspace"]);

const fingerprintSchema = z.string().regex(/^[a-f0-9]{16}$/);
const columnIdSchema = z.string().regex(/^col_[0-9a-f]{32}$/);
const rowIdSchema = z.string().regex(/^r_[0-9a-f]{32}$/);
const languageSchema = z.string().min(2).max(35);

/** Where a cell value came from; the quote is source text, not model output. */
export const tableEvidenceSchema = groundedEvidenceSchema({
  quoteChars: TABLE_LIMITS.quoteChars,
});

/* ------------------------------------------------------------------ columns */

/** A column as the user states it; `id` is present when it already exists. */
export const tableColumnInputSchema = z.object({
  id: columnIdSchema.optional(),
  name: z.string().trim().min(1).max(TABLE_LIMITS.columnNameChars),
  description: z.string().max(TABLE_LIMITS.columnDescriptionChars).optional(),
  type: tableColumnTypeSchema,
});
export type TableColumnInput = z.infer<typeof tableColumnInputSchema>;

export const tableColumnSchema = z.object({
  id: columnIdSchema,
  name: z.string().min(1).max(TABLE_LIMITS.columnNameChars),
  description: z.string().max(TABLE_LIMITS.columnDescriptionChars).optional(),
  type: tableColumnTypeSchema,
  fingerprint: fingerprintSchema,
});
export type TableColumn = z.infer<typeof tableColumnSchema>;

/* -------------------------------------------------------------------- cells */

/**
 * `unverified` means the model gave a value that the source text could not
 * confirm; the value is deliberately not stored. The objects are strict so a
 * stray `value` or `evidence` on a cell that must not carry one is rejected.
 */
export const tableCellSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("found"),
      value: z.string().min(1).max(TABLE_LIMITS.cellChars),
      /** For sorting and export only; `value` keeps the source's own notation. */
      normalized: z.union([z.number(), z.string(), z.boolean()]).optional(),
      evidence: z.array(tableEvidenceSchema).min(1).max(TABLE_LIMITS.evidencePerCell),
      fingerprint: fingerprintSchema,
    })
    .strict(),
  z.object({ status: z.literal("not_found"), fingerprint: fingerprintSchema }).strict(),
  z.object({ status: z.literal("unverified"), fingerprint: fingerprintSchema }).strict(),
]);
export type TableCell = z.infer<typeof tableCellSchema>;

/* --------------------------------------------------------------------- rows */

export const tableRowSchema = z.object({
  id: rowIdSchema,
  sourceId: z.string().min(1),
  documentId: z.string().min(1),
  title: z.string(),
  /** Content hash of the source when the row was generated. */
  contentHash: z.string().min(1),
  /** `skipped` is a source that is not indexed yet. */
  status: z.enum(["ok", "failed", "skipped"]),
  /** Keyed by column id. */
  cells: z.record(z.string(), tableCellSchema),
});
export type TableRow = z.infer<typeof tableRowSchema>;

/* ------------------------------------------------------------------ content */

const count = z.number().int().nonnegative();

export const tableStatsSchema = z.object({
  sources: count,
  columns: count,
  found: count,
  notFound: count,
  unverified: count,
  reusedCells: count,
  failedRows: count,
  skippedRows: count,
  modelCalls: count,
  tokensEstimated: count,
});
export type TableStats = z.infer<typeof tableStatsSchema>;

const tableColumnInputsSchema = z
  .array(tableColumnInputSchema)
  .min(1)
  .max(TABLE_LIMITS.maxColumns);
const tableSourceIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(TABLE_LIMITS.maxSources);

/** The recipe is what "adjust and regenerate" pre-fills the dialog from. */
export const tableGenerationMetaSchema = z.object({
  promptVersion: z.string().min(1),
  modelAlias: z.string().min(1),
  stats: tableStatsSchema,
  recipe: z.object({
    instruction: z.string().max(TABLE_LIMITS.instructionChars).optional(),
    columns: tableColumnInputsSchema,
    sourceIds: tableSourceIdsSchema,
  }),
});
export type TableGenerationMeta = z.infer<typeof tableGenerationMetaSchema>;

function addDuplicateIssues(
  values: readonly string[],
  ctx: z.RefinementCtx,
  path: (string | number)[],
  what: string,
) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      ctx.addIssue({ code: "custom", path, message: `duplicate ${what} ${value}` });
      return;
    }
    seen.add(value);
  }
}

export const tableContentSchema = z
  .object({
    schemaVersion: z.literal(TABLE_SCHEMA_VERSION),
    kind: z.literal("table"),
    language: languageSchema,
    columns: z.array(tableColumnSchema).min(1).max(TABLE_LIMITS.maxColumns),
    rows: z.array(tableRowSchema).max(TABLE_LIMITS.maxSources),
    generation: tableGenerationMetaSchema,
  })
  .superRefine((value, ctx) => {
    const columnIds = value.columns.map((column) => column.id);
    addDuplicateIssues(columnIds, ctx, ["columns"], "column id");
    addDuplicateIssues(
      value.rows.map((row) => row.id),
      ctx,
      ["rows"],
      "row id",
    );
    addDuplicateIssues(
      value.rows.map((row) => row.sourceId),
      ctx,
      ["rows"],
      "row source id",
    );
    const known = new Set(columnIds);
    value.rows.forEach((row, rowIndex) => {
      for (const columnId of Object.keys(row.cells)) {
        if (!known.has(columnId)) {
          ctx.addIssue({
            code: "custom",
            path: ["rows", rowIndex, "cells", columnId],
            message: `cell under unknown column id ${columnId}`,
          });
        }
      }
    });
  });
export type TableContent = z.infer<typeof tableContentSchema>;

/** Parses content stored on a `table` artifact. */
export function parseTableContent(value: unknown): TableContent {
  return tableContentSchema.parse(value);
}

/* ----------------------------------------------------------------- requests */

function refuseTooManyCells(
  sourceIds: readonly unknown[] | undefined,
  columns: readonly unknown[] | undefined,
  ctx: z.RefinementCtx,
) {
  if (!sourceIds || !columns) return;
  const cells = sourceIds.length * columns.length;
  if (cells > TABLE_LIMITS.maxCells) {
    ctx.addIssue({
      code: "custom",
      path: ["columns"],
      message: `${sourceIds.length} sources × ${columns.length} columns is ${cells} cells; a table holds at most ${TABLE_LIMITS.maxCells}. Use fewer sources or columns.`,
    });
  }
}

function refuseDuplicates(
  request: { sourceIds?: string[]; columns?: TableColumnInput[] },
  ctx: z.RefinementCtx,
) {
  if (request.sourceIds) {
    addDuplicateIssues(request.sourceIds, ctx, ["sourceIds"], "source id");
  }
  if (request.columns) {
    addDuplicateIssues(
      request.columns.flatMap((column) => (column.id ? [column.id] : [])),
      ctx,
      ["columns"],
      "column id",
    );
  }
}

const instructionSchema = z.string().max(TABLE_LIMITS.instructionChars);

export const tableGenerateRequestSchema = z
  .object({
    /** Artifacts hang off a thread, so generation is always requested in one. */
    threadId: z.string().min(1),
    sourceIds: tableSourceIdsSchema,
    columns: tableColumnInputsSchema,
    /** The user's own instruction; never source text. */
    instruction: instructionSchema.optional(),
    /** BCP 47 tag; omitted means follow the sources. */
    language: languageSchema.optional(),
    visibility: tableVisibilitySchema.optional(),
  })
  .superRefine((request, ctx) => {
    refuseTooManyCells(request.sourceIds, request.columns, ctx);
    refuseDuplicates(request, ctx);
  });
export type TableGenerateRequest = z.infer<typeof tableGenerateRequestSchema>;

/** Every field omitted keeps the previous version's recipe. */
export const tableRegenerateRequestSchema = z
  .object({
    sourceIds: tableSourceIdsSchema.optional(),
    columns: tableColumnInputsSchema.optional(),
    instruction: instructionSchema.optional(),
    language: languageSchema.optional(),
  })
  .superRefine((request, ctx) => {
    refuseTooManyCells(request.sourceIds, request.columns, ctx);
    refuseDuplicates(request, ctx);
  });
export type TableRegenerateRequest = z.infer<typeof tableRegenerateRequestSchema>;

export const tableSuggestColumnsRequestSchema = z.object({
  sourceIds: tableSourceIdsSchema,
  instruction: instructionSchema.optional(),
  language: languageSchema.optional(),
});
export type TableSuggestColumnsRequest = z.infer<typeof tableSuggestColumnsRequestSchema>;

/* ------------------------------------------------------ fingerprints and ids */

/**
 * First 16 hex digits of sha256 over the column's type, name and description,
 * each normalized (case, width, punctuation and spaces dropped) on its own so
 * that name and description cannot run into one another. Renaming a column or
 * editing its description changes it; the column's id does not change.
 */
export function tableColumnFingerprint(column: {
  name: string;
  description?: string;
  type: TableColumnType;
}): string {
  const name = normalizeFingerprintText(column.name);
  const description = normalizeFingerprintText(column.description ?? "");
  return sha256Hex(`${column.type}:${name}:${description}`).slice(0, 16);
}

/**
 * First 16 hex digits of sha256 over the four things a cell's value depends
 * on. A cell is reused on regeneration only while all four are unchanged.
 */
export function tableCellFingerprint(input: {
  columnFingerprint: string;
  contentHash: string;
  promptVersion: string;
  language: string;
}): string {
  return sha256Hex(
    JSON.stringify([
      input.columnFingerprint,
      input.contentHash,
      input.promptVersion,
      input.language,
    ]),
  ).slice(0, 16);
}

function mintId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/** Mints a column id. Call once when the column is created; it never changes. */
export function newTableColumnId(): string {
  return mintId("col");
}

/** Mints a row id. Call once when the row is created; it never changes. */
export function newTableRowId(): string {
  return mintId("r");
}

/** Throws when serialized content exceeds `TABLE_PAYLOAD_MAX_BYTES`. */
export function assertTablePayloadSize(payload: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (bytes > TABLE_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `Table payload too large: ${bytes} bytes exceeds ${TABLE_PAYLOAD_MAX_BYTES / 1024} KB`,
    );
  }
}

/* ---------------------------------------------------------------- freshness */

/** Whether the table still matches its sources. */
export type TableFreshness = {
  state: "fresh" | "stale" | "source_deleted";
  changedSourceIds: string[];
  deletedSourceIds: string[];
};
