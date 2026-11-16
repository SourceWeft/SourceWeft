import assert from "node:assert/strict";
import test from "node:test";
import {
  DESIRED_RETENTION,
  newReviewCard,
  scheduleReview,
  type ReviewCard,
} from "../src/scheduling/fsrs";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Grades a card repeatedly, each time at its due date, and returns every step. */
function gradeAtDue(
  grades: readonly (1 | 2 | 3 | 4)[],
  options?: { desiredRetention?: number },
) {
  let card: ReviewCard | null = null;
  let now = T0;
  const steps = [];
  for (const grade of grades) {
    const result = scheduleReview(card, grade, now, options);
    steps.push(result);
    card = result.state;
    now = card.dueAt;
  }
  return steps;
}

test("the target retention is the 0.9 code constant", () => {
  assert.equal(DESIRED_RETENTION, 0.9);
});

test("a new card is New, due now, with zeroed counters", () => {
  const card = newReviewCard(T0);
  assert.deepEqual(card, {
    state: 0,
    dueAt: T0,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    lastReviewedAt: null,
  });
});

for (const [grade, expected] of [
  // Default learning steps are [1m, 10m]: Again 1m, Hard 6m, Good 10m in
  // Learning; Easy graduates straight to Review in days.
  [1, { state: 1, dueInMs: 60_000 }],
  [2, { state: 1, dueInMs: 6 * 60_000 }],
  [3, { state: 1, dueInMs: 10 * 60_000 }],
  [4, { state: 2, dueInMs: null }],
] as const) {
  test(`a new card graded ${grade} is scheduled deterministically`, () => {
    const first = scheduleReview(null, grade, T0);
    const again = scheduleReview(null, grade, T0);
    assert.deepEqual(first, again, "no fuzz: the same input gives the same card");
    assert.equal(first.state.state, expected.state);
    assert.equal(first.state.reps, 1);
    assert.equal(first.state.lapses, 0);
    assert.deepEqual(first.state.lastReviewedAt, T0);
    if (expected.dueInMs === null) {
      assert.ok(first.state.dueAt.getTime() - T0.getTime() >= DAY);
      assert.ok(first.state.scheduledDays >= 1);
    } else {
      assert.equal(first.state.dueAt.getTime() - T0.getTime(), expected.dueInMs);
    }
    assert.ok(first.state.stability > 0);
    assert.ok(first.state.difficulty > 0);
  });
}

test("Good in Review keeps growing the interval and moves due forward", () => {
  const steps = gradeAtDue([3, 3, 3, 3, 3, 3]);
  const review = steps.filter((step) => step.state.state === 2);
  assert.ok(review.length >= 3, "the card graduates to Review");
  for (let i = 1; i < review.length; i += 1) {
    assert.ok(
      review[i]!.state.scheduledDays > review[i - 1]!.state.scheduledDays,
      "each Good review schedules a longer interval",
    );
  }
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(steps[i]!.state.dueAt > steps[i - 1]!.state.dueAt, "due is monotonic");
  }
  assert.equal(steps.at(-1)!.state.reps, 6);
});

test("Again in Review counts a lapse and enters Relearning", () => {
  const steps = gradeAtDue([4, 3, 1]);
  assert.equal(steps[1]!.state.state, 2);
  const lapse = steps[2]!;
  assert.equal(lapse.state.state, 3);
  assert.equal(lapse.state.lapses, 1);
  assert.ok(lapse.state.stability < steps[1]!.state.stability);
});

test("the log records the card as it was before the grade", () => {
  const first = scheduleReview(null, 4, T0);
  const reviewedAt = at(first.state.scheduledDays * DAY);
  const second = scheduleReview(first.state, 3, reviewedAt);
  assert.deepEqual(second.log, {
    grade: 3,
    stateBefore: 2,
    dueBefore: first.state.dueAt,
    stabilityBefore: first.state.stability,
    difficultyBefore: first.state.difficulty,
    elapsedDays: first.state.scheduledDays,
    scheduledDays: first.state.scheduledDays,
    reviewedAt,
  });
  assert.deepEqual(scheduleReview(null, 1, T0).log, {
    grade: 1,
    stateBefore: 0,
    dueBefore: T0,
    stabilityBefore: 0,
    difficultyBefore: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reviewedAt: T0,
  });
});

test("the input card is not mutated", () => {
  const first = scheduleReview(null, 4, T0).state;
  const snapshot = structuredClone(first);
  scheduleReview(first, 1, first.dueAt);
  assert.deepEqual(first, snapshot);
});

test("a higher target retention schedules shorter intervals", () => {
  const relaxed = gradeAtDue([4, 3, 3], { desiredRetention: 0.8 }).at(-1)!;
  const standard = gradeAtDue([4, 3, 3]).at(-1)!;
  const strict = gradeAtDue([4, 3, 3], { desiredRetention: 0.97 }).at(-1)!;
  assert.ok(relaxed.state.scheduledDays > standard.state.scheduledDays);
  assert.ok(standard.state.scheduledDays > strict.state.scheduledDays);
});

test("a card restored from stored columns schedules like the live one", () => {
  const live = scheduleReview(null, 4, T0).state;
  const restored: ReviewCard = JSON.parse(JSON.stringify(live), (key, value) =>
    key === "dueAt" || key === "lastReviewedAt"
      ? value === null
        ? null
        : new Date(value)
      : value,
  );
  assert.deepEqual(
    scheduleReview(restored, 3, live.dueAt),
    scheduleReview(live, 3, live.dueAt),
  );
});

test("an invalid grade is rejected rather than treated as Manual", () => {
  assert.throws(() => scheduleReview(null, 0 as never, T0), /grade/);
  assert.throws(() => scheduleReview(null, 5 as never, T0), /grade/);
});
