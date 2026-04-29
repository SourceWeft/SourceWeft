import assert from "node:assert/strict";
import test from "node:test";
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

test("normalizeAssistantCitations keeps only citations referenced in assistant text", () => {
  const available = ["c1", "c2", "c3", "c4", "c5"].map((key) => citation(key));

  const result = normalizeAssistantCitations({
    assistantText: "The answer uses the evidence but does not emit markers.",
    citations: available,
  });

  assert.equal(available.length, 5);
  assert.equal(result.citations.length, 0);
  assert.equal(result.invalidKeys.length, 0);
  assert.equal(result.removedInvalidCitations, false);
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
});
