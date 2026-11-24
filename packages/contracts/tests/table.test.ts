import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../src/sha256";
import {
  TABLE_COLUMN_TYPES,
  TABLE_LIMITS,
  TABLE_PAYLOAD_MAX_BYTES,
  TABLE_SCHEMA_VERSION,
  assertTablePayloadSize,
  newTableColumnId,
  newTableRowId,
  parseTableContent,
  tableCellFingerprint,
  tableColumnFingerprint,
  tableContentSchema,
  tableGenerateRequestSchema,
  tableRegenerateRequestSchema,
  tableSuggestColumnsRequestSchema,
} from "../src/table";
import {
  TABLE_CAPABILITY_FACTORY,
  TableCapabilityUnavailableError,
  isTableGenerationError,
  readTableCapability,
  TableGenerationError,
} from "../src/table-capability";

const QUOTE = "The cohort enrolled 1,200 participants.";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    kind: "chunk",
    sourceId: "src_1",
    documentId: "doc_1",
    chunkId: "chunk_1",
    chunkNo: 0,
    headingPath: null,
    quote: QUOTE,
    startChar: 0,
    endChar: QUOTE.length,
    quoteHash: `sha256:${sha256Hex(QUOTE)}`,
    ...overrides,
  };
}

const FP = "0123456789abcdef";

function foundCell(overrides: Record<string, unknown> = {}) {
  return {
    status: "found",
    value: "1,200",
    normalized: 1200,
    evidence: [evidence()],
    fingerprint: FP,
    ...overrides,
  };
}

function columnInputs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `Column ${i}`,
    type: "text" as const,
  }));
}

function sourceIds(count: number) {
  return Array.from({ length: count }, (_, i) => `s${i}`);
}

function stats(overrides: Record<string, unknown> = {}) {
  return {
    sources: 1,
    columns: 1,
    found: 1,
    notFound: 0,
    unverified: 0,
    reusedCells: 0,
    failedRows: 0,
    skippedRows: 0,
    modelCalls: 1,
    tokensEstimated: 100,
    ...overrides,
  };
}

type Row = {
  id: string;
  sourceId: string;
  documentId: string;
  title: string;
  contentHash: string;
  status: string;
  cells: Record<string, unknown>;
};
type Column = { id: string; name: string; type: string; fingerprint: string };

/** Valid content plus handles on its column and row, so tests can mutate them. */
function draft(overrides: Record<string, unknown> = {}) {
  const column: Column = {
    id: newTableColumnId(),
    name: "Sample size",
    type: "number",
    fingerprint: tableColumnFingerprint({ name: "Sample size", type: "number" }),
  };
  const row: Row = {
    id: newTableRowId(),
    sourceId: "src_1",
    documentId: "doc_1",
    title: "Paper one",
    contentHash: "sha256:abc",
    status: "ok",
    cells: { [column.id]: foundCell() },
  };
  const doc = {
    schemaVersion: TABLE_SCHEMA_VERSION,
    kind: "table",
    language: "en",
    columns: [column] as Column[],
    rows: [row] as Row[],
    generation: {
      promptVersion: "table-v1",
      modelAlias: "chat-default",
      stats: stats(),
      recipe: {
        columns: [{ id: column.id, name: "Sample size", type: "number" }],
        sourceIds: ["src_1"],
      },
    },
    ...overrides,
  };
  return { doc, column, row };
}

function content(overrides: Record<string, unknown> = {}) {
  return draft(overrides).doc;
}

/* ----------------------------------------------------------------- requests */

test("a request with more than 400 cells is rejected", () => {
  const result = tableGenerateRequestSchema.safeParse({
    threadId: "t",
    sourceIds: sourceIds(45),
    columns: columnInputs(9), // 405 cells
  });
  assert.equal(result.success, false);
});

test("exactly 400 cells are accepted", () => {
  const result = tableGenerateRequestSchema.safeParse({
    threadId: "t",
    sourceIds: sourceIds(50),
    columns: columnInputs(8),
  });
  assert.equal(result.success, true);
  assert.equal(TABLE_LIMITS.maxCells, 400);
});

test("401 cells are rejected and the issue names the cell ceiling", () => {
  // 1 column × 401 is impossible (50 sources), so use 50 × 9 = 450.
  const result = tableGenerateRequestSchema.safeParse({
    threadId: "t",
    sourceIds: sourceIds(50),
    columns: columnInputs(9),
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => /400/.test(i.message)));
  }
});

