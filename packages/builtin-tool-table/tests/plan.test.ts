import assert from "node:assert/strict";
import test from "node:test";
import { tableContentSchema } from "@sourceweft/contracts/table";
import { TABLE_FIXTURE_EN } from "../src/testing";
import { planFill, planSourceCalls, resolveColumns } from "../src/engine/plan";
import {
  columnsOf,
  dateColumn,
  numberColumn,
  previousOf,
  sourceOf,
  textColumn,
} from "./helpers";

const sources = () => [sourceOf("a"), sourceOf("b")];
const baseColumns = () =>
  columnsOf(textColumn("Design"), numberColumn("Sample size"), dateColumn("Published"));

function plan(
  columns: ReturnType<typeof columnsOf>,
  current: ReturnType<typeof sources>,
  previous?: ReturnType<typeof previousOf>,
) {
  return planFill({ columns, sources: current, language: "en", ...(previous ? { previous } : {}) });
}

test("the shared fixtures are valid table content with reusable and non-reusable cells", () => {
  for (const content of [TABLE_FIXTURE_EN]) {
    assert.doesNotThrow(() => tableContentSchema.parse(content));
  }
  const statuses = TABLE_FIXTURE_EN.rows.flatMap((row) =>
    Object.values(row.cells).map((cell) => cell.status),
  );
  assert.deepEqual([...new Set(statuses)].sort(), ["found", "not_found", "unverified"]);
});

test("resolveColumns keeps an id the previous version has, mints one otherwise, and recomputes fingerprints", () => {
  const previous = baseColumns();
  const resolved = resolveColumns(
    [
      { id: previous[0]!.id, name: "Study design", description: "How it was run", type: "text" },
      { id: previous[1]!.id, name: "Sample size", type: "number" },
      { name: "Funding", type: "text" },
    ],
    previous,
  );
  assert.equal(resolved[0]!.id, previous[0]!.id);
  assert.equal(resolved[1]!.id, previous[1]!.id);
  assert.match(resolved[2]!.id, /^col_[0-9a-f]{32}$/);
  assert.ok(!previous.some((column) => column.id === resolved[2]!.id));
  // Same id and name, new description: the fingerprint moved.
  assert.notEqual(resolved[0]!.fingerprint, previous[0]!.fingerprint);
  // Unchanged name and type: the fingerprint is the same.
  assert.equal(resolved[1]!.fingerprint, previous[1]!.fingerprint);
});

test("resolveColumns mints a fresh id for an id the previous version does not have, and with no previous version", () => {
  const stray = `col_${"f".repeat(32)}`;
  const [column] = resolveColumns([{ id: stray, name: "X", type: "text" }], baseColumns());
  assert.notEqual(column!.id, stray);
  const [alone] = resolveColumns([{ id: stray, name: "X", type: "text" }]);
  assert.notEqual(alone!.id, stray);
});

test("resolveColumns trims names and drops an empty description", () => {
  const [column] = resolveColumns([{ name: "  Funding  ", description: "", type: "text" }]);
  assert.equal(column!.name, "Funding");
  assert.equal("description" in column!, false);
});

test("an unchanged table plans zero calls and reuses every cell", () => {
  const columns = baseColumns();
  const current = sources();
  const previous = previousOf({ columns, sources: current });
  const result = plan(columns, current, previous);
  assert.deepEqual(
    [result.calls, result.cellsToFill, result.reusedCells, result.totalTokens],
    [0, 0, 6, 0],
  );
});

test("a table without a previous version plans one call per indexed source for every column", () => {
  const result = plan(baseColumns(), sources());
  assert.deepEqual([result.calls, result.cellsToFill, result.reusedCells], [2, 6, 0]);
  assert.ok(result.totalTokens > 0);
});

