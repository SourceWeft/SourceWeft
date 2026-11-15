import assert from "node:assert/strict";
import { StudyCapabilityUnavailableError } from "@sourceweft/contracts/study-capability";
import { test, vi } from "vitest";
import {
  loadStudyDerivation,
  loadStudyGeneration,
  loadStudyScheduling,
  STUDY_CAPABILITY_PACKAGE,
} from "./capability";

test("scheduling and derivation load through the same registry entry", async () => {
  const scheduling = await loadStudyScheduling();
  assert.equal(scheduling.desiredRetention, 0.9);
  assert.equal(scheduling.scheduleReview(null, 3, new Date()).state.reps, 1);
  const derivation = await loadStudyDerivation();
  assert.equal(typeof derivation.deriveFlashcardsFromQuiz, "function");
  await assert.rejects(
    loadStudyScheduling(() => async () => ({ createStudyCapability: () => ({}) })),
    /"scheduling"/,
  );
  await assert.rejects(
    loadStudyDerivation(() => async () => ({ createStudyCapability: () => ({}) })),
    /"derivation"/,
  );
});

test("the real study package loads through the registry with its generation members", async () => {
  const generation = await loadStudyGeneration();
  assert.equal(typeof generation.generateStudyContent, "function");
  assert.equal(generation.estimateTokens("abcd"), 1);
  assert.ok(generation.limits.maxTotalInputTokens > generation.limits.singlePassMaxInputTokens);
});

test("a package missing from the module table is a deployment fault", async () => {
  const loader = vi.fn(() => undefined);
  await assert.rejects(loadStudyGeneration(loader), StudyCapabilityUnavailableError);
  assert.deepEqual(loader.mock.calls, [[STUDY_CAPABILITY_PACKAGE]]);
});

test("an entry without the factory, or without generation members, fails loudly", async () => {
  await assert.rejects(
    loadStudyGeneration(() => async () => ({})),
    StudyCapabilityUnavailableError,
  );
  await assert.rejects(
    loadStudyGeneration(() => async () => ({ createStudyCapability: () => ({}) })),
    /"generation"/,
  );
  await assert.rejects(
    loadStudyGeneration(() => async () => ({
      createStudyCapability: () => ({ generation: { estimateTokens: () => 0 } }),
    })),
    /generateStudyContent/,
  );
});
