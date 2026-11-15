import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Card,
  type FSRS,
  type Grade,
} from "ts-fsrs";
import type {
  StudyReviewCard,
  StudyReviewCardState,
  StudyReviewGrade,
  StudyReviewLogEntry,
} from "@sourceweft/contracts/study-capability";

/**
 * Spaced-repetition scheduling for flashcards: a thin wrapper over `ts-fsrs`
 * (FSRS-6, default parameters).
 *
 * Server-only. No package subpath exports this module; the host reaches it
 * through `createStudyCapability().scheduling`, so `ts-fsrs` stays out of web
 * bundles (`tests/browser-boundary.test.ts`).
 *
 * Fuzz is off: the same history always produces the same schedule, which is
 * what lets two devices grading the same card agree and tests stay exact.
 * Default learning steps (1m, 10m) and relearning steps (10m) apply.
 */

/** The share of reviews FSRS aims to have recalled. A code constant, not config. */
export const DESIRED_RETENTION = 0.9;

export type ReviewGrade = StudyReviewGrade;
export type ReviewCardState = StudyReviewCardState;
export type ReviewCard = StudyReviewCard;
export type ReviewLogEntry = StudyReviewLogEntry;

const schedulers = new Map<number, FSRS>();

function schedulerFor(desiredRetention: number): FSRS {
  let scheduler = schedulers.get(desiredRetention);
  if (!scheduler) {
    scheduler = fsrs(
      generatorParameters({
        request_retention: desiredRetention,
        enable_fuzz: false,
      }),
    );
    schedulers.set(desiredRetention, scheduler);
  }
  return scheduler;
}

function fromCard(card: Card): ReviewCard {
  return {
    state: card.state as number as ReviewCardState,
    dueAt: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    lastReviewedAt: card.last_review ? new Date(card.last_review) : null,
  };
}

function toCard(card: ReviewCard): Card {
  return {
    state: card.state,
    due: new Date(card.dueAt),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    ...(card.lastReviewedAt ? { last_review: new Date(card.lastReviewedAt) } : {}),
  };
}

/** The card an item has before its first grade: New and due now. */
export function newReviewCard(now: Date): ReviewCard {
  return fromCard(createEmptyCard(now));
}

/**
 * Applies one grade at `now`. `card` is the stored state, or `null` for an
 * item never graded. Pure: the input is not mutated.
 */
export function scheduleReview(
  card: ReviewCard | null,
  grade: ReviewGrade,
  now: Date,
  options: { desiredRetention?: number } = {},
): { state: ReviewCard; log: ReviewLogEntry } {
  if (!Number.isInteger(grade) || grade < 1 || grade > 4) {
    throw new RangeError(`Invalid review grade ${String(grade)}: expected 1-4`);
  }
  const before = card ?? newReviewCard(now);
  const result = schedulerFor(
    options.desiredRetention ?? DESIRED_RETENTION,
  ).next(toCard(before), now, grade as Grade);
  // ts-fsrs's own log carries the previous *review* time in `due`, so the
  // before-values come from the card we passed in; the day counts are its.
  return {
    state: fromCard(result.card),
    log: {
      grade,
      stateBefore: before.state,
      dueBefore: new Date(before.dueAt),
      stabilityBefore: before.stability,
      difficultyBefore: before.difficulty,
      elapsedDays: result.log.elapsed_days,
      scheduledDays: result.log.scheduled_days,
      reviewedAt: new Date(result.log.review),
    },
  };
}
