import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "@sourceweft/atlassian-client";
import {
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
  connectorSelectionSearchResultSchema,
  type ConnectorActionInput,
} from "@sourceweft/contracts";
import { createConfluenceConnectorAdapter } from "../src/adapter";

const SPACE_SCOPE = "read:space:confluence";
const PAGE_SCOPE = "read:page:confluence";

type Call = { url: string; cloudId: string | null; path: string; params: URLSearchParams };

type SiteFixture = { id: string; url: string; name: string; scopes: string[] };

type Handler = (cloudId: string, url: URL) => Response | Promise<Response>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cloudId(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
}

const CLOUD_A = cloudId(1);
const CLOUD_B = cloudId(2);

function siteA(overrides: Partial<SiteFixture> = {}): SiteFixture {
  return {
    id: CLOUD_A,
    url: "https://alpha.atlassian.net",
    name: "Alpha",
    scopes: [SPACE_SCOPE, PAGE_SCOPE, "offline_access"],
    ...overrides,
  };
}

/** Routes a fake fetcher to the Atlassian endpoints this adapter calls: the
 * accessible-resources list and, per site, the v2 spaces list, a space's pages,
 * a page's children, the v2 pages lookup, and the v1 search. A route without a
 * handler fails the test when it is requested. */
function buildFetcher(opts: {
  sites?: SiteFixture[] | (() => Response | Promise<Response>);
  spaces?: Handler;
  spacePages?: (cloudId: string, spaceId: string, url: URL) => Response | Promise<Response>;
  children?: (cloudId: string, pageId: string, url: URL) => Response | Promise<Response>;
  pages?: Handler;
  search?: Handler;
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
      if (typeof opts.sites === "function") return opts.sites();
      return json(opts.sites ?? []);
    }
    if (route) {
      const site = route[1]!;
      const path = route[2]!;
      let match: RegExpMatchArray | null;
      if (path === "/wiki/api/v2/spaces" && opts.spaces) return opts.spaces(site, url);
      if (
        (match = path.match(/^\/wiki\/api\/v2\/spaces\/([0-9]+)\/pages$/)) &&
        opts.spacePages
      ) {
        return opts.spacePages(site, match[1]!, url);
      }
      if (
        (match = path.match(/^\/wiki\/api\/v2\/pages\/([0-9]+)\/children$/)) &&
        opts.children
      ) {
        return opts.children(site, match[1]!, url);
      }
      if (path === "/wiki/api/v2/pages" && opts.pages) return opts.pages(site, url);
      if (path === "/wiki/rest/api/search" && opts.search) return opts.search(site, url);
    }
    throw new Error(`Unexpected request: ${value}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

function adapter(fetcher: typeof fetch) {
  return createConfluenceConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "confluence-client-id",
    clientSecret: "confluence-client-secret",
    fetcher,
  });
}

function actionInput(
  actionType: string,
  request: Record<string, unknown>,
): ConnectorActionInput {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "confluence",
    actionType,
    request,
    config: { items: [] },
    accessToken: "access-token",
    idempotencyKey: "idem-1",
  };
}

function entry(
  id: string,
  kind: "space" | "page",
  name: string,
  detail: string | null,
) {
  return {
    id,
    kind,
    name,
    detail,
    selectable: true,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  };
}

function isInvalidRequest(error: unknown): boolean {
  return (
    error instanceof AtlassianApiError &&
    error.statusCode === 400 &&
    error.code === "CONFLUENCE_INVALID_REQUEST"
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof AtlassianApiError &&
    error.statusCode === 404 &&
    error.code === "CONFLUENCE_NOT_FOUND"
  );
}

function cursorOf(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** The ids a `/pages?id=` or `/spaces?ids=` request asked for. */
function idsOf(url: URL, name: "id" | "ids"): string[] {
  return (url.searchParams.get(name) ?? "").split(",").filter(Boolean);
}

function pageRecord(
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, status: "current", title: `Page ${id}`, spaceId: "1001", ...extra };
}

test("root lists only sites with a Confluence scope", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [
      siteA({ id: CLOUD_B, url: "https://zeta.atlassian.net", name: "Zeta", scopes: [PAGE_SCOPE] }),
      siteA({
        id: cloudId(3),
        url: "https://jira-only.atlassian.net",
        name: "JiraOnly",
        scopes: ["read:jira-work", "offline_access"],
      }),
      siteA(),
    ],
  });
  const confluence = adapter(fetcher);
  const result = await confluence.executeAction(actionInput("confluence.browse", {}));
  const site = (id: string, name: string, host: string) => ({
    id: `site:${id}`,
    kind: "site",
    name,
    detail: host,
    selectable: false,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  });
  assert.deepEqual(result.result, {
    container: null,
    breadcrumbs: [],
    entries: [
      site(CLOUD_A, "Alpha", "alpha.atlassian.net"),
      site(CLOUD_B, "Zeta", "zeta.atlassian.net"),
    ],
    cursor: "",
    hasMore: false,
    helpLink: null,
  });
  assert.equal(calls.length, 1);
});

test("root lists the site even when there is only one", async () => {
  const { fetcher } = buildFetcher({ sites: [siteA()] });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.browse", { containerId: null }),
  );
  assert.equal((result.result.entries as unknown[]).length, 1);
});

test("site lists spaces", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA()],
    spaces: () =>
      json({
        results: [
          { id: "1001", key: "ENG", name: "Engineering" },
          { id: "1002", key: "OPS", name: "Operations" },
        ],
        _links: { next: "/wiki/api/v2/spaces?cursor=next-1" },
      }),
  });
  const confluence = adapter(fetcher);
  const result = await confluence.executeAction(
    actionInput("confluence.browse", { containerId: `site:${CLOUD_A}` }),
  );
  assert.deepEqual(result.result.container, {
    id: `site:${CLOUD_A}`,
    kind: "site",
    name: "Alpha",
    detail: "alpha.atlassian.net",
  });
  assert.deepEqual(result.result.breadcrumbs, []);
  assert.deepEqual(result.result.entries, [
    entry(`space:${CLOUD_A}:1001`, "space", "Engineering", "ENG"),
    entry(`space:${CLOUD_A}:1002`, "space", "Operations", "OPS"),
  ]);
  assert.equal(result.result.hasMore, true);
  assert.deepEqual(
    JSON.parse(Buffer.from(result.result.cursor as string, "base64url").toString("utf8")),
    { v: 1, containerId: `site:${CLOUD_A}`, next: "next-1" },
  );
  const spacesCall = calls.find((call) => call.path === "/wiki/api/v2/spaces");
  assert.equal(spacesCall?.params.get("limit"), "50");
  assert.equal(spacesCall?.params.get("status"), "current");
});

test("space lists root pages with the site as breadcrumb", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA()],
    spaces: (_site, url) => {
      assert.deepEqual(idsOf(url, "ids"), ["1001"]);
      return json({ results: [{ id: "1001", key: "ENG", name: "Engineering" }] });
    },
    spacePages: (_site, spaceId, url) => {
      assert.equal(spaceId, "1001");
      assert.equal(url.searchParams.get("depth"), "root");
      assert.equal(url.searchParams.get("limit"), "50");
      return json({
        results: [pageRecord("10", { title: "Home" }), pageRecord("11", { title: "Guide" })],
        _links: { next: "/wiki/api/v2/spaces/1001/pages?cursor=p2" },
      });
    },
  });
  const confluence = adapter(fetcher);
  const result = await confluence.executeAction(
    actionInput("confluence.browse", { containerId: `space:${CLOUD_A}:1001` }),
  );
  assert.deepEqual(result.result.container, {
    id: `space:${CLOUD_A}:1001`,
    kind: "space",
    name: "Engineering",
    detail: "ENG",
  });
  assert.deepEqual(result.result.breadcrumbs, [
    { id: `site:${CLOUD_A}`, name: "Alpha" },
  ]);
  assert.deepEqual(result.result.entries, [
    entry(`page:${CLOUD_A}:10`, "page", "Home", null),
    entry(`page:${CLOUD_A}:11`, "page", "Guide", null),
  ]);
  assert.equal(result.result.hasMore, true);
  assert.ok(calls.length > 0);
});

test("page lists children with site, space and ancestors as breadcrumbs", async () => {
  const tree: Record<string, { title: string; parentId: string | null }> = {
    "10": { title: "Root", parentId: null },
    "20": { title: "Middle", parentId: "10" },
    "30": { title: "Leaf", parentId: "20" },
  };
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    spaces: () => json({ results: [{ id: "1001", key: "ENG", name: "Engineering" }] }),
    pages: (_site, url) =>
      json({
        results: idsOf(url, "id")
          .filter((id) => tree[id])
          .map((id) => pageRecord(id, tree[id]!)),
      }),
    children: (_site, pageId) => {
      assert.equal(pageId, "30");
      return json({
        results: [{ id: "31", status: "current", title: "Child", spaceId: "1001" }],
      });
    },
  });
  const confluence = adapter(fetcher);
  const result = await confluence.executeAction(
    actionInput("confluence.browse", { containerId: `page:${CLOUD_A}:30` }),
  );
  assert.deepEqual(result.result.container, {
    id: `page:${CLOUD_A}:30`,
    kind: "page",
    name: "Leaf",
    detail: null,
  });
  assert.deepEqual(result.result.breadcrumbs, [
    { id: `site:${CLOUD_A}`, name: "Alpha" },
    { id: `space:${CLOUD_A}:1001`, name: "Engineering" },
    { id: `page:${CLOUD_A}:10`, name: "Root" },
    { id: `page:${CLOUD_A}:20`, name: "Middle" },
  ]);
  assert.deepEqual(result.result.entries, [
    entry(`page:${CLOUD_A}:31`, "page", "Child", null),
  ]);
  assert.equal(result.result.hasMore, false);
  assert.equal(result.result.cursor, "");
});

test("an ancestor chain that cannot be completed gives the breadcrumbs it has", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    spaces: () => json({ results: [{ id: "1001", key: "ENG", name: "Engineering" }] }),
    pages: (_site, url) => {
      const [id] = idsOf(url, "id");
      if (id === "30") return json({ results: [pageRecord("30", { parentId: "20" })] });
      if (id === "20") {
        return json({ results: [pageRecord("20", { title: "Middle", parentId: "10" })] });
      }
      // The outermost page is not visible: the lookup answers 404.
      return json({ message: "not found" }, 404);
    },
    children: () => json({ results: [] }),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.browse", { containerId: `page:${CLOUD_A}:30` }),
  );
  assert.deepEqual(result.result.breadcrumbs, [
    { id: `site:${CLOUD_A}`, name: "Alpha" },
    { id: `space:${CLOUD_A}:1001`, name: "Engineering" },
    { id: `page:${CLOUD_A}:20`, name: "Middle" },
  ]);
});

test("the ancestor walk stops after 25 levels", async () => {
  const lookups: string[] = [];
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    spaces: () => json({ results: [{ id: "1001", key: "ENG", name: "Engineering" }] }),
    pages: (_site, url) => {
      const [id] = idsOf(url, "id");
      lookups.push(id!);
      return json({
        results: [pageRecord(id!, { title: `T${id}`, parentId: String(Number(id) + 1) })],
      });
    },
    children: () => json({ results: [] }),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.browse", { containerId: `page:${CLOUD_A}:100` }),
  );
  // The page itself, then at most 25 ancestors.
  assert.equal(lookups.length, 26);
  const breadcrumbs = result.result.breadcrumbs as Array<{ id: string }>;
  assert.equal(breadcrumbs.length, 2 + 25);
  assert.equal(breadcrumbs[2]!.id, `page:${CLOUD_A}:125`);
  assert.equal(breadcrumbs.at(-1)!.id, `page:${CLOUD_A}:101`);
});

test("an ancestor cycle ends the walk", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    spaces: () => json({ results: [{ id: "1001", key: "ENG", name: "Engineering" }] }),
    pages: (_site, url) => {
      const [id] = idsOf(url, "id");
      return json({
        results: [pageRecord(id!, { parentId: id === "30" ? "20" : "30" })],
      });
    },
    children: () => json({ results: [] }),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.browse", { containerId: `page:${CLOUD_A}:30` }),
  );
  assert.deepEqual(
    (result.result.breadcrumbs as Array<{ id: string }>).map((crumb) => crumb.id),
    [`site:${CLOUD_A}`, `space:${CLOUD_A}:1001`, `page:${CLOUD_A}:20`],
  );
});

test("cursor page has no container or breadcrumbs", async () => {
  const seen: Array<string | null> = [];
  const { fetcher, calls } = buildFetcher({
    sites: [siteA()],
    spaces: (_site, url) => {
      seen.push(url.searchParams.get("cursor"));
      return json({
        results: [{ id: "1003", key: "DOC", name: "Docs" }],
        _links: { next: "/wiki/api/v2/spaces?cursor=next-2" },
      });
    },
  });
  const confluence = adapter(fetcher);
  const result = await confluence.executeAction(
    actionInput("confluence.browse", {
      cursor: cursorOf({ v: 1, containerId: `site:${CLOUD_A}`, next: "next-1" }),
    }),
  );
  assert.equal(result.result.container, null);
  assert.deepEqual(result.result.breadcrumbs, []);
  assert.deepEqual(result.result.entries, [
    entry(`space:${CLOUD_A}:1003`, "space", "Docs", "DOC"),
  ]);
  assert.deepEqual(seen, ["next-1"]);
  assert.equal(result.result.hasMore, true);
  assert.deepEqual(
    JSON.parse(Buffer.from(result.result.cursor as string, "base64url").toString("utf8")),
    { v: 1, containerId: `site:${CLOUD_A}`, next: "next-2" },
  );
  // A cursor page does not list sites again.
  assert.equal(
    calls.some((call) => call.url.includes("accessible-resources")),
    false,
  );
});

test("cursor pages continue space and page listings", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    spacePages: (_site, spaceId, url) => {
      assert.equal(spaceId, "1001");
      assert.equal(url.searchParams.get("cursor"), "p2");
      return json({ results: [pageRecord("12", { title: "Third" })] });
    },
    children: (_site, pageId, url) => {
      assert.equal(pageId, "30");
      assert.equal(url.searchParams.get("cursor"), "c2");
      return json({ results: [pageRecord("32", { title: "Later child" })] });
    },
  });
  const confluence = adapter(fetcher);
  const spacePage = await confluence.executeAction(
    actionInput("confluence.browse", {
      containerId: `space:${CLOUD_A}:1001`,
      cursor: cursorOf({ v: 1, containerId: `space:${CLOUD_A}:1001`, next: "p2" }),
    }),
  );
  assert.deepEqual(spacePage.result.entries, [
    entry(`page:${CLOUD_A}:12`, "page", "Third", null),
  ]);
  assert.equal(spacePage.result.hasMore, false);
  assert.equal(spacePage.result.cursor, "");

  const childPage = await confluence.executeAction(
    actionInput("confluence.browse", {
      cursor: cursorOf({ v: 1, containerId: `page:${CLOUD_A}:30`, next: "c2" }),
    }),
  );
  assert.deepEqual(childPage.result.entries, [
    entry(`page:${CLOUD_A}:32`, "page", "Later child", null),
  ]);
});

test("bad cursors are refused without a request", async () => {
  const { fetcher, calls } = buildFetcher({});
  const confluence = adapter(fetcher);
  const good = { v: 1, containerId: `site:${CLOUD_A}`, next: "n" };
  const bad: Array<Record<string, unknown>> = [
    { cursor: "!!not-base64url-json!!" },
    { cursor: cursorOf("not an object") },
    { cursor: cursorOf({ ...good, v: 2 }) },
    { cursor: cursorOf({ ...good, containerId: "site:not-a-cloud-id" }) },
    { cursor: cursorOf({ ...good, containerId: `project:${CLOUD_A}:1` }) },
    { cursor: cursorOf({ ...good, next: "" }) },
    { cursor: cursorOf({ ...good, next: 5 }) },
    { cursor: cursorOf({ v: 1, containerId: `site:${CLOUD_A}` }) },
    // The cursor belongs to a different container than the request names.
    { cursor: cursorOf(good), containerId: `space:${CLOUD_A}:1001` },
    { cursor: cursorOf(good), containerId: `site:${CLOUD_B}` },
    { cursor: "a".repeat(4097) },
    { cursor: 7 },
  ];
  for (const request of bad) {
    await assert.rejects(
      confluence.executeAction(actionInput("confluence.browse", request)),
      isInvalidRequest,
      JSON.stringify(request).slice(0, 80),
    );
  }
  assert.equal(calls.length, 0);
});

test("malformed container ids are refused without a request", async () => {
  const { fetcher, calls } = buildFetcher({});
  const confluence = adapter(fetcher);
  for (const containerId of [
    "",
    "project:abc",
    `space:${CLOUD_A}:abc`,
    `page:${CLOUD_A}`,
    "site:AAAAAAAA-0000-0000-0000-000000000000",
    42,
  ]) {
    await assert.rejects(
      confluence.executeAction(actionInput("confluence.browse", { containerId })),
      isInvalidRequest,
    );
  }
  assert.equal(calls.length, 0);
});

test("an oversized next cursor is an outage, not a truncated listing", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    spaces: () =>
      json({
        results: [{ id: "1001", key: "ENG", name: "Engineering" }],
        _links: { next: `/wiki/api/v2/spaces?cursor=${"x".repeat(3500)}` },
      }),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput("confluence.browse", { containerId: `site:${CLOUD_A}` }),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 503 &&
      error.code === "CONFLUENCE_UNAVAILABLE",
  );
});

test("unknown site is not found", async () => {
  const { fetcher, calls } = buildFetcher({ sites: [] });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput("confluence.browse", { containerId: `site:${CLOUD_A}` }),
    ),
    isNotFound,
  );
  assert.equal(calls.some((call) => call.cloudId !== null), false);
});

test("a site without a Confluence scope is not found", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA({ scopes: ["read:jira-work"] })],
  });
  for (const containerId of [
    `site:${CLOUD_A}`,
    `space:${CLOUD_A}:1001`,
    `page:${CLOUD_A}:10`,
  ]) {
    await assert.rejects(
      adapter(fetcher).executeAction(actionInput("confluence.browse", { containerId })),
      isNotFound,
    );
  }
  assert.equal(calls.some((call) => call.cloudId !== null), false);
});

test("missing space is not found", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA()],
    spaces: () => json({ results: [] }),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput("confluence.browse", { containerId: `space:${CLOUD_A}:1001` }),
    ),
    isNotFound,
  );
  assert.equal(calls.some((call) => call.path.includes("/pages")), false);
});

test("missing page is not found", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA()],
    pages: () => json({ results: [] }),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput("confluence.browse", { containerId: `page:${CLOUD_A}:30` }),
    ),
    isNotFound,
  );
  assert.equal(calls.some((call) => call.path.endsWith("/children")), false);
});

test("a page that is not current is not found", async () => {
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    pages: () => json({ results: [pageRecord("30", { status: "trashed" })] }),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput("confluence.browse", { containerId: `page:${CLOUD_A}:30` }),
    ),
    isNotFound,
  );
});

test("search returns spaces before pages, capped per site", async () => {
  const spaceRows = Array.from({ length: 12 }, (_, i) => ({
    id: String(2000 + i),
    key: `M${i}`,
    name: `Match space ${i}`,
  }));
  const searchCalls: URL[] = [];
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    spaces: () => json({ results: [...spaceRows, { id: "3000", key: "X", name: "Other" }] }),
    search: (_site, url) => {
      searchCalls.push(url);
      return json({
        results: [
          { title: "Match one", content: { id: "100" }, excerpt: "", url: "/spaces/E/pages/100" },
          { title: "Match gone", content: { id: "101" }, excerpt: "", url: "/spaces/E/pages/101" },
          { title: "Match old", content: { id: "102" }, excerpt: "", url: "/spaces/E/pages/102" },
          { title: "Match two", content: { id: "103" }, excerpt: "", url: "/spaces/E/pages/103" },
        ],
      });
    },
    pages: (_site, url) => {
      assert.deepEqual(idsOf(url, "id"), ["100", "101", "102", "103"]);
      return json({
        results: [
          pageRecord("100", { title: "Match one" }),
          pageRecord("102", { title: "Match old", status: "archived" }),
          pageRecord("103", { title: "Match two" }),
        ],
      });
    },
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.search", { query: "match" }),
  );
  const entries = result.result.entries as Array<ReturnType<typeof entry>>;
  assert.deepEqual(
    entries.map((item) => [item.kind, item.id]),
    [
      ...spaceRows.slice(0, 10).map((row) => ["space", `space:${CLOUD_A}:${row.id}`]),
      ["page", `page:${CLOUD_A}:100`],
      ["page", `page:${CLOUD_A}:103`],
    ],
  );
  assert.deepEqual(entries[0], entry(`space:${CLOUD_A}:2000`, "space", "Match space 0", "M0"));
  assert.deepEqual(entries.at(-1), entry(`page:${CLOUD_A}:103`, "page", "Match two", null));
  assert.equal(result.result.hasMore, false);
  assert.equal(result.result.cursor, "");
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0]!.searchParams.get("cql"), 'type = page AND title ~ "match"');
  assert.equal(searchCalls[0]!.searchParams.get("limit"), "10");
});

test("search fans out to at most five sites", async () => {
  const sites = Array.from({ length: 7 }, (_, i) =>
    siteA({ id: cloudId(i + 1), url: `https://site${i + 1}.atlassian.net`, name: `Site ${i + 1}` }),
  );
  const contacted = new Set<string>();
  const { fetcher } = buildFetcher({
    sites,
    spaces: (site) => {
      contacted.add(site);
      return json({ results: [] });
    },
    search: (site) => {
      contacted.add(site);
      return json({ results: [] });
    },
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.search", { query: "match" }),
  );
  assert.deepEqual(
    [...contacted].sort(),
    sites.slice(0, 5).map((site) => site.id),
  );
  assert.deepEqual(result.result, { entries: [], cursor: "", hasMore: false });
});

