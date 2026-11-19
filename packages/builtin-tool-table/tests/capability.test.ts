import assert from "node:assert/strict";
import test from "node:test";
import { tableContentSchema } from "@sourceweft/contracts/table";
import { readTableCapability } from "@sourceweft/contracts/table-capability";
import { MAX_TOTAL_INPUT_TOKENS } from "@sourceweft/grounded-generation";
import { createTableCapability } from "../src";
import { TABLE_JOB_TIMEOUT_MS } from "../src/engine/constants";
import { TABLE_FIXTURE_EN, TABLE_FIXTURE_ZH } from "../src/testing";
import { columnsOf, textColumn } from "./helpers";

test("the capability exposes every generation member", () => {
  assert.doesNotThrow(() => readTableCapability({ createTableCapability }, "generation"));
  const { generation } = readTableCapability({ createTableCapability }, "generation");
  assert.deepEqual(generation!.limits, {
    maxTotalInputTokens: MAX_TOTAL_INPUT_TOKENS,
    jobTimeoutMs: TABLE_JOB_TIMEOUT_MS,
  });
});

test("the entry module exports the factory the host loads", async () => {
  const entry = await import("../src/index");
  assert.equal(typeof entry.createTableCapability, "function");
  assert.doesNotThrow(() => readTableCapability(entry, "generation"));
});

test("the members work through the capability object", () => {
  const { generation } = readTableCapability({ createTableCapability }, "generation");
  const columns = generation!.resolveColumns([{ name: "Design", type: "text" }]);
  assert.equal(columns.length, 1);
  assert.deepEqual(columns, columnsOf(textColumn("Design")).map((column) => ({ ...column, id: columns[0]!.id })));
  const plan = generation!.planFill({ columns, sources: [], language: "en" });
  assert.deepEqual(plan, { calls: 0, reusedCells: 0, cellsToFill: 0, totalTokens: 0, exceedsLimit: false });
});

test("both shared fixtures are valid table content with every cell status", () => {
  for (const fixture of [TABLE_FIXTURE_EN, TABLE_FIXTURE_ZH]) {
    assert.doesNotThrow(() => tableContentSchema.parse(fixture));
    assert.equal(fixture.rows.length, 2);
    assert.equal(fixture.columns.length, 3);
    const statuses = fixture.rows.flatMap((row) => Object.values(row.cells).map((cell) => cell.status));
    assert.deepEqual([...new Set(statuses)].sort(), ["found", "not_found", "unverified"]);
  }
  assert.equal(TABLE_FIXTURE_EN.language, "en");
  assert.equal(TABLE_FIXTURE_ZH.language, "zh-CN");
});
