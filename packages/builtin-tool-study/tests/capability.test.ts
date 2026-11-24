import assert from "node:assert/strict";
import test from "node:test";
import { readStudyCapability } from "@sourceweft/contracts/study-capability";
import * as entry from "../src/index";
import {
  MAX_TOTAL_INPUT_TOKENS,
  SINGLE_PASS_MAX_INPUT_TOKENS,
  STUDY_JOB_TIMEOUT_MS,
} from "../src/engine/constants";
import { factChunks } from "./fixtures";

test("the entry module provides the generation members the host requires", () => {
  const capability = readStudyCapability(entry, "generation");
  const generation = capability.generation!;
  assert.deepEqual(generation.limits, {
    singlePassMaxInputTokens: SINGLE_PASS_MAX_INPUT_TOKENS,
    maxTotalInputTokens: MAX_TOTAL_INPUT_TOKENS,
    jobTimeoutMs: { ...STUDY_JOB_TIMEOUT_MS },
  });
  assert.equal(generation.estimateTokens("abcd"), 1);
});

test("measureCorpus reports mode, groups and the size limit without a model", () => {
  const { generation } = readStudyCapability(entry, "generation");
  const small = factChunks(2, { tokens: 100 });
  assert.deepEqual(generation!.measureCorpus(small), {
    totalTokens: small.reduce((sum, c) => sum + generation!.estimateTokens(c.text), 0),
    mode: "single",
    groups: 1,
    exceedsLimit: false,
  });
  const split = generation!.measureCorpus(factChunks(12, { tokens: 5_000 }));
  assert.equal(split.mode, "mapreduce");
  assert.ok(split.groups > 1);
  const huge = generation!.measureCorpus(factChunks(31, { tokens: 10_000 }));
  assert.equal(huge.exceedsLimit, true);
  assert.equal(huge.groups, 0);
});

test("the entry module provides scheduling and derivation as the host requires them", () => {
  const { scheduling, derivation } = readStudyCapability(
    entry,
    "scheduling",
    "derivation",
  );
  assert.equal(scheduling!.desiredRetention, 0.9);
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(scheduling!.newReviewCard(now).state, 0);
  const { state, log } = scheduling!.scheduleReview(null, 3, now);
  assert.equal(state.reps, 1);
  assert.equal(log.grade, 3);
  assert.equal(typeof derivation!.deriveFlashcardsFromQuiz, "function");
});
