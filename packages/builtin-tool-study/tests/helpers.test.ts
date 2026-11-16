import assert from "node:assert/strict";
import test from "node:test";
import { dedupeItems, ngramJaccard } from "../src/engine/dedupe";
import {
  matchesOutputLanguage,
  resolveOutputLanguage,
} from "../src/engine/language";
import {
  assertRetention,
  difficultySkewed,
  minimumKept,
} from "../src/engine/quality";
import { shuffleOptions } from "../src/engine/shuffle";
import { StudyGenerationError } from "../src/engine/types";

test("shuffleOptions is deterministic per item id and remaps correct", () => {
  const options = ["alpha", "beta", "gamma", "delta"];
  const first = shuffleOptions(options, [2], "q_abc");
  const again = shuffleOptions(options, [2], "q_abc");
  assert.deepEqual(first, again);
  assert.equal(first.options[first.correct[0]!], "gamma");
  assert.deepEqual([...first.options].sort(), [...options].sort());

  const orders = new Set(
    ["q_1", "q_2", "q_3", "q_4", "q_5", "q_6"].map((id) =>
      shuffleOptions(options, [0], id).options.join("|"),
    ),
  );
  assert.ok(orders.size > 1, "different ids should give different orders");
});

test("shuffleOptions keeps multi answers attached to their text", () => {
  const options = ["a1", "b2", "c3", "d4", "e5"];
  const result = shuffleOptions(options, [1, 3], "q_multi");
  assert.deepEqual(
    result.correct.map((index) => result.options[index]).sort(),
    ["b2", "d4"],
  );
  assert.deepEqual(result.correct, [...result.correct].sort((a, b) => a - b));
});

test("ngramJaccard sees through case, spaces and punctuation", () => {
  assert.equal(ngramJaccard("What is FSRS?", "what is fsrs"), 1);
  assert.ok(ngramJaccard("What is FSRS?", "Explain photosynthesis") < 0.2);
});

test("dedupeItems keeps the item with more evidence among near duplicates", () => {
  const items = [
    { id: "a", text: "What does the mitochondria produce?", evidence: 1, difficulty: 1 },
    { id: "b", text: "What does the mitochondria produce", evidence: 2, difficulty: 1 },
    { id: "c", text: "Who discovered penicillin?", evidence: 1, difficulty: 2 },
  ];
  const { kept, dropped } = dedupeItems(items, {
    text: (item) => item.text,
    evidence: (item) => item.evidence,
    difficulty: (item) => item.difficulty,
  });
  assert.deepEqual(
    kept.map((item) => item.id),
    ["b", "c"],
  );
  assert.equal(dropped, 1);
});

test("dedupeItems prefers the rarer difficulty when evidence ties", () => {
  const items = [
    { id: "x", text: "Define osmosis", evidence: 1, difficulty: 1 },
    { id: "y", text: "Name the capital of France", evidence: 1, difficulty: 1 },
    { id: "z", text: "Define osmosis.", evidence: 1, difficulty: 3 },
  ];
  const { kept } = dedupeItems(items, {
    text: (item) => item.text,
    evidence: (item) => item.evidence,
    difficulty: (item) => item.difficulty,
  });
  assert.deepEqual(kept.map((item) => item.id).sort(), ["y", "z"]);
});

test("minimumKept is 60% of the request and at least three items", () => {
  assert.equal(minimumKept(10), 6);
  assert.equal(minimumKept(20), 12);
  assert.equal(minimumKept(4), 3);
  assert.equal(minimumKept(2), 2);
});

test("assertRetention fails below 60% and passes at it", () => {
  assert.throws(
    () => assertRetention({ kept: 59, requested: 100 }),
    (error: unknown) =>
      error instanceof StudyGenerationError &&
      error.code === "GENERATION_QUALITY_TOO_LOW",
  );
  assert.doesNotThrow(() => assertRetention({ kept: 60, requested: 100 }));
});

test("difficultySkewed records a skew without failing", () => {
  assert.equal(difficultySkewed([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]), true);
  assert.equal(difficultySkewed([1, 2, 3, 1, 2, 3]), false);
  assert.equal(difficultySkewed([]), false);
});

test("resolveOutputLanguage prefers the request, then a source majority, then the UI", () => {
  const chunks = (langs: [string | null, number][]) =>
    langs.map(([language, tokens]) => ({ language, tokens }));
  assert.equal(
    resolveOutputLanguage({ requested: "fr", chunks: chunks([["en", 10]]), uiLocale: "zh-CN" }),
    "fr",
  );
  assert.equal(
    resolveOutputLanguage({
      chunks: chunks([
        ["zh", 70],
        ["en", 30],
      ]),
      uiLocale: "en",
    }),
    "zh",
  );
  assert.equal(
    resolveOutputLanguage({
      chunks: chunks([
        ["zh", 50],
        ["en", 50],
      ]),
      uiLocale: "zh-TW",
    }),
    "zh-TW",
  );
  assert.equal(
    resolveOutputLanguage({ chunks: chunks([[null, 10]]), uiLocale: "en" }),
    "en",
  );
});

test("matchesOutputLanguage checks the script of Chinese and English output", () => {
  assert.equal(matchesOutputLanguage("光合作用把光能转化为化学能 (photosynthesis)", "zh-CN"), true);
  assert.equal(matchesOutputLanguage("Photosynthesis converts light into energy", "zh-CN"), false);
  assert.equal(matchesOutputLanguage("Photosynthesis converts light", "en"), true);
  assert.equal(matchesOutputLanguage("光合作用把光能转化为化学能", "en-US"), false);
  // Languages without a script rule are not judged.
  assert.equal(matchesOutputLanguage("anything", "fr"), true);
  // Text without letters (a formula) is not judged either.
  assert.equal(matchesOutputLanguage("3 = 1 + 2", "zh"), true);
});
