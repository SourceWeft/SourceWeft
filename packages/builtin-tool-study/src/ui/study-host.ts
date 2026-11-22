import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import {
  configureGroundedHost,
  GroundedHostProvider,
  type GroundedFreshness,
  type GroundedTranslate,
  type GroundedVersionRef,
} from "@sourceweft/grounded-generation/ui";
import type {
  QuizAnswer,
  QuizAttempt,
  ReviewGrade,
  ReviewState,
  StudyEvidence,
} from "@sourceweft/contracts/study";

/**
 * The study viewers' port to the app.
 *
 * Like `configureArtifactRenderHost`, the app injects its facilities once and
 * the package never imports app code: learning-state API calls, opening a
 * source at a quote, the chat composer, file downloads and translations all go
 * through here. A viewer rendered without a configured host (the public share
 * page, or before the app wires one) gets `readOnlyStudyHost`: cards flip and
 * quizzes answer locally, nothing is recorded.
 */

/**
 * Which artifact version a viewer shows. Clients know a version by its
 * `artifactVersionId`; the host maps it to whatever the learning-state API
 * needs.
 */
export type StudyVersionRef = GroundedVersionRef;

export type ReviewStateView = Pick<
  ReviewState,
  "itemId" | "state" | "dueAt" | "reps" | "lapses"
>;

export type QuizAttemptView = QuizAttempt;

export type StudyFreshness = GroundedFreshness;

export type StudyTranslate = GroundedTranslate;

export type StudyHost = {
  /** False on public or signed-out surfaces: nothing is written, grading is hidden. */
  readonly interactive: boolean;
  /**
   * Translations for `study.*` keys. A React hook — only legal from a
   * component's render, so the app can back it with its i18n provider.
   */
  readonly useTranslate: () => StudyTranslate;
  listReviewProgress(
    ref: StudyVersionRef,
  ): Promise<Readonly<Record<string, ReviewStateView>>>;
  gradeCard(
    input: StudyVersionRef & { itemId: string; grade: ReviewGrade },
  ): Promise<ReviewStateView>;
  /** The newest attempt on this version, so a reload resumes an unfinished one. */
  latestQuizAttempt(ref: StudyVersionRef): Promise<QuizAttemptView | null>;
  startQuizAttempt(
    input: StudyVersionRef & { itemIds?: readonly string[] },
  ): Promise<QuizAttemptView>;
  saveQuizAnswers(input: {
    /** The workspace the attempt's artifact belongs to. */
    workspaceId: string;
    attemptId: string;
    answers: Readonly<Record<string, QuizAnswer>>;
    finish?: boolean;
  }): Promise<QuizAttemptView>;
  /** Opens the source at the quote (the app's source preview). */
  openEvidence(
    evidence: StudyEvidence,
    context: { workspaceId: string; artifactId: string },
  ): void;
  /**
   * `sha256:` digest of the text now at the evidence's range, or null when the
   * chunk no longer exists. The viewer compares it with `quoteHash`.
   */
  currentQuoteHash(
    evidence: StudyEvidence,
    context: { workspaceId: string; artifactId: string },
  ): Promise<string | null>;
  /** Puts a follow-up question into the current thread's composer. Never sends it. */
  askInChat(input: { text: string; evidence?: readonly StudyEvidence[] }): void;
  downloadText(fileName: string, mimeType: string, body: string): void;
  getFreshness(ref: StudyVersionRef): Promise<StudyFreshness>;
  /** Present when the app can regenerate (retry a failure, refresh a stale artifact). */
  readonly requestRegenerate?: (ref: StudyVersionRef) => void | Promise<void>;
};

/**
 * Every translation key the study viewers and the shared evidence and
 * staleness components ask the host for, so an app can check its catalogs
 * cover them. Keys built from a value are listed once per value.
 */
