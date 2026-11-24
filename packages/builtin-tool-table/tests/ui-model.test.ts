import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTableContent,
  type TableContent,
  type TableRow,
} from "@sourceweft/contracts/table";
import {
  nextSort,
  readHiddenColumns,
  rowFreshness,
  SOURCE_COLUMN_ID,
  sortRows,
  visibleColumns,
  withoutEvidence,
  writeHiddenColumns,
} from "../src/ui/table-model";

const hex = (n: number, length: number) => n.toString(16).padStart(length, "0");
const COLUMN = `col_${hex(1, 32)}`;

type Cell = number | string | boolean | null | "unverified";

function found(value: Cell) {
  return {
    status: "found" as const,
    value: String(value),
    ...(typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? { normalized: value }
      : {}),
    evidence: [
      {
        kind: "chunk" as const,
        sourceId: "s",
        documentId: "d",
        chunkId: "c",
        quote: "q",
        quoteHash: `sha256:${hex(1, 64)}`,
      },
    ],
    fingerprint: hex(1, 16),
  };
}

function table(cells: Cell[], status: TableRow["status"][] = []): TableContent {
  return parseTableContent({
    schemaVersion: 1,
    kind: "table",
    language: "en",
    columns: [{ id: COLUMN, name: "C", type: "text", fingerprint: hex(2, 16) }],
    rows: cells.map((cell, index) => ({
      id: `r_${hex(index + 1, 32)}`,
      sourceId: `source-${index + 1}`,
      documentId: `document-${index + 1}`,
      title: `Row ${index + 1}`,
      contentHash: "h",
      status: status[index] ?? "ok",
      cells:
        cell === null
          ? { [COLUMN]: { status: "not_found", fingerprint: hex(3, 16) } }
          : cell === "unverified"
            ? { [COLUMN]: { status: "unverified", fingerprint: hex(3, 16) } }
            : { [COLUMN]: found(cell) },
    })),
    generation: {
      promptVersion: "table-v1",
      modelAlias: "m",
      stats: {
        sources: cells.length,
        columns: 1,
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
        columns: [{ id: COLUMN, name: "C", type: "text" }],
        sourceIds: cells.map((_, index) => `source-${index + 1}`),
      },
    },
  });
}

const order = (rows: TableRow[]) => rows.map((row) => row.title);

test("numbers sort numerically, not as text", () => {
  const content = table([10, 9, 100]);
  assert.deepEqual(
    order(sortRows(content.rows, { columnId: COLUMN, direction: "asc" }, "en")),
    ["Row 2", "Row 1", "Row 3"],
  );
});

test("empty cells, unverified cells and unusable rows are last in both directions", () => {
  const content = table([5, null, 1, "unverified", 3], ["ok", "ok", "ok", "ok", "failed"]);
  for (const direction of ["asc", "desc"] as const) {
    const sorted = order(sortRows(content.rows, { columnId: COLUMN, direction }, "en"));
    assert.deepEqual(sorted.slice(-3), ["Row 2", "Row 4", "Row 5"], direction);
  }
  assert.deepEqual(
    order(sortRows(content.rows, { columnId: COLUMN, direction: "desc" }, "en")).slice(0, 2),
    ["Row 1", "Row 3"],
  );
});

test("ties keep the table's order whichever way it sorts", () => {
  const content = table([2, 1, 2, 1, 2]);
  assert.deepEqual(
    order(sortRows(content.rows, { columnId: COLUMN, direction: "asc" }, "en")),
    ["Row 2", "Row 4", "Row 1", "Row 3", "Row 5"],
  );
  assert.deepEqual(
    order(sortRows(content.rows, { columnId: COLUMN, direction: "desc" }, "en")),
    ["Row 1", "Row 3", "Row 5", "Row 2", "Row 4"],
  );
});

test("text sorts with the table's language and numbers inside it in order", () => {
  const content = table(["file 10", "file 9", "File 1"]);
  assert.deepEqual(
    order(sortRows(content.rows, { columnId: COLUMN, direction: "asc" }, "en")),
    ["Row 3", "Row 2", "Row 1"],
  );
  assert.doesNotThrow(() =>
    sortRows(content.rows, { columnId: COLUMN, direction: "asc" }, "not a language tag"),
  );
});

test("booleans sort false before true and the source column sorts by title", () => {
  const content = table([true, false]);
  assert.deepEqual(
    order(sortRows(content.rows, { columnId: COLUMN, direction: "asc" }, "en")),
    ["Row 2", "Row 1"],
  );
  assert.deepEqual(
    order(sortRows(content.rows, { columnId: SOURCE_COLUMN_ID, direction: "desc" }, "en")),
    ["Row 2", "Row 1"],
  );
});