test("12 columns and 33 sources are accepted (396 cells)", () => {
  const result = tableGenerateRequestSchema.safeParse({
    threadId: "t",
    sourceIds: sourceIds(33),
    columns: columnInputs(12),
  });
  assert.equal(result.success, true);
});

test("13 columns, 51 sources, a 61-character column name, a 201-character description and a 301-character instruction are each rejected", () => {
  const base = { threadId: "t", sourceIds: sourceIds(2), columns: columnInputs(2) };
  assert.equal(tableGenerateRequestSchema.safeParse(base).success, true);
  assert.equal(
    tableGenerateRequestSchema.safeParse({ ...base, columns: columnInputs(13) }).success,
    false,
  );
  assert.equal(
    tableGenerateRequestSchema.safeParse({ ...base, sourceIds: sourceIds(51) }).success,
    false,
  );
  assert.equal(
    tableGenerateRequestSchema.safeParse({
      ...base,
      columns: [{ name: "x".repeat(61), type: "text" }],
    }).success,
    false,
  );
  assert.equal(
    tableGenerateRequestSchema.safeParse({
      ...base,
      columns: [{ name: "x".repeat(60), description: "d".repeat(201), type: "text" }],
    }).success,
    false,
  );
  assert.equal(
    tableGenerateRequestSchema.safeParse({
      ...base,
      columns: [{ name: "x".repeat(60), description: "d".repeat(200), type: "text" }],
    }).success,
    true,
  );
  assert.equal(
    tableGenerateRequestSchema.safeParse({ ...base, instruction: "i".repeat(301) }).success,
    false,
  );
  assert.equal(
    tableGenerateRequestSchema.safeParse({ ...base, instruction: "i".repeat(300) }).success,
    true,
  );
});

test("a request needs at least one source and one column, and a known column type", () => {
  const ok = { threadId: "t", sourceIds: ["s"], columns: columnInputs(1) };
  assert.equal(tableGenerateRequestSchema.safeParse({ ...ok, sourceIds: [] }).success, false);
  assert.equal(tableGenerateRequestSchema.safeParse({ ...ok, columns: [] }).success, false);
  assert.equal(
    tableGenerateRequestSchema.safeParse({ ...ok, columns: [{ name: "a", type: "money" }] })
      .success,
    false,
  );
  assert.deepEqual([...TABLE_COLUMN_TYPES], ["text", "number", "date", "boolean"]);
});

test("a request accepts visibility, language and an existing column id", () => {
  const result = tableGenerateRequestSchema.safeParse({
    threadId: "t",
    sourceIds: ["s"],
    columns: [{ id: newTableColumnId(), name: "a", type: "date" }],
    language: "zh-CN",
    visibility: "workspace",
  });
  assert.equal(result.success, true);
  assert.equal(
    tableGenerateRequestSchema.safeParse({
      threadId: "t",
      sourceIds: ["s"],
      columns: [{ id: "col_nope", name: "a", type: "date" }],
    }).success,
    false,
  );
});

test("regenerate and suggest-columns requests share the caps", () => {
  assert.equal(tableRegenerateRequestSchema.safeParse({}).success, true);
  assert.equal(
    tableRegenerateRequestSchema.safeParse({
      sourceIds: sourceIds(45),
      columns: columnInputs(9),
    }).success,
    false,
  );
  assert.equal(
    tableRegenerateRequestSchema.safeParse({ instruction: "i".repeat(301) }).success,
    false,
  );
  assert.equal(
    tableSuggestColumnsRequestSchema.safeParse({ sourceIds: ["s"], language: "en" }).success,
    true,
  );
  assert.equal(tableSuggestColumnsRequestSchema.safeParse({ sourceIds: [] }).success, false);
  assert.equal(
    tableSuggestColumnsRequestSchema.safeParse({ sourceIds: sourceIds(51) }).success,
    false,
  );
});

/* ------------------------------------------------------------------ content */

test("valid content parses", () => {
  const parsed = parseTableContent(content());
  assert.equal(parsed.kind, "table");
  assert.equal(parsed.rows.length, 1);
});

