// The three agent-visible Confluence live tools (`confluence.content.search`,
// `confluence.page.read`, `confluence.space.list`) with scope enforcement. Scope
// is enforced twice: every search query is built only from the selected spaces
// and pages of a site, and every page a request returns is re-checked against
// that selection with `resolvePageScope` before it leaves the adapter. The agent
// never supplies CQL, and a page whose place in the selection cannot be proven is
// dropped.

import {
  adfToMarkdown,
  AtlassianApiError,
  buildSitesNote,
  CLOUD_ID_PATTERN,
  CURSOR_MAX_LENGTH,
  decodeSiteCursor,
  encodeSiteCursor,
  listAccessibleResources,
  pickAccessibleSites,
  type AtlassianClientConfig,
  type AtlassianSite,
} from "@sourceweft/atlassian-client";
import type { ConnectorActionResult } from "@sourceweft/contracts";
import {
  createConfluenceClient,
  type ConfluencePage,
  type ConfluencePageRef,
  type ConfluenceSearchHit,
  type ConfluenceSpace,
} from "./confluence-client";
import { buildSearchCql, cqlTextTerm } from "./cql";
import { parseConfluenceSelection, scopeBySite } from "./ids";
import { resolvePageScope } from "./scope";
import { hasConfluenceScope, invalidRequest } from "./shared";

type ConfluenceClient = ReturnType<typeof createConfluenceClient>;

export type ConfluenceLiveToolDeps = {
  client: ConfluenceClient;
  atlassianConfig: AtlassianClientConfig;
  /** The clock the search date filter is computed from; defaults to the wall
   * clock. Injected so the computed date literal is deterministic in tests. */
  now?: () => Date;
};

/** Pages requested per site per search page. */
const SEARCH_PAGE_SIZE = 20;
/** The truncation cap for one page body. */
const BODY_LIMIT = 20000;
/** A bare numeric page id, or one prefixed with its site's cloud id. */
const PAGE_ID_INPUT = new RegExp(`^(?:(${CLOUD_ID_PATTERN}):)?([0-9]{1,20})$`);
/** A space key the agent may narrow by (contribution input schema). */
const SPACE_KEY_PATTERN = /^[A-Za-z0-9_~.-]{1,255}$/;
/** A numeric id as handed back to or accepted from the agent. */
const NUMERIC_ID = /^[0-9]{1,20}$/;

function nothingSelected(): AtlassianApiError {
  return new AtlassianApiError(
    409,
    "CONFLUENCE_NOTHING_SELECTED",
    "No Confluence spaces or pages are selected for this connector. Ask the user to choose them in the connector settings.",
  );
}

function pageNotFound(): AtlassianApiError {
  return new AtlassianApiError(
    404,
    "CONFLUENCE_NOT_FOUND",
    "Confluence page not found",
  );
}

/** Thrown when not one selected site is reachable any more, instead of letting a
 * tool return an empty result that looks like "no matching pages". */
function noSitesReachable(): AtlassianApiError {
  return new AtlassianApiError(
    404,
    "CONFLUENCE_NOT_FOUND",
    "None of the selected Confluence sites can be accessed any more. Ask the user to reconnect Confluence or choose spaces and pages again.",
  );
}

/** One selected site kept for a call, with the numeric space and page ids
 * selected on it (at least one is non-empty: it came from the selection). */
type SiteScope = {
  cloudId: string;
  site: AtlassianSite;
  spaceIds: string[];
  pageIds: string[];
};

/** Parses the stored selection and groups it by cloud id (ascending). Throws
 * `409 CONFLUENCE_NOTHING_SELECTED` on an empty selection — before any request
 * reaches Confluence. */
function selectionScope(
  config: Record<string, unknown>,
): Map<string, { spaceIds: string[]; pageIds: string[] }> {
  const selection = parseConfluenceSelection(config);
  if (selection.length === 0) throw nothingSelected();
  return scopeBySite(selection);
}

type AccessibleSites = {
  kept: SiteScope[];
  inaccessible: string[];
  overflowCount: number;
};

