import type {
  CreateStudyCapability,
  StudyCorpusMeasure,
  StudyDerivationMembers,
  StudyGenerationMembers,
  StudySchedulingMembers,
} from "@sourceweft/contracts/study-capability";
import { deriveFlashcardsFromQuiz } from "./derive/cards-from-quiz";
import {
  DESIRED_RETENTION,
  newReviewCard,
  scheduleReview,
} from "./scheduling/fsrs";
import {
  MAX_TOTAL_INPUT_TOKENS,
  SINGLE_PASS_MAX_INPUT_TOKENS,
  STUDY_JOB_TIMEOUT_MS,
} from "./engine/constants";
import {
  assembleCorpus,
  estimateTokens,
  groupCorpus,
  StudyInputTooLargeError,
} from "./engine/corpus";
import { generateStudyContent } from "./engine/generate";
import { resolveStudyOptions } from "./engine/options";

/**
 * Server-only: the generation engine imports `node:crypto` and scheduling
 * imports `ts-fsrs`. Reached by the
 * host through the registry's server entry, never from a browser graph (the
 * web imports `./ui` and `./export` only).
 */

function measureCorpus(
  chunks: Parameters<StudyGenerationMembers["measureCorpus"]>[0],
): StudyCorpusMeasure {
  try {
    const corpus = assembleCorpus(chunks);
    const single = corpus.totalTokens <= SINGLE_PASS_MAX_INPUT_TOKENS;
    return {
      totalTokens: corpus.totalTokens,
      mode: single ? "single" : "mapreduce",
      groups: single ? 1 : groupCorpus(corpus.chunks).length,
      exceedsLimit: false,
    };
  } catch (error) {
    if (error instanceof StudyInputTooLargeError) {
      return {
        totalTokens: error.totalTokens,
        mode: "mapreduce",
        groups: 0,
        exceedsLimit: true,
      };
    }
    throw error;
  }
}

const generation: StudyGenerationMembers = {
  generateStudyContent,
  resolveStudyOptions,
  measureCorpus,
  estimateTokens,
  limits: {
    singlePassMaxInputTokens: SINGLE_PASS_MAX_INPUT_TOKENS,
    maxTotalInputTokens: MAX_TOTAL_INPUT_TOKENS,
    jobTimeoutMs: { ...STUDY_JOB_TIMEOUT_MS },
  },
};

/** The host factory: everything this package offers the backend, by group. */
const scheduling: StudySchedulingMembers = {
  scheduleReview,
  newReviewCard,
  desiredRetention: DESIRED_RETENTION,
};

const derivation: StudyDerivationMembers = { deriveFlashcardsFromQuiz };

export const createStudyCapability: CreateStudyCapability = () => ({
  generation,
  scheduling,
  derivation,
});
