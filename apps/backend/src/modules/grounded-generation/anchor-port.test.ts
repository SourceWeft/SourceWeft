import assert from "node:assert/strict";
import { test } from "vitest";
import {
  SEMANTIC_MAX_CHARS,
  SEMANTIC_MAX_TEXTS,
} from "../citations/semantic-anchoring";
import {
  batchForSemanticBudget,
  createGroundedAnchorPort,
  embeddingBatchKey,
} from "./anchor-port";

const MEASURES = 30;

/** An English chunk of one sentence per measure, each naming its number. */
const EN_CHUNK = Array.from(
  { length: MEASURES },
  (_, index) => `Measure ${index + 1} rose to ${index + 1} units in the survey.`,
).join(" ");

/**
 * Puts a text on the axis of the first number it names, so a Chinese claim and
 * the English sentence about the same measure match by meaning while nothing
 * else does. Tests the batching, not the model.
 */
function fakeEmbedder() {
  const calls: string[][] = [];
  const embedTexts = async (texts: string[]) => {
    calls.push(texts);
    return texts.map((text) => {
      const vector = Array.from({ length: MEASURES + 1 }, () => 0);
      const number = Number(text.match(/\d+/)?.[0] ?? 0);
      vector[number <= MEASURES ? number : 0] = 1;
      return vector;
    });
  };
  return { calls, embedTexts };
}

test("every item of a large cross-language batch reaches the by-meaning pass", async () => {
  const { calls, embedTexts } = fakeEmbedder();
  const port = createGroundedAnchorPort({ embedTexts });
  const requests = Array.from({ length: MEASURES }, (_, index) => ({
    text: `第 ${index + 1} 项指标在调查中上升到 ${index + 1} 个单位。`,
    chunkId: "chunk-1",
    chunkContent: EN_CHUNK,
  }));

  const results = await port.anchor(requests);

  results.forEach((result, index) => {
    assert.ok(result, `request ${index + 1} has no evidence`);
    assert.ok(
      result.quote.startsWith(`Measure ${index + 1} rose`),
      `request ${index + 1} anchored to "${result.quote}"`,
    );
  });
  // One call could not hold them all; each call stays within its bounds.
  assert.ok(calls.length > 1);
  for (const texts of calls) {
    assert.ok(texts.length <= SEMANTIC_MAX_TEXTS);
    assert.ok(texts.join("").length <= SEMANTIC_MAX_CHARS);
  }
});

test("a same-language batch never reaches the embedder", async () => {
  const { calls, embedTexts } = fakeEmbedder();
  const port = createGroundedAnchorPort({ embedTexts });
  const results = await port.anchor(
    Array.from({ length: MEASURES }, (_, index) => ({
      text: `Measure ${index + 1} rose to ${index + 1} units in the survey.`,
      chunkId: "chunk-1",
      chunkContent: EN_CHUNK,
    })),
  );
  assert.ok(results.every((result) => result !== null));
  assert.equal(calls.length, 0);
});

test("batches keep request order and split only when the next request would not fit", () => {
  const prepared = Array.from({ length: 12 }, (_, index) => ({
    index,
    claims: ["一项说法。"],
    request: { text: "一项说法。", chunkId: "chunk-1", chunkContent: EN_CHUNK },
  }));
  const batches = batchForSemanticBudget(prepared);
  assert.deepEqual(
    batches.flat().map((item) => item.index),
    prepared.map((item) => item.index),
  );
  // Each request costs one claim plus the chunk's 30 sentences.
  const perBatch = Math.floor(SEMANTIC_MAX_TEXTS / (1 + MEASURES));
  assert.ok(batches.every((batch) => batch.length <= perBatch));
  assert.equal(batches[0]!.length, perBatch);
});

test("embedding batch keys repeat for the same texts and differ for others", () => {
  const base = "study:art_1:v1:anchor";
  assert.equal(embeddingBatchKey(base, ["a", "b"]), embeddingBatchKey(base, ["a", "b"]));
  assert.notEqual(embeddingBatchKey(base, ["a", "b"]), embeddingBatchKey(base, ["a", "c"]));
  assert.notEqual(embeddingBatchKey(base, ["ab"]), embeddingBatchKey(base, ["a", "b"]));
  assert.match(embeddingBatchKey(base, ["a"]), /^study:art_1:v1:anchor:[0-9a-f]{16}$/);
});
