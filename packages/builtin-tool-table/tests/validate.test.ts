import assert from "node:assert/strict";
import test from "node:test";
import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";
import {
  answerMatchesLanguage,
  anchorTextOf,
  keptValue,
  readEntry,
} from "../src/engine/validate";
import { figures } from "./helpers";

const own = new Set(["c1", "c2"]);
const entry = (overrides: Partial<Parameters<typeof readEntry>[0]> = {}) => ({
  columnId: "col",
  found: true,
  value: "randomised trial",
  chunk: "c1",
  quote: "randomised trial",
  ...overrides,
});
const evidenceOf = (quote: string): GroundedEvidence[] => [
  {
    kind: "chunk",
    sourceId: "s",
    documentId: "d",
    chunkId: "x",
    quote,
    quoteHash: `sha256:${"d".repeat(64)}`,
  },
];

test("a claim needs a value within the cell limit and a handle of this source's chunks", () => {
  assert.deepEqual(readEntry(entry(), own), {
    kind: "claim",
    value: "randomised trial",
    handle: "c1",
    quote: "randomised trial",
  });
  assert.deepEqual(readEntry(entry({ found: false }), own), { kind: "absent" });
  assert.equal(readEntry(entry({ chunk: "c9" }), own).kind, "invalid");
  assert.equal(readEntry(entry({ chunk: null }), own).kind, "invalid");
  assert.equal(readEntry(entry({ value: null }), own).kind, "invalid");
  assert.equal(readEntry(entry({ value: "   " }), own).kind, "invalid");
  assert.equal(readEntry(entry({ value: "v".repeat(301) }), own).kind, "invalid");
  assert.equal(readEntry(entry({ value: "v".repeat(300) }), own).kind, "claim");
});

test("whitespace in a value and quote is collapsed and an empty quote is none", () => {
  assert.deepEqual(readEntry(entry({ value: " a \n b ", quote: "  " }), own), {
    kind: "claim",
    value: "a b",
    handle: "c1",
    quote: null,
  });
});

test("the anchor text is the value and, on its own line, the quote", () => {
  assert.equal(anchorTextOf({ value: "v", quote: "q" }), "v\nq");
  assert.equal(anchorTextOf({ value: "v", quote: null }), "v");
});

test("type rules are checked against the evidence text and keep the value as written", () => {
  assert.equal(keptValue({ type: "text" }, "anything", evidenceOf("x"), figures), "anything");
  assert.equal(keptValue({ type: "number" }, "1,200", evidenceOf("1.2k people"), figures), "1,200");
  assert.equal(keptValue({ type: "number" }, "１２００", evidenceOf("1,200 people"), figures), "１２００");
  assert.equal(keptValue({ type: "number" }, "1,300", evidenceOf("1.2k people"), figures), undefined);
  assert.equal(keptValue({ type: "number" }, "many", evidenceOf("many people"), figures), undefined);
  assert.equal(keptValue({ type: "date" }, "2024-03-05", evidenceOf("5 March 2024"), figures), "2024-03-05");
  assert.equal(keptValue({ type: "date" }, "2024-03-06", evidenceOf("5 March 2024"), figures), undefined);
  assert.equal(keptValue({ type: "boolean" }, "Yes", evidenceOf("anything"), figures), "Yes");
  assert.equal(keptValue({ type: "boolean" }, "perhaps", evidenceOf("anything"), figures), undefined);
});

test("a date more precise than its evidence is kept at the evidence's precision", () => {
  assert.equal(keptValue({ type: "date" }, "2025-12-31", evidenceOf("截至2025年末"), figures), "2025");
  assert.equal(keptValue({ type: "date" }, "2025-12-31", evidenceOf("截至2025年12月"), figures), "2025-12");
  assert.equal(keptValue({ type: "date" }, "2024-12-31", evidenceOf("截至2025年末"), figures), undefined);
});

test("the answer language is judged on the text columns together", () => {
  const columns = new Map<string, { type: "text" | "number" }>([
    ["t", { type: "text" }],
    ["n", { type: "number" }],
  ]);
  const found = (columnId: string, value: string) => ({
    columnId,
    found: true,
    value,
    chunk: "c1",
    quote: null,
  });
  assert.equal(answerMatchesLanguage([found("t", "随机对照试验 RCT")], columns, "zh-CN"), true);
  assert.equal(answerMatchesLanguage([found("t", "randomised trial")], columns, "zh-CN"), false);
  assert.equal(answerMatchesLanguage([found("n", "1200")], columns, "zh-CN"), true);
  assert.equal(answerMatchesLanguage([found("t", "randomised trial")], columns, "en"), true);
  assert.equal(answerMatchesLanguage([], columns, "zh-CN"), true);
});
