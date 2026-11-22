"use client";

import { useEffect, useRef, useState } from "react";
import type { ThreadSearchResult } from "@sourceweft/contracts";

export const CHAT_SEARCH_DEBOUNCE_MS = 250;

export type ChatSearchState = {
  /** True while a query is set: the sidebar shows results, not the list. */
  active: boolean;
  /** True until results for the current query arrive. */
  loading: boolean;
  failed: boolean;
  results: ThreadSearchResult[];
  /** Drops one chat from the shown results (after it is deleted). */
  removeResult: (threadId: string) => void;
};

type SearchFn = (q: string) => Promise<{ items: ThreadSearchResult[] }>;

type Answer = {
  query: string;
  /** The search (one per workspace) that produced the answer. */
  source: SearchFn | null;
  results: ThreadSearchResult[];
  failed: boolean;
};

const NO_ANSWER: Answer = {
  query: "",
  source: null,
  results: [],
  failed: false,
};

/**
 * Searches every chat the member can see on the server, `debounceMs` after the
 * query stops changing. A response for an older query never replaces a newer
 * one.
 */
export function useChatSearch(
  query: string,
  search: SearchFn | undefined,
  debounceMs = CHAT_SEARCH_DEBOUNCE_MS,
): ChatSearchState {
  const trimmed = query.trim();
  const [answer, setAnswer] = useState<Answer>(NO_ANSWER);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    if (!trimmed || !search) return;

    const timer = setTimeout(() => {
      search(trimmed).then(
        (response) => {
          if (requestRef.current !== request) return;
          setAnswer({
            query: trimmed,
            source: search,
            results: response.items,
            failed: false,
          });
        },
        () => {
          if (requestRef.current !== request) return;
          setAnswer({ query: trimmed, source: search, results: [], failed: true });
        },
      );
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [trimmed, search, debounceMs]);

  const active = Boolean(trimmed) && Boolean(search);
  // Results from another workspace's search never show here.
  const current =
    active && answer.query === trimmed && answer.source === search;
  return {
    active,
    loading: active && !current,
    failed: current && answer.failed,
    results: current ? answer.results : [],
    removeResult: (threadId) =>
      setAnswer((value) => ({
        ...value,
        results: value.results.filter(
          (result) => result.thread.id !== threadId,
        ),
      })),
  };
}