test("search skips sites without a Confluence scope", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [siteA({ scopes: ["read:jira-work"] })],
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.search", { query: "match" }),
  );
  assert.deepEqual(result.result.entries, []);
  assert.equal(calls.some((call) => call.cloudId !== null), false);
});

test("search request errors are refused without a request", async () => {
  const { fetcher, calls } = buildFetcher({});
  const confluence = adapter(fetcher);
  for (const request of [
    { query: "   " },
    { query: 5 },
    {},
    { query: "x".repeat(201) },
    { query: "match", cursor: "abc" },
    { query: "match", cursor: 4 },
    // No searchable word is left once the text is cleaned.
    { query: "***" },
  ]) {
    await assert.rejects(
      confluence.executeAction(actionInput("confluence.search", request)),
      isInvalidRequest,
      JSON.stringify(request),
    );
  }
  assert.equal(calls.length, 0);
});

test("search accepts an empty cursor", async () => {
  const { fetcher } = buildFetcher({ sites: [] });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.search", { query: "match", cursor: "" }),
  );
  assert.deepEqual(result.result, { entries: [], cursor: "", hasMore: false });
});

test("describe keeps order across kinds and sites", async () => {
  const idSpaceA = `space:${CLOUD_A}:1001`;
  const idPageA = `page:${CLOUD_A}:10`;
  const idPageB = `page:${CLOUD_B}:20`;
  const idMissingA = `page:${CLOUD_A}:11`;
  const idSpaceB = `space:${CLOUD_B}:2001`;
  const { fetcher } = buildFetcher({
    sites: [
      siteA(),
      siteA({ id: CLOUD_B, url: "https://beta.atlassian.net", name: "Beta" }),
    ],
    spaces: (site, url) => {
      const ids = idsOf(url, "ids");
      if (site === CLOUD_A) {
        return json({ results: ids.map((id) => ({ id, key: "ENG", name: "Engineering" })) });
      }
      return json({ results: ids.map((id) => ({ id, key: "OPS", name: "Operations" })) });
    },
    pages: (site, url) => {
      const ids = idsOf(url, "id");
      if (site === CLOUD_A) {
        return json({
          results: ids
            .filter((id) => id === "10")
            .map((id) => pageRecord(id, { title: "Home", spaceId: "1001" })),
        });
      }
      return json({
        results: ids.map((id) => pageRecord(id, { title: "Beta page", spaceId: "2001" })),
      });
    },
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.describe", {
      ids: [idPageB, idMissingA, idSpaceB, idPageA, idSpaceA],
    }),
  );
  assert.deepEqual(result.result.items, [
    {
      id: idPageB,
      kind: "page",
      name: "Beta page",
      detail: null,
      exists: true,
      meta: { spaceId: "2001" },
    },
    { id: idMissingA, kind: null, name: null, detail: null, exists: false, meta: {} },
    {
      id: idSpaceB,
      kind: "space",
      name: "Operations",
      detail: "OPS",
      exists: true,
      meta: { key: "OPS" },
    },
    {
      id: idPageA,
      kind: "page",
      name: "Home",
      detail: null,
      exists: true,
      meta: { spaceId: "1001" },
    },
    {
      id: idSpaceA,
      kind: "space",
      name: "Engineering",
      detail: "ENG",
      exists: true,
      meta: { key: "ENG" },
    },
  ]);
});

