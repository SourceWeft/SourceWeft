import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { anchorCitations, anchorClaimInContent } from "./anchoring";
import {
  serializeDiagnostics,
  type AnchoringSummary,
  type SemanticOutcome,
} from "./anchoring-diagnostics";
import {
  pickSemanticAnchor,
  type EmbeddedSegment,
} from "./semantic-anchoring";

/**
 * #516: every anchor records how it was decided. The record holds numbers and
 * enums only, and recording it must not change what is judged strong or weak.
 */
const CONTENT = "First sentence. Second sentence. Third sentence.";
const segment = (
  at: string,
  text: string,
  vector: number[],
): EmbeddedSegment => {
  const start = CONTENT.indexOf(at);
  return { start, end: start + at.length, text, vector };
};

const CLAIM = "营收增长23%，达到41亿美元";
const PASSAGE = "Revenue grew 23% to $4.1 billion.";

function pick(claim: string, segments: EmbeddedSegment[]) {
  return pickSemanticAnchor({
    claim,
    claimVector: [1, 0],
    content: CONTENT,
    segments,
    lexicalScore: 0.2,
  });
}

/** One case per outcome of the by-meaning pass that `pickSemanticAnchor` decides. */
const OUTCOMES: Array<{
  outcome: SemanticOutcome;
  support: "strong" | "weak";
  claim: string;
  segments: EmbeddedSegment[];
}> = [
  {
    outcome: "strong",
    support: "strong",
    claim: "营收增长",
    segments: [
      segment("First sentence.", "Revenue grew.", [0.95, 0.31]),
      segment("Second sentence.", "Other.", [0.2, 0.98]),
    ],
  },
  {
    outcome: "below_similarity",
    support: "weak",
    claim: "营收增长",
    segments: [
      segment("First sentence.", PASSAGE, [0.5, 0.866]),
      segment("Second sentence.", "Other.", [0.1, 0.995]),
    ],
  },
  {
    outcome: "below_margin",
    support: "weak",
    claim: "营收增长",
    segments: [
      segment("First sentence.", "Revenue grew.", [0.9, 0.436]),
      segment("Second sentence.", "Revenue rose.", [0.88, 0.475]),
    ],
  },
  {
    outcome: "figures_missing",
    support: "weak",
    claim: "营收增长23%",
    segments: [
      segment("First sentence.", "Revenue grew 31%.", [0.97, 0.24]),
      segment("Second sentence.", "Other.", [0.1, 0.995]),
    ],
  },
  {
    outcome: "direction_conflict",
    support: "weak",
    claim: "Net sales fell 14%",
    segments: [
      segment("First sentence.", "净销售额增长14%。", [0.97, 0.24]),
      segment("Second sentence.", "Other.", [0.1, 0.995]),
    ],
  },
];

test.each(OUTCOMES)(
  "the by-meaning decision records the outcome $outcome",
  ({ outcome, support, claim, segments }) => {
    const anchor = pick(claim, segments);
    assert.equal(anchor.support, support);
    const diagnostics = anchor.diagnostics!;
    assert.equal(diagnostics.method, "semantic");
    assert.equal(diagnostics.lexicalScore, 0.2);
    assert.equal(diagnostics.semantic?.outcome, outcome);
    assert.equal(diagnostics.semantic?.segments, 2);
    assert.equal(typeof diagnostics.semantic?.similarity, "number");
    assert.equal(typeof diagnostics.semantic?.margin, "number");
    // A refused match has no span; a strong one quotes the cited sentence.
    assert.equal(anchor.quoteText === null, support === "weak");
  },
);

test("the diagnostics hold no claim or passage text", () => {
  const texts = [
    "营收增长23%，达到41亿美元",
    "Revenue grew 23% to $4.1 billion.",
    "First sentence.",
    "Second sentence.",
  ];
  const anchors = [
    ...OUTCOMES.map((item) => pick(item.claim, item.segments)),
    anchorClaimInContent({ claim: CLAIM, content: PASSAGE })!,
  ];
  for (const anchor of anchors) {
    const stored = JSON.stringify(serializeDiagnostics(anchor.diagnostics!));
    for (const text of [...texts, ...OUTCOMES.map((o) => o.claim)]) {
      assert.equal(stored.includes(text), false, stored);
    }
    // Only these keys are ever stored.
    assert.deepEqual(
      Object.keys(JSON.parse(stored)).filter(
        (key) =>
          !["method", "scripts", "lexicalScore", "semantic"].includes(key),
      ),
      [],
    );
  }
});

