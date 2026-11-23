import assert from "node:assert/strict";
import type {
  QuizItem,
  StudyContent,
  StudyEvidence,
} from "@sourceweft/contracts/study";
import { describe, test } from "vitest";
import {
  anchoringOf,
  dominantScript,
  duplicatesOf,
  evidenceInChunk,
  headingCoverageOf,
  injectionHitsOf,
  itemsOf,
  languageCorrectnessOf,
  median,
  percentile,
  positionBiasOf,
  quizLeaksOf,
  rateOf,
  ratio,
  sumRatios,
  trigramJaccard,
  type EvalItem,
} from "./metrics";

const CHUNK = "Water boils at 100 degrees at sea level.  Ice melts at 0 degrees.";
const chunks = new Map([
  ["c1", CHUNK],
  ["c2", "第二段：水在海平面一百度沸腾。"],
]);

function evidence(chunkId: string, quote: string, range?: [number, number]): StudyEvidence {
  return {
    kind: "chunk",
    sourceId: "s",
    documentId: "d",
    chunkId,
    quote,
    quoteHash: `sha256:${"0".repeat(64)}`,
    ...(range ? { startChar: range[0], endChar: range[1] } : {}),
  };
}

function item(overrides: Partial<EvalItem> = {}): EvalItem {
  return { kind: "flashcards", id: "c_1", key: "k", text: "t", evidence: [], ...overrides };
}

function quiz(overrides: Partial<QuizItem> = {}): QuizItem {
  return {
    id: "q_1",
    fingerprint: `sha256:${"0".repeat(64)}`,
    type: "single",
    stem: "At what temperature does water boil at sea level?",
    options: ["100 degrees", "90 degrees", "80 degrees", "70 degrees"],
    correct: [0],
    explanation: "Water boils at 100 degrees at sea level.",
    difficulty: 1,
    evidence: [evidence("c1", "Water boils")],
    ...overrides,
  };
}

describe("evidence anchoring", () => {
  test("a recorded range must hold exactly the quote", () => {
    assert.equal(evidenceInChunk(evidence("c1", "Water boils", [0, 11]), chunks), true);
    assert.equal(evidenceInChunk(evidence("c1", "Water boils", [1, 12]), chunks), false);
  });

  test("without a range the chunk must contain the quote, whitespace aside", () => {
    assert.equal(evidenceInChunk(evidence("c1", "level. Ice melts"), chunks), true);
    assert.equal(evidenceInChunk(evidence("c1", "Ice freezes"), chunks), false);
  });

  test("an unknown chunk or a blank quote is not anchored", () => {
    assert.equal(evidenceInChunk(evidence("c9", "Water"), chunks), false);
    assert.equal(evidenceInChunk(evidence("c1", "  "), chunks), false);
  });

  test("an item counts only when every quote is anchored; items without evidence are apart", () => {
    const result = anchoringOf(
      [
        item({ id: "a", evidence: [evidence("c1", "Water boils", [0, 11])] }),
        item({ id: "b", evidence: [evidence("c1", "Water boils"), evidence("c2", "不存在")] }),
        item({ id: "c", evidence: [] }),
      ],
      chunks,
    );
    assert.deepEqual(result.anchored, ratio(1, 2));
    assert.equal(result.withoutEvidence, 1);
  });
});

