// The page-scope decision shared by the Confluence live tools. A page is in
// scope only when it is current and either sits in a selected space, is itself a
// selected page, or has a selected page somewhere on its parent chain. The chain
// is climbed one level at a time, fetching every pending page's next parent in a
// single lookup per level, and a chain that cannot be proven to reach the
// selection is treated as out of scope.

import type { ConfluencePageRef } from "./confluence-client";

/** The fields a page contributes to the scope decision. */
export type ScopePage = Pick<
  ConfluencePageRef,
  "id" | "spaceId" | "parentId" | "status"
>;

export type ResolvePageScopeInput = {
  /** The pages whose scope is to be decided. */
  pages: readonly ScopePage[];
  /** The numeric ids of the spaces that were selected for this connector. */
  selectedSpaceIds: ReadonlySet<string>;
  /** The numeric ids of the pages that were selected for this connector. */
  selectedPageIds: ReadonlySet<string>;
  /** Looks up current pages by numeric id on the one site being decided. */
  getPagesByIds: (ids: string[]) => Promise<ScopePage[]>;
};

/** The most parent levels climbed before a chain is abandoned as out of scope. */
const MAX_LEVELS = 25;
/** The most ids asked for in one parent-lookup request. */
const BATCH_SIZE = 100;

const NUMERIC_ID = /^[0-9]{1,20}$/;

/** A page still waiting on its parent chain: which page the decision is for, the
 * next parent id to resolve, and every id already visited on this chain so a
 * loop can be detected. */
type Pending = { pageId: string; nextParentId: string; seen: Set<string> };

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/**
 * Decides which of `pages` are in scope and returns their ids. A page is in
 * scope when its status is `current` and any of: its space is selected, its own
 * id is selected, or a selected page lies on its parent chain. The chain is
 * climbed for at most {@link MAX_LEVELS} levels, resolving all pending pages'
 * next parents together in one lookup per level (chunked to {@link BATCH_SIZE}
 * ids) and caching every page so no id is fetched twice. A chain whose parent
 * does not resolve, is not current, forms a loop, or reaches the level cap is
 * left out of scope: scope is never granted on an unprovable chain.
 */
export async function resolvePageScope(
  input: ResolvePageScopeInput,
): Promise<Set<string>> {
  const { selectedSpaceIds, selectedPageIds, getPagesByIds } = input;
  const inScope = new Set<string>();
  let pending: Pending[] = [];

  for (const page of input.pages) {
    if (page.status !== "current") continue;
    const spaceSelected =
      page.spaceId !== null && selectedSpaceIds.has(page.spaceId);
    if (spaceSelected || selectedPageIds.has(page.id)) {
      inScope.add(page.id);
      continue;
    }
    if (page.parentId !== null && NUMERIC_ID.test(page.parentId)) {
      pending.push({
        pageId: page.id,
        nextParentId: page.parentId,
        seen: new Set([page.id]),
      });
    }
  }

  const cache = new Map<string, ScopePage>();
  for (let level = 0; level < MAX_LEVELS && pending.length > 0; level += 1) {
    // A chain that is about to revisit an id it has already seen is a loop and
    // is dropped before any request is made for it.
    const active = pending.filter((p) => !p.seen.has(p.nextParentId));

    const toFetch: string[] = [];
    const queued = new Set<string>();
    for (const p of active) {
      if (!cache.has(p.nextParentId) && !queued.has(p.nextParentId)) {
        queued.add(p.nextParentId);
        toFetch.push(p.nextParentId);
      }
    }
    for (const batch of chunk(toFetch, BATCH_SIZE)) {
      for (const parent of await getPagesByIds(batch)) {
        cache.set(parent.id, parent);
      }
    }

    const next: Pending[] = [];
    for (const p of active) {
      const parent = cache.get(p.nextParentId);
      if (!parent || parent.status !== "current") continue;
      if (selectedPageIds.has(parent.id)) {
        inScope.add(p.pageId);
        continue;
      }
      if (parent.parentId === null || !NUMERIC_ID.test(parent.parentId)) {
        continue;
      }
      p.seen.add(p.nextParentId);
      p.nextParentId = parent.parentId;
      next.push(p);
    }
    pending = next;
  }

  return inScope;
}
