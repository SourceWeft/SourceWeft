"use client";

import type { StudyContent } from "@sourceweft/contracts/study";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useStudyHost, type StudyVersionRef } from "../study-host";
import { QuizQuestion } from "./question";
import { QuizResultSummary } from "./result-summary";
import { scoreQuiz } from "./scoring";
import { useQuizSession } from "./use-quiz-session";

type QuizContent = Extract<StudyContent, { kind: "quiz" }>;

/** A quiz: one question at a time, then the result with explanations and evidence. */
export function QuizViewer({
  content,
  version,
  interactive: interactiveProp,
}: {
  content: QuizContent;
  version: StudyVersionRef;
  /** Narrows the host's `interactive` (e.g. false on the share page). */
  interactive?: boolean;
}) {
  const host = useStudyHost();
  const t = host.useTranslate();
  const interactive = host.interactive && interactiveProp !== false;
  const quiz = useQuizSession({ items: content.items, host, version, interactive });
  const { session, sessionItems } = quiz;
  const total = sessionItems.length;

  if (session.phase === "loading") {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        {t("study.quiz.loading")}
      </p>
    );
  }

  if (session.phase === "intro") {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center" data-study-quiz>
        <p className="text-base font-medium">
          {t("study.quiz.intro", { total: content.items.length })}
        </p>
        <Button onClick={() => void quiz.start()} type="button">
          {t("study.quiz.start")}
        </Button>
      </div>
    );
  }

  if (session.phase === "finished") {
    const score = scoreQuiz(sessionItems, session.answers);
    return (
      <div className="h-full min-h-0 overflow-y-auto p-4" data-study-quiz>
        {session.saveFailed ? (
          <p className="mb-3 text-sm text-destructive" role="alert">
            {t("study.quiz.saveFailed")}
          </p>
        ) : null}
        <QuizResultSummary
          answers={session.answers}
          interactive={interactive}
          items={sessionItems}
          onPracticeMistakes={() => void quiz.start(score.wrongItemIds)}
          onRestart={() => void quiz.start()}
          score={score}
          t={t}
          version={version}
        />
      </div>
    );
  }

  const item = sessionItems[session.index];
  const last = session.index >= total - 1;
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4" data-study-quiz>
      <div className="flex items-center justify-between text-sm text-muted-foreground tabular-nums">
        <span>{t("study.quiz.questionOf", { current: session.index + 1, total })}</span>
      </div>
      <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${(Object.keys(session.answers).length / Math.max(total, 1)) * 100}%` }}
        />
      </div>
      {session.saveFailed ? (
        <p className="text-sm text-destructive" role="alert">
          {t("study.quiz.saveFailed")}
        </p>
      ) : null}
      {item ? (
        <QuizQuestion
          answer={session.answers[item.id]}
          item={item}
          key={item.id}
          onAnswer={(value) => quiz.answer(item.id, value)}
          t={t}
        />
      ) : null}
      <div className="flex items-center justify-between gap-2 pt-2">
        <Button
          disabled={session.index === 0}
          onClick={() => quiz.goTo(session.index - 1)}
          type="button"
          variant="ghost"
        >
          {t("study.quiz.previous")}
        </Button>
        {last ? (
          <Button onClick={() => void quiz.submit()} type="button">
            {t("study.quiz.submit")}
          </Button>
        ) : (
          <Button onClick={() => quiz.goTo(session.index + 1)} type="button">
            {t("study.quiz.next")}
          </Button>
        )}
      </div>
    </div>
  );
}
