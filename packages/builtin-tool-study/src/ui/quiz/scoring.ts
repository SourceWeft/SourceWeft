import type { QuizAnswer, QuizItem } from "@sourceweft/contracts/study";

/**
 * Whether a choice answer is right: exactly the correct options, nothing more.
 * Short questions are self-graded and never auto-scored, so they return null.
 */
export function isAnswerCorrect(
  item: QuizItem,
  answer: QuizAnswer | undefined,
): boolean | null {
  if (item.type === "short") return null;
  const selected = new Set(answer?.selected ?? []);
  const correct = item.correct ?? [];
  return (
    selected.size === correct.length &&
    correct.every((index) => selected.has(index))
  );
}

export type QuizScore = {
  /** Choice questions answered right. */
  readonly autoCorrect: number;
  /** Choice questions in the attempt. */
  readonly autoTotal: number;
  /** Short questions the learner says they knew; kept apart from the auto score. */
  readonly selfKnew: number;
  readonly selfTotal: number;
  /** Wrong, unanswered, or self-graded as missed: what "practice mistakes" re-runs. */
  readonly wrongItemIds: string[];
};

export function scoreQuiz(
  items: readonly QuizItem[],
  answers: Readonly<Record<string, QuizAnswer>>,
): QuizScore {
  let autoCorrect = 0;
  let autoTotal = 0;
  let selfKnew = 0;
  let selfTotal = 0;
  const wrongItemIds: string[] = [];
  for (const item of items) {
    const answer = answers[item.id];
    if (item.type === "short") {
      selfTotal += 1;
      if (answer?.selfGrade === "knew") selfKnew += 1;
      else wrongItemIds.push(item.id);
      continue;
    }
    autoTotal += 1;
    if (isAnswerCorrect(item, answer)) autoCorrect += 1;
    else wrongItemIds.push(item.id);
  }
  return { autoCorrect, autoTotal, selfKnew, selfTotal, wrongItemIds };
}
