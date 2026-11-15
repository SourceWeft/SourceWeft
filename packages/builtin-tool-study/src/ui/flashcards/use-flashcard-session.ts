"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { FlashcardItem, ReviewGrade } from "@sourceweft/contracts/study";
import type { ReviewStateView, StudyHost, StudyVersionRef } from "../study-host";

export type FlashcardMode = "browse" | "review";

type State = {
  mode: FlashcardMode;
  /** Item ids of the current pass, in order. */
  queue: string[];
  /** Position in `queue`; `queue.length` once the pass is done. */
  index: number;
  flipped: boolean;
  graded: Record<string, ReviewGrade>;
  progress: Record<string, ReviewStateView>;
  gradeFailed: boolean;
};

type Action =
  | { type: "flip" }
  | { type: "move"; by: number }
  | { type: "mode"; mode: FlashcardMode; items: readonly FlashcardItem[]; now: number }
  | { type: "progress"; progress: Readonly<Record<string, ReviewStateView>> }
  | { type: "graded"; id: string; grade: ReviewGrade }
  | { type: "saved"; state: ReviewStateView }
  | { type: "rollback"; id: string; index: number }
  | { type: "restart" };

/** Cards the review pass holds: never seen, or due by `now`. */
export function dueCardIds(
  items: readonly FlashcardItem[],
  progress: Readonly<Record<string, ReviewStateView>>,
  now: number,
): string[] {
  return items
    .filter((item) => {
      const state = progress[item.id];
      return !state || Date.parse(state.dueAt) <= now;
    })
    .map((item) => item.id);
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "flip":
      return state.index < state.queue.length
        ? { ...state, flipped: !state.flipped }
        : state;
    case "move": {
      const index = Math.min(
        Math.max(state.index + action.by, 0),
        Math.max(state.queue.length - 1, 0),
      );
      return { ...state, index, flipped: false, gradeFailed: false };
    }
    case "mode":
      return {
        ...state,
        mode: action.mode,
        queue:
          action.mode === "review"
            ? dueCardIds(action.items, state.progress, action.now)
            : action.items.map((item) => item.id),
        index: 0,
        flipped: false,
        graded: {},
        gradeFailed: false,
      };
    case "progress":
      return { ...state, progress: { ...action.progress, ...state.progress } };
    case "graded":
      return {
        ...state,
        graded: { ...state.graded, [action.id]: action.grade },
        index: state.index + 1,
        flipped: false,
        gradeFailed: false,
      };
    case "saved":
      return {
        ...state,
        progress: { ...state.progress, [action.state.itemId]: action.state },
      };
    case "rollback": {
      const graded = { ...state.graded };
      delete graded[action.id];
      return { ...state, graded, index: action.index, flipped: false, gradeFailed: true };
    }
    case "restart":
      return { ...state, index: 0, flipped: false, graded: {}, gradeFailed: false };
  }
}

/**
 * One pass through a deck. Grading is optimistic: the deck moves on at once
 * and, if the host fails to save the grade, steps back to that card and flags
 * the failure.
 */
export function useFlashcardSession({
  items,
  host,
  version,
  interactive,
}: {
  items: readonly FlashcardItem[];
  host: StudyHost;
  version: StudyVersionRef;
  interactive: boolean;
}) {
  const [state, dispatch] = useReducer(reducer, items, (initial) => ({
    mode: "browse" as const,
    queue: initial.map((item) => item.id),
    index: 0,
    flipped: false,
    graded: {},
    progress: {},
    gradeFailed: false,
  }));
  const { workspaceId, artifactId, artifactVersionId } = version;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!interactive) return;
    let cancelled = false;
    host
      .listReviewProgress({ workspaceId, artifactId, artifactVersionId })
      .then((progress) => {
        if (!cancelled) dispatch({ type: "progress", progress });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artifactId, artifactVersionId, host, interactive, workspaceId]);

  const grade = useCallback(
    (value: ReviewGrade) => {
      const current = stateRef.current;
      const id = current.queue[current.index];
      if (!interactive || !current.flipped || !id) return;
      const index = current.index;
      dispatch({ type: "graded", id, grade: value });
      host
        .gradeCard({ workspaceId, artifactId, artifactVersionId, itemId: id, grade: value })
        .then((saved) => dispatch({ type: "saved", state: saved }))
        .catch(() => dispatch({ type: "rollback", id, index }));
    },
    [artifactId, artifactVersionId, host, interactive, workspaceId],
  );

  return {
    state,
    current: items.find((item) => item.id === state.queue[state.index]) ?? null,
    done: state.queue.length > 0 && state.index >= state.queue.length,
    flip: () => dispatch({ type: "flip" }),
    move: (by: number) => dispatch({ type: "move", by }),
    setMode: (mode: FlashcardMode) =>
      dispatch({ type: "mode", mode, items, now: Date.now() }),
    restart: () => dispatch({ type: "restart" }),
    grade,
  };
}