describe("duplicates", () => {
  test("trigram Jaccard ignores case, punctuation and spaces", () => {
    assert.equal(trigramJaccard("What is a cell?", "what is a CELL"), 1);
    assert.ok(trigramJaccard("What is a cell?", "Who wrote Hamlet?") < 0.2);
  });

  test("each item similar to an earlier one counts once", () => {
    const result = duplicatesOf([
      "What does the Senate do?",
      "What does the Senate do",
      "what does the senate do!",
      "Who elects the House?",
    ]);
    assert.deepEqual(result.duplicates, ratio(2, 4));
    assert.deepEqual(result.pairs, [
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
  });
});

describe("heading coverage", () => {
  const rows = [
    { chunkId: "c1", headingPath: "Article I > Section 1" },
    { chunkId: "c2", headingPath: "Article I > Section 2" },
    { chunkId: "c3", headingPath: "Article II > Section 1" },
    { chunkId: "c4", headingPath: null },
  ];
  const items = [item({ evidence: [evidence("c1", "x")] }), item({ evidence: [evidence("c3", "y")] })];

  test("counts distinct heading paths cited by any item", () => {
    const result = headingCoverageOf({ chunks: rows, items });
    assert.deepEqual(result?.covered, ratio(2, 3));
    assert.deepEqual(result?.missing, ["Article I > Section 2"]);
  });

  test("reachable coverage counts at most one section per item", () => {
    const one = headingCoverageOf({ chunks: rows, items: items.slice(0, 1) });
    assert.deepEqual(one?.covered, ratio(1, 3));
    assert.deepEqual(one?.reachable, ratio(1, 1));
    assert.deepEqual(headingCoverageOf({ chunks: rows, items })?.reachable, ratio(2, 2));
  });

  test("top level folds sections into their first heading", () => {
    assert.deepEqual(headingCoverageOf({ chunks: rows, items, level: "top" })?.covered, ratio(2, 2));
  });

  test("a source without headings is not measured", () => {
    assert.equal(headingCoverageOf({ chunks: [{ chunkId: "c4", headingPath: null }], items }), null);
  });
});

describe("language", () => {
  test("counts a Latin word as one unit against each Han character", () => {
    assert.equal(dominantScript("《Origin of Species》的作者是谁？达尔文。"), "zh");
    assert.equal(dominantScript("Confucius said 學 means learning by practice."), "en");
    assert.equal(dominantScript("123 456"), null);
  });

  test("rates items by the requested language's primary subtag", () => {
    const items = [item({ text: "达尔文认为家养生物变异更多。" }), item({ text: "Darwin wrote this." }), item({ text: "42" })];
    assert.deepEqual(languageCorrectnessOf(items, "zh-CN"), ratio(1, 2));
    assert.equal(languageCorrectnessOf(items, "fr"), null);
  });
});

describe("injection", () => {
  test("finds canaries regardless of case and width", () => {
    const hits = injectionHitsOf(
      [item({ id: "a", text: "Answer: canary-7f3k approved" }), item({ id: "b", text: "暗号Ｑ９Ｚ" }), item({ id: "c", text: "clean" })],
      ["CANARY-7F3K", "Q9Z"],
    );
    assert.deepEqual(hits, ["a", "b"]);
  });
});

describe("quiz leaks and position bias", () => {
  test("flags a much longer correct option and an answer repeated in the stem", () => {
    const leaks = quizLeaksOf([
      quiz({ id: "q_long", options: ["It boils at one hundred degrees Celsius at sea level", "90", "80", "70"] }),
      quiz({ id: "q_stem", stem: "Does water boil at 100 degrees or lower?", options: ["100 degrees", "90 degrees", "80 degrees", "70 degrees"] }),
      quiz({ id: "q_ok" }),
      quiz({ id: "q_tf", type: "truefalse", options: ["true", "false"], correct: [0] }),
    ]);
    assert.deepEqual(
      leaks.map((leak) => [leak.id, leak.longCorrect, leak.stemHasAnswer]),
      [
        ["q_long", true, false],
        ["q_stem", false, true],
        ["q_ok", false, false],
      ],
    );
  });

  test("detects answers that always sit in one position", () => {
    const biased = Array.from({ length: 24 }, (_, index) => quiz({ id: `q_${index}`, correct: [0] }));
    const even = Array.from({ length: 24 }, (_, index) => quiz({ id: `q_${index}`, correct: [index % 4] }));
    assert.equal(positionBiasOf(biased)?.biased, true);
    assert.equal(positionBiasOf(even)?.biased, false);
    assert.equal(positionBiasOf(even)?.degreesOfFreedom, 3);
    assert.equal(positionBiasOf(biased.slice(0, 8)), null);
  });
});

describe("items of a payload", () => {
  test("a mind map's root is not an item and depth counts from its children", () => {
    const content = {
      kind: "mindmap",
      root: {
        id: "n_root",
        fingerprint: "f",
        label: "Root",
        evidence: [],
        children: [
          {
            id: "n_a",
            fingerprint: "f",
            label: "A",
            summary: "About A",
            evidence: [],
            children: [{ id: "n_b", fingerprint: "f", label: "B", evidence: [], children: [] }],
          },
        ],
      },
    } as unknown as StudyContent;
    assert.deepEqual(
      itemsOf(content).map((node) => [node.id, node.depth, node.text]),
      [
        ["n_a", 1, "A About A"],
        ["n_b", 2, "B"],
      ],
    );
  });

  test("quiz text includes options only for choice questions", () => {
    const content = {
      kind: "quiz",
      items: [quiz({ type: "short", options: undefined, correct: undefined, referenceAnswer: "Boiling" })],
    } as unknown as StudyContent;
    assert.equal(itemsOf(content)[0]!.text, `${quiz().stem} Boiling ${quiz().explanation}`);
  });
});

describe("ratios and percentiles", () => {
  test("sums parts and reports nothing measured as null", () => {
    assert.deepEqual(sumRatios([ratio(1, 2), ratio(3, 4)]), ratio(4, 6));
    assert.equal(rateOf(ratio(0, 0)), null);
  });

  test("nearest-rank percentile and median", () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([], 95), null);
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });
});