test("adding one column plans one call per indexed source, for that column only", () => {
  const old = baseColumns();
  const current = sources();
  const previous = previousOf({ columns: old, sources: current });
  const columns = resolveColumns(
    [...old.map(({ id, name, type }) => ({ id, name, type })), { name: "Funding", type: "text" }],
    old,
  );
  const result = plan(columns, current, previous);
  assert.deepEqual([result.calls, result.cellsToFill, result.reusedCells], [2, 2, 6]);
  const perSource = planSourceCalls({ columns, sources: current, language: "en", previous });
  for (const entry of perSource) {
    assert.deepEqual(entry.missingColumnIds, [columns[3]!.id]);
    assert.equal(Object.keys(entry.reused).length, 3);
  }
});

test("a source whose content hash changed is refilled in full; the other is reused", () => {
  const columns = baseColumns();
  const before = sources();
  const previous = previousOf({ columns, sources: before });
  const after = [sourceOf("a", undefined, { contentHash: "hash-a-v2" }), before[1]!];
  const result = plan(columns, after, previous);
  assert.deepEqual([result.calls, result.cellsToFill, result.reusedCells], [1, 3, 3]);
  const perSource = planSourceCalls({ columns, sources: after, language: "en", previous });
  assert.deepEqual(perSource.map((entry) => entry.missingColumnIds.length), [3, 0]);
});

test("a changed output language invalidates every reused cell", () => {
  const columns = baseColumns();
  const current = sources();
  const previous = previousOf({ columns, sources: current, language: "en" });
  const result = planFill({ columns, sources: current, language: "zh-CN", previous });
  assert.deepEqual([result.calls, result.cellsToFill, result.reusedCells], [2, 6, 0]);
});

test("editing a column description refills that column and keeps its id", () => {
  const old = baseColumns();
  const current = sources();
  const previous = previousOf({ columns: old, sources: current });
  const columns = resolveColumns(
    old.map(({ id, name, type }, index) => ({
      id,
      name,
      type,
      ...(index === 1 ? { description: "People enrolled" } : {}),
    })),
    old,
  );
  assert.equal(columns[1]!.id, old[1]!.id);
  const result = plan(columns, current, previous);
  assert.deepEqual([result.calls, result.cellsToFill, result.reusedCells], [2, 2, 4]);
  for (const entry of planSourceCalls({ columns, sources: current, language: "en", previous })) {
    assert.deepEqual(entry.missingColumnIds, [old[1]!.id]);
  }
});

test("renaming a column refills that column and keeps its id; changing only letter case does not", () => {
  const old = baseColumns();
  const current = sources();
  const previous = previousOf({ columns: old, sources: current });
  const renamed = resolveColumns(
    old.map(({ id, name, type }, index) => ({ id, name: index === 0 ? "Study type" : name, type })),
    old,
  );
  assert.equal(renamed[0]!.id, old[0]!.id);
  assert.deepEqual(plan(renamed, current, previous).cellsToFill, 2);
  const recased = resolveColumns(
    old.map(({ id, name, type }, index) => ({ id, name: index === 0 ? name.toUpperCase() : name, type })),
    old,
  );
  assert.deepEqual(plan(recased, current, previous).cellsToFill, 0);
});

test("a removed source and a removed column plan no call and appear nowhere in the plan", () => {
  const old = baseColumns();
  const before = [sourceOf("a"), sourceOf("b"), sourceOf("gone")];
  const previous = previousOf({ columns: old, sources: before });
  const columns = old.slice(0, 2); // the date column is removed
  const current = [before[0]!, before[1]!];
  const result = plan(columns, current, previous);
  assert.deepEqual([result.calls, result.cellsToFill, result.reusedCells], [0, 0, 4]);
  const perSource = planSourceCalls({ columns, sources: current, language: "en", previous });
  assert.deepEqual(perSource.map((entry) => entry.sourceId), ["a", "b"]);
  for (const entry of perSource) {
    assert.deepEqual(Object.keys(entry.reused).sort(), columns.map((column) => column.id).sort());
    assert.ok(!(old[2]!.id in entry.reused));
    assert.ok(!entry.missingColumnIds.includes(old[2]!.id));
  }
});

