import assert from "node:assert/strict";
import test from "node:test";
import {
  isStudyGenerationError,
  readStudyCapability,
  STUDY_CAPABILITY_FACTORY,
  StudyCapabilityUnavailableError,
  StudyGenerationError,
} from "../src/study-capability";

const generation = {
  generateStudyContent: async () => ({}) as never,
  resolveStudyOptions: () => ({ count: 1, difficulty: "mixed" as const, language: "en" }),
  measureCorpus: () => ({ totalTokens: 0, mode: "single" as const, groups: 1, exceedsLimit: false }),
  estimateTokens: () => 0,
  limits: {
    singlePassMaxInputTokens: 1,
    maxTotalInputTokens: 2,
    jobTimeoutMs: { single: 1, mapreduce: 2 },
  },
};

test("readStudyCapability returns the module the entry factory builds", () => {
  const capability = readStudyCapability({
    [STUDY_CAPABILITY_FACTORY]: () => ({ generation }),
  });
  assert.equal(capability.generation, generation);
});

test("scheduling and derivation are groups of their own, each checked by name", () => {
  const scheduling = {
    scheduleReview: () => ({}) as never,
    newReviewCard: () => ({}) as never,
    desiredRetention: 0.9,
  };
  const derivation = { deriveFlashcardsFromQuiz: () => ({}) as never };
  const entry = {
    [STUDY_CAPABILITY_FACTORY]: () => ({ scheduling, derivation }),
  };
  const capability = readStudyCapability(entry, "scheduling", "derivation");
  assert.equal(capability.scheduling, scheduling);
  assert.equal(capability.derivation, derivation);
  assert.throws(() => readStudyCapability(entry, "generation"), /generation/);
  assert.throws(
    () =>
      readStudyCapability(
        { [STUDY_CAPABILITY_FACTORY]: () => ({ scheduling: { scheduleReview: () => 0 } }) },
        "scheduling",
      ),
    /newReviewCard, desiredRetention/,
  );
  assert.throws(
    () =>
      readStudyCapability(
        { [STUDY_CAPABILITY_FACTORY]: () => ({ derivation: {} }) },
        "derivation",
      ),
    /deriveFlashcardsFromQuiz/,
  );
});

test("a missing or malformed factory is a deployment fault, not a degraded feature", () => {
  for (const entry of [
    null,
    {},
    { [STUDY_CAPABILITY_FACTORY]: "nope" },
    { [STUDY_CAPABILITY_FACTORY]: () => null },
  ]) {
    assert.throws(
      () => readStudyCapability(entry as never),
      StudyCapabilityUnavailableError,
    );
  }
});

test("a group a host needs but the module lacks is reported by name", () => {
  const capability = readStudyCapability({
    [STUDY_CAPABILITY_FACTORY]: () => ({}),
  });
  assert.equal(capability.generation, undefined);
  assert.throws(
    () => readStudyCapability({ [STUDY_CAPABILITY_FACTORY]: () => ({}) }, "generation"),
    /generation/,
  );
  assert.throws(
    () =>
      readStudyCapability(
        { [STUDY_CAPABILITY_FACTORY]: () => ({ generation: { limits: {} } }) },
        "generation",
      ),
    /generateStudyContent/,
  );
});

test("study generation errors are recognized by shape across module graphs", () => {
  const error = new StudyGenerationError("INPUT_TOO_LARGE", "big", { totalTokens: 9 });
  assert.equal(isStudyGenerationError(error), true);
  assert.deepEqual(error.details, { totalTokens: 9 });
  const foreign = Object.assign(new Error("x"), {
    name: "StudyGenerationError",
    code: "MODEL_UNAVAILABLE",
    details: {},
  });
  assert.equal(isStudyGenerationError(foreign), true);
  assert.equal(
    isStudyGenerationError(Object.assign(new Error("x"), { code: "OTHER" })),
    false,
  );
});
