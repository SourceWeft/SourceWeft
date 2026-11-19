import type { StudyKind, StudySize } from "@sourceweft/contracts/study";

/**
 * Cost bounds of one study generation. Code constants, not settings: they
 * change with a code review, never with a deployment variable. The input-size
 * bounds are shared with every grounded generator and live in
 * `@sourceweft/grounded-generation`.
 */
export {
  GROUP_MAX_TOKENS,
  GROUP_MIN_TOKENS,
  GROUP_TARGET_TOKENS,
  MAX_TOTAL_INPUT_TOKENS,
  SINGLE_PASS_MAX_INPUT_TOKENS,
} from "@sourceweft/grounded-generation";

/** Item counts per size step; mind maps count nodes below the root. */
export const STUDY_SIZE_COUNTS: Record<StudyKind, Record<StudySize, number>> = {
  flashcards: { fewer: 10, standard: 20, more: 40 },
  quiz: { fewer: 5, standard: 10, more: 20 },
  mindmap: { fewer: 20, standard: 40, more: 80 },
};

/** Items are asked for at this multiple of the request, then cut back. */
export const OVERGENERATE_FACTOR = 1.3;

/** Output token ceiling of one generation call for `items` requested items. */
export function generationMaxTokens(kind: StudyKind, items: number): number {
  const perItem = kind === "flashcards" ? 230 : kind === "quiz" ? 320 : 80;
  return Math.min(8_000, 400 + perItem * items);
}

/** A generation keeps at least this share of the requested items... */
export const MIN_KEEP_RATIO = 0.6;
/** ...and at least this many (or the whole request, when it is smaller). */
export const MIN_KEEP_ITEMS = 3;

/** Character 3-gram Jaccard at or above which two items are duplicates. */
export const DEDUPE_JACCARD = 0.8;

export const QUOTE_MAX_CHARS = 600;

/** Cited text handed to one verification call. */
export const VERIFY_MAX_INPUT_TOKENS = 1_500;
export const VERIFY_MAX_OUTPUT_TOKENS = 200;
/** Flashcards are verified by sample: one card in this many... */
export const FLASHCARD_VERIFY_EVERY = 5;
/** ...but never fewer than this many cards. */
export const FLASHCARD_VERIFY_MIN = 3;

/** A correct option longer than the others' mean by this factor gives it away. */
export const LEAK_LENGTH_RATIO = 1.6;
/** One difficulty holding more than this share is recorded as skewed. */
export const DIFFICULTY_SKEW_SHARE = 0.85;

/** Serialized checkpoint ceiling; beyond it the checkpoint is not saved. */
export const CHECKPOINT_MAX_BYTES = 200 * 1024;

/** Queue attempts of one generation job. */
export const STUDY_JOB_ATTEMPTS = 2;
/** Wall-clock budget of one job, by mode. */
export const STUDY_JOB_TIMEOUT_MS = {
  single: 3 * 60_000,
  mapreduce: 10 * 60_000,
} as const;

export const STUDY_PROMPT_VERSIONS: Record<StudyKind, string> = {
  flashcards: "flashcards-v1",
  quiz: "quiz-v1",
  mindmap: "mindmap-v1",
};
