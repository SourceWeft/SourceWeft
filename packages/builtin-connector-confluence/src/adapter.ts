import {
  AtlassianApiError,
  CURSOR_MAX_LENGTH,
  MAX_FANOUT_SITES,
  exchangeAtlassianCode,
  getMe,
  groupBySite,
  listAccessibleResources,
  refreshAtlassianToken,
  reportAccounts,
  siteHost,
  type AtlassianClientConfig,
  type AtlassianSite,
} from "@sourceweft/atlassian-client";
import type {
  ConnectorActionInput,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorDiscoverInput,
  ConnectorExtractInput,
  ConnectorExtractedContent,
  ConnectorItem,
  ConnectorSelectionBrowseResult,
  ConnectorSelectionDescribeItem,
  ConnectorSelectionDescribeResult,
  ConnectorSelectionEntry,
  ConnectorSelectionSearchResult,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
  OAuthTokenSet,
} from "@sourceweft/contracts";
import { toBackendConfluenceManifest } from "./backend-manifest";
import {
  createConfluenceClient,
  type ConfluencePageRef,
  type ConfluenceSpace,
} from "./confluence-client";
import { buildTitleCql } from "./cql";
import {
  pageItemId,
  parsePageId,
  parseSiteId,
  parseSpaceId,
  siteItemId,
  spaceItemId,
} from "./ids";
import { executeConfluenceLiveTool } from "./live-tools";
import { hasConfluenceScope, invalidRequest } from "./shared";

export type ConfluenceAdapterConfig = {
  baseUrl: string;
  redirectUri?: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
  /** The clock the search date filter is computed from; defaults to the wall
   * clock. Injected so a computed date literal is deterministic in tests. */
  now?: () => Date;
};

/** `confluence.browse` page size for every listing. */
const BROWSE_PAGE_SIZE = 50;
/** Selection search asks for this many spaces and this many pages per site, so
 * one site contributes at most twice this many entries. */
const SEARCH_LIMIT_PER_KIND = 10;
/** The most parent hops walked to build a page's breadcrumbs. */
const MAX_ANCESTOR_LEVELS = 25;

const NUMERIC_ID = /^[0-9]{1,20}$/;

function unsupported(): AtlassianApiError {
  return new AtlassianApiError(
    400,
    "CONFLUENCE_UNSUPPORTED",
    "The Confluence connector does not index content.",
  );
}

function unsupportedAction(): AtlassianApiError {
  return new AtlassianApiError(
    400,
    "CONFLUENCE_UNSUPPORTED_ACTION",
    "Unsupported Confluence action",
  );
}

function notFound(what: string): AtlassianApiError {
  return new AtlassianApiError(404, "CONFLUENCE_NOT_FOUND", `Confluence ${what} not found`);
}

function unconfigured(): AtlassianApiError {
  return new AtlassianApiError(
    503,
    "CONFLUENCE_UNAVAILABLE",
    "Confluence is not configured",
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof AtlassianApiError && error.code === "CONFLUENCE_NOT_FOUND";
}

/** Runs a lookup and treats `CONFLUENCE_NOT_FOUND` as "nothing resolved": a
 * lookup that names something the user cannot see may be rejected rather than
 * answered with an empty list. Every other error propagates. */
async function orEmpty<T>(lookup: Promise<T[]>): Promise<T[]> {
  try {
    return await lookup;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

type BrowseTarget =
  | { kind: "site"; cloudId: string }
  | { kind: "space"; cloudId: string; spaceId: string }
  | { kind: "page"; cloudId: string; pageId: string };

/** A well-formed `site:`, `space:` or `page:` container id, or `null`. */
function parseContainer(id: string): BrowseTarget | null {
  const siteCloudId = parseSiteId(id);
  if (siteCloudId !== null) return { kind: "site", cloudId: siteCloudId };
  const space = parseSpaceId(id);
  if (space) return { kind: "space", cloudId: space.cloudId, spaceId: space.id };
  const page = parsePageId(id);
  if (page) return { kind: "page", cloudId: page.cloudId, pageId: page.id };
  return null;
}

type BrowseCursor = { v: 1; containerId: string; next: string };

/** `confluence.browse` pagination cursor:
 * `base64url(JSON.stringify({ v, containerId, next }))`, where `next` is the
 * provider's own continuation cursor. A result that cannot carry its cursor
 * within the contract's bound is an outage: the listing is never cut short
 * silently. */
function encodeBrowseCursor(data: BrowseCursor): string {
  const encoded = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  if (encoded.length > CURSOR_MAX_LENGTH) {
    throw new AtlassianApiError(
      503,
      "CONFLUENCE_UNAVAILABLE",
      "Atlassian is unavailable",
    );
  }
  return encoded;
}

/** Decodes and validates a `confluence.browse` cursor. Any mismatch (bad
 * base64url, bad JSON, wrong version, a `containerId` that is not a well-formed
 * site, space or page id, or an empty or non-string `next`) is
 * `400 CONFLUENCE_INVALID_REQUEST`; this runs before any request reaches
 * Confluence. */
function decodeBrowseCursor(value: string): BrowseCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.v !== 1 ||
      typeof parsed.containerId !== "string" ||
      parseContainer(parsed.containerId) === null ||
      typeof parsed.next !== "string" ||
      parsed.next.length < 1 ||
      parsed.next.length > CURSOR_MAX_LENGTH
    ) {
      throw new Error("malformed Confluence browse cursor");
    }
    return parsed as BrowseCursor;
  } catch {
    throw invalidRequest();
  }
}