test("no sort leaves the rows as they are, without changing the input", () => {
  const content = table([3, 1, 2]);
  const rows = sortRows(content.rows, null, "en");
  assert.deepEqual(order(rows), ["Row 1", "Row 2", "Row 3"]);
  assert.notEqual(rows, content.rows);
});

test("a column cycles ascending, descending, off; another column starts ascending", () => {
  const asc = nextSort(null, "a");
  assert.deepEqual(asc, { columnId: "a", direction: "asc" });
  const desc = nextSort(asc, "a");
  assert.deepEqual(desc, { columnId: "a", direction: "desc" });
  assert.equal(nextSort(desc, "a"), null);
  assert.deepEqual(nextSort(desc, "b"), { columnId: "b", direction: "asc" });
});

function withStorage(storage: unknown, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test("hidden columns are written and read back by column id", () => {
  const data = new Map<string, string>();
  withStorage(
    {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    },
    () => {
      writeHiddenColumns(new Set([COLUMN]));
      assert.deepEqual([...readHiddenColumns()], [COLUMN]);
      writeHiddenColumns(new Set());
      assert.deepEqual([...readHiddenColumns()], []);
    },
  );
});

test("storage that throws, is missing or holds junk means every column shows", () => {
  const throwing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  withStorage(throwing, () => {
    assert.equal(readHiddenColumns().size, 0);
    assert.doesNotThrow(() => writeHiddenColumns(new Set([COLUMN])));
  });
  withStorage(undefined, () => assert.equal(readHiddenColumns().size, 0));
  withStorage({ getItem: () => "{oops" }, () => assert.equal(readHiddenColumns().size, 0));
  withStorage({ getItem: () => '[1, "col_a", null]' }, () =>
    assert.deepEqual([...readHiddenColumns()], ["col_a"]),
  );
});

test("visible columns drop the hidden ones", () => {
  const content = table([1]);
  assert.equal(visibleColumns(content, new Set([COLUMN])).length, 0);
  assert.equal(visibleColumns(content, new Set(["col_other"])).length, 1);
});

test("a row is stale or deleted by its source id, deletion first", () => {
  const [row] = table([1]).rows;
  const freshness = (changed: string[], deleted: string[]) => ({
    state: "stale" as const,
    changedSourceIds: changed,
    deletedSourceIds: deleted,
  });
  assert.equal(rowFreshness(row!, undefined), null);
  assert.equal(rowFreshness(row!, freshness(["other"], [])), null);
  assert.equal(rowFreshness(row!, freshness(["source-1"], [])), "stale");
  assert.equal(rowFreshness(row!, freshness(["source-1"], ["source-1"])), "source_deleted");
});

test("a payload without evidence quotes opens once its evidence is replaced", () => {
  const content = table([1, null]);
  const stripped = JSON.parse(JSON.stringify(content));
  for (const row of stripped.rows) {
    for (const cell of Object.values<Record<string, unknown>>(row.cells)) {
      if (cell.status === "found") {
        cell.evidence = [{ kind: "chunk", sourceId: "s", documentId: "d", chunkId: "c", quoteHash: `sha256:${hex(1, 64)}` }];
      }
    }
  }
  assert.throws(() => parseTableContent(stripped));
  const parsed = parseTableContent(withoutEvidence(stripped));
  assert.equal(parsed.rows.length, 2);
  // Whatever the payload carried is gone from the parsed content.
  const withQuote = parseTableContent(withoutEvidence(JSON.parse(JSON.stringify(content))));
  assert.doesNotMatch(JSON.stringify(withQuote), /"quote":"q"/);
  assert.equal(withoutEvidence("not a table"), "not a table");
});

test("a payload without generation metadata opens, and a recipe left in is not kept", () => {
  const content = table([1]);
  const { generation: _generation, ...withoutGeneration } = JSON.parse(JSON.stringify(content));
  assert.throws(() => parseTableContent(withoutGeneration));
  assert.equal(parseTableContent(withoutEvidence(withoutGeneration)).rows.length, 1);

  const leaked = JSON.parse(JSON.stringify(content));
  leaked.generation.recipe.instruction = "the owner's private brief";
  const parsed = parseTableContent(withoutEvidence(leaked));
  assert.doesNotMatch(JSON.stringify(parsed), /private brief/);
});
