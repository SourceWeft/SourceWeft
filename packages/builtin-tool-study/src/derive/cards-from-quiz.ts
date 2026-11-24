import {
  newStudyItemId,
  studyContentSchema,
  studyFingerprint,
  type FlashcardItem,
  type QuizItem,
  type StudyContent,
} from "@sourceweft/contracts/study";

type QuizContent = Extract<StudyContent, { kind: "quiz" }>;
type FlashcardsContent = Extract<StudyContent, { kind: "flashcards" }>;

/** Bumped when the card wording below changes. */
export const DERIVED_FROM_QUIZ_PROMPT_VERSION = "derive-from-quiz-v1";

const MAX_BACK_CHARS = 2000;

export type DeriveFlashcardsOptions = {
  /** Words for the two fixed true/false options, in the content's language. */
  readonly trueFalseLabels?: { readonly true: string; readonly false: string };
};

function optionText(
  item: QuizItem,
  index: number,
  labels: NonNullable<DeriveFlashcardsOptions["trueFalseLabels"]>,
) {
  const option = item.options?.[index] ?? "";
  if (item.type !== "truefalse") return option;
  return option === "true" ? labels.true : labels.false;
}

function cardBack(
  item: QuizItem,
  labels: NonNullable<DeriveFlashcardsOptions["trueFalseLabels"]>,
) {
  // A short question was only ever self-graded: its card is the stem and the
  // reference answer, nothing scored.
  if (item.type === "short") return item.referenceAnswer ?? item.explanation;
  const answer = (item.correct ?? [])
    .map((index) => optionText(item, index, labels))
    .join("; ");
  const back = `${answer}\n\n${item.explanation}`;
  return back.length > MAX_BACK_CHARS ? `${back.slice(0, MAX_BACK_CHARS - 1)}…` : back;
}

/**
 * Turns chosen quiz questions into a new flashcards content: no model call, the
 * cards are the questions' own stems, answers and evidence. Questions keep the
 * quiz's order. New card ids are minted, since a card is a new item.
 */
export function deriveFlashcardsFromQuiz(
  content: QuizContent,
  itemIds: readonly string[],
  options: DeriveFlashcardsOptions = {},
): FlashcardsContent {
  const labels = options.trueFalseLabels ?? { true: "True", false: "False" };
  const chosen = new Set(itemIds);
  const items: FlashcardItem[] = content.items
    .filter((item) => chosen.has(item.id))
    .map((item) => ({
      id: newStudyItemId("flashcards"),
      fingerprint: studyFingerprint("flashcards", item.stem),
      front: item.stem,
      back: cardBack(item, labels),
      tags: [],
      difficulty: item.difficulty,
      evidence: item.evidence,
    }));
  if (items.length === 0) {
    throw new Error("None of the given quiz questions are in this quiz");
  }
  const derived = {
    schemaVersion: content.schemaVersion,
    kind: "flashcards" as const,
    language: content.language,
    inputs: content.inputs,
    generation: {
      ...content.generation,
      promptVersion: DERIVED_FROM_QUIZ_PROMPT_VERSION,
      mode: "single" as const,
      stats: {
        requested: items.length,
        kept: items.length,
        dropped: {},
        groups: 0,
        tokensEstimated: 0,
      },
    },
    items,
  };
  return studyContentSchema.parse(derived) as FlashcardsContent;
}
