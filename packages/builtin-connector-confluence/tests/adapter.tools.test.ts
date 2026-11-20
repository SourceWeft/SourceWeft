import assert from "node:assert/strict";
import test from "node:test";
import {
  AtlassianApiError,
  decodeSiteCursor,
} from "@sourceweft/atlassian-client";
import type { ConnectorActionInput } from "@sourceweft/contracts";
import { createConfluenceConnectorAdapter } from "../src/adapter";

const SPACE_SCOPE = "read:space:confluence";
const PAGE_SCOPE = "read:page:confluence";
const ACCESS_TOKEN = "SECRET-ACCESS-TOKEN-should-never-appear-in-a-result";

type SiteFixture = { id: string; url: string; name: string; scopes: string[] };
type Call = {
  url: string;
  cloudId: string | null;
  path: string;
  params: URLSearchParams;
};
type PageHandler = (
  cloudId: string,
  pageId: string,
  url: URL,
) => Response | Promise<Response>;
type ListHandler = (
  cloudId: string,
  ids: string[],
  url: URL,
) => Response | Promise<Response>;
type SearchHandler = (
  cloudId: string,
  cql: string,
  url: URL,
) => Response | Promise<Response>;

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function cloudId(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
}

const CLOUD_A = cloudId(1);
const CLOUD_B = cloudId(2);
const CLOUD_C = cloudId(3);

function site(n: number): SiteFixture {
  return {
    id: cloudId(n),
    url: `https://site${n}.atlassian.net`,
    name: `Site ${n}`,
    scopes: [SPACE_SCOPE, PAGE_SCOPE, "offline_access"],
  };
}

const siteA = site(1);
const siteB = site(2);

/** Routes a fake fetcher to the endpoints the live tools call: the accessible
 * resources, per site the v2 single-page read, the v2 pages lookup, the v2
 * spaces lookup, and the v1 search. */
