"use client";

import type { ReviewGrade } from "@sourceweft/contracts/study";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import type { StudyTranslate } from "../study-host";

export const GRADE_KEYS: Record<ReviewGrade, string> = {
  1: "study.flashcards.grade.again",
  2: "study.flashcards.grade.hard",
  3: "study.flashcards.grade.good",
  4: "study.flashcards.grade.easy",
};

const GRADES: ReviewGrade[] = [1, 2, 3, 4];

/** The four FSRS grades; number keys 1–4 do the same. */
export function ReviewControls({
  onGrade,
  t,
}: {
  onGrade: (grade: ReviewGrade) => void;
  t: StudyTranslate;
}) {
  return (
    <div
      aria-label={t("study.flashcards.gradeLabel")}
      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      role="group"
    >
      {GRADES.map((grade) => (
        <Button
          aria-keyshortcuts={String(grade)}
          data-grade={grade}
          key={grade}
          onClick={() => onGrade(grade)}
          type="button"
          variant={grade === 1 ? "destructive" : grade === 3 ? "default" : "outline"}
        >
          {t(GRADE_KEYS[grade])}
        </Button>
      ))}
    </div>
  );
}
