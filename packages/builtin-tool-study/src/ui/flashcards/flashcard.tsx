"use client";

import type { FlashcardItem } from "@sourceweft/contracts/study";
import type { StudyTranslate } from "../study-host";

/** One card. Clicking it flips it; the back is only in the DOM once flipped. */
export function Flashcard({
  item,
  flipped,
  onFlip,
  t,
}: {
  item: FlashcardItem;
  flipped: boolean;
  onFlip: () => void;
  t: StudyTranslate;
}) {
  return (
    <button
      aria-label={t(flipped ? "study.flashcards.showFront" : "study.flashcards.showBack")}
      className="flex min-h-56 w-full flex-col items-center justify-center gap-4 rounded-2xl border bg-card p-6 text-center shadow-sm transition-colors hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={onFlip}
      type="button"
    >
      <span className="text-lg font-medium whitespace-pre-wrap text-foreground">
        {item.front}
      </span>
      {flipped ? (
        <>
          <span aria-hidden className="h-px w-16 bg-border" />
          <span className="text-base whitespace-pre-wrap text-foreground">
            {item.back}
          </span>
        </>
      ) : item.hint ? (
        <span className="text-sm text-muted-foreground">{item.hint}</span>
      ) : null}
    </button>
  );
}
