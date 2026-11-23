import type { StudyKind } from "@sourceweft/contracts/study";

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

/** Item counts per size step (shared with the generate dialog). */
export { STUDY_SIZE_COUNTS } from "@sourceweft/contracts/study";

/** Items are asked for at this multiple of the request, then cut back. */
export const OVERGENERATE_FACTOR = 1.3;

/** The smallest output ceiling of a generation call. */
export const GENERATION_MIN_MAX_TOKENS = 2_000;

/**
 * Output token ceiling of one generation call for `items` requested items.
 * Models write past "at most N" mind map nodes, and a cut-off answer is
 * unreadable JSON, so small requests still get room for a whole answer. Only
 * the tokens written are paid for.
 */
export function generationMaxTokens(kind: StudyKind, items: number): number {
  // Each item also carries a word-for-word quote of up to 200 characters.
  const perItem = kind === "flashcards" ? 300 : kind === "quiz" ? 400 : 160;
  return Math.min(
    8_000,
    Math.max(GENERATION_MIN_MAX_TOKENS, 400 + perItem * items),
  );
}

/**
 * Items one generation call may be asked for. A larger share is split over
 * consecutive parts of the source: one structured answer must arrive within
 * the gateway's per-call timeout (30 s), and with a quote per item 26 cards
 * took longer than that. Mind maps stay one call per group.
 */
export const MAX_ITEMS_PER_CALL = { flashcards: 10, quiz: 6 } as const;

/** A generation keeps at least this share of the requested items... */
export const MIN_KEEP_RATIO = 0.6;
/** ...and at least this many (or the whole request, when it is smaller). */
export const MIN_KEEP_ITEMS = 3;

/** Character 3-gram Jaccard at or above which two items are duplicates. */
export const DEDUPE_JACCARD = 0.8;

export const QUOTE_MAX_CHARS = 600;
/** A model quote shorter than this (estimated tokens) proves too little to be evidence. */
export const QUOTE_MIN_TOKENS = 6;

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
  flashcards: "flashcards-v3",
  quiz: "quiz-v3",
  mindmap: "mindmap-v2",
};
