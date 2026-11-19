// Confluence REST client on top of `@sourceweft/atlassian-client`'s
// product-scoped request wrapper. v2 endpoints live under `/wiki/api/v2`, the
// one v1 endpoint (search) under `/wiki/rest/api`. Endpoint paths, parameters
// and scopes were checked against Atlassian's published Confluence Cloud REST
// API descriptions on 2026-11-19 (description only; no live tenant).
//
// Rules this client keeps:
// - Search is the only v1 call and is never sent `expand`; what a search hit
//   would carry beyond the fields read here is not relied on. A hit therefore
//   yields only an id, a title, an excerpt, a date and a link; scope data
//   (space, parent, status) comes from the v2 page endpoints only.
// - Children come from `/pages/{id}/children`; there is no ancestors lookup.
// - Every response is shape-guarded: a list response without a `results`
//   array is an outage (`503`), an item without an id is dropped.

import {
  atlassianRequest,
  AtlassianApiError,
  CURSOR_MAX_LENGTH,
  type AtlassianClientConfig,
} from "@sourceweft/atlassian-client";
import { invalidRequest } from "./shared";

export type ConfluenceSpace = {
  id: string;
  key: string;
  name: string;
  webUrl: string | null;
};

export type ConfluencePageRef = {
  id: string;
  title: string;
  spaceId: string | null;
  parentId: string | null;
  status: string | null;
};

export type ConfluencePage = ConfluencePageRef & {
  version: number | null;
  updated: string | null;
  adf: unknown;
  webUrl: string | null;
};

/** A search hit. Scope data (space, parent, status) is deliberately absent:
 * it is read from the v2 page endpoints, never from a hit. */
export type ConfluenceSearchHit = {
  pageId: string;
  title: string;
  excerpt: string;
  lastModified: string | null;
  webUrl: string | null;
};

const V2 = "/wiki/api/v2";
const V1_SEARCH_PATH = "/wiki/rest/api/search";

/** v2 list endpoints accept at most 250 per page, and at most 250 ids in an
 * `id`/`ids` list. */
const V2_MAX_LIMIT = 250;
const V2_MAX_IDS = 250;

/** The v1 search endpoint documents a default of 25 and no maximum ("may be
 * restricted by fixed system limits"), so a request never asks for more than
 * the default page size. */
const SEARCH_MAX_LIMIT = 25;

/** `searchSpaces` reads at most this many pages of {@link V2_MAX_LIMIT}. */
const SPACE_SEARCH_MAX_PAGES = 5;

/** Page titles are cut at the selection contract's entry-name limit, so a long
 * title can never make a whole selection result fail validation. */
const TITLE_MAX = 1024;

const EXCERPT_MAX = 500;
const HIGHLIGHT_MARKERS = /@@@(?:end)?hl@@@/g;

const NUMERIC_ID = /^[0-9]{1,20}$/;

function unavailable(): AtlassianApiError {
  return new AtlassianApiError(503, "CONFLUENCE_UNAVAILABLE", "Atlassian is unavailable");
}

function safeString(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

/** Ids are strings in v2 and numbers in v1; both become non-empty strings. */
function idString(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value.slice(0, 64) : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function clampLimit(limit: number, max: number): number {
  return Math.min(max, Math.max(1, Math.trunc(limit)));
}

function requireNumericId(id: string): string {
  if (!NUMERIC_ID.test(id)) throw invalidRequest("Invalid Confluence id");
  return id;
}

/** Unique ids in first-seen order, each required to be numeric so a value can
 * never widen a comma-separated id list or alter a path. */
function numericIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(requireNumericId))];
}

/** The body must be an object whose `results` is an array; anything else is a
 * provider outage rather than an empty answer. */
function resultsOf(response: unknown): { results: unknown[]; links: Record<string, unknown> } {
  if (!isRecord(response) || !Array.isArray(response.results)) throw unavailable();
  return { results: response.results, links: asRecord(response._links) };
}