export const STUDY_TRANSLATION_KEYS = [
  "study.status.queued",
  "study.status.generating",
  "study.error.retry",
  "study.error.cannotDisplay",
  "study.error.code.INSUFFICIENT_CREDITS",
  "study.error.code.INPUT_TOO_LARGE",
  "study.error.code.NO_INDEXED_SOURCES",
  "study.error.code.MODEL_UNAVAILABLE",
  "study.error.code.GENERATION_QUALITY_TOO_LOW",
  "study.error.code.SOURCE_NOT_READABLE",
  "study.error.code.UNKNOWN",
  "study.evidence.show",
  "study.evidence.hide",
  "study.evidence.sourceChanged",
  "study.evidence.openSource",
  "study.stale.message",
  "study.stale.sourceDeleted",
  "study.stale.regenerate",
  "study.flashcards.label",
  "study.flashcards.mode.browse",
  "study.flashcards.mode.review",
  "study.flashcards.progress",
  "study.flashcards.exportAnki",
  "study.flashcards.showFront",
  "study.flashcards.showBack",
  "study.flashcards.showingFront",
  "study.flashcards.showingBack",
  "study.flashcards.gradeFailed",
  "study.flashcards.nothingDue",
  "study.flashcards.done",
  "study.flashcards.restart",
  "study.flashcards.previous",
  "study.flashcards.next",
  "study.flashcards.hintFlip",
  "study.flashcards.hintGrade",
  "study.flashcards.gradeLabel",
  "study.flashcards.grade.again",
  "study.flashcards.grade.hard",
  "study.flashcards.grade.good",
  "study.flashcards.grade.easy",
  "study.quiz.loading",
  "study.quiz.intro",
  "study.quiz.start",
  "study.quiz.saveFailed",
  "study.quiz.questionOf",
  "study.quiz.previous",
  "study.quiz.submit",
  "study.quiz.next",
  "study.quiz.true",
  "study.quiz.false",
  "study.quiz.chooseOne",
  "study.quiz.chooseAll",
  "study.quiz.yourAnswer",
  "study.quiz.referenceAnswer",
  "study.quiz.showReference",
  "study.quiz.selfGrade.knew",
  "study.quiz.selfGrade.missed",
  "study.quiz.result.score",
  "study.quiz.result.selfGraded",
  "study.quiz.practiceMistakes",
  "study.quiz.restart",
  "study.quiz.verdict.correct",
  "study.quiz.verdict.wrong",
  "study.quiz.verdict.self.knew",
  "study.quiz.verdict.self.missed",
  "study.quiz.verdict.self.none",
  "study.quiz.correctAnswer",
  "study.mindmap.view.map",
  "study.mindmap.view.outline",
  "study.mindmap.exportMarkdown",
  "study.mindmap.exportJson",
  "study.mindmap.detailLabel",
  "study.mindmap.askPrompt",
  "study.mindmap.askInChat",
  "study.mindmap.expand",
  "study.mindmap.collapse",
  "study.mindmap.outlineLabel",
] as const;

function notAvailable(): Promise<never> {
  return Promise.reject(new Error("Learning state is not available here"));
}

/** Without translations the key itself is shown. */
const passthroughTranslate: StudyTranslate = (key) => key;

function browserDownload(fileName: string, mimeType: string, body: string) {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const url = URL.createObjectURL(new Blob([body], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const readOnlyStudyHost: StudyHost = {
  interactive: false,
  useTranslate: () => passthroughTranslate,
  listReviewProgress: async () => ({}),
  gradeCard: notAvailable,
  latestQuizAttempt: async () => null,
  startQuizAttempt: notAvailable,
  saveQuizAnswers: notAvailable,
  openEvidence: () => {},
  currentQuoteHash: notAvailable,
  askInChat: () => {},
  downloadText: browserDownload,
  getFreshness: async () => ({ status: "unknown" }),
};

let configuredHost: StudyHost | null = null;

/** Installed once by the app shell, before any study viewer renders. */
export function configureStudyHost(host: StudyHost | null) {
  configuredHost = host;
  // The shared evidence and staleness components read the same host.
  configureGroundedHost(host);
}

const StudyHostContext = createContext<StudyHost | null>(null);

/** Overrides the configured host for a subtree (tests, the share page). */
export function StudyHostProvider({
  host,
  children,
}: {
  host: StudyHost;
  children?: ReactNode;
}) {
  return createElement(
    StudyHostContext.Provider,
    { value: host },
    createElement(GroundedHostProvider, { host, children }),
  );
}

export function useStudyHost(): StudyHost {
  return useContext(StudyHostContext) ?? configuredHost ?? readOnlyStudyHost;
}