function buildFetcher(opts: {
  sites?: SiteFixture[];
  page?: PageHandler;
  pagesByIds?: ListHandler;
  spacesByIds?: ListHandler;
  search?: SearchHandler;
}) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const value = String(input);
    const url = new URL(value);
    const route = url.pathname.match(/^\/ex\/confluence\/([0-9a-f-]+)(\/.*)$/);
    calls.push({
      url: value,
      cloudId: route?.[1] ?? null,
      path: route?.[2] ?? url.pathname,
      params: url.searchParams,
    });
    if (value.startsWith("https://api.atlassian.com/oauth/token/accessible-resources")) {
      return json(opts.sites ?? []);
    }
    if (route) {
      const siteCloudId = route[1]!;
      const path = route[2]!;
      const single = path.match(/^\/wiki\/api\/v2\/pages\/([0-9]+)$/);
      if (single) {
        if (!opts.page) throw new Error(`Unexpected page read: ${value}`);
        return opts.page(siteCloudId, single[1]!, url);
      }
      if (path === "/wiki/api/v2/pages") {
        if (!opts.pagesByIds) throw new Error(`Unexpected pages lookup: ${value}`);
        return opts.pagesByIds(siteCloudId, idsOf(url, "id"), url);
      }
      if (path === "/wiki/api/v2/spaces") {
        if (!opts.spacesByIds) throw new Error(`Unexpected spaces lookup: ${value}`);
        return opts.spacesByIds(siteCloudId, idsOf(url, "ids"), url);
      }
      if (path === "/wiki/rest/api/search") {
        if (!opts.search) throw new Error(`Unexpected search: ${value}`);
        return opts.search(siteCloudId, url.searchParams.get("cql") ?? "", url);
      }
    }
    throw new Error(`Unexpected request: ${value}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

function idsOf(url: URL, name: "id" | "ids"): string[] {
  return (url.searchParams.get(name) ?? "").split(",").filter(Boolean);
}

function adapter(fetcher: typeof fetch, now?: () => Date) {
  return createConfluenceConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "confluence-client-id",
    clientSecret: "confluence-client-secret",
    fetcher,
    now,
  });
}

function actionInput(
  actionType: string,
  request: Record<string, unknown>,
  config: Record<string, unknown>,
): ConnectorActionInput {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "confluence",
    actionType,
    request,
    config,
    accessToken: ACCESS_TOKEN,
    idempotencyKey: "idem-1",
  };
}

function spaceItem(cId: string, id: string) {
  return { id: `space:${cId}:${id}`, kind: "space" };
}
function pageItem(cId: string, id: string) {
  return { id: `page:${cId}:${id}`, kind: "page" };
}
function selection(...items: Array<{ id: string; kind: string }>) {
  return { items };
}

/** A v2 page record for a pages lookup or single-page read. */
function pageRecord(
  id: string,
  opts: {
    spaceId?: string | null;
    parentId?: string | null;
    status?: string;
    title?: string;
  } = {},
): Record<string, unknown> {
  return {
    id,
    status: opts.status ?? "current",
    title: opts.title ?? `Page ${id}`,
    spaceId: opts.spaceId ?? null,
    parentId: opts.parentId ?? null,
  };
}

/** A pages-lookup handler backed by a store, returning only current requested
 * pages, in request order (as the real endpoint with `status=current` does). */
function storePages(records: Record<string, unknown>[]): ListHandler {
  const byId = new Map(records.map((r) => [String(r.id), r]));
  return (_cloudId, ids) =>
    json({
      results: ids
        .map((id) => byId.get(id))
        .filter((r): r is Record<string, unknown> => r !== undefined && r.status === "current"),
    });
}

/** A spaces-lookup handler backed by a store, returning the requested spaces. */
function storeSpaces(records: Array<{ id: string; key: string; name: string }>): ListHandler {
  const byId = new Map(records.map((r) => [r.id, r]));
  return (_cloudId, ids) =>
    json({
      results: ids.map((id) => byId.get(id)).filter(Boolean),
      _links: { base: "https://site1.atlassian.net/wiki" },
    });
}

function searchHit(
  id: string,
  opts: { title?: string; excerpt?: string; lastModified?: string; url?: string } = {},
) {
  return {
    content: { id },
    title: opts.title ?? `Page ${id}`,
    excerpt: opts.excerpt ?? "",
    lastModified: opts.lastModified ?? "2026-11-18T00:00:00.000Z",
    url: opts.url ?? `/spaces/X/pages/${id}`,
  };
}

function searchResponse(
  hits: Array<Record<string, unknown>>,
  opts: { next?: string } = {},
) {
  const links: Record<string, unknown> = { base: "https://site1.atlassian.net/wiki" };
  if (opts.next) links.next = `/wiki/rest/api/search?cursor=${opts.next}`;
  return json({ results: hits, _links: links });
}

function searchCqlOf(calls: Call[]): string[] {
  return calls
    .filter((c) => c.path === "/wiki/rest/api/search")
    .map((c) => c.params.get("cql") ?? "");
}

test("nothing selected returns CONFLUENCE_NOTHING_SELECTED without a request", async () => {
  const { fetcher, calls } = buildFetcher({});
  const confluence = adapter(fetcher);
  await assert.rejects(
    confluence.executeAction(
      actionInput("confluence.content.search", { text: "hello" }, { items: [] }),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 409 &&
      error.code === "CONFLUENCE_NOTHING_SELECTED" &&
      error.message ===
        "No Confluence spaces or pages are selected for this connector. Ask the user to choose them in the connector settings.",
  );
  assert.equal(calls.length, 0);
});

test("search builds the scope from space keys and page ids", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
    pagesByIds: storePages([pageRecord("2001", { spaceId: "1001" })]),
    search: () => searchResponse([]),
  });
  await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "roadmap" },
      selection(spaceItem(CLOUD_A, "1001"), pageItem(CLOUD_A, "2001")),
    ),
  );
  assert.deepEqual(searchCqlOf(calls), [
    'type = page AND (space in ("ENG") OR ancestor in (2001) OR id in (2001)) AND text ~ "roadmap"',
  ]);
});

test("search drops selected pages and spaces that no longer resolve", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
    pagesByIds: storePages([pageRecord("2001", { spaceId: "1001" })]),
    search: () => searchResponse([]),
  });
  await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "roadmap" },
      selection(
        spaceItem(CLOUD_A, "1001"),
        spaceItem(CLOUD_A, "1002"),
        pageItem(CLOUD_A, "2001"),
        pageItem(CLOUD_A, "2002"),
      ),
    ),
  );
  assert.deepEqual(searchCqlOf(calls), [
    'type = page AND (space in ("ENG") OR ancestor in (2001) OR id in (2001)) AND text ~ "roadmap"',
  ]);
});

test("results whose scope cannot be proved are dropped", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([
      { id: "1001", key: "ENG", name: "Engineering" },
      { id: "9002", key: "DEV", name: "Developers" },
    ]),
    pagesByIds: storePages([
      pageRecord("3000", { spaceId: "9002", parentId: null }), // selected ancestor
      pageRecord("4001", { spaceId: "1001", parentId: null }), // in a selected space
      pageRecord("4002", { spaceId: "9002", parentId: "3000" }), // under the selected ancestor
      pageRecord("4003", { spaceId: "9003", parentId: "5003" }), // parent does not resolve
      pageRecord("4004", { spaceId: "9004", parentId: "5004" }), // unrelated parent chain
      pageRecord("5004", { spaceId: "9004", parentId: null }),
    ]),
    search: () =>
      searchResponse([
        searchHit("4001"),
        searchHit("4002"),
        searchHit("4003"),
        searchHit("4004"),
      ]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan" },
      selection(spaceItem(CLOUD_A, "1001"), pageItem(CLOUD_A, "3000")),
    ),
  );
  const pages = result.result.pages as Array<{ pageId: string }>;
  assert.deepEqual(
    pages.map((p) => p.pageId),
    [`${CLOUD_A}:4001`, `${CLOUD_A}:4002`],
  );
});

test("a hit the page lookup does not return is dropped", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
    pagesByIds: storePages([pageRecord("4001", { spaceId: "1001" })]), // 4002 absent
    search: () => searchResponse([searchHit("4001"), searchHit("4002")]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan" },
      selection(spaceItem(CLOUD_A, "1001")),
    ),
  );
  const pages = result.result.pages as Array<{ pageId: string }>;
  assert.deepEqual(
    pages.map((p) => p.pageId),
    [`${CLOUD_A}:4001`],
  );
});

test("parent chain deeper than 25 levels is out of scope", async () => {
  const chain: Record<string, unknown>[] = [pageRecord("6000", { spaceId: "8000", parentId: "7001" })];
  for (let i = 1; i <= 40; i += 1) {
    chain.push(pageRecord(String(7000 + i), { parentId: String(7000 + i + 1) }));
  }
  const { fetcher } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([{ id: "8000", key: "DEV", name: "Developers" }]),
    pagesByIds: storePages([...chain, pageRecord("7026", { parentId: "7027" })]),
    search: () => searchResponse([searchHit("6000")]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan" },
      selection(pageItem(CLOUD_A, "7026")), // selected ancestor 26 levels up
    ),
  );
  assert.deepEqual(result.result.pages, []);
});

test("a parent cycle is out of scope", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    pagesByIds: storePages([
      pageRecord("9999", { parentId: null }), // selected page resolves
      pageRecord("6100", { spaceId: "8000", parentId: "6101" }),
      pageRecord("6101", { parentId: "6102" }),
      pageRecord("6102", { parentId: "6101" }),
    ]),
    search: () => searchResponse([searchHit("6100")]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan" },
      selection(pageItem(CLOUD_A, "9999")),
    ),
  );
  assert.deepEqual(result.result.pages, []);
});

test("parents are fetched level by level in one request per level", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA],
    pagesByIds: storePages([
      pageRecord("7100", { parentId: null }), // selected, second level
      pageRecord("7200", { parentId: null }), // selected, second level
      pageRecord("6200", { spaceId: "8000", parentId: "6201" }),
      pageRecord("6300", { spaceId: "8000", parentId: "6301" }),
      pageRecord("6201", { parentId: "7100" }),
      pageRecord("6301", { parentId: "7200" }),
    ]),
    spacesByIds: storeSpaces([{ id: "8000", key: "DEV", name: "Developers" }]),
    search: () => searchResponse([searchHit("6200"), searchHit("6300")]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan" },
      selection(pageItem(CLOUD_A, "7100"), pageItem(CLOUD_A, "7200")),
    ),
  );
  const pages = result.result.pages as Array<{ pageId: string }>;
  assert.deepEqual(
    pages.map((p) => p.pageId).sort(),
    [`${CLOUD_A}:6200`, `${CLOUD_A}:6300`],
  );
  const idCalls = calls
    .filter((c) => c.path === "/wiki/api/v2/pages")
    .map((c) => c.params.get("id"));
  // selected pages, then the hits, then one request per parent level.
  assert.deepEqual(idCalls, ["7100,7200", "6200,6300", "6201,6301", "7100,7200"]);
});

test("search sends no expand parameter", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
    pagesByIds: storePages([pageRecord("4001", { spaceId: "1001" })]),
    search: () => searchResponse([searchHit("4001")]),
  });
  await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan" },
      selection(spaceItem(CLOUD_A, "1001")),
    ),
  );
  const searchCall = calls.find((c) => c.path === "/wiki/rest/api/search")!;
  assert.equal(searchCall.params.has("expand"), false);
});

test("updatedWithinDays becomes a UTC date literal from the injected clock", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
    search: () => searchResponse([]),
  });
  await adapter(fetcher, () => new Date("2026-11-19T12:00:00.000Z")).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "roadmap", updatedWithinDays: 7 },
      selection(spaceItem(CLOUD_A, "1001")),
    ),
  );
  assert.deepEqual(searchCqlOf(calls), [
    'type = page AND (space in ("ENG")) AND text ~ "roadmap" AND lastmodified >= "2026-11-12"',
  ]);
});

test("search skips a lost site and notes it", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA], // CLOUD_B is selected but gone
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
    pagesByIds: storePages([pageRecord("4001", { spaceId: "1001" })]),
    search: () => searchResponse([searchHit("4001")]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan" },
      selection(spaceItem(CLOUD_A, "1001"), spaceItem(CLOUD_B, "2001")),
    ),
  );
  assert.equal(
    result.result.note,
    `1 selected site can no longer be accessed: ${CLOUD_B}.`,
  );
  assert.equal(
    calls.some((c) => c.path === "/wiki/rest/api/search" && c.cloudId === CLOUD_B),
    false,
  );
});

test("every selected site lost is a 404", async () => {
  const sel = selection(spaceItem(CLOUD_A, "1001"));
  for (const [actionType, request] of [
    ["confluence.content.search", { text: "plan" }],
    ["confluence.page.read", { pageId: "123" }],
    ["confluence.space.list", {}],
  ] as const) {
    const { fetcher } = buildFetcher({ sites: [] });
    await assert.rejects(
      adapter(fetcher).executeAction(actionInput(actionType, request, sel)),
      (error: unknown) =>
        error instanceof AtlassianApiError &&
        error.statusCode === 404 &&
        error.code === "CONFLUENCE_NOT_FOUND" &&
        error.message ===
          "None of the selected Confluence sites can be accessed any more. Ask the user to reconnect Confluence or choose spaces and pages again.",
    );
  }
});

test("more than five sites are capped and noted", async () => {
  const { fetcher } = buildFetcher({
    sites: [site(1), site(2), site(3), site(4), site(5), site(6)],
    spacesByIds: (_cloudId, ids) =>
      json({
        results: ids.map((id) => ({ id, key: `K${id}`, name: `N${id}` })),
        _links: { base: "https://x.atlassian.net/wiki" },
      }),
    search: () => searchResponse([]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan" },
      selection(
        spaceItem(cloudId(1), "1001"),
        spaceItem(cloudId(2), "2001"),
        spaceItem(cloudId(3), "3001"),
        spaceItem(cloudId(4), "4001"),
        spaceItem(cloudId(5), "5001"),
        spaceItem(cloudId(6), "6001"),
      ),
    ),
  );
  assert.equal(
    result.result.note,
    "Only the first 5 selected sites are searched; 1 more were not.",
  );
});

test("search pages sites independently", async () => {
  const handlers = {
    sites: [siteA, siteB],
    spacesByIds: ((cloudId, ids) =>
      json({
        results: ids.map((id) => ({
          id,
          key: cloudId === CLOUD_A ? "ENG" : "OPS",
          name: "N",
        })),
        _links: { base: "https://x.atlassian.net/wiki" },
      })) as ListHandler,
    pagesByIds: ((cloudId, ids) => {
      const spaceId = cloudId === CLOUD_A ? "1001" : "2001";
      const owned = cloudId === CLOUD_A ? ["4001"] : ["5001"];
      return json({
        results: ids
          .filter((id) => owned.includes(id))
          .map((id) => pageRecord(id, { spaceId })),
      });
    }) as ListHandler,
    search: ((cloudId, _cql, url) => {
      if (cloudId === CLOUD_A && url.searchParams.get("cursor") === null) {
        return searchResponse([searchHit("4001")], { next: "tokA" });
      }
      if (cloudId === CLOUD_A) return searchResponse([]);
      return searchResponse([searchHit("5001")]);
    }) as SearchHandler,
  };
  const { fetcher, calls } = buildFetcher(handlers);
  const confluence = adapter(fetcher);
  const sel = selection(spaceItem(CLOUD_A, "1001"), spaceItem(CLOUD_B, "2001"));
  const first = await confluence.executeAction(
    actionInput("confluence.content.search", { text: "plan" }, sel),
  );
  const cursor = first.result.nextCursor as string;
  assert.deepEqual(decodeSiteCursor(cursor, [CLOUD_A, CLOUD_B], "CONFLUENCE"), {
    [CLOUD_A]: "tokA",
    [CLOUD_B]: null,
  });

  const before = calls.length;
  const second = await confluence.executeAction(
    actionInput("confluence.content.search", { text: "plan", cursor }, sel),
  );
  const followUp = calls
    .slice(before)
    .filter((c) => c.path === "/wiki/rest/api/search");
  assert.equal(followUp.length, 1);
  assert.equal(followUp[0]!.cloudId, CLOUD_A);
  assert.equal(followUp[0]!.params.get("cursor"), "tokA");
  assert.equal(second.result.nextCursor, null);
});

test("spaceKeys narrow locally and a key matching nothing queries no site", async () => {
  const build = () =>
    buildFetcher({
      sites: [siteA],
      spacesByIds: storeSpaces([
        { id: "1001", key: "ENG", name: "Engineering" },
        { id: "1002", key: "OPS", name: "Operations" },
      ]),
      search: () => searchResponse([]),
    });

  const narrowed = build();
  await adapter(narrowed.fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan", spaceKeys: ["ENG"] },
      selection(spaceItem(CLOUD_A, "1001"), spaceItem(CLOUD_A, "1002")),
    ),
  );
  assert.deepEqual(searchCqlOf(narrowed.calls), [
    'type = page AND (space in ("ENG")) AND text ~ "plan"',
  ]);

  const none = build();
  const result = await adapter(none.fetcher).executeAction(
    actionInput(
      "confluence.content.search",
      { text: "plan", spaceKeys: ["ZZZ"] },
      selection(spaceItem(CLOUD_A, "1001"), spaceItem(CLOUD_A, "1002")),
    ),
  );
  assert.equal(
    none.calls.some((c) => c.path === "/wiki/rest/api/search"),
    false,
  );
  assert.deepEqual(result.result.pages, []);
  assert.equal(result.result.nextCursor, null);
});

test("empty search text is rejected", async () => {
  const { fetcher, calls } = buildFetcher({ sites: [siteA] });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput(
        "confluence.content.search",
        { text: "()" },
        selection(spaceItem(CLOUD_A, "1001")),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 400 &&
      error.code === "CONFLUENCE_INVALID_REQUEST" &&
      error.message === "The search text has no searchable words.",
  );
  assert.equal(calls.length, 0);
});

test("bad cursors are rejected without a request", async () => {
  const sel = selection(spaceItem(CLOUD_A, "1001"), spaceItem(CLOUD_B, "2001"));
  const wrongVersion = Buffer.from(
    JSON.stringify({ v: 2, sites: { [CLOUD_A]: null } }),
    "utf8",
  ).toString("base64url");
  const unselectedSite = Buffer.from(
    JSON.stringify({ v: 1, sites: { [CLOUD_C]: "tok" } }),
    "utf8",
  ).toString("base64url");
  const bad = ["not-base64-!!!", wrongVersion, unselectedSite, "a".repeat(5000)];
  for (const cursor of bad) {
    const { fetcher, calls } = buildFetcher({});
    await assert.rejects(
      adapter(fetcher).executeAction(
        actionInput("confluence.content.search", { text: "plan", cursor }, sel),
      ),
      (error: unknown) =>
        error instanceof AtlassianApiError &&
        error.statusCode === 400 &&
        error.code === "CONFLUENCE_INVALID_REQUEST",
    );
    assert.equal(calls.length, 0, `cursor ${cursor.slice(0, 12)} should not reach the network`);
  }
});

test("read accepts a prefixed id and checks that site only", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA, siteB],
    page: (cId, pageId) => {
      assert.equal(cId, CLOUD_B);
      return json(pageRecord(pageId, { spaceId: "2001" }));
    },
    spacesByIds: storeSpaces([{ id: "2001", key: "OPS", name: "Operations" }]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.page.read",
      { pageId: `${CLOUD_B}:7777` },
      selection(spaceItem(CLOUD_A, "1001"), spaceItem(CLOUD_B, "2001")),
    ),
  );
  const page = result.result.page as Record<string, unknown>;
  assert.equal(page.pageId, `${CLOUD_B}:7777`);
  const pageReads = calls.filter((c) => /\/wiki\/api\/v2\/pages\/[0-9]+$/.test(c.path));
  assert.equal(pageReads.length, 1);
  assert.equal(pageReads[0]!.cloudId, CLOUD_B);
});

test("bare id tries each selected site", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA, siteB],
    page: (cId, pageId) => {
      if (cId === CLOUD_A) return json({ message: "not found" }, 404);
      return json(pageRecord(pageId, { spaceId: "2001" }));
    },
    spacesByIds: storeSpaces([{ id: "2001", key: "OPS", name: "Operations" }]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.page.read",
      { pageId: "7777" },
      selection(spaceItem(CLOUD_A, "1001"), spaceItem(CLOUD_B, "2001")),
    ),
  );
  const page = result.result.page as Record<string, unknown>;
  assert.equal(page.pageId, `${CLOUD_B}:7777`);
  const pageReads = calls
    .filter((c) => /\/wiki\/api\/v2\/pages\/[0-9]+$/.test(c.path))
    .map((c) => c.cloudId);
  assert.deepEqual(pageReads, [CLOUD_A, CLOUD_B]);
});

test("page under a selected ancestor is readable", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    page: (_cId, pageId) =>
      json(pageRecord(pageId, { spaceId: "9000", parentId: "8000" })),
    pagesByIds: storePages([pageRecord("8000", { parentId: null })]),
    spacesByIds: storeSpaces([{ id: "9000", key: "DEV", name: "Developers" }]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.page.read",
      { pageId: "8100" },
      selection(pageItem(CLOUD_A, "8000")),
    ),
  );
  const page = result.result.page as Record<string, unknown>;
  assert.equal(page.pageId, `${CLOUD_A}:8100`);
});

test("page moved out from under a selected ancestor is not found", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    page: (_cId, pageId) =>
      json(pageRecord(pageId, { spaceId: "9000", parentId: "8200" })),
    pagesByIds: storePages([pageRecord("8200", { parentId: null })]), // 8000 no longer on the chain
  });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput(
        "confluence.page.read",
        { pageId: "8100" },
        selection(pageItem(CLOUD_A, "8000")),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 404 &&
      error.code === "CONFLUENCE_NOT_FOUND" &&
      error.message === "Confluence page not found",
  );
});

test("page in an unselected space is not found", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    page: (_cId, pageId) => json(pageRecord(pageId, { spaceId: "9999", parentId: null })),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput(
        "confluence.page.read",
        { pageId: "8300" },
        selection(spaceItem(CLOUD_A, "1001")),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 404 &&
      error.code === "CONFLUENCE_NOT_FOUND",
  );
});

test("trashed page is not found", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    page: (_cId, pageId) =>
      json(pageRecord(pageId, { spaceId: "1001", status: "trashed" })),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput(
        "confluence.page.read",
        { pageId: "8400" },
        selection(spaceItem(CLOUD_A, "1001")),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 404 &&
      error.code === "CONFLUENCE_NOT_FOUND",
  );
});

test("the parent chain is walked only when the space and the page are not selected", async () => {
  const direct = buildFetcher({
    sites: [siteA],
    page: (_cId, pageId) => json(pageRecord(pageId, { spaceId: "1001", parentId: "8000" })),
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
  });
  await adapter(direct.fetcher).executeAction(
    actionInput(
      "confluence.page.read",
      { pageId: "8500" },
      selection(spaceItem(CLOUD_A, "1001")),
    ),
  );
  assert.equal(
    direct.calls.filter((c) => c.path === "/wiki/api/v2/pages").length,
    0,
  );

  const walked = buildFetcher({
    sites: [siteA],
    page: (_cId, pageId) => json(pageRecord(pageId, { spaceId: "9000", parentId: "8000" })),
    pagesByIds: storePages([pageRecord("8000", { parentId: null })]),
    spacesByIds: storeSpaces([{ id: "9000", key: "DEV", name: "Developers" }]),
  });
  await adapter(walked.fetcher).executeAction(
    actionInput(
      "confluence.page.read",
      { pageId: "8600" },
      selection(pageItem(CLOUD_A, "8000")),
    ),
  );
  assert.equal(
    walked.calls.filter((c) => c.path === "/wiki/api/v2/pages").length,
    1,
  );
});

test("long body is truncated and flagged", async () => {
  const longText = "x".repeat(25000);
  const { fetcher } = buildFetcher({
    sites: [siteA],
    page: (_cId, pageId) =>
      json({
        ...pageRecord(pageId, { spaceId: "1001" }),
        version: { number: 3, createdAt: "2026-11-18T00:00:00.000Z" },
        body: {
          atlas_doc_format: {
            value: JSON.stringify({
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: longText }] },
              ],
            }),
          },
        },
      }),
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.page.read",
      { pageId: "8700" },
      selection(spaceItem(CLOUD_A, "1001")),
    ),
  );
  const page = result.result.page as Record<string, unknown>;
  assert.equal((page.body as string).length, 20000);
  assert.equal(page.bodyTruncated, true);
});

test("list merges selected spaces with spaces of selected pages", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([
      { id: "1001", key: "ENG", name: "Engineering" },
      { id: "1003", key: "DEV", name: "Developers" },
    ]),
    pagesByIds: storePages([
      pageRecord("9100", { spaceId: "1001" }),
      pageRecord("9200", { spaceId: "1003" }),
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.space.list",
      {},
      selection(
        spaceItem(CLOUD_A, "1001"),
        pageItem(CLOUD_A, "9100"),
        pageItem(CLOUD_A, "9200"),
      ),
    ),
  );
  const spaces = result.result.spaces as Array<{ key: string; coverage: string }>;
  assert.deepEqual(spaces.map((s) => [s.key, s.coverage]), [
    ["ENG", "space"],
    ["DEV", "pages"],
  ]);
  assert.equal(result.result.unavailable, 0);
});

test("list ignores a space the fake returns that was not asked for", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    spacesByIds: () =>
      json({
        results: [
          { id: "1001", key: "ENG", name: "Engineering" },
          { id: "9999", key: "SNEAK", name: "Not selected" },
        ],
        _links: { base: "https://site1.atlassian.net/wiki" },
      }),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput(
      "confluence.space.list",
      {},
      selection(spaceItem(CLOUD_A, "1001")),
    ),
  );
  const spaces = result.result.spaces as Array<{ key: string }>;
  assert.deepEqual(
    spaces.map((s) => s.key),
    ["ENG"],
  );
});

test("403 from the provider is CONFLUENCE_NOT_FOUND", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    page: () => json({ message: "forbidden" }, 403),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput(
        "confluence.page.read",
        { pageId: "8800" },
        selection(spaceItem(CLOUD_A, "1001")),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 404 &&
      error.code === "CONFLUENCE_NOT_FOUND" &&
      error.message === "Confluence page not found",
  );
});

test("429 carries retryAfterSeconds", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
    search: () => json({ message: "slow down" }, 429, { "Retry-After": "42" }),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput(
        "confluence.content.search",
        { text: "plan" },
        selection(spaceItem(CLOUD_A, "1001")),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 429 &&
      error.code === "CONFLUENCE_RATE_LIMITED" &&
      error.details?.retryAfterSeconds === 42,
  );
});

test("results contain no token", async () => {
  const sel = selection(spaceItem(CLOUD_A, "1001"), pageItem(CLOUD_A, "9100"));
  const { fetcher } = buildFetcher({
    sites: [siteA],
    spacesByIds: storeSpaces([{ id: "1001", key: "ENG", name: "Engineering" }]),
    pagesByIds: storePages([
      pageRecord("9100", { spaceId: "1001" }),
      pageRecord("4001", { spaceId: "1001" }),
    ]),
    page: (_cId, pageId) => json(pageRecord(pageId, { spaceId: "1001" })),
    search: () => searchResponse([searchHit("4001")]),
  });
  const confluence = adapter(fetcher);
  const search = await confluence.executeAction(
    actionInput("confluence.content.search", { text: "plan" }, sel),
  );
  const read = await confluence.executeAction(
    actionInput("confluence.page.read", { pageId: "9100" }, sel),
  );
  const list = await confluence.executeAction(
    actionInput("confluence.space.list", {}, sel),
  );
  for (const actionResult of [search, read, list]) {
    assert.equal(JSON.stringify(actionResult).includes(ACCESS_TOKEN), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(actionResult, "rawResponseJson"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(actionResult, "resultJson"),
      false,
    );
  }
});
