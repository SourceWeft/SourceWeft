import assert from "node:assert/strict";
import { test } from "vitest";
import { rewriteCitationsForNote } from "./citation-rewrite";

const citations = [
  {
    citation: "c1",
    sourceId: "s1",
    sourceTitle: "Annual report",
    chunkId: "k1",
    excerpt: "Overview of the company. Revenue grew 23%.",
    spanText: "Revenue grew 23% to $4.1 billion.",
  },
  {
    citation: "c2",
    sourceId: "s2",
    sourceTitle: "Policy",
    chunkId: "k2",
    excerpt: "<p>Remote work is permitted.</p>",
  },
];

test("markers become numbered footnotes in order of first use", () => {
  const { text, references } = rewriteCitationsForNote({
    content:
      "Policy allows remote work [citation:c2]. Revenue grew [citation:c1]. Again [citation:c2].",
    citations,
  });
  assert.ok(
    text.startsWith(
      "Policy allows remote work [1]. Revenue grew [2]. Again [1].",
    ),
  );
  assert.deepEqual(
    references.map((item) => [item.number, item.citation]),
    [
      [1, "c2"],
      [2, "c1"],
    ],
  );
  assert.equal(text.includes("citation:"), false);
});

test("the sources list shows the supporting passage, else the cleaned excerpt", () => {
  const { text } = rewriteCitationsForNote({
    content: "A [citation:c1]. B [citation:c2].",
    citations,
  });
  assert.ok(
    text.includes('[1] Annual report: "Revenue grew 23% to $4.1 billion."'),
  );
  assert.ok(text.includes('[2] Policy: "Remote work is permitted."'));
  assert.ok(text.includes("\nSources\n"));
});

test("several keys in one marker and full-width brackets are handled", () => {
  const { text } = rewriteCitationsForNote({
    content: "收入增长[citation:c1, c2]。另见【citation:c1】。",
    citations,
  });
  assert.ok(text.startsWith("收入增长[1][2]。另见[1]。"));
  assert.ok(text.includes("参考来源"));
});

test("a marker with no matching citation is dropped, not left dangling", () => {
  const { text, references } = rewriteCitationsForNote({
    content: "Unknown claim [citation:zzz]. Known [citation:c1].",
    citations,
  });
  assert.equal(text.includes("zzz"), false);
  assert.equal(references.length, 1);
});

test("an answer without citations is saved unchanged and gets no sources list", () => {
  const { text, references } = rewriteCitationsForNote({
    content: "Plain answer.",
    citations,
  });
  assert.equal(text, "Plain answer.");
  assert.deepEqual(references, []);
});

test("a long passage is shortened", () => {
  const { references } = rewriteCitationsForNote({
    content: "X [citation:c1].",
    citations: [{ ...citations[0]!, spanText: "w ".repeat(400) }],
  });
  assert.ok((references[0]?.passage ?? "").length <= 281);
  assert.ok(references[0]?.passage?.endsWith("…"));
});