test("a found cell needs 1 or 2 evidence entries and a value of at most 300 characters", () => {
  const withCell = (cell: unknown) => {
    const { doc, column, row } = draft();
    row.cells = { [column.id]: cell };
    return tableContentSchema.safeParse(doc).success;
  };
  assert.equal(withCell(foundCell()), true);
  assert.equal(withCell(foundCell({ evidence: [evidence(), evidence({ chunkId: "c2" })] })), true);
  assert.equal(withCell(foundCell({ evidence: [] })), false);
  assert.equal(
    withCell(
      foundCell({
        evidence: [evidence(), evidence({ chunkId: "c2" }), evidence({ chunkId: "c3" })],
      }),
    ),
    false,
  );
  assert.equal(withCell(foundCell({ value: "v".repeat(300) })), true);
  assert.equal(withCell(foundCell({ value: "v".repeat(301) })), false);
  assert.equal(withCell(foundCell({ value: "" })), false);
  assert.equal(
    withCell(foundCell({ evidence: [evidence({ quote: "q".repeat(301) })] })),
    false,
  );
  assert.equal(withCell(foundCell({ evidence: undefined })), false);
});

test("unverified and not_found cells carry no value or evidence", () => {
  const withCell = (cell: unknown) => {
    const { doc, column, row } = draft();
    row.cells = { [column.id]: cell };
    return tableContentSchema.safeParse(doc).success;
  };
  assert.equal(withCell({ status: "unverified", fingerprint: FP }), true);
  assert.equal(withCell({ status: "not_found", fingerprint: FP }), true);
  assert.equal(withCell({ status: "unverified", value: "x", fingerprint: FP }), false);
  assert.equal(
    withCell({ status: "unverified", evidence: [evidence()], fingerprint: FP }),
    false,
  );
  assert.equal(withCell({ status: "not_found", value: "x", fingerprint: FP }), false);
  assert.equal(
    withCell({ status: "not_found", evidence: [evidence()], fingerprint: FP }),
    false,
  );
  assert.equal(withCell({ status: "found", fingerprint: FP }), false);
});

test("a cell fingerprint must be 16 hex digits", () => {
  const { doc, column, row } = draft();
  row.cells = { [column.id]: { status: "not_found", fingerprint: "xyz" } };
  assert.equal(tableContentSchema.safeParse(doc).success, false);
});

test("duplicate column ids, duplicate row source ids, and a cell under an unknown column id are rejected", () => {
  const dupColumns = draft();
  dupColumns.doc.columns.push({ ...dupColumns.column });
  assert.equal(tableContentSchema.safeParse(dupColumns.doc).success, false);

  const dupSources = draft();
  dupSources.doc.rows.push({ ...dupSources.row, id: newTableRowId() });
  assert.equal(tableContentSchema.safeParse(dupSources.doc).success, false);

  const dupRowIds = draft();
  dupRowIds.doc.rows.push({ ...dupRowIds.row, sourceId: "src_2" });
  assert.equal(tableContentSchema.safeParse(dupRowIds.doc).success, false);

  const unknown = draft();
  unknown.row.cells[newTableColumnId()] = { status: "not_found", fingerprint: FP };
  assert.equal(tableContentSchema.safeParse(unknown.doc).success, false);
});

test("content keeps the limits and the shape: a failed row has no cells, 13 columns are too many", () => {
  const failed = draft();
  failed.row.status = "failed";
  failed.row.cells = {};
  assert.equal(tableContentSchema.safeParse(failed.doc).success, true);

  const tooMany = draft();
  tooMany.doc.columns = Array.from({ length: 13 }, (_, i) => ({
    ...tooMany.column,
    id: newTableColumnId(),
    name: `c${i}`,
  }));
  tooMany.row.cells = {};
  assert.equal(tableContentSchema.safeParse(tooMany.doc).success, false);

  assert.equal(tableContentSchema.safeParse(content({ kind: "quiz" })).success, false);
  assert.equal(tableContentSchema.safeParse(content({ schemaVersion: 2 })).success, false);
  assert.throws(() => parseTableContent({}));
});

/* -------------------------------------------------------------- fingerprints */

test("renaming a column or editing its description changes the fingerprint; changing letter case does not", () => {
  const base = tableColumnFingerprint({ name: "Sample size", type: "number" });
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.notEqual(base, tableColumnFingerprint({ name: "Cohort size", type: "number" }));
  assert.notEqual(
    base,
    tableColumnFingerprint({ name: "Sample size", description: "participants", type: "number" }),
  );
  assert.equal(base, tableColumnFingerprint({ name: "sample SIZE", type: "number" }));
});