function parseBrowseRequest(
  request: Record<string, unknown>,
): { containerId: string | null; cursor?: string } {
  const rawCursor = request.cursor;
  if (
    rawCursor !== undefined &&
    (typeof rawCursor !== "string" || rawCursor.length > CURSOR_MAX_LENGTH)
  ) {
    throw invalidRequest();
  }
  const rawContainerId = request.containerId;
  let containerId: string | null = null;
  if (rawContainerId !== undefined && rawContainerId !== null) {
    if (typeof rawContainerId !== "string" || parseContainer(rawContainerId) === null) {
      throw invalidRequest();
    }
    containerId = rawContainerId;
  }
  return { containerId, cursor: rawCursor ? rawCursor : undefined };
}

/** Validates `confluence.search`'s request. The query is trimmed and bounded to
 * 1-200 chars; the selection search returns one bounded page, so an empty
 * cursor is accepted (and ignored) while a non-empty one is rejected before any
 * request reaches Confluence. */
function parseSearchRequest(request: Record<string, unknown>): { query: string } {
  const rawCursor = request.cursor;
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== "string" || rawCursor.length > CURSOR_MAX_LENGTH) {
      throw invalidRequest();
    }
    if (rawCursor !== "") throw invalidRequest();
  }
  const rawQuery = request.query;
  if (typeof rawQuery !== "string") throw invalidRequest();
  const query = rawQuery.trim();
  if (query.length < 1 || query.length > 200) throw invalidRequest();
  return { query };
}

type ParsedDescribeId = {
  id: string;
  kind: "space" | "page";
  cloudId: string;
  numericId: string;
};

function parseDescribeRequest(
  request: Record<string, unknown>,
): { ids: ParsedDescribeId[] } {
  const rawIds = request.ids;
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 100) {
    throw invalidRequest();
  }
  const ids: ParsedDescribeId[] = [];
  for (const rawId of rawIds) {
    if (typeof rawId !== "string") throw invalidRequest();
    const space = parseSpaceId(rawId);
    const page = space ? null : parsePageId(rawId);
    const parsed = space ?? page;
    if (!parsed) throw invalidRequest();
    ids.push({
      id: rawId,
      kind: space ? "space" : "page",
      cloudId: parsed.cloudId,
      numericId: parsed.id,
    });
  }
  return { ids };
}