/** Lists the accessible sites and keeps the first selected sites that still
 * carry a Confluence scope, in cloud-id ascending order. Throws
 * `404 CONFLUENCE_NOT_FOUND` when not one selected site is reachable, rather than
 * returning an empty result. */
async function accessibleSelectedSites(
  deps: ConfluenceLiveToolDeps,
  accessToken: string,
  grouped: Map<string, { spaceIds: string[]; pageIds: string[] }>,
): Promise<AccessibleSites> {
  const sites = await listAccessibleResources(deps.atlassianConfig, accessToken);
  const picked = pickAccessibleSites({
    sites,
    grouped,
    hasScope: hasConfluenceScope,
  });
  if (picked.kept.length === 0) throw noSitesReachable();
  return {
    kept: picked.kept.map(({ cloudId, site, value }) => ({
      cloudId,
      site,
      spaceIds: value.spaceIds,
      pageIds: value.pageIds,
    })),
    inaccessible: picked.inaccessible,
    overflowCount: picked.overflowCount,
  };
}

/** Current pages among `ids` on one site; a page in any other status is left
 * out, so a trashed selected page never contributes to a query or a decision. */
async function currentPagesByIds(
  deps: ConfluenceLiveToolDeps,
  accessToken: string,
  cloudId: string,
  ids: string[],
): Promise<ConfluencePageRef[]> {
  if (ids.length === 0) return [];
  const pages = await deps.client.getPagesByIds(accessToken, cloudId, ids);
  return pages.filter((page) => page.status === "current");
}

