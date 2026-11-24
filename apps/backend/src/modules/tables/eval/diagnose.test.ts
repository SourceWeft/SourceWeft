import assert from "node:assert/strict";
import { test } from "vitest";
import { diagnoseRun, type DiagnosisCall } from "./diagnose";

const col = (n: number) => `col_${String(n).padStart(32, "0")}`;
const columns = [
  { id: "name", engineId: col(1), type: "text" as const },
  { id: "revenue", engineId: col(2), type: "number" as const },
  { id: "date", engineId: col(3), type: "date" as const },
  { id: "listed", engineId: col(4), type: "boolean" as const },
  { id: "ceo", engineId: col(5), type: "text" as const },
  { id: "hq", engineId: col(6), type: "text" as const },
];
const chunks = [
  {
    handle: "c1",
    chunkId: "k-a-0",
    sourceId: "a",
    text: "公司名称：比亚迪。营业收入为1,200亿元。",
  },
  {
    handle: "c2",
    chunkId: "k-a-1",
    sourceId: "a",
    text: "报告日期为2024年3月。公司总部位于深圳。",
  },
  {
    handle: "c3",
    chunkId: "k-b-0",
    sourceId: "b",
    text: "宁德时代总部位于宁德。",
  },
];
const key = (rest: string) => `table:eval-s-run1:v1:${rest}`;
const cell = (
  columnId: string,
  found: boolean,
  value: string | null,
  chunk: string | null,
  quote: string | null,
) => ({
  columnId,
  found,
  value,
  chunk,
  quote,
});

const calls: DiagnosisCall[] = [
  {
    operation: "table.fill",
    idempotencyKey: key("a:g0"),
    ok: true,
    // English text values: fails the zh-CN language check.
    rawOutput: { cells: [cell(col(1), true, "BYD Company", "c1", null)] },
  },
  {
    operation: "table.fill",
    idempotencyKey: key("a:g0:retry"),
    ok: true,
    rawOutput: {
      cells: [
        cell(col(1), true, "比亚迪", "c1", "公司名称：比亚迪"),
        cell(col(2), true, "1,300亿元", "c1", "营业收入为1,200亿元"),
        cell(col(3), true, "2024年5月", "c2", "报告日期为2024年3月"),
        cell(col(4), true, "也许", "c2", "公司总部位于深圳"),
        // ceo omitted
        cell(col(6), true, "宁德", "c3", "宁德时代总部位于宁德"),
      ],
    },
  },
  {
    operation: "table.fill",
    idempotencyKey: key("b:g0"),
    ok: false,
    error: "timeout after 30000 ms",
  },
];

const anchorLog = [
  {
    requests: [
      { text: "比亚迪\n公司名称：比亚迪", chunkId: "k-a-0" },
      { text: "1,300亿元\n营业收入为1,200亿元", chunkId: "k-a-0" },
      { text: "2024年5月\n报告日期为2024年3月", chunkId: "k-a-1" },
      { text: "也许\n公司总部位于深圳", chunkId: "k-a-1" },
    ],
    results: [
      { quote: "公司名称：比亚迪", confidence: 1 },
      { quote: "营业收入为1,200亿元", confidence: 0.9 },
      { quote: "报告日期为2024年3月", confidence: 0.9 },
      { quote: "公司总部位于深圳", confidence: 0.8 },
    ],
  },
];
const figureLog = [
  { claim: "1,300亿元", passage: "营业收入为1,200亿元", result: false },
];

test("each unverified cell names its candidate and why it was rejected; a failed row names its failing call", () => {
  const diagnosis = diagnoseRun({
    artifactId: "eval-s-run1",
    versionNo: 1,
    language: "zh-CN",
    columns,
    chunks,
    calls,
    anchorLog,
    figureLog,
    rows: [
      {
        sourceId: "a",
        status: "ok",
        cells: {
          [col(1)]: { status: "found" },
          [col(2)]: { status: "unverified" },
          [col(3)]: { status: "unverified" },
          [col(4)]: { status: "unverified" },
          [col(5)]: { status: "unverified" },
          [col(6)]: { status: "unverified" },
        },
      },
    ],
    quoteChars: 300,
  });

  const byColumn = new Map(diagnosis.unverifiedCells.map((c) => [c.column, c]));
  assert.deepEqual([...byColumn.keys()].sort(), [
    "ceo",
    "date",
    "hq",
    "listed",
    "revenue",
  ]);

  const revenue = byColumn.get("revenue")!;
  assert.equal(revenue.candidates[0]!.outcome, "figure_check_failed");
  assert.equal(revenue.candidates[0]!.value, "1,300亿元");
  assert.deepEqual(revenue.candidates[0]!.detail?.valueFigures, [1.3e11]);
  assert.deepEqual(revenue.candidates[0]!.detail?.passageFigures, [1.2e11]);

  assert.equal(
    byColumn.get("date")!.candidates[0]!.outcome,
    "date_check_failed",
  );
  assert.equal(
    byColumn.get("listed")!.candidates[0]!.outcome,
    "boolean_unreadable",
  );
  assert.equal(
    byColumn.get("ceo")!.reason,
    "the model left the column out of its answer",
  );
  const hq = byColumn.get("hq")!.candidates[0]!;
  assert.equal(hq.outcome, "handle_of_another_source");
  assert.equal(hq.detail?.handleSourceId, "b");
  assert.equal(hq.detail?.quoteInChunk, true);

  assert.deepEqual(diagnosis.languageRetries, [
    { sourceId: "a", group: 0, retryPassed: true },
  ]);

  assert.equal(diagnosis.failedRows.length, 1);
  assert.equal(diagnosis.failedRows[0]!.sourceId, "b");
  assert.match(
    diagnosis.failedRows[0]!.reason,
    /b:g0 failed: timeout after 30000 ms/,
  );
});

test("an anchor the port could not find, an unreadable answer and a missing language retry are named", () => {
  const diagnosis = diagnoseRun({
    artifactId: "eval-s-run1",
    versionNo: 1,
    language: "zh-CN",
    columns,
    chunks,
    calls: [
      {
        operation: "table.fill",
        idempotencyKey: key("a:g0"),
        ok: true,
        rawOutput: {
          cells: [cell(col(1), true, "比亚迪汽车", "c1", "比亚迪汽车公司")],
        },
      },
      {
        operation: "table.fill",
        idempotencyKey: key("b:g0"),
        ok: true,
        rawOutput: { nope: true },
      },
    ],
    anchorLog: [
      {
        requests: [{ text: "比亚迪汽车\n比亚迪汽车公司", chunkId: "k-a-0" }],
        results: [null],
      },
    ],
    figureLog: [],
    rows: [
      {
        sourceId: "a",
        status: "ok",
        cells: { [col(1)]: { status: "unverified" } },
      },
    ],
    quoteChars: 300,
  });
  const name = diagnosis.unverifiedCells[0]!;
  assert.equal(name.candidates[0]!.outcome, "anchor_not_found");
  assert.equal(name.candidates[0]!.detail?.quoteInChunk, false);
  assert.match(diagnosis.failedRows[0]!.reason, /could not be read/);
});