/** The `cursor` query parameter of `_links.next`, or `null` when there is no
 * next link or it carries no usable cursor. A next link that pages by another
 * mechanism (for example a `start` offset) is treated as the last page: the
 * continuation is never guessed. */
function nextCursor(links: Record<string, unknown>): string | null {
  const next = links.next;
  if (typeof next !== "string") return null;
  try {
    const cursor = new URL(next, "https://placeholder.invalid").searchParams.get("cursor");
    return cursor !== null && cursor.length > 0 && cursor.length <= CURSOR_MAX_LENGTH
      ? cursor
      : null;
  } catch {
    return null;
  }
}

/** `base` + `path`, only when both are strings forming an `https` URL. The
 * v1 `url` is documented without the `/wiki` context path while `base` ends
 * with it; a path that already repeats it is not doubled. */
function joinWebUrl(base: unknown, path: unknown): string | null {
  if (typeof base !== "string" || typeof path !== "string") return null;
  if (!path.startsWith("/")) return null;
  const trimmedBase = base.replace(/\/+$/, "");
  const joinedPath =
    trimmedBase.endsWith("/wiki") && path.startsWith("/wiki/") ? path.slice(5) : path;
  const url = trimmedBase + joinedPath;
  try {
    return new URL(url).protocol === "https:" ? url.slice(0, 2048) : null;
  } catch {
    return null;
  }
}

function toSpace(raw: unknown, base: unknown): ConfluenceSpace | null {
  const value = asRecord(raw);
  const id = idString(value.id);
  const key = safeString(value.key, 255);
  if (!id || !key) return null;
  return {
    id,
    key,
    name: safeString(value.name, 512) ?? "",
    webUrl: joinWebUrl(base, asRecord(value._links).webui),
  };
}

function toPageRef(raw: unknown): ConfluencePageRef | null {
  const value = asRecord(raw);
  const id = idString(value.id);
  if (!id) return null;
  return {
    id,
    title: safeString(value.title, TITLE_MAX) ?? "",
    spaceId: idString(value.spaceId),
    parentId: idString(value.parentId),
    status: safeString(value.status, 64),
  };
}

function mapDefined<T>(values: readonly unknown[], map: (raw: unknown) => T | null): T[] {
  const result: T[] = [];
  for (const value of values) {
    const mapped = map(value);
    if (mapped !== null) result.push(mapped);
  }
  return result;
}

/** The ADF document travels as a JSON string at
 * `body.atlas_doc_format.value`; a value that does not parse (or is absent)
 * is `null`. An already-decoded object is accepted as is. */
function parseAdf(body: unknown): unknown {
  const value = asRecord(asRecord(body).atlas_doc_format).value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

function toPage(raw: unknown): ConfluencePage | null {
  const ref = toPageRef(raw);
  if (!ref) return null;
  const value = asRecord(raw);
  const version = asRecord(value.version);
  return {
    ...ref,
    version:
      typeof version.number === "number" && Number.isSafeInteger(version.number)
        ? version.number
        : null,
    updated: safeString(version.createdAt, 64),
    adf: parseAdf(value.body),
    webUrl: joinWebUrl(asRecord(value._links).base, asRecord(value._links).webui),
  };
}

function toSearchHit(raw: unknown, base: unknown): ConfluenceSearchHit | null {
  const value = asRecord(raw);
  const content = asRecord(value.content);
  const pageId = idString(content.id);
  if (!pageId) return null;
  const excerpt = typeof value.excerpt === "string" ? value.excerpt : "";
  return {
    pageId,
    title: safeString(value.title, TITLE_MAX) ?? safeString(content.title, TITLE_MAX) ?? "",
    excerpt: excerpt.replace(HIGHLIGHT_MARKERS, "").slice(0, EXCERPT_MAX),
    lastModified: safeString(value.lastModified, 64),
    webUrl: joinWebUrl(base, value.url),
  };
}

/** Returns `items` re-ordered to follow `ids`, dropping any item whose id was
 * not requested and any requested id with no item. */
function inRequestOrder<T extends { id: string }>(ids: readonly string[], items: T[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) ordered.push(item);
  }
  return ordered;
}

