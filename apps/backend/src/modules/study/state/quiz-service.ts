import {
  quizAnswerSchema,
  type DeriveCardsResponse,
  type QuizAnswer,
  type QuizAttemptListResponse,
  type QuizAttemptView,
  type QuizItem,
  type QuizItemResult,
  type StudyContent,
} from "@sourceweft/contracts/study";
import { publishArtifact } from "../../artifacts/publish";
import { ContentError } from "../../content/errors";
import { notFound, requireStudyVersion, type AuthorizedStudyVersion } from "./access";
import { loadStudyDerivation } from "../capability";
import {
  copyInputSources,
  findOwnQuizAttempt,
  insertQuizAttempt,
  listOwnQuizAttempts,
  saveQuizAttempt,
  type QuizAttemptRow,
} from "./repository";

const ATTEMPT_HISTORY_MAX = 20;

type QuizContent = Extract<StudyContent, { kind: "quiz" }>;
type Clock = { now?: () => Date };

function badRequest(code: string, message: string) {
  return new ContentError(400, code, message);
}

function attemptFinished() {
  return new ContentError(
    409,
    "STUDY_ATTEMPT_FINISHED",
    "This quiz attempt is finished and can no longer change",
  );
}

/** Choice questions score only when the chosen set equals the correct set. */
export function gradeQuizItem(
  item: QuizItem,
  answer: QuizAnswer | undefined,
): QuizItemResult {
  if (item.type === "short") {
    if (!answer?.selfGrade) return "unanswered";
    return answer.selfGrade === "knew" ? "correct" : "incorrect";
  }
  if (!answer?.selected || answer.selected.length === 0) return "unanswered";
  const chosen = new Set(answer.selected);
  const correct = new Set(item.correct ?? []);
  return chosen.size === correct.size &&
    [...correct].every((index) => chosen.has(index))
    ? "correct"
    : "incorrect";
}

function gradeAttempt(
  quiz: QuizContent,
  attempt: Pick<QuizAttemptRow, "itemIds" | "answers">,
) {
  const items = new Map(quiz.items.map((item) => [item.id, item]));
  const answers = attempt.answers as Record<string, QuizAnswer>;
  const results: Record<string, QuizItemResult> = {};
  for (const itemId of attempt.itemIds) {
    const item = items.get(itemId);
    // Versions are immutable, so an attempt's items are always present.
    results[itemId] = item ? gradeQuizItem(item, answers[itemId]) : "unanswered";
  }
  // The score counts choice questions only; short questions are self-graded,
  // reported per question in `results` and kept out of the auto score (the
  // viewer's `scoreQuiz` makes the same split).
  const score = attempt.itemIds.filter(
    (id) => items.get(id)?.type !== "short" && results[id] === "correct",
  ).length;
  return { results, score };
}

function attemptView(
  row: QuizAttemptRow,
  quiz: QuizContent | null,
): QuizAttemptView {
  return {
    id: row.id,
    artifactId: row.artifactId,
    versionNo: row.versionNo,
    itemIds: row.itemIds,
    answers: row.answers as Record<string, QuizAnswer>,
    score: row.score,
    total: row.total,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    results:
      row.finishedAt && quiz ? gradeAttempt(quiz, row).results : null,
  };
}

/** Starts an attempt over the named questions, or over the whole quiz. */
export async function startQuizAttempt(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
  /** Exactly one of these names the version. */
  versionNo?: number;
  artifactVersionId?: string;
  itemIds?: string[];
}): Promise<QuizAttemptView> {
  const version = await requireStudyVersion({ ...input, artifactType: "quiz" });
  const known = new Set(version.content.items.map((item) => item.id));
  const itemIds = input.itemIds ?? [...known];
  if (new Set(itemIds).size !== itemIds.length) {
    throw badRequest("STUDY_DUPLICATE_ITEMS", "A question is listed twice");
  }
  if (itemIds.some((id) => !known.has(id))) {
    throw badRequest(
      "STUDY_ITEM_NOT_IN_VERSION",
      "A question is not part of that version",
    );
  }
  const types = new Map(version.content.items.map((item) => [item.id, item.type]));
  const row = await insertQuizAttempt({
    total: itemIds.filter((id) => types.get(id) !== "short").length,
    owner: version.owner,
    versionNo: version.versionNo,
    itemIds,
  });
  return attemptView(row, version.content);
}

/**
 * Loads the caller's attempt and re-checks that they may still view its quiz.
 * Another user's attempt, or one in a different workspace than the route
 * names, is a 404.
 */
async function requireOwnAttempt(input: {
  workspaceId: string;
  userId: string;
  attemptId: string;
}): Promise<{ row: QuizAttemptRow; version: AuthorizedStudyVersion<"quiz"> }> {
  const row = await findOwnQuizAttempt(input);
  if (!row || row.workspaceId !== input.workspaceId) throw notFound();
  const version = await requireStudyVersion({
    workspaceId: input.workspaceId,
    userId: input.userId,
    artifactId: row.artifactId,
    artifactType: "quiz",
    versionNo: row.versionNo,
  });
  return { row, version };
}

