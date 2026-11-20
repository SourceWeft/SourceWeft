import assert from "node:assert/strict";
import test from "node:test";
import { TABLE_LIMITS, type TableColumnInput } from "@sourceweft/contracts/table";
import {
  blankTableColumn,
  cleanColumns,
  columnsProblem,
  mergeSuggestedColumns,
} from "../src/ui/column-inputs";

const column = (name: string, extra: Partial<TableColumnInput> = {}): TableColumnInput => ({
  name,
  type: "text",
  ...extra,
});

test("a new column is blank text", () => {
  assert.deepEqual(blankTableColumn(), { name: "", type: "text" });
});

test("columnsProblem asks for at least one column, a name on each, and at most the maximum", () => {
  assert.equal(columnsProblem([]), "none");
  assert.equal(columnsProblem([column("Price"), column("  ")]), "nameMissing");
  assert.equal(
    columnsProblem(Array.from({ length: TABLE_LIMITS.maxColumns + 1 }, (_, i) => column(`C${i}`))),
    "tooMany",
  );
  assert.equal(columnsProblem([column("Price")]), null);
  assert.equal(columnsProblem([column("A"), column("B")], 1), "tooMany");
});

test("suggestions keep the columns already typed and add only new names", () => {
  const typed = [
    column("Price", { type: "number" }),
    column(""),
    column("Warranty", { id: `col_${"1".repeat(32)}` }),
  ];
  const merged = mergeSuggestedColumns(typed, [
    column("price", { type: "number" }),
    column("Launch date", { type: "date" }),
    column(" WARRANTY "),
    column("Battery life", { description: "Hours of use" }),
  ]);
  assert.deepEqual(merged, [
    column("Price", { type: "number" }),
    column("Warranty", { id: `col_${"1".repeat(32)}` }),
    column("Launch date", { type: "date" }),
    column("Battery life", { description: "Hours of use" }),
  ]);
});

test("suggestions stop at the maximum and never bring an id along", () => {
  const typed = [column("A"), column("B")];
  const merged = mergeSuggestedColumns(
    typed,
    [column("C", { id: `col_${"2".repeat(32)}` }), column("D"), column("E")],
    3,
  );
  assert.deepEqual(merged, [column("A"), column("B"), column("C")]);
});

test("cleanColumns trims names and descriptions and drops an empty description", () => {
  assert.deepEqual(
    cleanColumns([
      column("  Price ", { description: "   ", type: "number" }),
      column("Warranty", { description: " Years ", id: `col_${"3".repeat(32)}` }),
    ]),
    [
      { name: "Price", type: "number" },
      { id: `col_${"3".repeat(32)}`, name: "Warranty", description: "Years", type: "text" },
    ],
  );
});
