"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { QuizAnswer, QuizItem } from "@sourceweft/contracts/study";
import type { StudyHost, StudyVersionRef } from "../study-host";

export type QuizPhase = "loading" | "intro" | "answering" | "finished";

/** Answers are saved this long after the last change, and at once on submit. */
export const QUIZ_SAVE_DEBOUNCE_MS = 600;

type Session = {
  phase: QuizPhase;
  attemptId: string | null;
  itemIds: string[];
  index: number;
  answers: Record<string, QuizAnswer>;
  saveFailed: boolean;
};

function firstUnanswered(itemIds: readonly string[], answers: Record<string, QuizAnswer>) {
  const index = itemIds.findIndex((id) => !answers[id]);
  return index === -1 ? Math.max(itemIds.length - 1, 0) : index;
}

/**
 * One quiz attempt. Interactive viewers keep it on the server (start, debounced
 * saves, a final save that finishes it, and resuming an unfinished attempt on
 * reload); otherwise it lives only in this component.
 */
export function useQuizSession({
  items,
  host,
  version,
  interactive,
}: {
  items: readonly QuizItem[];
  host: StudyHost;
  version: StudyVersionRef;
  interactive: boolean;
}) {
  const allIds = items.map((item) => item.id);
  const [session, setSession] = useState<Session>({
    phase: interactive ? "loading" : "intro",
    attemptId: null,
    itemIds: allIds,
    index: 0,
    answers: {},
    saveFailed: false,
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { workspaceId, artifactId, artifactVersionId } = version;
  const knownIds = new Set(allIds);

  useEffect(() => {
    if (!interactive) return;
    let cancelled = false;
    host
      .latestQuizAttempt({ workspaceId, artifactId, artifactVersionId })
      .then((attempt) => {
        if (cancelled) return;
        const itemIds = attempt?.itemIds.filter((id) => knownIds.has(id)) ?? [];
        if (attempt && !attempt.finishedAt && itemIds.length > 0) {
          const answers = { ...attempt.answers };
          setSession({
            phase: "answering",
            attemptId: attempt.id,
            itemIds,
            index: firstUnanswered(itemIds, answers),
            answers,
            saveFailed: false,
          });
        } else {
          setSession((current) => ({ ...current, phase: "intro" }));
        }
      })
      .catch(() => {
        if (!cancelled) setSession((current) => ({ ...current, phase: "intro" }));
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, artifactVersionId, host, interactive, workspaceId]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const save = useCallback(
    async (finish: boolean) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const { attemptId, answers } = sessionRef.current;
      if (!interactive || !attemptId) return true;
      try {
        await host.saveQuizAnswers({
          workspaceId,
          attemptId,
          answers,
          ...(finish ? { finish: true } : {}),
        });
        return true;
      } catch {
        setSession((current) => ({ ...current, saveFailed: true }));
        return false;
      }
    },
    [host, interactive, workspaceId],
  );

  const start = useCallback(
    async (itemIds: readonly string[] = allIds) => {
      let attemptId: string | null = null;
      let ids = [...itemIds];
      if (interactive) {
        try {
          const attempt = await host.startQuizAttempt({
            workspaceId,
            artifactId,
            artifactVersionId,
            itemIds: ids,
          });
          attemptId = attempt.id;
          if (attempt.itemIds.length > 0) ids = attempt.itemIds;
        } catch {
          setSession((current) => ({ ...current, saveFailed: true }));
        }
      }
      setSession({
        phase: "answering",
        attemptId,
        itemIds: ids,
        index: 0,
        answers: {},
        saveFailed: false,
      });
    },
    [artifactId, artifactVersionId, host, interactive, workspaceId, items],
  );

  const answer = useCallback(
    (itemId: string, value: QuizAnswer) => {
      setSession((current) => ({
        ...current,
        answers: { ...current.answers, [itemId]: value },
      }));
      if (!interactive) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void save(false);
      }, QUIZ_SAVE_DEBOUNCE_MS);
    },
    [interactive, save],
  );

  const submit = useCallback(async () => {
    await save(true);
    setSession((current) => ({ ...current, phase: "finished" }));
  }, [save]);

  const goTo = useCallback((index: number) => {
    setSession((current) => ({
      ...current,
      index: Math.min(Math.max(index, 0), current.itemIds.length - 1),
    }));
  }, []);

  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    session,
    sessionItems: session.itemIds
      .map((id) => byId.get(id))
      .filter((item): item is QuizItem => Boolean(item)),
    start,
    answer,
    submit,
    goTo,
  };
}
