"use client";

import { useState } from "react";
import { CircleCheck, CircleX, Layers, RotateCcw } from "lucide-react";
import { buildArtifactPreviewUrl } from "@sourceweft/contracts/artifact-urls";
import type { QuizAnswer, QuizItem } from "@sourceweft/contracts/study";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { EvidencePopover } from "@sourceweft/grounded-generation/ui";
import type { StudyTranslate, StudyVersionRef } from "../study-host";
import { quizOptionLabel } from "./question";
import { isAnswerCorrect, type QuizScore } from "./scoring";

/**
 * The end of an attempt: the auto score, short answers' self grades counted
 * apart, and every question with its verdict, the correct answer, the
 * explanation and the evidence. "Practise mistakes" re-runs only the wrong ones
 * in the quiz; "Make flashcards from mistakes" turns them into a new deck.
 */
export function QuizResultSummary({
  items,
  answers,
  score,
  version,
  interactive,
  onPracticeMistakes,
  onRestart,
  onMakeCards,
  t,
}: {
  items: readonly QuizItem[];
  answers: Readonly<Record<string, QuizAnswer>>;
  score: QuizScore;
  version: StudyVersionRef;
  interactive: boolean;
  onPracticeMistakes: () => void;
  onRestart: () => void;
  /** Present when the attempt can become a deck (saved, and the host writes). */
  onMakeCards?: () => Promise<{ artifactId: string; versionId: string | null; itemCount: number }>;
  t: StudyTranslate;
}) {
  const [cards, setCards] = useState<
    | { status: "idle" | "pending" | "failed" }
    | { status: "done"; href: string; itemCount: number }
  >({ status: "idle" });

  async function makeCards() {
    if (!onMakeCards || cards.status === "pending") return;
    setCards({ status: "pending" });
    try {
      const deck = await onMakeCards();
      setCards({
        status: "done",
        itemCount: deck.itemCount,
        href: buildArtifactPreviewUrl({
          workspaceId: version.workspaceId,
          artifactId: deck.artifactId,
          ...(deck.versionId ? { artifactVersionId: deck.versionId } : {}),
        }),
      });
    } catch {
      setCards({ status: "failed" });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1 rounded-xl border bg-card p-4">
        {score.autoTotal > 0 ? (
          <p className="text-lg font-semibold">
            {t("study.quiz.result.score", {
              correct: score.autoCorrect,
              total: score.autoTotal,
            })}
          </p>
        ) : null}
        {score.selfTotal > 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("study.quiz.result.selfGraded", {
              knew: score.selfKnew,
              total: score.selfTotal,
            })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-2">
          {score.wrongItemIds.length > 0 ? (
            <Button onClick={onPracticeMistakes} size="sm" type="button">
              {t("study.quiz.practiceMistakes")}
            </Button>
          ) : null}
          {score.wrongItemIds.length > 0 && onMakeCards && cards.status !== "done" ? (
            <Button
              data-make-cards
              disabled={cards.status === "pending"}
              onClick={() => void makeCards()}
              size="sm"
              type="button"
              variant="outline"
            >
              <Layers aria-hidden />
              {t("study.quiz.mistakesToCards")}
            </Button>
          ) : null}
          <Button onClick={onRestart} size="sm" type="button" variant="outline">
            <RotateCcw aria-hidden />
            {t("study.quiz.restart")}
          </Button>
        </div>
        {cards.status === "done" ? (
          <p className="pt-1 text-sm" data-made-cards role="status">
            {t("study.quiz.mistakesToCardsDone", { count: cards.itemCount })}{" "}
            <a
              className="font-medium underline underline-offset-2"
              href={cards.href}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("study.quiz.mistakesToCardsOpen")}
            </a>
          </p>
        ) : null}
        {cards.status === "failed" ? (
          <p className="pt-1 text-sm text-destructive" role="alert">
            {t("study.quiz.mistakesToCardsFailed")}
          </p>
        ) : null}
      </div>

      <ol className="flex flex-col gap-3">
        {items.map((item, position) => {
          const answer = answers[item.id];
          const verdict = isAnswerCorrect(item, answer);
          const right = verdict ?? answer?.selfGrade === "knew";
          return (
            <li className="space-y-2 rounded-xl border p-4" data-quiz-result={item.id} key={item.id}>
              <div className="flex items-start gap-2">
                {right ? (
                  <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                ) : (
                  <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <p className="text-sm font-medium whitespace-pre-wrap">
                  {position + 1}. {item.stem}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  verdict === null
                    ? `study.quiz.verdict.self.${answer?.selfGrade ?? "none"}`
                    : verdict
                      ? "study.quiz.verdict.correct"
                      : "study.quiz.verdict.wrong",
                )}
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground">{t("study.quiz.correctAnswer")} </span>
                {item.type === "short"
                  ? item.referenceAnswer
                  : (item.correct ?? [])
                      .map((index) => quizOptionLabel(item, index, t))
                      .join("; ")}
              </p>
              <p className="text-sm whitespace-pre-wrap">{item.explanation}</p>
              <EvidencePopover
                artifactId={version.artifactId}
                evidence={item.evidence}
                interactive={interactive}
                workspaceId={version.workspaceId}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