test("a lone sentence has no margin, and an empty source records nothing compared", () => {
  const lone = pick("营收增长", [
    segment("First sentence.", "Revenue grew.", [0.9, 0.436]),
  ]);
  assert.equal(lone.support, "strong");
  assert.equal(lone.diagnostics?.semantic?.margin, null);
  const none = pick("营收增长", []);
  assert.equal(none.support, "weak");
  assert.equal(none.diagnostics?.semantic?.similarity, null);
  assert.equal(none.diagnostics?.semantic?.segments, 0);
});

test("the word matcher's decision records the script pair and score", () => {
  const cross = anchorClaimInContent({ claim: CLAIM, content: PASSAGE })!;
  assert.equal(cross.diagnostics?.method, "lexical");
  assert.equal(cross.diagnostics?.scripts, "cjk>latin");
  const reverse = anchorClaimInContent({
    claim: "Revenue grew 23% to $4.1 billion",
    content: "营收增长23%，达到41亿美元。",
  })!;
  assert.equal(reverse.diagnostics?.scripts, "latin>cjk");
  const same = anchorClaimInContent({
    claim: "Revenue grew 23% to $4.1 billion",
    content: PASSAGE,
  })!;
  assert.equal(same.diagnostics?.scripts, "same");
  assert.equal(same.diagnostics?.lexicalScore, same.score);
  assert.equal(same.support, "strong");
});

const EN_CHUNK =
  "Overview of the company. Revenue grew 23% to $4.1 billion in fiscal 2025. Headcount stayed flat at 12,000 employees.";
const embedByTopic = async (texts: string[]) =>
  texts.map((text) => {
    if (/营收|Revenue grew/.test(text)) return [1, 0, 0];
    if (/员工|Headcount/.test(text)) return [0, 1, 0];
    // A Chinese claim about nothing in the source points away from every sentence.
    if (/[一-鿿]/.test(text)) return [0, 0, -1];
    return [0, 0, 1];
  });

function run(input: {
  text: string;
  contents: Record<string, string>;
  embedTexts?: (texts: string[]) => Promise<number[][]>;
}) {
  let summary: AnchoringSummary | undefined;
  return anchorCitations({
    text: input.text,
    citations: Object.keys(input.contents).map((key) => ({
      citation: key,
      chunkId: key,
      content: input.contents[key],
    })),
    loadChunkContents: async () => new Map(),
    embedTexts: input.embedTexts,
    onSemanticError: () => undefined,
    onSummary: (value) => {
      summary = value;
    },
  }).then((anchors) => ({ anchors, summary: summary! }));
}

test("a by-meaning success replaces the lexical record and counts in the summary", async () => {
  const { anchors, summary } = await run({
    text: "营收增长23%，达到41亿美元 [citation:c1]。The company has a new office in Singapore [citation:c2]。",
    contents: { c1: EN_CHUNK, c2: EN_CHUNK },
    embedTexts: embedByTopic,
  });
  const c1 = anchors.get("c1")!;
  assert.equal(c1.support, "strong");
  assert.equal(c1.diagnostics?.method, "semantic");
  assert.equal(c1.diagnostics?.scripts, "cjk>latin");
  assert.equal(c1.diagnostics?.semantic?.outcome, "strong");
  // The same-language citation never reaches the second pass.
  const c2 = anchors.get("c2")!;
  assert.equal(c2.support, "weak");
  assert.equal(c2.diagnostics?.method, "lexical");
  assert.equal(c2.diagnostics?.semantic, undefined);
  expect(summary).toMatchObject({
    citations: 2,
    lexicalStrong: 0,
    sentToSemantic: 1,
    semanticStrong: 1,
    overBudget: 0,
    boundsHit: false,
    embeddingFailed: false,
  });
  assert.equal(summary.embeddedTexts, 4);
  assert.ok(summary.embeddedCharacters > 0);
  assert.equal(typeof summary.embeddingMs, "number");
});

