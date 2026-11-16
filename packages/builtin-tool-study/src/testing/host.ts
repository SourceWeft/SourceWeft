import type { QuizAnswer } from "@sourceweft/contracts/study";
import type {
  QuizAttemptView,
  ReviewStateView,
  StudyHost,
  StudyTranslate,
} from "../ui/study-host";

/**
 * A study host for tests and fixture previews: interactive, answers from
 * memory, and records every call by method name. Translation shows the key,
 * followed by its values, so a test can assert on keys.
 */
export type RecordingStudyHost = StudyHost & {
  readonly calls: Array<{ method: string; input: unknown }>;
  callsTo(method: string): unknown[];
};

export const keyTranslate: StudyTranslate = (key, values) =>
  values && Object.keys(values).length > 0
    ? `${key} ${Object.entries(values)
        .map(([name, value]) => `${name}=${value}`)
        .join(" ")}`
    : key;

export function createRecordingStudyHost(
  overrides: Partial<StudyHost> = {},
): RecordingStudyHost {
  const calls: Array<{ method: string; input: unknown }> = [];
  let attemptNo = 0;
  const attempts = new Map<string, QuizAttemptView>();
  const record = (method: string, input: unknown) => calls.push({ method, input });

  const base: StudyHost = {
    interactive: true,
    useTranslate: () => keyTranslate,
    async listReviewProgress(ref) {
      record("listReviewProgress", ref);
      return {};
    },
    async gradeCard(input) {
      record("gradeCard", input);
      const state: ReviewStateView = {
        itemId: input.itemId,
        state: 1,
        dueAt: "2026-11-16T00:00:00.000Z",
        reps: 1,
        lapses: input.grade === 1 ? 1 : 0,
      };
      return state;
    },
    async latestQuizAttempt(ref) {
      record("latestQuizAttempt", ref);
      return null;
    },
    async startQuizAttempt(input) {
      record("startQuizAttempt", input);
      attemptNo += 1;
      const attempt: QuizAttemptView = {
        id: `attempt-${attemptNo}`,
        artifactId: input.artifactId,
        versionNo: 1,
        itemIds: [...(input.itemIds ?? [])],
        answers: {},
        score: null,
        total: input.itemIds?.length ?? 0,
        startedAt: "2026-11-15T00:00:00.000Z",
        finishedAt: null,
      };
      attempts.set(attempt.id, attempt);
      return attempt;
    },
    async saveQuizAnswers(input) {
      record("saveQuizAnswers", input);
      const previous = attempts.get(input.attemptId);
      if (!previous) throw new Error(`unknown attempt ${input.attemptId}`);
      const next: QuizAttemptView = {
        ...previous,
        answers: { ...(input.answers as Record<string, QuizAnswer>) },
        finishedAt: input.finish ? "2026-11-15T00:10:00.000Z" : null,
      };
      attempts.set(next.id, next);
      return next;
    },
    openEvidence(evidence, context) {
      record("openEvidence", { evidence, context });
    },
    async currentQuoteHash(evidence) {
      record("currentQuoteHash", evidence);
      return evidence.quoteHash;
    },
    askInChat(input) {
      record("askInChat", input);
    },
    downloadText(fileName, mimeType, body) {
      record("downloadText", { fileName, mimeType, body });
    },
    async getFreshness(ref) {
      record("getFreshness", ref);
      return { status: "fresh" };
    },
  };

  const host = { ...base } as StudyHost;
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value === "function" && name !== "useTranslate") {
      (host as Record<string, unknown>)[name] = (...args: unknown[]) => {
        record(name, args[0]);
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    } else {
      (host as Record<string, unknown>)[name] = value;
    }
  }
  return Object.assign(host, {
    calls,
    callsTo: (method: string) =>
      calls.filter((call) => call.method === method).map((call) => call.input),
  });
}
