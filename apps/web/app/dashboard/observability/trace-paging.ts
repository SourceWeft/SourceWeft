export const TRACE_PAGE_SIZES = [25, 50, 100, 200] as const;
export type TracePageSize = (typeof TRACE_PAGE_SIZES)[number];
export const DEFAULT_TRACE_PAGE_SIZE: TracePageSize = 50;

/**
 * Where the trace list is. The API pages by cursor, so `cursors[i]` is the
 * cursor that fetches page `i` (page 0 needs none). Keeping the cursors of
 * pages already seen is what lets Previous step back.
 */
export type TracePaging = {
  cursors: (string | null)[];
  index: number;
  nextCursor: string | null;
};

export type TracePageTarget = { cursor: string | null; index: number };

export const FIRST_TRACE_PAGE: TracePageTarget = { cursor: null, index: 0 };

export const INITIAL_TRACE_PAGING: TracePaging = {
  cursors: [null],
  index: 0,
  nextCursor: null,
};

/** The page Next or Previous would load, or null when there is none. */
export function adjacentTracePage(
  paging: TracePaging,
  direction: "next" | "previous",
): TracePageTarget | null {
  if (direction === "next") {
    return paging.nextCursor
      ? { cursor: paging.nextCursor, index: paging.index + 1 }
      : null;
  }
  if (paging.index === 0) {
    return null;
  }
  const index = paging.index - 1;
  return { cursor: paging.cursors[index] ?? null, index };
}

/** The paging state once `target` has loaded and reported its next cursor. */
export function settleTracePage(
  paging: TracePaging,
  target: TracePageTarget,
  nextCursor: string | null,
): TracePaging {
  return {
    cursors: [...paging.cursors.slice(0, target.index), target.cursor],
    index: target.index,
    nextCursor,
  };
}