export function createConfluenceClient(config: AtlassianClientConfig) {
  async function get(
    token: string,
    cloudId: string,
    path: string,
    query: Record<string, string | number | string[] | undefined>,
  ): Promise<unknown> {
    return atlassianRequest<unknown>(config, {
      accessToken: token,
      product: "confluence",
      cloudId,
      path,
      query,
    });
  }

  async function listSpaces(
    token: string,
    cloudId: string,
    input: { cursor?: string; limit: number },
  ): Promise<{ spaces: ConfluenceSpace[]; next: string | null }> {
    const response = await get(token, cloudId, `${V2}/spaces`, {
      status: "current",
      limit: clampLimit(input.limit, V2_MAX_LIMIT),
      cursor: input.cursor,
    });
    const { results, links } = resultsOf(response);
    return {
      spaces: mapDefined(results, (raw) => toSpace(raw, links.base)),
      next: nextCursor(links),
    };
  }

  return {
    /** `GET /wiki/api/v2/spaces` (scope `read:space:confluence`), current
     * spaces only. */
    listSpaces,

    /** `GET /wiki/api/v2/spaces?ids=…`, at most 250 ids per request; results
     * follow the order of `ids`. Ids the user cannot see are simply absent. */
    async getSpacesByIds(
      token: string,
      cloudId: string,
      ids: string[],
    ): Promise<ConfluenceSpace[]> {
      const unique = numericIds(ids);
      const found: ConfluenceSpace[] = [];
      for (const batch of chunk(unique, V2_MAX_IDS)) {
        const response = await get(token, cloudId, `${V2}/spaces`, {
          ids: batch.join(","),
          status: "current",
          limit: batch.length,
        });
        const { results, links } = resultsOf(response);
        found.push(...mapDefined(results, (raw) => toSpace(raw, links.base)));
      }
      return inRequestOrder(unique, found);
    },

    /** `GET /wiki/api/v2/spaces/{id}/pages?depth=root` (scope
     * `read:page:confluence`): current top-level pages ordered by title. */
    async listSpaceRootPages(
      token: string,
      cloudId: string,
      spaceId: string,
      input: { cursor?: string; limit: number },
    ): Promise<{ pages: ConfluencePageRef[]; next: string | null }> {
      const response = await get(
        token,
        cloudId,
        `${V2}/spaces/${encodeURIComponent(requireNumericId(spaceId))}/pages`,
        {
          depth: "root",
          status: "current",
          sort: "title",
          limit: clampLimit(input.limit, V2_MAX_LIMIT),
          cursor: input.cursor,
        },
      );
      const { results, links } = resultsOf(response);
      return { pages: mapDefined(results, toPageRef), next: nextCursor(links) };
    },

    /** `GET /wiki/api/v2/pages/{id}/children` (scope `read:page:confluence`):
     * child pages, with `id`, `status`, `title` and `spaceId` per item. The
     * endpoint documents no status filter, so an item whose status is present
     * and not `current` is dropped here; the parent id is not returned and
     * stays `null`. */
    async listChildPages(
      token: string,
      cloudId: string,
      pageId: string,
      input: { cursor?: string; limit: number },
    ): Promise<{ pages: ConfluencePageRef[]; next: string | null }> {
      const response = await get(
        token,
        cloudId,
        `${V2}/pages/${encodeURIComponent(requireNumericId(pageId))}/children`,
        {
          limit: clampLimit(input.limit, V2_MAX_LIMIT),
          cursor: input.cursor,
        },
      );
      const { results, links } = resultsOf(response);
      return {
        pages: mapDefined(results, toPageRef).filter(
          (page) => page.status === null || page.status === "current",
        ),
        next: nextCursor(links),
      };
    },

    /** `GET /wiki/api/v2/pages?id=…`, at most 250 ids per request; results
     * follow the order of `ids`, a page that was not asked for is never
     * returned, and ids the user cannot see (or that are not current) are
     * simply absent. Whether the endpoint omits or rejects an unviewable id is
     * not documented, so a rejection propagates like any other error. */
    async getPagesByIds(
      token: string,
      cloudId: string,
      ids: string[],
    ): Promise<ConfluencePageRef[]> {
      const unique = numericIds(ids);
      const found: ConfluencePageRef[] = [];
      for (const batch of chunk(unique, V2_MAX_IDS)) {
        const response = await get(token, cloudId, `${V2}/pages`, {
          id: batch.join(","),
          status: "current",
          limit: batch.length,
        });
        found.push(...mapDefined(resultsOf(response).results, toPageRef));
      }
      return inRequestOrder(unique, found);
    },

    /** `GET /wiki/api/v2/pages/{id}?body-format=atlas_doc_format` (scope
     * `read:page:confluence`). Returns `null` for a missing or forbidden
     * page (the request wrapper reports both as `CONFLUENCE_NOT_FOUND`) and
     * for a response without an id; every other error propagates. The status
     * a trashed page returns is not documented, so `status` is reported as
     * received and the caller decides what is readable. */
    async getPage(
      token: string,
      cloudId: string,
      pageId: string,
    ): Promise<ConfluencePage | null> {
      const path = `${V2}/pages/${encodeURIComponent(requireNumericId(pageId))}`;
      let response: unknown;
      try {
        response = await get(token, cloudId, path, { "body-format": "atlas_doc_format" });
      } catch (error) {
        if (error instanceof AtlassianApiError && error.code === "CONFLUENCE_NOT_FOUND") {
          return null;
        }
        throw error;
      }
      if (!isRecord(response)) throw unavailable();
      return toPage(response);
    },

    /** `GET /wiki/rest/api/search?cql=…` (v1; scope `search:confluence` or
     * `read:content-details:confluence`). Never sent `expand`. A hit without
     * a content id (a non-content result) is dropped. */
    async search(
      token: string,
      cloudId: string,
      input: { cql: string; cursor?: string; limit: number },
    ): Promise<{ hits: ConfluenceSearchHit[]; next: string | null }> {
      const response = await get(token, cloudId, V1_SEARCH_PATH, {
        cql: input.cql,
        limit: clampLimit(input.limit, SEARCH_MAX_LIMIT),
        cursor: input.cursor,
      });
      const { results, links } = resultsOf(response);
      return {
        hits: mapDefined(results, (raw) => toSearchHit(raw, links.base)),
        next: nextCursor(links),
      };
    },

    /** Spaces whose name or key contains `query` (case-insensitive), found by
     * reading at most 5 pages of 250 current spaces: there is no documented
     * space title search, so the filter runs here. */
    async searchSpaces(
      token: string,
      cloudId: string,
      query: string,
      limit: number,
    ): Promise<ConfluenceSpace[]> {
      const needle = query.trim().toLowerCase();
      const wanted = Math.max(0, Math.trunc(limit));
      const matches: ConfluenceSpace[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < SPACE_SEARCH_MAX_PAGES && matches.length < wanted; page += 1) {
        const { spaces, next } = await listSpaces(token, cloudId, {
          cursor,
          limit: V2_MAX_LIMIT,
        });
        for (const space of spaces) {
          if (
            space.name.toLowerCase().includes(needle) ||
            space.key.toLowerCase().includes(needle)
          ) {
            matches.push(space);
          }
        }
        if (next === null) break;
        cursor = next;
      }
      return matches.slice(0, wanted);
    },
  };
}