function checkAnswers(
  quiz: QuizContent,
  itemIds: readonly string[],
  answers: Record<string, QuizAnswer>,
) {
  const inAttempt = new Set(itemIds);
  const items = new Map(quiz.items.map((item) => [item.id, item]));
  for (const [itemId, raw] of Object.entries(answers)) {
    const item = items.get(itemId);
    if (!inAttempt.has(itemId) || !item) {
      throw badRequest(
        "STUDY_ITEM_NOT_IN_ATTEMPT",
        "An answer names a question outside this attempt",
      );
    }
    const answer = quizAnswerSchema.parse(raw);
    if (item.type === "short") {
      if (answer.selected !== undefined) {
        throw badRequest("STUDY_ANSWER_INVALID", "A short question takes no options");
      }
      continue;
    }
    if (answer.selfGrade !== undefined) {
      throw badRequest(
        "STUDY_ANSWER_INVALID",
        "Only short questions are self-graded",
      );
    }
    const selected = answer.selected ?? [];
    const optionCount = item.options?.length ?? 0;
    if (
      new Set(selected).size !== selected.length ||
      selected.some((index) => index >= optionCount) ||
      (item.type !== "multi" && selected.length > 1)
    ) {
      throw badRequest("STUDY_ANSWER_INVALID", "An answer chooses invalid options");
    }
  }
}

/**
 * Saves answers (merged over the ones already saved). `finish` scores the
 * attempt on the server against its version and closes it; after that every
 * change is a 409.
 */
export async function saveQuizAnswers(
  input: {
    workspaceId: string;
    userId: string;
    attemptId: string;
    answers: Record<string, QuizAnswer>;
    finish?: boolean;
  },
  clock: Clock = {},
): Promise<QuizAttemptView> {
  const { row, version } = await requireOwnAttempt(input);
  if (row.finishedAt) throw attemptFinished();
  checkAnswers(version.content, row.itemIds, input.answers);
  const answers = {
    ...(row.answers as Record<string, QuizAnswer>),
    ...input.answers,
  };
  const finish = input.finish
    ? {
        score: gradeAttempt(version.content, { itemIds: row.itemIds, answers })
          .score,
        finishedAt: (clock.now ?? (() => new Date()))(),
      }
    : null;
  const saved = await saveQuizAttempt({
    userId: input.userId,
    attemptId: row.id,
    answers,
    finish,
  });
  if (!saved) throw attemptFinished();
  return attemptView(saved, version.content);
}

/** The caller's own recent attempts at one quiz, newest first. */
export async function listQuizAttempts(input: {
  workspaceId: string;
  userId: string;
  artifactId: string;
}): Promise<QuizAttemptListResponse> {
  const current = await requireStudyVersion({ ...input, artifactType: "quiz" });
  const rows = await listOwnQuizAttempts({
    userId: input.userId,
    artifactId: current.owner.artifactId,
    limit: ATTEMPT_HISTORY_MAX,
  });
  const contents = new Map<number, QuizContent>([
    [current.versionNo, current.content],
  ]);
  const items: QuizAttemptView[] = [];
  for (const row of rows) {
    let content = contents.get(row.versionNo) ?? null;
    if (!content && row.finishedAt) {
      content = (
        await requireStudyVersion({
          ...input,
          artifactType: "quiz",
          versionNo: row.versionNo,
        })
      ).content;
      contents.set(row.versionNo, content);
    }
    items.push(attemptView(row, content));
  }
  return { items };
}

/**
 * Turns the questions missed in a finished attempt (wrong, unanswered, or
 * self-graded as missed) into a new flashcards artifact on the quiz's thread.
 * No model is called and nothing is billed. Retrying returns the same deck.
 */
export async function deriveCardsFromAttempt(input: {
  workspaceId: string;
  userId: string;
  attemptId: string;
}): Promise<DeriveCardsResponse> {
  const { row, version } = await requireOwnAttempt(input);
  if (!row.finishedAt) {
    throw new ContentError(
      409,
      "STUDY_ATTEMPT_NOT_FINISHED",
      "Finish the quiz before turning mistakes into cards",
    );
  }
  const { results } = gradeAttempt(version.content, row);
  const missed = row.itemIds.filter((id) => results[id] !== "correct");
  if (missed.length === 0) {
    throw badRequest("STUDY_NO_MISTAKES", "This attempt has no missed questions");
  }
  if (!version.threadId) {
    throw new ContentError(
      409,
      "STUDY_THREAD_UNAVAILABLE",
      "The quiz's conversation no longer exists",
    );
  }
  const { deriveFlashcardsFromQuiz } = await loadStudyDerivation();
  const content = deriveFlashcardsFromQuiz(version.content, missed);
  const result = await publishArtifact({
    context: {
      teamId: version.owner.teamId,
      workspaceId: version.owner.workspaceId,
      threadId: version.threadId,
      userId: input.userId,
    },
    spec: {
      artifactType: "flashcards",
      title: version.title?.trim() || "Quiz review cards",
      payload: content as unknown as Record<string, unknown>,
      idempotency: { requestKey: `study-derive-cards:${row.id}` },
    },
  });
  await copyInputSources({
    fromArtifactId: version.owner.artifactId,
    toArtifactId: result.artifactId,
  });
  return {
    artifactId: result.artifactId,
    versionId: result.versionId,
    itemCount: content.items.length,
    reused: result.reused,
  };
}