test("unverified cells and cells of a failed row are never reused", () => {
  const columns = baseColumns();
  const current = sources();
  const previous = previousOf({
    columns,
    sources: current,
    status: (source, column) =>
      source.sourceId === "a" && column.id === columns[0]!.id
        ? "unverified"
        : column.id === columns[2]!.id
          ? "not_found"
          : "found",
    rowStatus: (source) => (source.sourceId === "b" ? "failed" : "ok"),
  });
  const perSource = planSourceCalls({ columns, sources: current, language: "en", previous });
  // Row a: the unverified cell is retried; found and not_found cells are kept.
  assert.deepEqual(perSource[0]!.missingColumnIds, [columns[0]!.id]);
  assert.deepEqual(Object.keys(perSource[0]!.reused).sort(), [columns[1]!.id, columns[2]!.id].sort());
  // Row b failed last time: nothing is reused.
  assert.equal(perSource[1]!.missingColumnIds.length, 3);
  assert.equal(Object.keys(perSource[1]!.reused).length, 0);
});

test("not_found cells are reused", () => {
  const columns = baseColumns();
  const current = sources();
  const previous = previousOf({ columns, sources: current, status: () => "not_found" });
  assert.deepEqual(plan(columns, current, previous).calls, 0);
});

test("an unindexed source plans no call and is not counted as reusable", () => {
  const columns = baseColumns();
  const current = [sourceOf("a"), sourceOf("b", undefined, { indexed: false })];
  const result = plan(columns, current);
  assert.deepEqual([result.calls, result.cellsToFill, result.reusedCells], [1, 3, 0]);
  const perSource = planSourceCalls({ columns, sources: current, language: "en" });
  assert.deepEqual(perSource[1], {
    sourceId: "b",
    missingColumnIds: [],
    reused: {},
    tokens: 0,
    groups: 0,
  });
});

test("an indexed source without any text is treated like an unindexed one", () => {
  const empty = { ...sourceOf("a"), chunks: [] };
  const [entry] = planSourceCalls({ columns: baseColumns(), sources: [empty], language: "en" });
  assert.deepEqual([entry!.missingColumnIds.length, entry!.groups, entry!.tokens], [0, 0, 0]);
});

/** One chunk of exactly `tokens` estimated tokens (4 ASCII characters each). */
const sourceOfTokens = (id: string, tokens: number, options?: Parameters<typeof sourceOf>[2]) =>
  sourceOf(id, ["x".repeat(tokens * 4)], options);

test("300,001 tokens to read exceeds the limit; the same corpus with one source reusable does not", () => {
  const columns = baseColumns();
  const current = [sourceOfTokens("a", 150_000), sourceOfTokens("b", 150_001)];
  const over = plan(columns, current);
  assert.equal(over.totalTokens, 300_001);
  assert.equal(over.exceedsLimit, true);

  const exact = [sourceOfTokens("a", 150_000), sourceOfTokens("b", 150_000)];
  assert.equal(plan(columns, exact).exceedsLimit, false);

  const previous = previousOf({ columns, sources: [current[1]!] });
  const reusable = plan(columns, current, previous);
  assert.equal(reusable.totalTokens, 150_000);
  assert.equal(reusable.exceedsLimit, false);
});

test("a source above the single-pass limit is read in several groups, one call each", () => {
  const columns = baseColumns();
  const small = plan(columns, [sourceOfTokens("a", 40_000)]);
  assert.equal(small.calls, 1);
  const big = sourceOf(
    "a",
    Array.from({ length: 6 }, () => "x".repeat(8_000 * 4)),
  );
  const [entry] = planSourceCalls({ columns, sources: [big], language: "en" });
  assert.ok(entry!.groups > 1);
  assert.equal(plan(columns, [big]).calls, entry!.groups);
});
