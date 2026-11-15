"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type { QuizAnswer, QuizItem } from "@sourceweft/contracts/study";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import type { StudyTranslate } from "../study-host";

/** Display text of option `index`; true/false labels are localized here. */
export function quizOptionLabel(item: QuizItem, index: number, t: StudyTranslate) {
  const option = item.options?.[index] ?? "";
  if (item.type !== "truefalse") return option;
  return t(option === "true" ? "study.quiz.true" : "study.quiz.false");
}

function ChoiceOptions({
  item,
  answer,
  onAnswer,
  t,
}: {
  item: QuizItem;
  answer: QuizAnswer | undefined;
  onAnswer: (answer: QuizAnswer) => void;
  t: StudyTranslate;
}) {
  const multi = item.type === "multi";
  const selected = new Set(answer?.selected ?? []);

  function toggle(index: number) {
    if (!multi) {
      onAnswer({ selected: [index] });
      return;
    }
    const next = new Set(selected);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onAnswer({ selected: [...next].sort((a, b) => a - b) });
  }

  return (
    <div
      aria-label={t(multi ? "study.quiz.chooseAll" : "study.quiz.chooseOne")}
      className="flex flex-col gap-2"
      role={multi ? "group" : "radiogroup"}
    >
      {(item.options ?? []).map((_, index) => {
        const checked = selected.has(index);
        return (
          <button
            aria-checked={checked}
            className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none ${
              checked ? "border-primary bg-primary/10" : "bg-card hover:bg-accent/50"
            }`}
            key={index}
            onClick={() => toggle(index)}
            role={multi ? "checkbox" : "radio"}
            type="button"
          >
            <span
              aria-hidden
              className={`flex size-5 shrink-0 items-center justify-center border ${
                multi ? "rounded-md" : "rounded-full"
              } ${checked ? "border-primary bg-primary text-primary-foreground" : ""}`}
            >
              {checked ? <Check className="size-3.5" /> : null}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap">
              {quizOptionLabel(item, index, t)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ShortAnswer({
  item,
  answer,
  onAnswer,
  t,
}: {
  item: QuizItem;
  answer: QuizAnswer | undefined;
  onAnswer: (answer: QuizAnswer) => void;
  t: StudyTranslate;
}) {
  const [revealed, setRevealed] = useState(Boolean(answer?.selfGrade));
  const text = answer?.text ?? "";

  return (
    <div className="flex flex-col gap-3">
      <textarea
        aria-label={t("study.quiz.yourAnswer")}
        className="min-h-24 w-full rounded-xl border bg-card px-3 py-2 text-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        onChange={(event) =>
          onAnswer({ ...answer, text: event.target.value })
        }
        placeholder={t("study.quiz.yourAnswer")}
        value={text}
      />
      {revealed ? (
        <div className="space-y-3 rounded-xl border bg-muted/40 p-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">
            {t("study.quiz.referenceAnswer")}
          </p>
          <p className="whitespace-pre-wrap">{item.referenceAnswer}</p>
          <div className="flex flex-wrap gap-2" role="group">
            {(["knew", "missed"] as const).map((grade) => (
              <Button
                aria-pressed={answer?.selfGrade === grade}
                key={grade}
                onClick={() => onAnswer({ ...answer, selfGrade: grade })}
                size="sm"
                type="button"
                variant={answer?.selfGrade === grade ? "secondary" : "outline"}
              >
                {t(`study.quiz.selfGrade.${grade}`)}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <Button
          className="self-start"
          onClick={() => setRevealed(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("study.quiz.showReference")}
        </Button>
      )}
    </div>
  );
}

/**
 * One question. Choice options keep the order stored in the content, so a
 * later review shows them exactly as answered. Short questions are only
 * self-graded against the reference answer.
 */
export function QuizQuestion({
  item,
  answer,
  onAnswer,
  t,
}: {
  item: QuizItem;
  answer: QuizAnswer | undefined;
  onAnswer: (answer: QuizAnswer) => void;
  t: StudyTranslate;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-base font-medium whitespace-pre-wrap">{item.stem}</p>
      {item.type === "short" ? (
        <ShortAnswer answer={answer} item={item} key={item.id} onAnswer={onAnswer} t={t} />
      ) : (
        <ChoiceOptions answer={answer} item={item} onAnswer={onAnswer} t={t} />
      )}
    </div>
  );
}