test("trashed page is described as missing", async () => {
  const id = `page:${CLOUD_A}:10`;
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    pages: () => json({ results: [pageRecord("10", { status: "trashed" })] }),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.describe", { ids: [id] }),
  );
  assert.deepEqual(result.result.items, [
    { id, kind: null, name: null, detail: null, exists: false, meta: {} },
  ]);
});

test("describe marks items on a lost site as missing without a request", async () => {
  const ids = [`page:${CLOUD_A}:10`, `space:${CLOUD_A}:1001`, `page:${CLOUD_B}:20`];
  const { fetcher, calls } = buildFetcher({
    // Site A is gone; site B no longer carries the Confluence scope.
    sites: [siteA({ id: CLOUD_B, scopes: ["read:jira-work"] })],
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.describe", { ids }),
  );
  assert.deepEqual(
    result.result.items,
    ids.map((id) => ({ id, kind: null, name: null, detail: null, exists: false, meta: {} })),
  );
  assert.equal(calls.some((call) => call.cloudId !== null), false);
});

test("describe marks a site that stops resolving as missing", async () => {
  const id = `page:${CLOUD_A}:10`;
  const { fetcher } = buildFetcher({
    sites: [siteA()],
    pages: () => json({ message: "gone" }, 404),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("confluence.describe", { ids: [id] }),
  );
  assert.deepEqual(result.result.items, [
    { id, kind: null, name: null, detail: null, exists: false, meta: {} },
  ]);
});

test("describe request errors are refused without a request", async () => {
  const { fetcher, calls } = buildFetcher({});
  const confluence = adapter(fetcher);
  const tooMany = Array.from({ length: 101 }, (_, i) => `page:${CLOUD_A}:${10 + i}`);
  for (const request of [
    { ids: tooMany },
    { ids: [] },
    { ids: "page" },
    {},
    { ids: [`site:${CLOUD_A}`] },
    { ids: [`project:${CLOUD_A}:10000`] },
    { ids: [`page:${CLOUD_A}:abc`] },
    { ids: [5] },
  ]) {
    await assert.rejects(
      confluence.executeAction(actionInput("confluence.describe", request)),
      isInvalidRequest,
      JSON.stringify(request).slice(0, 80),
    );
  }
  assert.equal(calls.length, 0);
});

test("every result parses with the contract schemas", async () => {
  const handlers = {
    sites: [siteA()],
    spaces: (_site: string, url: URL) => {
      const ids = idsOf(url, "ids");
      return json({
        results: (ids.length > 0 ? ids : ["1001"]).map((id) => ({
          id,
          key: "ENG",
          name: "Engineering",
        })),
        _links: { next: "/wiki/api/v2/spaces?cursor=s2" },
      });
    },
    spacePages: () =>
      json({
        results: [pageRecord("10", { title: "Home" })],
        _links: { next: "/wiki/api/v2/spaces/1001/pages?cursor=p2" },
      }),
    children: () => json({ results: [pageRecord("31", { title: "Child" })] }),
    pages: (_site: string, url: URL) =>
      json({
        results: idsOf(url, "id")
          .filter((id) => id !== "11")
          .map((id) => pageRecord(id, { parentId: null })),
      }),
    search: () =>
      json({ results: [{ title: "Home", content: { id: "10" }, excerpt: "", url: "/x" }] }),
  };
  const confluence = adapter(buildFetcher(handlers).fetcher);

  const browse = connectorSelectionBrowseResultSchema.strict();
  for (const request of [
    {},
    { containerId: `site:${CLOUD_A}` },
    { containerId: `space:${CLOUD_A}:1001` },
    { containerId: `page:${CLOUD_A}:10` },
    { cursor: cursorOf({ v: 1, containerId: `site:${CLOUD_A}`, next: "s2" }) },
  ]) {
    const result = await confluence.executeAction(actionInput("confluence.browse", request));
    assert.deepEqual(browse.parse(result.result), result.result);
  }

  const search = await confluence.executeAction(
    actionInput("confluence.search", { query: "home" }),
  );
  assert.deepEqual(
    connectorSelectionSearchResultSchema.strict().parse(search.result),
    search.result,
  );

  const describe = await confluence.executeAction(
    actionInput("confluence.describe", {
      ids: [`space:${CLOUD_A}:1001`, `page:${CLOUD_A}:10`, `page:${CLOUD_A}:11`],
    }),
  );
  assert.deepEqual(
    connectorSelectionDescribeResultSchema.strict().parse(describe.result),
    describe.result,
  );
});

test("action 401 surfaces CONFLUENCE_REAUTH_REQUIRED", async () => {
  const { fetcher } = buildFetcher({
    sites: () => json({ error: "unauthorized" }, 401),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(actionInput("confluence.browse", {})),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 401 &&
      error.code === "CONFLUENCE_REAUTH_REQUIRED",
  );
});

test("unknown and agent actions are CONFLUENCE_UNSUPPORTED_ACTION", async () => {
  const { fetcher, calls } = buildFetcher({});
  const confluence = adapter(fetcher);
  for (const actionType of [
    "confluence.nope",
    "confluence.content.search",
    "confluence.page.read",
    "confluence.space.list",
  ]) {
    await assert.rejects(
      confluence.executeAction(actionInput(actionType, {})),
      (error: unknown) =>
        error instanceof AtlassianApiError &&
        error.statusCode === 400 &&
        error.code === "CONFLUENCE_UNSUPPORTED_ACTION",
      actionType,
    );
  }
  assert.equal(calls.length, 0);
});
