"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type TouchEvent } from "react";
import { ChevronLeft, ChevronRight, Download, RotateCcw } from "lucide-react";
import type { ReviewGrade, StudyContent } from "@sourceweft/contracts/study";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { exportFlashcardsCsv } from "../../export/anki-csv";
import { EvidencePopover } from "@sourceweft/grounded-generation/ui";
import { downloadStem, isViewerShortcut } from "../shared/util";
import {
  useStudyHost,
  type ReviewStateView,
  type StudyTranslate,
  type StudyVersionRef,
} from "../study-host";
import { Flashcard } from "./flashcard";
import { ReviewControls } from "./review-controls";
import {
  cardStatus,
  deckSummary,
  dueCardIds,
  nextDueAt,
  useFlashcardSession,
  type FlashcardMode,
} from "./use-flashcard-session";

type FlashcardsContent = Extract<StudyContent, { kind: "flashcards" }>;

const SWIPE_DISTANCE = 60;
const MINUTE = 60_000;

/** The current time, refreshed every minute so due labels stay true. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "Due now", or how long until a card is due, in minutes, hours or days. */
export function dueLabel(due: number, now: number, t: StudyTranslate) {
  const minutes = Math.ceil((due - now) / MINUTE);
  if (minutes <= 0) return t("study.flashcards.due.now");
  if (minutes < 60) return t("study.flashcards.due.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("study.flashcards.due.hours", { count: hours });
  return t("study.flashcards.due.days", { count: Math.round(hours / 24) });
}

/** Where one card stands, with its due time once it has been graded. */
function CardStatusLine({
  state,
  now,
  t,
}: {
  state: ReviewStateView | undefined;
  now: number;
  t: StudyTranslate;
}) {
  const status = cardStatus(state);
  return (
    <p className="text-center text-xs text-muted-foreground" data-card-status={status}>
      {t(`study.flashcards.status.${status}`)}
      {state && status !== "new" ? ` · ${dueLabel(Date.parse(state.dueAt), now, t)}` : null}
    </p>
  );
}

/**
 * Flashcards in two modes: browse every card with where it stands, changing
 * nothing, or review the cards that are new or due and grade them. A deck
 * with saved progress opens on its review. Space/Enter flips, 1–4 grades a
 * flipped card in review, arrow keys move; on touch, swiping a flipped review
 * card right grades it Good and left Again. Progress and grading only exist
 * when the viewer is interactive.
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
  const now = useNow();
  const reviewing = interactive && state.mode === "review";

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
  const summary = deckSummary(content.items, state.progress);
  const dueCount = dueCardIds(content.items, state.progress, now).length;
  const nextDue = nextDueAt(content.items, state.progress, now);

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
                {mode === "review" && dueCount > 0 ? (
                  <span
                    className="rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground tabular-nums"
                    data-due-count
                  >
                    {dueCount}
                  </span>
                ) : null}
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

      {interactive ? (
        <p className="text-xs text-muted-foreground" data-deck-summary>
          {t("study.flashcards.summary", {
            new: summary.new,
            learning: summary.learning,
            learned: summary.learned,
          })}
        </p>
      ) : null}

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
        <div className="flex flex-col items-center gap-1 py-10 text-center text-sm text-muted-foreground">
          <p>{t("study.flashcards.nothingDue")}</p>
          {nextDue !== null ? (
            <p data-next-due>{t("study.flashcards.nextDue", { when: dueLabel(nextDue, now, t) })}</p>
          ) : null}
        </div>
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
          {interactive && !reviewing ? (
            <CardStatusLine now={now} state={state.progress[current.id]} t={t} />
          ) : null}
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
              {t(
                !state.flipped || !interactive
                  ? "study.flashcards.hintFlip"
                  : reviewing
                    ? "study.flashcards.hintGrade"
                    : "study.flashcards.hintBrowse",
              )}
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
          {state.flipped && reviewing ? (
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
