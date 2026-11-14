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

/**
 * Second pass by meaning (#516). The fake embedder places a claim and a
 * sentence on the same axis when the sentence's text contains the marker the
 * claim names, so these tests exercise the plumbing and the bounds, not the
 * model: the real model is measured by `scripts/eval-citation-anchoring.ts`.
 */
const EN_CHUNK =
  "Overview of the company. Revenue grew 23% to $4.1 billion in fiscal 2025. Headcount stayed flat at 12,000 employees.";

function fakeEmbedder() {
  const calls: string[][] = [];
  const embedTexts = async (texts: string[]) => {
    calls.push(texts);
    return texts.map((text) => {
      if (/营收|Revenue grew/.test(text)) return [1, 0, 0];
      if (/员工|Headcount/.test(text)) return [0, 1, 0];
      return [0, 0, 1];
    });
  };
  return { calls, embedTexts };
}

test("a Chinese claim over an English chunk is located by meaning when words cannot", async () => {
  const { calls, embedTexts } = fakeEmbedder();
  const result = await anchorCitations({
    text: "2025财年营收增长23%，达到41亿美元 [citation:c1]。",
    citations: [{ citation: "c1", chunkId: "chunk-1", content: undefined }],
    loadChunkContents: async () => new Map([["chunk-1", EN_CHUNK]]),
    embedTexts,
  });

  const anchor = result.get("c1");
  assert.equal(anchor?.support, "strong");
  assert.ok(
    EN_CHUNK.slice(anchor!.startChar!, anchor!.endChar!).startsWith(
      "Revenue grew 23%",
    ),
  );
  assert.equal(calls.length, 1);
});

test("a same-language claim never reaches the embedder", async () => {
  const { calls, embedTexts } = fakeEmbedder();
  const result = await anchorCitations({
    text: "The company opened a new office in Singapore [citation:c1].",
    citations: [{ citation: "c1", chunkId: "chunk-1", content: undefined }],
    loadChunkContents: async () => new Map([["chunk-1", EN_CHUNK]]),
    embedTexts,
  });

  assert.equal(result.get("c1")?.support, "weak");
  assert.equal(calls.length, 0);
});

test("a citation the word matcher already supports is not sent to the embedder", async () => {
  const { calls, embedTexts } = fakeEmbedder();
  await anchorCitations({
    text: "Revenue grew 23% to $4.1 billion [citation:c1]。营收增长23%，达到41亿美元 [citation:c2]。",
    citations: [
      { citation: "c1", chunkId: "chunk-1", content: undefined },
      { citation: "c2", chunkId: "chunk-1", content: undefined },
    ],
    loadChunkContents: async () => new Map([["chunk-1", EN_CHUNK]]),
    embedTexts,
  });

  const sentToEmbedder = calls.flat().join("|");
  assert.equal(calls.length, 1);
  assert.equal(sentToEmbedder.includes("营收增长23%"), true);
});

test("several cross-language citations share one embedding call", async () => {
  const { calls, embedTexts } = fakeEmbedder();
  const result = await anchorCitations({
    text: "营收增长23% [citation:c1]。员工人数持平，保持在12000人 [citation:c2]。",
    citations: [
      { citation: "c1", chunkId: "chunk-1", content: undefined },
      { citation: "c2", chunkId: "chunk-1", content: undefined },
    ],
    loadChunkContents: async () => new Map([["chunk-1", EN_CHUNK]]),
    embedTexts,
  });

  assert.equal(calls.length, 1);
  assert.equal(result.get("c1")?.support, "strong");
  assert.equal(result.get("c2")?.support, "strong");
});

test("a failing embedder leaves the word-matched result and reports the failure", async () => {
  let reported: unknown;
  const result = await anchorCitations({
    text: "营收增长23% [citation:c1]。",
    citations: [{ citation: "c1", chunkId: "chunk-1", content: undefined }],
    loadChunkContents: async () => new Map([["chunk-1", EN_CHUNK]]),
    embedTexts: async () => {
      throw new Error("provider down");
    },
    onSemanticError: (error) => {
      reported = error;
    },
  });

  assert.equal(result.get("c1")?.support, "weak");
  assert.match(String(reported), /provider down/);
});

test("a wrong-sized embedding answer is treated as a failure", async () => {
  let reported: unknown;
  const result = await anchorCitations({
    text: "营收增长23% [citation:c1]。",
    citations: [{ citation: "c1", chunkId: "chunk-1", content: undefined }],
    loadChunkContents: async () => new Map([["chunk-1", EN_CHUNK]]),
    embedTexts: async () => [[1, 0, 0]],
    onSemanticError: (error) => {
      reported = error;
    },
  });

  assert.equal(result.get("c1")?.support, "weak");
  assert.ok(reported);
});

test("a very long source is capped and the other citations are still judged", async () => {
  const { calls, embedTexts } = fakeEmbedder();
  const huge = Array.from(
    { length: 400 },
    (_, index) => `Filler sentence number ${index}.`,
  ).join(" ");
  const result = await anchorCitations({
    text: "营收增长23% [citation:c1]。员工人数持平，保持在12000人 [citation:c2]。",
    citations: [
      { citation: "c1", chunkId: "chunk-huge", content: huge },
      { citation: "c2", chunkId: "chunk-1", content: undefined },
    ],
    loadChunkContents: async () => new Map([["chunk-1", EN_CHUNK]]),
    embedTexts,
  });

  assert.ok(calls.flat().length <= 160);
  assert.equal(result.get("c2")?.support, "strong");
});
