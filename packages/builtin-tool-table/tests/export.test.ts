import assert from "node:assert/strict";
import { test } from "node:test";
import { tableToCsv, tableToMarkdown } from "../src/export";
import {
  COLUMN_DATE,
  COLUMN_NOTE,
  COLUMN_PRICE,
  found,
  makeTable,
  notFound,
  unverified,
  withNote,
} from "./table-fixture";

const labels = {
  source: "Source",
  notFound: "Not mentioned",
  unverified: "Unverified",
  evidenceSuffix: "evidence",
};
const plain = { includeEvidence: false, labels };
const withEvidence = { includeEvidence: true, labels };

const BOM = "﻿";

function lines(csv: string) {
  return csv.slice(BOM.length).split("\r\n");
}

/** The note column (third data column) of the first data row, unquoted-only inputs. */
function noteCell(csv: string) {
  return lines(csv)[1]!.split(",")[3];
}

test("csv starts with a BOM, uses CRLF, puts the source title first and ends with a line break", () => {
  const table = makeTable([
    {
      n: 1,
      title: "Alpha report",
      cells: { [COLUMN_PRICE]: found("1,200 USD"), [COLUMN_NOTE]: found("ok") },
    },
    { n: 2, title: "Beta", cells: { [COLUMN_PRICE]: found("5") } },
  ]);
  const csv = tableToCsv(table, plain);
  assert.ok(csv.startsWith(BOM));
  assert.equal(csv.indexOf("\n"), csv.indexOf("\r\n") + 1, "no bare LF in the header");
  assert.ok(!/(?<!\r)\n/.test(csv), "every line break is CRLF");
  assert.ok(csv.endsWith("\r\n"));
  assert.deepEqual(lines(csv), [
    "Source,Price,Date,Note",
    'Alpha report,"1,200 USD",,ok',
    "Beta,5,,",
    "",
  ]);
});

test("not_found and unverified cells export as empty, never as the label", () => {
  const table = makeTable([
    {
      n: 1,
      title: "A",
      cells: { [COLUMN_PRICE]: notFound, [COLUMN_DATE]: unverified, [COLUMN_NOTE]: found("x") },
    },
  ]);
  const csv = tableToCsv(table, plain);
  assert.deepEqual(lines(csv)[1], "A,,,x");
  assert.ok(!csv.includes(labels.notFound));
  assert.ok(!csv.includes(labels.unverified));
});

test("RFC 4180: commas, quotes and line breaks are quoted and quotes doubled", () => {
  assert.equal(noteCell(tableToCsv(withNote("a,b"), plain)), '"a');
  const csv = tableToCsv(withNote('say "hi"\nthen, leave\r\nbye'), plain);
  assert.ok(csv.includes('"say ""hi""\nthen, leave\r\nbye"'));
  // A title with a comma is quoted too, and so is a header.
  const titled = tableToCsv(withNote("x", 'Smith, "J."'), plain);
  assert.ok(titled.includes('"Smith, ""J."""'));
  const named = tableToCsv(makeTable([], { [COLUMN_NOTE]: "Notes, long" }), plain);
  assert.ok(named.includes('"Notes, long"'));
});

test("number cells export the original value, not the normalized number", () => {
  const table = makeTable([
    { n: 1, title: "A", cells: { [COLUMN_PRICE]: found("1.2k", ["q"], 1200) } },
  ]);
  const csv = tableToCsv(table, plain);
  assert.deepEqual(lines(csv)[1], "A,1.2k,,");
  assert.ok(!csv.includes("1200"));
});

test("includeEvidence adds one column after each data column holding the first quote", () => {
  const table = makeTable([
    {
      n: 1,
      title: "A",
      cells: {
        [COLUMN_PRICE]: found("10", ["first quote", "second quote"]),
        [COLUMN_DATE]: notFound,
        [COLUMN_NOTE]: found("n", ["a, quote"]),
      },
    },
  ]);
  const csv = tableToCsv(table, withEvidence);
  assert.deepEqual(lines(csv), [
    "Source,Price,Price evidence,Date,Date evidence,Note,Note evidence",
    'A,10,first quote,,,n,"a, quote"',
    "",
  ]);
  assert.ok(!csv.includes("second quote"));
});

test("the evidence header suffix and the source header come from the caller", () => {
  const csv = tableToCsv(makeTable([]), {
    includeEvidence: true,
    labels: { source: "来源", notFound: "未提及", unverified: "未核实", evidenceSuffix: "出处" },
  });
  assert.deepEqual(lines(csv)[0], "来源,Price,Price 出处,Date,Date 出处,Note,Note 出处");
});

test("csv labels for not_found and unverified are optional because csv leaves them empty", () => {
  const csv = tableToCsv(makeTable([]), {
    includeEvidence: false,
    labels: { source: "Source", evidenceSuffix: "evidence" },
  });
  assert.deepEqual(lines(csv)[0], "Source,Price,Date,Note");
});

test("a table with no rows exports just its header", () => {
  assert.equal(tableToCsv(makeTable([]), plain), `${BOM}Source,Price,Date,Note\r\n`);
  assert.equal(
    tableToMarkdown(makeTable([]), labels),
    "| Source | Price | Date | Note |\n| --- | --- | --- | --- |\n",
  );
});

