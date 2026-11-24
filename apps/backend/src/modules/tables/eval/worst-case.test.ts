import assert from "node:assert/strict";
import { TABLE_LIMITS, tableContentSchema } from "@sourceweft/contracts/table";
import { test } from "vitest";
import { buildWorstCaseTable, measureTableSize } from "./worst-case";

test("the worst case is 50 Chinese sources × 8 full columns, each cell 300 characters with two 300-character quotes", () => {
  const content = buildWorstCaseTable();
  assert.doesNotThrow(() => tableContentSchema.parse(content));
  assert.equal(content.rows.length, 50);
  assert.equal(content.columns.length, 8);
  assert.equal(content.language, "zh-CN");
  for (const row of content.rows) {
    assert.equal(Object.keys(row.cells).length, 8);
    for (const cell of Object.values(row.cells)) {
      assert.equal(cell.status, "found");
      if (cell.status !== "found") continue;
      assert.equal(cell.value.length, TABLE_LIMITS.cellChars);
      // Chinese throughout: three UTF-8 bytes per character.
      assert.equal(
        Buffer.byteLength(cell.value, "utf8"),
        3 * cell.value.length,
      );
      assert.equal(cell.evidence.length, TABLE_LIMITS.evidencePerCell);
      for (const evidence of cell.evidence) {
        assert.equal(evidence.quote.length, TABLE_LIMITS.quoteChars);
      }
    }
  }
});

test("the size measure reports bytes against the limit and the one-evidence fallback", () => {
  const measure = measureTableSize(buildWorstCaseTable(), { iterations: 2 });
  assert.ok(measure.bytes > 0);
  assert.ok(measure.bytesWithOneEvidence < measure.bytes);
  assert.equal(measure.limitBytes, 1024 * 1024);
  assert.equal(measure.overLimit, measure.bytes > measure.limitBytes);
  assert.ok(measure.parseMs.median >= 0);
  assert.ok(measure.validateMs.median >= 0);
});
