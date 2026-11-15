"use client";

import { useRef, type KeyboardEvent, type TouchEvent } from "react";
import { ChevronLeft, ChevronRight, Download, RotateCcw } from "lucide-react";
import type { ReviewGrade, StudyContent } from "@sourceweft/contracts/study";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { exportFlashcardsCsv } from "../../export/anki-csv";
import { EvidencePopover } from "../shared/evidence-popover";
import { downloadStem, isViewerShortcut } from "../shared/util";
import { useStudyHost, type StudyVersionRef } from "../study-host";
import { Flashcard } from "./flashcard";
import { ReviewControls } from "./review-controls";
import { useFlashcardSession, type FlashcardMode } from "./use-flashcard-session";

type FlashcardsContent = Extract<StudyContent, { kind: "flashcards" }>;

const SWIPE_DISTANCE = 60;

/**
 * Flashcards in two modes: browse every card, or review only the cards that
 * are new or due. Space/Enter flips, 1–4 grades a flipped card, arrow keys
 * move; on touch, swiping a flipped card right grades it Good and left Again.
 * Grading only exists when the viewer is interactive.
 */
export function FlashcardsViewer({
  content,
  version,
  interactive: interactiveProp,
  title,
}: {
  content: FlashcardsContent;
  version: StudyVersionRef;
  /** Narrows the host's `interactive` (e.g. false on the share page). */
  interactive?: boolean;
  title?: string | null;
}) {
  const host = useStudyHost();
  const t = host.useTranslate();
  const interactive = host.interactive && interactiveProp !== false;
  const session = useFlashcardSession({
    items: content.items,
    host,
    version,
    interactive,
  });
  const { state, current, done } = session;
  const touchStartX = useRef<number | null>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!isViewerShortcut(event)) return;
    if (event.key === " " || event.key === "Enter") {
      // A focused button inside handles its own activation.
      if ((event.target as HTMLElement).tagName === "BUTTON") return;
      event.preventDefault();
      session.flip();
    } else if (event.key === "ArrowRight") {
      session.move(1);
    } else if (event.key === "ArrowLeft") {
      session.move(-1);
    } else if (["1", "2", "3", "4"].includes(event.key)) {
      session.grade(Number(event.key) as ReviewGrade);
    }
  }

  function onTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const start = touchStartX.current;
    touchStartX.current = null;
    const end = event.changedTouches[0]?.clientX;
    if (start === null || end === undefined) return;
    if (end - start > SWIPE_DISTANCE) session.grade(3);
    else if (start - end > SWIPE_DISTANCE) session.grade(1);
  }

  const modes: FlashcardMode[] = interactive ? ["browse", "review"] : ["browse"];
  const total = state.queue.length;
  const gradedCount = Object.keys(state.graded).length;

  return (
    <div
      aria-label={t("study.flashcards.label")}
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 outline-none"
      data-study-flashcards
      onKeyDown={onKeyDown}
      onTouchEnd={onTouchEnd}
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      role="region"
      tabIndex={0}
    >
      <div className="flex flex-wrap items-center gap-2">
        {modes.length > 1 ? (
          <div className="flex gap-1" role="group">
            {modes.map((mode) => (
              <Button
                aria-pressed={state.mode === mode}
                key={mode}
                onClick={() => session.setMode(mode)}
                size="sm"
                type="button"
                variant={state.mode === mode ? "secondary" : "ghost"}
              >
                {t(`study.flashcards.mode.${mode}`)}
              </Button>
            ))}
          </div>
        ) : null}
        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {total > 0
            ? t("study.flashcards.progress", {
                current: Math.min(state.index + 1, total),
                total,
              })
            : null}
        </span>
        <Button
          onClick={() =>
            host.downloadText(
              `${downloadStem(title, "flashcards")}.csv`,
              "text/csv",
              exportFlashcardsCsv(content),
            )
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          <Download aria-hidden />
          {t("study.flashcards.exportAnki")}
        </Button>
      </div>

      {total > 0 ? (
        <div
          aria-hidden
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${(Math.min(state.index, total) / total) * 100}%` }}
          />
        </div>
      ) : null}

      <div aria-live="polite" className="sr-only">
        {current
          ? t(state.flipped ? "study.flashcards.showingBack" : "study.flashcards.showingFront")
          : null}
      </div>

      {state.gradeFailed ? (
        <p className="text-sm text-destructive" role="alert">
          {t("study.flashcards.gradeFailed")}
        </p>
      ) : null}

      {total === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t("study.flashcards.nothingDue")}
        </p>
      ) : done ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-base font-medium">
            {t("study.flashcards.done", { graded: gradedCount, total })}
          </p>
          <Button onClick={session.restart} type="button" variant="outline">
            <RotateCcw aria-hidden />
            {t("study.flashcards.restart")}
          </Button>
        </div>
      ) : current ? (
        <>
          <Flashcard
            flipped={state.flipped}
            item={current}
            onFlip={session.flip}
            t={t}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              aria-label={t("study.flashcards.previous")}
              disabled={state.index === 0}
              onClick={() => session.move(-1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ChevronLeft aria-hidden />
            </Button>
            <span className="text-xs text-muted-foreground">
              {t(state.flipped ? "study.flashcards.hintGrade" : "study.flashcards.hintFlip")}
            </span>
            <Button
              aria-label={t("study.flashcards.next")}
              disabled={state.index >= total - 1}
              onClick={() => session.move(1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>
          {state.flipped && interactive ? (
            <ReviewControls onGrade={session.grade} t={t} />
          ) : null}
          {state.flipped ? (
            <EvidencePopover
              artifactId={version.artifactId}
              evidence={current.evidence}
              interactive={interactive}
              workspaceId={version.workspaceId}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