test("a failed or skipped row keeps its title and exports empty cells", () => {
  const table = makeTable([
    { n: 1, title: "Broken", status: "failed" },
    { n: 2, title: "Not indexed, yet", status: "skipped" },
  ]);
  assert.deepEqual(lines(tableToCsv(table, withEvidence)).slice(1), [
    "Broken,,,,,,",
    '"Not indexed, yet",,,,,,',
    "",
  ]);
  assert.equal(
    tableToMarkdown(table, labels),
    [
      "| Source | Price | Date | Note |",
      "| --- | --- | --- | --- |",
      "| Broken |  |  |  |",
      "| Not indexed, yet |  |  |  |",
      "",
    ].join("\n"),
  );
});

/* Review Focus 5: spreadsheet formula injection. */

for (const lead of ["=", "+", "-", "@"]) {
  test(`a cell value starting with ${lead} is prefixed with a single quote`, () => {
    const csv = tableToCsv(withNote(`${lead}SUM(A1)`), plain);
    assert.equal(noteCell(csv), `'${lead}SUM(A1)`);
  });
}

test("a cell value starting with a tab or a carriage return is prefixed too", () => {
  assert.equal(noteCell(tableToCsv(withNote("\t=1"), plain)), "'\t=1");
  // A CR forces quoting as well; the guard still comes first inside the quotes.
  assert.ok(tableToCsv(withNote("\r=1"), plain).includes(`"'\r=1"`));
});

test("a value that merely contains a formula character later is left alone", () => {
  assert.equal(noteCell(tableToCsv(withNote("a=b+c-d@e"), plain)), "a=b+c-d@e");
});

function priceCell(value: string) {
  const table = makeTable([{ n: 1, title: "A", cells: { [COLUMN_PRICE]: found(value) } }]);
  return lines(tableToCsv(table, plain))[1]!.slice(2);
}

test("a plain negative number in a number column is not prefixed", () => {
  assert.equal(priceCell("-5"), "-5,,");
  assert.equal(priceCell("-5%"), "-5%,,");
  assert.equal(priceCell("-0.25"), "-0.25,,");
  assert.equal(priceCell("5"), "5,,");
  // The thousands comma makes the field quoted, still without the guard.
  assert.equal(priceCell("-1,200.5"), '"-1,200.5",,');
});

test("anything else starting with a formula character keeps the guard in a number column", () => {
  for (const value of ["-5+1", "-=1", "-5 USD", "- 5", "-cmd|' /C calc'!A0", "-1,2,3", "-.5", "-5%%", "+5", "=5", "@5"]) {
    assert.ok(priceCell(value).replace(/^"/, "").startsWith("'"), value);
  }
});

test("a negative number in a text column keeps the guard", () => {
  assert.equal(noteCell(tableToCsv(withNote("-5"), plain)), "'-5");
});

test("the source title column is guarded", () => {
  const csv = tableToCsv(withNote("x", "=HYPERLINK(1)"), plain);
  assert.equal(lines(csv)[1]!.split(",")[0], "'=HYPERLINK(1)");
});

test("evidence quote columns are guarded", () => {
  const table = makeTable([
    {
      n: 1,
      title: "A",
      cells: { [COLUMN_NOTE]: found("n", ["=cmd|'/c calc'!A1"]) },
    },
  ]);
  const csv = tableToCsv(table, withEvidence);
  assert.ok(csv.includes(",'=cmd|'/c calc'!A1\r\n"));
});

test("column headers, which the user names, are guarded", () => {
  const csv = tableToCsv(makeTable([], { [COLUMN_NOTE]: "@owner" }), withEvidence);
  assert.ok(csv.includes(",'@owner,'@owner evidence"));
});

/* Markdown */

test("markdown renders a header, a separator and one row per source, with caller labels", () => {
  const table = makeTable([
    {
      n: 1,
      title: "Alpha",
      cells: {
        [COLUMN_PRICE]: found("1.2k", ["q"], 1200),
        [COLUMN_DATE]: notFound,
        [COLUMN_NOTE]: unverified,
      },
    },
  ]);
  assert.equal(
    tableToMarkdown(table, labels),
    [
      "| Source | Price | Date | Note |",
      "| --- | --- | --- | --- |",
      "| Alpha | 1.2k | Not mentioned | Unverified |",
      "",
    ].join("\n"),
  );
  const zh = tableToMarkdown(table, { source: "来源", notFound: "未提及", unverified: "未核实" });
  assert.ok(zh.startsWith("| 来源 | Price"));
  assert.ok(zh.includes("| Alpha | 1.2k | 未提及 | 未核实 |"));
});

test("markdown escapes pipes, backslashes and line breaks in titles, headers and values", () => {
  const table = makeTable([{ n: 1, title: "a|b", cells: { [COLUMN_NOTE]: found("x|y\nz\r\nw\\") } }], {
    [COLUMN_DATE]: "When|Where",
  });
  const out = tableToMarkdown(table, labels);
  assert.ok(out.includes("| When\\|Where |"));
  assert.ok(out.includes("| a\\|b |"));
  assert.ok(out.includes("| x\\|y z w\\\\ |"));
  for (const row of out.trimEnd().split("\n")) {
    assert.equal(row.replace(/\\\|/g, "").split("|").length, 6, row);
  }
});
