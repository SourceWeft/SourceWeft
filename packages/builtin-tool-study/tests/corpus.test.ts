import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateGroupQuotas,
  assembleCorpus,
  estimateTokens,
  groupCorpus,
  StudyInputTooLargeError,
} from "../src/engine/corpus";
import {
  GROUP_MAX_TOKENS,
  GROUP_MIN_TOKENS,
  MAX_TOTAL_INPUT_TOKENS,
} from "../src/engine/constants";
import type { CorpusChunkInput } from "../src/engine/types";

function chunk(
  overrides: Partial<CorpusChunkInput> & { chunkNo: number },
): CorpusChunkInput {
  return {
    chunkId: `chunk-${overrides.documentId ?? "d1"}-${overrides.chunkNo}`,
    sourceId: "s1",
    documentId: "d1",
    headingPath: null,
    language: "en",
    text: "text",
    ...overrides,
  };
}

test("estimateTokens counts CJK per character and other text per four characters", () => {
  const cases: [string, number][] = [
    ["", 0],
    ["abcd", 1],
    ["abcde", 2],
    ["学习", 2],
    ["学习 abcd", 4],
    ["学習カタカナ한국", 8],
  ];
  for (const [text, tokens] of cases) {
    assert.equal(estimateTokens(text), tokens, JSON.stringify(text));
  }
});

test("assembleCorpus orders by document then chunk number and assigns handles", () => {
  const corpus = assembleCorpus([
    chunk({ documentId: "d2", chunkNo: 1, text: "d2-1" }),
    chunk({ documentId: "d1", chunkNo: 2, text: "d1-2" }),
    chunk({ documentId: "d2", chunkNo: 0, text: "d2-0" }),
    chunk({ documentId: "d1", chunkNo: 0, text: "d1-0" }),
  ]);
  // Documents keep the order they first appear in; chunks follow their number.
  assert.deepEqual(
    corpus.chunks.map((c) => [c.handle, c.text]),
    [
      ["c1", "d2-0"],
      ["c2", "d2-1"],
      ["c3", "d1-0"],
      ["c4", "d1-2"],
    ],
  );
  assert.equal(corpus.totalTokens, 4);
});

test("assembleCorpus refuses an oversized selection instead of truncating it", () => {
  const big = "a".repeat((MAX_TOTAL_INPUT_TOKENS + 4) * 4);
  assert.throws(
    () => assembleCorpus([chunk({ chunkNo: 0, text: big })]),
    (error: unknown) =>
      error instanceof StudyInputTooLargeError &&
      error.totalTokens > MAX_TOTAL_INPUT_TOKENS,
  );
});

function tokensText(tokens: number) {
  return "a".repeat(tokens * 4);
}

test("groupCorpus breaks at a heading change near the target", () => {
  const corpus = assembleCorpus([
    chunk({ chunkNo: 0, headingPath: "A", text: tokensText(3_000) }),
    chunk({ chunkNo: 1, headingPath: "A", text: tokensText(2_500) }),
    chunk({ chunkNo: 2, headingPath: "B", text: tokensText(1_000) }),
    chunk({ chunkNo: 3, headingPath: "B", text: tokensText(3_000) }),
  ]);
  const groups = groupCorpus(corpus.chunks);
  assert.deepEqual(
    groups.map((g) => g.chunks.map((c) => c.chunkNo)),
    [
      [0, 1],
      [2, 3],
    ],
  );
});

test("groupCorpus never exceeds the group ceiling", () => {
  const corpus = assembleCorpus(
    Array.from({ length: 12 }, (_, i) =>
      chunk({ chunkNo: i, text: tokensText(2_000) }),
    ),
  );
  const groups = groupCorpus(corpus.chunks);
  for (const group of groups) {
    assert.ok(group.tokens <= GROUP_MAX_TOKENS, `group of ${group.tokens}`);
  }
  assert.equal(
    groups.reduce((sum, g) => sum + g.chunks.length, 0),
    12,
  );
});

test("groupCorpus merges a group that is too small with its neighbour", () => {
  const corpus = assembleCorpus([
    chunk({ documentId: "d1", chunkNo: 0, text: tokensText(6_000) }),
    chunk({ documentId: "d2", chunkNo: 0, text: tokensText(500) }),
    chunk({ documentId: "d3", chunkNo: 0, text: tokensText(5_000) }),
  ]);
  const groups = groupCorpus(corpus.chunks);
  for (const group of groups) {
    assert.ok(group.tokens >= GROUP_MIN_TOKENS, `group of ${group.tokens}`);
  }
  assert.equal(
    groups.reduce((sum, g) => sum + g.chunks.length, 0),
    3,
  );
});

test("allocateGroupQuotas sums to the total with at least one per group", () => {
  const cases: [number, number[]][] = [
    [26, [7_000, 7_000, 7_000, 2_000]],
    [13, [9_000, 1_500]],
    [39, [7_000, 6_000, 8_000, 7_500, 7_000, 3_000]],
    [5, [100, 100, 100, 100, 100]],
  ];
  for (const [total, tokens] of cases) {
    const quotas = allocateGroupQuotas(total, tokens);
    assert.equal(quotas.length, tokens.length);
    assert.equal(
      quotas.reduce((a, b) => a + b, 0),
      total,
      `${total} over ${tokens.join(",")}: ${quotas.join(",")}`,
    );
    for (const quota of quotas) {
      assert.ok(quota >= 1);
      assert.ok(quota <= Math.max(1, Math.ceil(total / 2)));
    }
  }
});

test("allocateGroupQuotas gives one per group when there are more groups than items", () => {
  assert.deepEqual(allocateGroupQuotas(2, [100, 100, 100]), [1, 1, 1]);
});