test("a citation the by-meaning pass refuses stays weak and records why", async () => {
  const { anchors, summary } = await run({
    text: "公司在新加坡开设了新办公室 [citation:c1]。",
    contents: { c1: EN_CHUNK },
    embedTexts: embedByTopic,
  });
  const anchor = anchors.get("c1")!;
  assert.equal(anchor.support, "weak");
  assert.equal(anchor.quoteText, null);
  assert.equal(anchor.diagnostics?.method, "semantic");
  assert.equal(anchor.diagnostics?.semantic?.outcome, "below_similarity");
  assert.equal(summary.sentToSemantic, 1);
  assert.equal(summary.semanticStrong, 0);
});

test("an embedding failure is recorded per citation and in the summary", async () => {
  const { anchors, summary } = await run({
    text: "营收增长23% [citation:c1]。",
    contents: { c1: EN_CHUNK },
    embedTexts: async () => {
      throw new Error("provider down");
    },
  });
  const anchor = anchors.get("c1")!;
  assert.equal(anchor.support, "weak");
  assert.equal(anchor.diagnostics?.semantic?.outcome, "embedding_failed");
  assert.equal(anchor.diagnostics?.semantic?.similarity, null);
  expect(summary).toMatchObject({
    sentToSemantic: 1,
    semanticStrong: 0,
    embeddingFailed: true,
  });
  assert.equal(JSON.stringify(summary).includes("provider down"), false);
});

test("a citation the bounds leave out is recorded as over budget", async () => {
  // Four sources of 40 short sentences: each needs 41 of the 160 texts.
  const many = Array.from({ length: 40 }, (_, i) => `Filler ${i}.`).join(" ");
  const contents = { c1: many, c2: many, c3: many, c4: many };
  const { anchors, summary } = await run({
    text: "营收增长23% [citation:c1]。营收增长23% [citation:c2]。营收增长23% [citation:c3]。营收增长23% [citation:c4]。",
    contents,
    embedTexts: embedByTopic,
  });
  assert.equal(anchors.get("c4")?.diagnostics?.semantic?.outcome, "over_budget");
  assert.equal(anchors.get("c4")?.diagnostics?.method, "semantic");
  assert.equal(anchors.get("c4")?.diagnostics?.semantic?.similarity, null);
  assert.notEqual(
    anchors.get("c1")?.diagnostics?.semantic?.outcome,
    "over_budget",
  );
  expect(summary).toMatchObject({
    citations: 4,
    sentToSemantic: 3,
    overBudget: 1,
    boundsHit: true,
  });
});

test("without an embedder nothing is sent and no semantic record is made", async () => {
  const { anchors, summary } = await run({
    text: "营收增长23% [citation:c1]。",
    contents: { c1: EN_CHUNK },
  });
  assert.equal(anchors.get("c1")?.diagnostics?.semantic, undefined);
  expect(summary).toMatchObject({
    citations: 1,
    sentToSemantic: 0,
    embeddedTexts: 0,
    embeddingMs: null,
    boundsHit: false,
  });
});

/**
 * Behaviour parity: the same inputs judge strong or weak, and quote, exactly
 * as before diagnostics existed (the expectations below are the pre-change
 * results of the existing fixtures).
 */
test("recording the decision does not change what is judged or quoted", async () => {
  const { anchors } = await run({
    text: "2025财年营收增长23% [citation:c1]。员工人数持平，保持在12000人 [citation:c2]。公司在新加坡开设了新办公室 [citation:c3]。",
    contents: { c1: EN_CHUNK, c2: EN_CHUNK, c3: EN_CHUNK },
    embedTexts: embedByTopic,
  });
  const quote = (key: string) =>
    anchors.get(key)?.support === "strong" ? anchors.get(key)?.quoteText : null;
  assert.equal(quote("c1"), "Revenue grew 23% to $4.1 billion in fiscal 2025.");
  assert.equal(quote("c2"), "Headcount stayed flat at 12,000 employees.");
  assert.equal(quote("c3"), null);
});
