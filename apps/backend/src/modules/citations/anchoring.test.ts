import assert from "node:assert/strict";
import { test } from "vitest";
import {
  anchorCitations,
  anchorClaimInContent,
  extractCitedClaims,
} from "./anchoring";

const REVENUE_CHUNK =
  "Overview of the company. Revenue grew 23% to $4.1 billion in fiscal 2025, driven by cloud services. " +
  "Headcount stayed flat at 12,000 employees. The board approved a new buyback programme.";

test("extractCitedClaims returns the sentence in front of each canonical marker", () => {
  const claims = extractCitedClaims(
    "Revenue grew 23% in 2025. [citation:c1] Headcount stayed flat [citation:c2]. Unrelated closing line.",
  );
  assert.deepEqual(claims.get("c1"), ["Revenue grew 23% in 2025."]);
  assert.deepEqual(claims.get("c2"), ["Headcount stayed flat"]);
});

test("extractCitedClaims splits on Chinese sentence punctuation and ignores other markers", () => {
  const claims = extractCitedClaims(
    "公司成立于2010年。营收增长23%[citation:c1]，员工人数持平[citation:c2]。",
  );
  assert.deepEqual(claims.get("c1"), ["营收增长23%"]);
  assert.deepEqual(claims.get("c2"), ["员工人数持平"]);
});

test("extractCitedClaims collects every occurrence of the same key", () => {
  const claims = extractCitedClaims(
    "Revenue grew 23% [citation:c1]. Cloud drove the growth [citation:c1].",
  );
  assert.equal(claims.get("c1")?.length, 2);
});

test("anchorClaimInContent locates the supporting sentence and its offsets", () => {
  const anchor = anchorClaimInContent({
    claim: "Revenue grew 23% to $4.1 billion",
    content: REVENUE_CHUNK,
  });
  assert.ok(anchor);
  assert.equal(anchor.support, "strong");
  const quote = REVENUE_CHUNK.slice(anchor.startChar!, anchor.endChar!);
  assert.ok(quote.startsWith("Revenue grew 23%"));
  assert.ok(quote.includes("$4.1 billion"));
  assert.ok(!quote.includes("Headcount"));
});

test("anchorClaimInContent matches Chinese claims against Chinese content", () => {
  const content =
    "公司概况。2025财年营收增长23%，达到41亿美元。员工人数保持在12000人。";
  const anchor = anchorClaimInContent({ claim: "营收增长23%", content });
  assert.ok(anchor);
  assert.equal(anchor.support, "strong");
  assert.ok(
    content.slice(anchor.startChar!, anchor.endChar!).includes("营收增长23%"),
  );
});

test("anchorClaimInContent reports weak support when nothing in the chunk backs the claim", () => {
  const anchor = anchorClaimInContent({
    claim: "The company opened a new office in Singapore",
    content: REVENUE_CHUNK,
  });
  assert.ok(anchor);
  assert.equal(anchor.support, "weak");
  assert.equal(anchor.startChar, null);
  assert.equal(anchor.endChar, null);
});

test("anchorClaimInContent does not treat a claim with too little signal as supported", () => {
  const anchor = anchorClaimInContent({ claim: "Yes", content: REVENUE_CHUNK });
  assert.equal(anchor?.support, "weak");
});

test("anchorClaimInContent offsets index the original text, including HTML", () => {
  const content =
    "<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Revenue growth</td><td>23%</td></tr></table>\n\nHeadcount stayed flat at 12,000 employees.";
  const anchor = anchorClaimInContent({
    claim: "Headcount stayed flat at 12,000 employees",
    content,
  });
  assert.ok(anchor);
  assert.equal(anchor.support, "strong");
  assert.equal(
    content.slice(anchor.startChar!, anchor.endChar!),
    "Headcount stayed flat at 12,000 employees.",
  );
});

test("anchorClaimInContent finds a table row for a claim about table cells", () => {
  const content =
    "| Metric | Value |\n| --- | --- |\n| Revenue growth | 23% |\n| Headcount | 12,000 |\n";
  const anchor = anchorClaimInContent({
    claim: "Headcount was 12,000",
    content,
  });
  assert.ok(anchor);
  assert.equal(anchor.support, "strong");
  assert.ok(
    content.slice(anchor.startChar!, anchor.endChar!).includes("Headcount"),
  );
});

test("anchorCitations anchors only used citations and keeps weak ones", async () => {
  const result = await anchorCitations({
    text: "Revenue grew 23% to $4.1 billion [citation:c1]. A Singapore office opened [citation:c2].",
    citations: [
      { citation: "c1", chunkId: "chunk-1", content: undefined },
      { citation: "c2", chunkId: "chunk-2", content: undefined },
      { citation: "c3", chunkId: "chunk-3", content: undefined },
    ],
    loadChunkContents: async (ids) =>
      new Map(ids.map((id) => [id, REVENUE_CHUNK])),
  });
  assert.equal(result.get("c1")?.support, "strong");
  assert.equal(result.get("c2")?.support, "weak");
  assert.equal(result.has("c3"), false);
});

test("anchorCitations prefers stored content for external and file citations", async () => {
  const seen: string[][] = [];
  const result = await anchorCitations({
    text: "Revenue grew 23% to $4.1 billion [citation:c1].",
    citations: [
      {
        citation: "c1",
        chunkId: "external:https://example.com/a",
        externalUri: "https://example.com/a",
        content: REVENUE_CHUNK,
      },
    ],
    loadChunkContents: async (ids) => {
      seen.push([...ids]);
      return new Map();
    },
  });
  assert.equal(result.get("c1")?.support, "strong");
  assert.deepEqual(seen.flat(), []);
});

test("anchorCitations leaves a citation unanchored when its content is unavailable", async () => {
  const result = await anchorCitations({
    text: "Revenue grew 23% [citation:c1].",
    citations: [{ citation: "c1", chunkId: "chunk-gone", content: undefined }],
    loadChunkContents: async () => new Map(),
  });
  assert.equal(result.has("c1"), false);
});

test("anchorCitations picks the best-supported occurrence of a repeated citation", async () => {
  const result = await anchorCitations({
    text: "Unrelated aside about weather [citation:c1]. Revenue grew 23% to $4.1 billion [citation:c1].",
    citations: [{ citation: "c1", chunkId: "chunk-1", content: undefined }],
    loadChunkContents: async () => new Map([["chunk-1", REVENUE_CHUNK]]),
  });
  const anchor = result.get("c1");
  assert.equal(anchor?.support, "strong");
  assert.ok(
    REVENUE_CHUNK.slice(anchor!.startChar!, anchor!.endChar!).startsWith(
      "Revenue grew",
    ),
  );
});

test("anchorClaimInContent rejects a passage that shares the words but not the figures", () => {
  const anchor = anchorClaimInContent({
    claim: "Revenue grew 31% to $4.1 billion in fiscal 2025",
    content: REVENUE_CHUNK,
  });
  assert.equal(anchor?.support, "weak");
  assert.equal(anchor?.startChar, null);
});

test("anchorClaimInContent reads spelled-out numbers as figures", () => {
  const content = "Remote work is permitted for up to three days per week.";
  assert.equal(
    anchorClaimInContent({
      claim: "Remote work is allowed three days per week",
      content,
    })?.support,
    "strong",
  );
  assert.equal(
    anchorClaimInContent({
      claim: "Remote work is allowed five days per week",
      content,
    })?.support,
    "weak",
  );
});