function toSiteEntry(site: AtlassianSite): ConnectorSelectionEntry {
  return {
    id: siteItemId(site.cloudId),
    kind: "site",
    name: site.name,
    detail: siteHost(site.url),
    selectable: false,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

/** A space entry, or `null` when its id could not be a selectable item id. */
function toSpaceEntry(
  cloudId: string,
  space: ConfluenceSpace,
): ConnectorSelectionEntry | null {
  if (!NUMERIC_ID.test(space.id)) return null;
  return {
    id: spaceItemId(cloudId, space.id),
    kind: "space",
    name: space.name,
    detail: space.key,
    selectable: true,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

/** A page entry, or `null` when its id could not be a selectable item id. The
 * listing cannot say whether a page has children, so every page is expandable,
 * and it carries no space data, so `detail` is empty. */
function toPageEntry(
  cloudId: string,
  page: Pick<ConfluencePageRef, "id" | "title">,
): ConnectorSelectionEntry | null {
  if (!NUMERIC_ID.test(page.id)) return null;
  return {
    id: pageItemId(cloudId, page.id),
    kind: "page",
    name: page.title,
    detail: null,
    selectable: true,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}

/**
 * Confluence connector adapter: OAuth and the three selection actions. This is
 * a tools-only connector, so `discover` stays empty and `extract` stays
 * unsupported.
 */
export function createConfluenceConnectorAdapter(
  config: ConfluenceAdapterConfig,
): ConnectorAdapter {
  const redirectUri =
    config.redirectUri ??
    `${config.baseUrl}/v1/connectors/oauth/confluence/callback`;
  const atlassianConfig: AtlassianClientConfig = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    errorPrefix: "CONFLUENCE",
    fetcher: config.fetcher,
  };
  const client = createConfluenceClient(atlassianConfig);

  /** Current pages among `ids`; a page in any other status is not returned. */
  async function currentPages(
    token: string,
    cloudId: string,
    ids: string[],
  ): Promise<ConfluencePageRef[]> {
    const pages = await orEmpty(client.getPagesByIds(token, cloudId, ids));
    return pages.filter((page) => page.status === "current");
  }

  /** The parents of `page`, outermost first. The chain is walked up one parent
   * at a time, for at most {@link MAX_ANCESTOR_LEVELS} levels; a parent that
   * cannot be resolved (not visible, not current, a repeat of a page already
   * seen) ends the walk, and the levels found so far are returned. */
  async function ancestorsOf(
    token: string,
    cloudId: string,
    page: ConfluencePageRef,
  ): Promise<ConfluencePageRef[]> {
    const chain: ConfluencePageRef[] = [];
    const seen = new Set([page.id]);
    let parentId = page.parentId;
    while (
      parentId !== null &&
      NUMERIC_ID.test(parentId) &&
      !seen.has(parentId) &&
      chain.length < MAX_ANCESTOR_LEVELS
    ) {
      seen.add(parentId);
      const [parent] = await currentPages(token, cloudId, [parentId]);
      if (!parent) break;
      chain.push(parent);
      parentId = parent.parentId;
    }
    return chain.reverse();
  }

  /** One page of the entries inside `target`: a site's spaces, a space's root
   * pages, or a page's child pages. */
  async function listEntries(
    token: string,
    target: BrowseTarget,
    cursor: string | undefined,
  ): Promise<{ entries: ConnectorSelectionEntry[]; next: string | null }> {
    const input = { cursor, limit: BROWSE_PAGE_SIZE };
    if (target.kind === "site") {
      const { spaces, next } = await client.listSpaces(token, target.cloudId, input);
      return {
        entries: compact(spaces.map((space) => toSpaceEntry(target.cloudId, space))),
        next,
      };
    }
    const { pages, next } =
      target.kind === "space"
        ? await client.listSpaceRootPages(token, target.cloudId, target.spaceId, input)
        : await client.listChildPages(token, target.cloudId, target.pageId, input);
    return {
      entries: compact(pages.map((page) => toPageEntry(target.cloudId, page))),
      next,
    };
  }

  function pageOfResult(
    containerId: string,
    listing: { entries: ConnectorSelectionEntry[]; next: string | null },
  ) {
    return {
      entries: listing.entries,
      cursor:
        listing.next === null
          ? ""
          : encodeBrowseCursor({ v: 1, containerId, next: listing.next }),
      hasMore: listing.next !== null,
      helpLink: null,
    };
  }

  /**
   * `confluence.browse`: the root lists the user's Confluence sites; a first
   * page for a `site:` container lists its spaces, for a `space:` container its
   * root pages, and for a `page:` container its child pages. A page fetched with
   * `cursor` continues that listing without re-resolving the container or its
   * breadcrumbs.
   */
  async function browseAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionBrowseResult> {
    const token = input.accessToken;
    const { containerId, cursor } = parseBrowseRequest(input.request);

    if (cursor) {
      const decoded = decodeBrowseCursor(cursor);
      if (containerId !== null && containerId !== decoded.containerId) {
        throw invalidRequest();
      }
      const target = parseContainer(decoded.containerId)!;
      const listing = await listEntries(token, target, decoded.next);
      return {
        container: null,
        breadcrumbs: [],
        ...pageOfResult(decoded.containerId, listing),
      };
    }

    const sites = await listAccessibleResources(atlassianConfig, token);

    if (containerId === null) {
      return {
        container: null,
        breadcrumbs: [],
        entries: sites
          .filter(hasConfluenceScope)
          .map(toSiteEntry)
          .sort((a, b) => a.name.localeCompare(b.name)),
        cursor: "",
        hasMore: false,
        helpLink: null,
      };
    }

    const target = parseContainer(containerId)!;
    const site = sites.find(
      (candidate) =>
        candidate.cloudId === target.cloudId && hasConfluenceScope(candidate),
    );
    if (!site) throw notFound("site");
    const siteCrumb = { id: siteItemId(site.cloudId), name: site.name };

    if (target.kind === "site") {
      const listing = await listEntries(token, target, undefined);
      return {
        container: {
          id: siteCrumb.id,
          kind: "site",
          name: site.name,
          detail: siteHost(site.url),
        },
        breadcrumbs: [],
        ...pageOfResult(containerId, listing),
      };
    }

    if (target.kind === "space") {
      const [space] = await orEmpty(
        client.getSpacesByIds(token, target.cloudId, [target.spaceId]),
      );
      if (!space) throw notFound("space");
      const listing = await listEntries(token, target, undefined);
      return {
        container: {
          id: containerId,
          kind: "space",
          name: space.name,
          detail: space.key,
        },
        breadcrumbs: [siteCrumb],
        ...pageOfResult(containerId, listing),
      };
    }

    const [page] = await currentPages(token, target.cloudId, [target.pageId]);
    if (!page) throw notFound("page");
    const listing = await listEntries(token, target, undefined);
    const breadcrumbs = [siteCrumb];
    if (page.spaceId !== null && NUMERIC_ID.test(page.spaceId)) {
      const [space] = await orEmpty(
        client.getSpacesByIds(token, target.cloudId, [page.spaceId]),
      );
      if (space) {
        breadcrumbs.push({
          id: spaceItemId(target.cloudId, space.id),
          name: space.name,
        });
      }
    }
    for (const ancestor of await ancestorsOf(token, target.cloudId, page)) {
      breadcrumbs.push({
        id: pageItemId(target.cloudId, ancestor.id),
        name: ancestor.title,
      });
    }
    return {
      container: { id: containerId, kind: "page", name: page.title, detail: null },
      breadcrumbs,
      ...pageOfResult(containerId, listing),
    };
  }

  /** `confluence.search`: the first {@link MAX_FANOUT_SITES} sites with a
   * Confluence scope, up to {@link SEARCH_LIMIT_PER_KIND} spaces and as many
   * pages each, as one bounded page (`hasMore: false`, `cursor: ""`). Spaces
   * come before pages. A page hit carries no reliable scope data, so it is kept
   * only when the page lookup resolves its id as a current page. */
  async function searchAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionSearchResult> {
    const token = input.accessToken;
    const { query } = parseSearchRequest(input.request);
    const cql = buildTitleCql("page", query);
    const sites = await listAccessibleResources(atlassianConfig, token);
    const candidates = sites.filter(hasConfluenceScope).slice(0, MAX_FANOUT_SITES);

    const spaceEntries: ConnectorSelectionEntry[] = [];
    const pageEntries: ConnectorSelectionEntry[] = [];
    for (const site of candidates) {
      const spaces = await client.searchSpaces(
        token,
        site.cloudId,
        query,
        SEARCH_LIMIT_PER_KIND,
      );
      spaceEntries.push(
        ...compact(spaces.map((space) => toSpaceEntry(site.cloudId, space))),
      );

      const { hits } = await client.search(token, site.cloudId, {
        cql,
        limit: SEARCH_LIMIT_PER_KIND,
      });
      const hitIds = [
        ...new Set(hits.map((hit) => hit.pageId).filter((id) => NUMERIC_ID.test(id))),
      ];
      if (hitIds.length === 0) continue;
      const current = new Map(
        (await currentPages(token, site.cloudId, hitIds)).map((page) => [page.id, page]),
      );
      for (const id of hitIds) {
        const page = current.get(id);
        if (!page) continue;
        const hit = hits.find((candidate) => candidate.pageId === id);
        const entry = toPageEntry(site.cloudId, {
          id,
          title: page.title || hit?.title || "",
        });
        if (entry) pageEntries.push(entry);
      }
    }
    return { entries: [...spaceEntries, ...pageEntries], cursor: "", hasMore: false };
  }

  /** `confluence.describe`: ids grouped by site and kind, resolved with
   * `getSpacesByIds` and `getPagesByIds`, in request order. An id on a site that
   * is lost or lacks the Confluence scope is missing and costs no request; so is
   * a page whose status is not `current`, and every id of a site that stops
   * resolving mid-request. */
  async function describeAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorSelectionDescribeResult> {
    const token = input.accessToken;
    const { ids } = parseDescribeRequest(input.request);
    const sites = await listAccessibleResources(atlassianConfig, token);
    const siteByCloudId = new Map(sites.map((site) => [site.cloudId, site]));

    const spaceById = new Map<string, ConfluenceSpace>();
    const pageById = new Map<string, ConfluencePageRef>();
    for (const [cloudId, group] of groupBySite(ids)) {
      const site = siteByCloudId.get(cloudId);
      if (!site || !hasConfluenceScope(site)) continue;
      const spaceIds = group.filter((id) => id.kind === "space").map((id) => id.numericId);
      const pageIds = group.filter((id) => id.kind === "page").map((id) => id.numericId);
      if (spaceIds.length > 0) {
        const spaces = await orEmpty(client.getSpacesByIds(token, cloudId, spaceIds));
        for (const space of spaces) spaceById.set(spaceItemId(cloudId, space.id), space);
      }
      if (pageIds.length > 0) {
        for (const page of await currentPages(token, cloudId, pageIds)) {
          pageById.set(pageItemId(cloudId, page.id), page);
        }
      }
    }

    const items = ids.map(({ id, kind }): ConnectorSelectionDescribeItem => {
      const space = kind === "space" ? spaceById.get(id) : undefined;
      if (space) {
        return {
          id,
          kind: "space",
          name: space.name,
          detail: space.key,
          exists: true,
          meta: { key: space.key },
        };
      }
      const page = kind === "page" ? pageById.get(id) : undefined;
      if (page) {
        return {
          id,
          kind: "page",
          name: page.title,
          detail: null,
          exists: true,
          meta: { spaceId: page.spaceId },
        };
      }
      return { id, kind: null, name: null, detail: null, exists: false, meta: {} };
    });
    return { items };
  }

  return {
    capabilityId: "sourceweft/confluence",
    getManifest() {
      // Without both credentials the manifest carries no client id, so the
      // platform refuses to start authorization (CONNECTOR_OAUTH_CONFIG_MISSING)
      // instead of sending the user to Atlassian for a code it cannot exchange.
      return toBackendConfluenceManifest({
        clientId: config.clientId && config.clientSecret ? config.clientId : "",
        redirectUri,
      });
    },
    async exchangeOAuthCode(
      input: OAuthCodeExchangeInput,
    ): Promise<OAuthTokenSet> {
      // Without both credentials no token request can succeed, so fail before
      // sending a code that cannot be exchanged.
      if (!config.clientId || !config.clientSecret) throw unconfigured();
      const token = await exchangeAtlassianCode(atlassianConfig, {
        code: input.code,
        redirectUri: input.redirectUri,
      });
      const identity = await getMe(atlassianConfig, token.accessToken);
      return {
        ...token,
        providerAccountId: identity.accountId,
        providerAccountEmail: identity.email,
        displayName: identity.name ?? identity.email ?? identity.accountId,
      };
    },
    async refreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthTokenSet> {
      if (!config.clientId || !config.clientSecret) throw unconfigured();
      return refreshAtlassianToken(atlassianConfig, input.refreshToken);
    },
    personalData: {
      async report(input) {
        if (!config.clientId || !config.clientSecret) throw unconfigured();
        return reportAccounts(atlassianConfig, input);
      },
      async readProfile(input) {
        if (!config.clientId || !config.clientSecret) throw unconfigured();
        const identity = await getMe(atlassianConfig, input.accessToken);
        return {
          providerAccountId: identity.accountId,
          email: identity.email,
          displayName: identity.name ?? identity.email ?? identity.accountId,
        };
      },
    },
    async *discover(
      _input: ConnectorDiscoverInput,
    ): AsyncIterable<ConnectorItem> {
      // Tools-only connector: nothing is indexed.
    },
    async extract(
      _input: ConnectorExtractInput,
    ): Promise<ConnectorExtractedContent> {
      throw unsupported();
    },
    async executeAction(
      input: ConnectorActionInput,
    ): Promise<ConnectorActionResult> {
      if (input.actionType === "confluence.browse") {
        return { result: await browseAction(input) };
      }
      if (input.actionType === "confluence.search") {
        return { result: await searchAction(input) };
      }
      if (input.actionType === "confluence.describe") {
        return { result: await describeAction(input) };
      }
      // The three agent-visible live tools (`confluence.content.search`,
      // `confluence.page.read`, `confluence.space.list`): `null` means the action
      // is not one of them.
      const liveResult = await executeConfluenceLiveTool(
        { client, atlassianConfig, now: config.now },
        input.accessToken,
        input.actionType,
        input.request,
        input.config,
      );
      if (liveResult) return liveResult;
      throw unsupportedAction();
    },
  };
}