test("the column fingerprint ignores punctuation and whitespace but changes with type", () => {
  const base = tableColumnFingerprint({ name: "Sample size", type: "number" });
  assert.equal(base, tableColumnFingerprint({ name: "  Sample   size! ", type: "number" }));
  assert.equal(base, tableColumnFingerprint({ name: "Sample size", description: "", type: "number" }));
  assert.notEqual(base, tableColumnFingerprint({ name: "Sample size", type: "text" }));
});

test("the column fingerprint keeps name and description apart", () => {
  assert.notEqual(
    tableColumnFingerprint({ name: "a", description: "b", type: "text" }),
    tableColumnFingerprint({ name: "ab", type: "text" }),
  );
});

test("the cell fingerprint changes with each input and is stable otherwise", () => {
  const input = {
    columnFingerprint: "aaaaaaaaaaaaaaaa",
    contentHash: "sha256:one",
    promptVersion: "table-v1",
    language: "en",
  };
  const base = tableCellFingerprint(input);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(base, tableCellFingerprint({ ...input }));
  assert.notEqual(base, tableCellFingerprint({ ...input, columnFingerprint: "bbbbbbbbbbbbbbbb" }));
  assert.notEqual(base, tableCellFingerprint({ ...input, contentHash: "sha256:two" }));
  assert.notEqual(base, tableCellFingerprint({ ...input, promptVersion: "table-v2" }));
  assert.notEqual(base, tableCellFingerprint({ ...input, language: "zh-CN" }));
});

/* ---------------------------------------------------------------------- ids */

test("ids are col_ / r_ plus 32 hex digits and never repeat", () => {
  const column = newTableColumnId();
  const row = newTableRowId();
  assert.match(column, /^col_[0-9a-f]{32}$/);
  assert.match(row, /^r_[0-9a-f]{32}$/);
  assert.notEqual(newTableColumnId(), column);
  assert.notEqual(newTableRowId(), row);
});

/* ------------------------------------------------------------------ payload */

test("assertTablePayloadSize throws over 1 MiB and passes under", () => {
  assert.equal(TABLE_PAYLOAD_MAX_BYTES, 1024 * 1024);
  assert.doesNotThrow(() => assertTablePayloadSize({ text: "x".repeat(1000) }));
  assert.doesNotThrow(() =>
    assertTablePayloadSize({ text: "x".repeat(TABLE_PAYLOAD_MAX_BYTES - 20) }),
  );
  assert.throws(
    () => assertTablePayloadSize({ text: "x".repeat(TABLE_PAYLOAD_MAX_BYTES) }),
    /too large/,
  );
});

/* --------------------------------------------------------------- capability */

const generation = {
  suggestColumns: async () => [],
  resolveColumns: () => [],
  planFill: () => ({
    calls: 0,
    reusedCells: 0,
    cellsToFill: 0,
    totalTokens: 0,
    exceedsLimit: false,
  }),
  fillTable: async () => ({}) as never,
  limits: { maxTotalInputTokens: 1, jobTimeoutMs: 2 },
};

test("readTableCapability returns the module the entry factory builds", () => {
  const capability = readTableCapability(
    { [TABLE_CAPABILITY_FACTORY]: () => ({ generation }) },
    "generation",
  );
  assert.equal(capability.generation, generation);
  assert.equal(TABLE_CAPABILITY_FACTORY, "createTableCapability");
});

test("readTableCapability names the missing member", () => {
  const { fillTable: _omitted, ...incomplete } = generation;
  assert.throws(
    () =>
      readTableCapability(
        { [TABLE_CAPABILITY_FACTORY]: () => ({ generation: incomplete }) },
        "generation",
      ),
    (error: unknown) =>
      error instanceof TableCapabilityUnavailableError && /fillTable/.test(error.message),
  );
});

test("readTableCapability fails loudly without the factory or the group", () => {
  assert.throws(() => readTableCapability({}), TableCapabilityUnavailableError);
  assert.throws(() => readTableCapability(null), TableCapabilityUnavailableError);
  assert.throws(
    () => readTableCapability({ [TABLE_CAPABILITY_FACTORY]: () => ({}) }, "generation"),
    /generation/,
  );
  assert.doesNotThrow(() => readTableCapability({ [TABLE_CAPABILITY_FACTORY]: () => ({}) }));
});

test("the table generation error is the shared grounded generation error", () => {
  const error = new TableGenerationError("INSUFFICIENT_CREDITS", "no credits");
  assert.equal(isTableGenerationError(error), true);
  assert.equal(isTableGenerationError(new Error("x")), false);
});
