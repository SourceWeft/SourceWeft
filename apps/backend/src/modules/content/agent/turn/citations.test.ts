import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentCitation } from "../citation-registry";
import { normalizeAssistantCitations } from "./citations";

function citation(key: string, chunkId = `chunk-${key}`): AgentCitation {
  return {
    citation: key,
    sourceId: "source-1",
    sourceTitle: "Source",
    documentId: "document-1",
    chunkId,
    chunkNo: 0,
    score: 1,
    excerpt: "excerpt",
    quoteText: "excerpt",
    origin: "search_sources",
  };
}

test("normalizeAssistantCitations does not insert missing markers", () => {
  const available = ["c1", "c2", "c3", "c4", "c5"].map((key) => citation(key));

  const result = normalizeAssistantCitations({
    assistantText: "The answer uses the evidence but does not emit markers.",
    citations: available,
  });

  assert.equal(
    result.text,
    "The answer uses the evidence but does not emit markers.",
  );
  assert.deepEqual(
    result.citations.map((item) => item.citation),
    [],
  );
  assert.equal(result.invalidKeys.length, 0);
  assert.equal(result.removedInvalidCitations, false);
  assert.equal(result.markerCount, 0);
  assert.equal(result.validMarkerCount, 0);
});

test("normalizeAssistantCitations keeps supported standard citation markers", () => {
  const result = normalizeAssistantCitations({
    assistantText: "Supported [citation:c1] and [citation:c2].",
    citations: [citation("c1"), citation("c2"), citation("c3")],
  });

  assert.equal(result.text, "Supported [citation:c1] and [citation:c2].");
  assert.deepEqual(
    result.citations.map((item) => item.citation),
    ["c1", "c2"],
  );
  assert.deepEqual(result.invalidKeys, []);
  assert.equal(result.removedInvalidCitations, false);
  assert.equal(result.markerCount, 2);
  assert.equal(result.validMarkerCount, 2);
});

test("normalizeAssistantCitations preserves markers inside table value cells", () => {
  const result = normalizeAssistantCitations({
    assistantText: [
      "| Field | Value |",
      "|---|---|",
      "| Invoice total | 50.00 [citation:c1] |",
    ].join("\n"),
    citations: [citation("c1"), citation("c2")],
  });

  assert.equal(
    result.text,
    [
      "| Field | Value |",
      "|---|---|",
      "| Invoice total | 50.00 [citation:c1] |",
    ].join("\n"),
  );
  assert.deepEqual(
    result.citations.map((item) => item.citation),
    ["c1"],
  );
  assert.deepEqual(result.invalidKeys, []);
  assert.equal(result.removedInvalidCitations, false);
  assert.equal(result.markerCount, 1);
  assert.equal(result.validMarkerCount, 1);
});

test("normalizeAssistantCitations does not accept shortened citation markers", () => {
  const result = normalizeAssistantCitations({
    assistantText: "The model shortened the citation [c1].",
    citations: [citation("c1"), citation("c2")],
  });

  assert.equal(result.text, "The model shortened the citation [c1].");
  assert.deepEqual(
    result.citations.map((item) => item.citation),
    [],
  );
  assert.deepEqual(result.invalidKeys, []);
  assert.equal(result.removedInvalidCitations, false);
  assert.equal(result.markerCount, 0);
  assert.equal(result.validMarkerCount, 0);
});

test("normalizeAssistantCitations removes unsupported citation markers", () => {
  const result = normalizeAssistantCitations({
    assistantText: "Supported [citation:c1]. Unsupported [citation:c9].",
    citations: [citation("c1"), citation("c2")],
  });

  assert.equal(result.text, "Supported [citation:c1]. Unsupported.");
  assert.deepEqual(
    result.citations.map((item) => item.citation),
    ["c1"],
  );
  assert.deepEqual(result.invalidKeys, ["c9"]);
  assert.equal(result.removedInvalidCitations, true);
  assert.equal(result.markerCount, 2);
  assert.equal(result.validMarkerCount, 1);
});

test("normalizeAssistantCitations removes non-canonical citation-like markers", () => {
  const result = normalizeAssistantCitations({
    assistantText:
      "Keep [citation:c1]. Remove 【citation: c1】 and [citation: c1] and [citation:c1,c2].",
    citations: [citation("c1"), citation("c2")],
  });

  assert.equal(result.text, "Keep [citation:c1]. Remove and and.");
  assert.deepEqual(
    result.citations.map((item) => item.citation),
    ["c1"],
  );
  assert.deepEqual(result.invalidKeys, ["c1", "c1,c2"]);
  assert.equal(result.removedInvalidCitations, true);
  assert.equal(result.markerCount, 4);
  assert.equal(result.validMarkerCount, 1);
});

test("normalizeAssistantCitations removes unsupported citation markers before Chinese punctuation", () => {
  const result = normalizeAssistantCitations({
    assistantText: "支持 [citation:c1]。不支持 [citation:c9]。",
    citations: [citation("c1"), citation("c2")],
  });

  assert.equal(result.text, "支持 [citation:c1]。不支持。");
  assert.deepEqual(
    result.citations.map((item) => item.citation),
    ["c1"],
  );
  assert.deepEqual(result.invalidKeys, ["c9"]);
  assert.equal(result.removedInvalidCitations, true);
  assert.equal(result.markerCount, 2);
  assert.equal(result.validMarkerCount, 1);
});

test("normalizeAssistantCitations preserves markers that reference existing chunk ids", () => {
  const result = normalizeAssistantCitations({
    assistantText:
      "The domain expires on the documented date [citation:043e27f7-c8e0-438e-a47f-adcf8b06088e:chunk-4].",
    citations: [
      citation("c1", "other-chunk"),
      citation("c2", "043e27f7-c8e0-438e-a47f-adcf8b06088e:chunk-4"),
    ],
  });

  assert.equal(
    result.text,
    "The domain expires on the documented date [citation:c2].",
  );
  assert.deepEqual(
    result.citations.map((item) => item.citation),
    ["c2"],
  );
  assert.deepEqual(result.invalidKeys, []);
  assert.equal(result.removedInvalidCitations, false);
  assert.equal(result.markerCount, 1);
  assert.equal(result.validMarkerCount, 1);
});