/** The UTC calendar date `days` before `now`, formatted `YYYY-MM-DD`. */
function utcDateMinusDays(now: Date, days: number): string {
  const shifted = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear().toString().padStart(4, "0");
  const month = (shifted.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = shifted.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type SearchParams = {
  text: string;
  spaceKeys?: string[];
  updatedWithinDays?: number;
  cursor?: string;
};

function parseSearchParams(request: Record<string, unknown>): SearchParams {
  const rawCursor = request.cursor;
  if (
    rawCursor !== undefined &&
    (typeof rawCursor !== "string" || rawCursor.length > CURSOR_MAX_LENGTH)
  ) {
    throw invalidRequest();
  }

  const rawText = request.text;
  if (typeof rawText !== "string" || rawText.length < 1 || rawText.length > 200) {
    throw invalidRequest();
  }

  let spaceKeys: string[] | undefined;
  if (request.spaceKeys !== undefined) {
    if (!Array.isArray(request.spaceKeys) || request.spaceKeys.length > 20) {
      throw invalidRequest();
    }
    spaceKeys = request.spaceKeys.map((key) => {
      if (typeof key !== "string" || !SPACE_KEY_PATTERN.test(key)) {
        throw invalidRequest();
      }
      return key;
    });
  }

  let updatedWithinDays: number | undefined;
  if (request.updatedWithinDays !== undefined) {
    const value = request.updatedWithinDays;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 365
    ) {
      throw invalidRequest();
    }
    updatedWithinDays = value;
  }

  return {
    text: rawText,
    spaceKeys,
    updatedWithinDays,
    cursor: rawCursor as string | undefined,
  };
}

function parsePageIdParam(request: Record<string, unknown>): {
  cloudId: string | null;
  pageId: string;
} {
  const raw = request.pageId;
  if (typeof raw !== "string") throw invalidRequest();
  const match = PAGE_ID_INPUT.exec(raw);
  if (!match) throw invalidRequest();
  return { cloudId: match[1] ?? null, pageId: match[2]! };
}

type SearchHit = {
  pageId: string;
  citationKey: string;
  title: string;
  excerpt: string;
  spaceKey: string;
  spaceName: string;
  lastModified: string | null;
  url: string;
};

/** The page's web URL, or a stable `viewpage` link built from the site when the
 * provider gave none. */
function pageUrl(site: AtlassianSite, webUrl: string | null, pageId: string): string {
  return webUrl ?? `${site.url}/wiki/pages/viewpage.action?pageId=${pageId}`;
}

/**
 * `confluence.content.search`: every site's query is built only from its
 * selected space keys and selected page ids, every hit is re-resolved and passed
 * through `resolvePageScope`, and a hit that does not resolve or whose scope
 * cannot be proven is dropped — so a page may hold fewer than the requested
 * number of results while a cursor is still returned. Sites are paged
 * independently via the multi-site cursor.
 */
async function searchTool(
  deps: ConfluenceLiveToolDeps,
  accessToken: string,
  request: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const grouped = selectionScope(config);
  const params = parseSearchParams(request);

  if (cqlTextTerm(params.text) === "") {
    // Text that is only stripped characters would otherwise drop the text filter
    // and return everything in scope; that is an error instead.
    throw invalidRequest("The search text has no searchable words.");
  }

  const cursorSites =
    params.cursor !== undefined && params.cursor !== ""
      ? decodeSiteCursor(params.cursor, [...grouped.keys()], "CONFLUENCE")
      : null;

  const { kept, inaccessible, overflowCount } = await accessibleSelectedSites(
    deps,
    accessToken,
    grouped,
  );

  const updatedAfter =
    params.updatedWithinDays !== undefined
      ? utcDateMinusDays((deps.now ?? (() => new Date()))(), params.updatedWithinDays)
      : undefined;
  const narrowKeys = params.spaceKeys
    ? new Set(params.spaceKeys.map((key) => key.toLowerCase()))
    : null;

  const pages: SearchHit[] = [];
  const nextSites: Record<string, string | null> = {};
  let anyUnfinished = false;

  for (const { cloudId, site, spaceIds, pageIds } of kept) {
    let pageToken: string | undefined;
    if (cursorSites) {
      if (!(cloudId in cursorSites)) continue;
      const token = cursorSites[cloudId];
      if (token === null) {
        nextSites[cloudId] = null;
        continue;
      }
      pageToken = token;
    }

    // Build the scope clause from what still resolves: selected spaces become
    // keys, selected pages are confirmed current. A space key the agent did not
    // ask for is dropped locally, never written into the query.
    const selectedSpaces =
      spaceIds.length > 0
        ? await deps.client.getSpacesByIds(accessToken, cloudId, spaceIds)
        : [];
    const selectedPages = await currentPagesByIds(deps, accessToken, cloudId, pageIds);

    let scopeSpaceKeys = selectedSpaces.map((space) => space.key);
    if (narrowKeys) {
      scopeSpaceKeys = scopeSpaceKeys.filter((key) => narrowKeys.has(key.toLowerCase()));
    }
    const scopePageIds = selectedPages.map((page) => page.id);
    if (scopeSpaceKeys.length === 0 && scopePageIds.length === 0) {
      nextSites[cloudId] = null;
      continue;
    }

    const cql = buildSearchCql({
      scope: { spaceKeys: scopeSpaceKeys, pageIds: scopePageIds },
      text: params.text,
      updatedAfter,
    });
    const { hits, next } = await deps.client.search(accessToken, cloudId, {
      cql,
      cursor: pageToken,
      limit: SEARCH_PAGE_SIZE,
    });

    const hitById = new Map<string, ConfluenceSearchHit>();
    for (const hit of hits) if (!hitById.has(hit.pageId)) hitById.set(hit.pageId, hit);
    const hitIds = [...hitById.keys()].filter((id) => NUMERIC_ID.test(id));

    let keptPages: ConfluencePageRef[] = [];
    if (hitIds.length > 0) {
      const hitPages = await deps.client.getPagesByIds(accessToken, cloudId, hitIds);
      const inScope = await resolvePageScope({
        pages: hitPages,
        selectedSpaceIds: new Set(selectedSpaces.map((space) => space.id)),
        selectedPageIds: new Set(selectedPages.map((page) => page.id)),
        getPagesByIds: (ids) => deps.client.getPagesByIds(accessToken, cloudId, ids),
      });
      keptPages = hitPages.filter((page) => inScope.has(page.id));
    }

    // Resolve the space of every kept hit to a key and name.
    const spaceIdsToResolve = [
      ...new Set(
        keptPages
          .map((page) => page.spaceId)
          .filter((id): id is string => id !== null && NUMERIC_ID.test(id)),
      ),
    ];
    const spaceById = new Map(
      (spaceIdsToResolve.length > 0
        ? await deps.client.getSpacesByIds(accessToken, cloudId, spaceIdsToResolve)
        : []
      ).map((space) => [space.id, space]),
    );

    for (const page of keptPages) {
      const space = page.spaceId !== null ? spaceById.get(page.spaceId) : undefined;
      const spaceKey = space?.key ?? "";
      if (narrowKeys && !narrowKeys.has(spaceKey.toLowerCase())) continue;
      const hit = hitById.get(page.id);
      pages.push({
        pageId: `${cloudId}:${page.id}`,
        citationKey: `confluence:${cloudId}:${page.id}`,
        title: page.title || hit?.title || "",
        excerpt: hit?.excerpt ?? "",
        spaceKey,
        spaceName: space?.name ?? "",
        lastModified: hit?.lastModified ?? null,
        url: pageUrl(site, hit?.webUrl ?? null, page.id),
      });
    }

    if (next !== null) {
      nextSites[cloudId] = next;
      anyUnfinished = true;
    } else {
      nextSites[cloudId] = null;
    }
  }

  const note = buildSitesNote(inaccessible, overflowCount);
  const result: Record<string, unknown> = {
    pages,
    nextCursor: anyUnfinished ? encodeSiteCursor(nextSites) : null,
  };
  if (note) result.note = note;
  return { result };
}

function toReadResult(
  cloudId: string,
  site: AtlassianSite,
  page: ConfluencePage,
  space: ConfluenceSpace | undefined,
): Record<string, unknown> {
  const body = adfToMarkdown(page.adf);
  return {
    pageId: `${cloudId}:${page.id}`,
    citationKey: `confluence:${cloudId}:${page.id}`,
    title: page.title,
    spaceKey: space?.key ?? "",
    spaceName: space?.name ?? "",
    version: page.version,
    updated: page.updated,
    body: body.slice(0, BODY_LIMIT),
    bodyTruncated: body.length > BODY_LIMIT,
    url: pageUrl(site, page.webUrl, page.id),
  };
}

/**
 * `confluence.page.read`: a bare page id is tried on each selected site in order;
 * a prefixed id only on its own site, which must be selected and accessible. The
 * page is returned only when it is current and in scope — directly through a
 * selected space or page, otherwise through `resolvePageScope` walking the parent
 * chain. Every other outcome (missing, trashed, forbidden, out of scope) is one
 * `404 CONFLUENCE_NOT_FOUND`.
 */
async function readTool(
  deps: ConfluenceLiveToolDeps,
  accessToken: string,
  request: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const grouped = selectionScope(config);
  const { cloudId: wantedCloudId, pageId } = parsePageIdParam(request);
  const { kept } = await accessibleSelectedSites(deps, accessToken, grouped);

  const sites =
    wantedCloudId !== null
      ? kept.filter((entry) => entry.cloudId === wantedCloudId)
      : kept;

  for (const { cloudId, site, spaceIds, pageIds } of sites) {
    const page = await deps.client.getPage(accessToken, cloudId, pageId);
    if (!page || page.status !== "current") continue;

    const directlySelected =
      (page.spaceId !== null && spaceIds.includes(page.spaceId)) ||
      pageIds.includes(page.id);
    if (!directlySelected) {
      const inScope = await resolvePageScope({
        pages: [page],
        selectedSpaceIds: new Set(spaceIds),
        selectedPageIds: new Set(pageIds),
        getPagesByIds: (ids) => deps.client.getPagesByIds(accessToken, cloudId, ids),
      });
      if (!inScope.has(page.id)) continue;
    }

    let space: ConfluenceSpace | undefined;
    if (page.spaceId !== null && NUMERIC_ID.test(page.spaceId)) {
      [space] = await deps.client.getSpacesByIds(accessToken, cloudId, [page.spaceId]);
    }
    return { result: { page: toReadResult(cloudId, site, page, space) } };
  }

  throw pageNotFound();
}

/**
 * `confluence.space.list`: the selected spaces (`coverage: "space"`) plus the
 * spaces that hold the selected pages (`coverage: "pages"`), de-duplicated with
 * `"space"` winning. Every returned space is re-checked against what was asked
 * for, and `unavailable` counts selected spaces and pages that no longer resolve.
 */
async function listTool(
  deps: ConfluenceLiveToolDeps,
  accessToken: string,
  config: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const grouped = selectionScope(config);
  const { kept, inaccessible, overflowCount } = await accessibleSelectedSites(
    deps,
    accessToken,
    grouped,
  );
  const keptCloudIds = new Set(kept.map((entry) => entry.cloudId));

  let unavailable = 0;
  for (const [cloudId, scope] of grouped) {
    if (!keptCloudIds.has(cloudId)) {
      unavailable += scope.spaceIds.length + scope.pageIds.length;
    }
  }

  const spaces: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const add = (
    cloudId: string,
    site: AtlassianSite,
    space: ConfluenceSpace,
    coverage: "space" | "pages",
  ) => {
    const key = `${cloudId}:${space.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    spaces.push({
      key: space.key,
      name: space.name,
      url:
        space.webUrl ??
        `${site.url}/wiki/spaces/${encodeURIComponent(space.key)}`,
      siteName: site.name,
      coverage,
    });
  };

  for (const { cloudId, site, spaceIds, pageIds } of kept) {
    // Selected spaces: re-check each returned space is one that was asked for.
    const requestedSpaceIds = new Set(spaceIds);
    const selectedSpaces =
      spaceIds.length > 0
        ? await deps.client.getSpacesByIds(accessToken, cloudId, spaceIds)
        : [];
    const resolvedSpaceIds = new Set<string>();
    for (const space of selectedSpaces) {
      if (!requestedSpaceIds.has(space.id)) continue;
      resolvedSpaceIds.add(space.id);
      add(cloudId, site, space, "space");
    }
    unavailable += spaceIds.filter((id) => !resolvedSpaceIds.has(id)).length;

    // Selected pages: their spaces are covered as "pages".
    const selectedPages = await currentPagesByIds(deps, accessToken, cloudId, pageIds);
    unavailable += pageIds.length - selectedPages.length;
    const pageSpaceIds = [
      ...new Set(
        selectedPages
          .map((page) => page.spaceId)
          .filter((id): id is string => id !== null && NUMERIC_ID.test(id)),
      ),
    ];
    if (pageSpaceIds.length > 0) {
      const requestedPageSpaceIds = new Set(pageSpaceIds);
      const pageSpaces = await deps.client.getSpacesByIds(accessToken, cloudId, pageSpaceIds);
      for (const space of pageSpaces) {
        if (!requestedPageSpaceIds.has(space.id)) continue;
        add(cloudId, site, space, "pages");
      }
    }
  }

  const note = buildSitesNote(inaccessible, overflowCount);
  const result: Record<string, unknown> = { spaces, unavailable };
  if (note) result.note = note;
  return { result };
}

/** Dispatches one of the three agent-visible Confluence actions, or returns
 * `null` when `actionId` is not one of them (the adapter then falls through to
 * its unsupported-action error). */
export async function executeConfluenceLiveTool(
  deps: ConfluenceLiveToolDeps,
  accessToken: string,
  actionId: string,
  request: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<ConnectorActionResult | null> {
  switch (actionId) {
    case "confluence.content.search":
      return searchTool(deps, accessToken, request, config);
    case "confluence.page.read":
      return readTool(deps, accessToken, request, config);
    case "confluence.space.list":
      return listTool(deps, accessToken, config);
    default:
      return null;
  }
}
