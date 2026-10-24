import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test, vi } from "vitest";

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../../shared/logger", () => ({
  logger: { warn: logs.warn, info: logs.info, debug: vi.fn(), error: vi.fn() },
}));

import {
  fetchGithubRegistryServers,
  GITHUB_MCP_REGISTRY_URL,
  GITHUB_REGISTRY_MAX_BODY_BYTES,
  GITHUB_REGISTRY_MAX_PAGES,
  GITHUB_REGISTRY_PAGE_SIZE,
  GITHUB_REGISTRY_REQUEST_TIMEOUT_MS,
  parseGithubRegistryEntry,
  parseGithubRegistryPage,
} from "./fetch";

/** A page of the real API (2026-10-23), trimmed to nine rows and no READMEs. */
const FIXTURE_PAGE: unknown = JSON.parse(
  readFileSync(
    new URL("./fixtures/servers-page.json", import.meta.url),
    "utf8",
  ),
);

function entry(name: string, extra: Record<string, unknown> = {}) {
  return {
    server: {
      name,
      version: "1.0.0",
      description: `${name} description`,
      ...extra,
    },
  };
}

function page(servers: unknown[], nextCursor?: string) {
  return JSON.stringify({
    servers,
    metadata: { count: servers.length, nextCursor },
  });
}

/** A page as the API answers `per_page`: numbered, no cursor. */
function numberedPage(servers: unknown[], page: number, totalPages: number) {
  return JSON.stringify({
    servers,
    metadata: { page, per_page: 100, total: 604, total_pages: totalPages },
  });
}

function json(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("the real page parses to rows with the GitHub facts and no README", () => {
  const { rows, next } = parseGithubRegistryPage(FIXTURE_PAGE);
  assert.equal(rows.length, 9);
  assert.ok(next && "cursor" in next && next.cursor.startsWith("mcp.cursor."));
  const notion = rows.find(
    (row) => row.name === "makenotion/notion-mcp-server",
  );
  assert.deepEqual(notion, {
    name: "makenotion/notion-mcp-server",
    title: undefined,
    description: "Official MCP server for Notion API",
    remoteUrl: "https://mcp.notion.com/sse",
    github: {
      displayName: "Notion",
      ownerAvatarUrl: "https://avatars.githubusercontent.com/u/4792552?v=4",
      isInOrganization: true,
      stars: 4676,
      license: "MIT License",
      nameWithOwner: "makenotion/notion-mcp-server",
    },
  });
  for (const row of rows) {
    assert.ok(!("readme" in row));
    assert.ok(!("readme" in row.github));
  }
  // A row whose repository no organization owns, and one whose remote is a
  // template rather than a URL, both parse; the matcher refuses them later.
  assert.equal(
    rows.find((row) => row.name === "antfu/nuxt-mcp")?.github.isInOrganization,
    false,
  );
  assert.equal(
    rows.find((row) => row.name === "zapier/zapier-mcp")?.remoteUrl,
    "{zapier_mcp_url}",
  );
});

test("only https avatars on GitHub's avatar host are kept", () => {
  const avatar = (ownerAvatarUrl: unknown) =>
    parseGithubRegistryEntry({
      server: {
        name: "io.github.acme/thing",
        _meta: {
          "io.modelcontextprotocol.registry/publisher-provided": {
            github: { ownerAvatarUrl },
          },
        },
      },
    })?.github.ownerAvatarUrl;
  assert.equal(
    avatar("https://avatars.githubusercontent.com/u/4792552?v=4"),
    "https://avatars.githubusercontent.com/u/4792552?v=4",
  );
  assert.equal(avatar("http://avatars.githubusercontent.com/u/1"), undefined);
  assert.equal(avatar("https://github.com/acme.png"), undefined);
  assert.equal(
    avatar("https://avatars.githubusercontent.com.evil.net/u/1"),
    undefined,
  );
  assert.equal(
    avatar("https://user:pw@avatars.githubusercontent.com/u/1"),
    undefined,
  );
  assert.equal(avatar(42), undefined);
});

test("entries without a name are dropped; strings are trimmed and bounded; only https avatars are kept", () => {
  assert.equal(
    parseGithubRegistryEntry({ server: { version: "1" } }),
    undefined,
  );
  assert.equal(parseGithubRegistryEntry("nope"), undefined);
  const long = "x".repeat(5000);
  const row = parseGithubRegistryEntry({
    server: {
      name: "  io.github.acme/thing  ",
      description: long,
      remotes: [{ type: "sse", url: " https://mcp.acme.test/sse " }],
      _meta: {
        "io.modelcontextprotocol.registry/publisher-provided": {
          github: {
            displayName: long,
            ownerAvatarUrl: "http://avatars.githubusercontent.com/u/1",
            stargazerCount: -3,
            license: 42,
            isInOrganization: "true",
            readme: "# never kept",
          },
        },
      },
    },
  });
  assert.ok(row);
  assert.equal(row.name, "io.github.acme/thing");
  assert.equal(row.description?.length, 1000);
  assert.equal(row.remoteUrl, "https://mcp.acme.test/sse");
  assert.equal(row.github.displayName?.length, 200);
  assert.equal(row.github.ownerAvatarUrl, undefined);
  assert.equal(row.github.stars, undefined);
  assert.equal(row.github.license, undefined);
  assert.equal(row.github.isInOrganization, false);
});

test("the GitHub block is read from the entry's _meta when the server has none", () => {
  const row = parseGithubRegistryEntry({
    server: { name: "io.github.acme/thing" },
    _meta: {
      "io.modelcontextprotocol.registry/publisher-provided": {
        github: { isInOrganization: true, stargazerCount: 7 },
      },
    },
  });
  assert.equal(row?.github.isInOrganization, true);
  assert.equal(row?.github.stars, 7);
});

test("walks every page by cursor, anonymously, with the page size and a timeout", async () => {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const doFetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      const cursor = url.searchParams.get("cursor");
      if (!cursor) return json(page([entry("a/one"), entry("a/two")], "c2"));
      if (cursor === "c2") return json(page([entry("a/three")], "c3"));
      return json(page([]));
    },
  );

  const result = await fetchGithubRegistryServers({
    fetch: doFetch as typeof fetch,
  });

  assert.deepEqual(
    result.rows.map((row) => row.name),
    ["a/one", "a/two", "a/three"],
  );
  assert.equal(result.pages, 3);
  assert.equal(result.stoppedBy, null);
  assert.equal(calls.length, 3);
  for (const { url, init } of calls) {
    assert.equal(url.origin + url.pathname, GITHUB_MCP_REGISTRY_URL);
    assert.equal(
      url.searchParams.get("per_page"),
      String(GITHUB_REGISTRY_PAGE_SIZE),
    );
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.accept, "application/json");
    assert.equal("authorization" in headers, false);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
  }
  assert.deepEqual(
    calls.map(({ url }) => url.searchParams.get("cursor")),
    [null, "c2", "c3"],
  );
  assert.equal(GITHUB_REGISTRY_REQUEST_TIMEOUT_MS, 10_000);
});

test("walks numbered pages when the API answers per_page that way, and stops at the last", async () => {
  const calls: URL[] = [];
  const doFetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const page = Number(url.searchParams.get("page") ?? "1");
    return json(numberedPage([entry(`a/${page}`)], page, 3));
  });
  const result = await fetchGithubRegistryServers({
    fetch: doFetch as unknown as typeof fetch,
  });
  assert.deepEqual(
    result.rows.map((row) => row.name),
    ["a/1", "a/2", "a/3"],
  );
  assert.equal(result.pages, 3);
  assert.equal(result.stoppedBy, null);
  assert.deepEqual(
    calls.map((url) => url.searchParams.get("page")),
    [null, "2", "3"],
  );
  assert.ok(calls.every((url) => !url.searchParams.has("cursor")));
  // A page past the count, or without page numbers, is the last.
  assert.equal(
    parseGithubRegistryPage(JSON.parse(numberedPage([], 3, 3))).next,
    undefined,
  );
  assert.equal(parseGithubRegistryPage({ servers: [] }).next, undefined);
  assert.deepEqual(
    parseGithubRegistryPage(JSON.parse(numberedPage([], 2, 7))).next,
    { page: 3 },
  );
});

test("stops at the page bound, keeping the rows read", async () => {
  let n = 0;
  const doFetch = vi.fn(async () => {
    n += 1;
    return json(page([entry(`a/${n}`)], `c${n + 1}`));
  });
  const result = await fetchGithubRegistryServers({
    fetch: doFetch as unknown as typeof fetch,
    maxPages: 3,
  });
  assert.equal(result.rows.length, 3);
  assert.equal(result.pages, 3);
  assert.equal(result.stoppedBy, "max_pages");
  assert.equal(doFetch.mock.calls.length, 3);
  assert.equal(GITHUB_REGISTRY_MAX_PAGES, 20);
});

test("a page body over the byte bound stops the walk with the earlier rows", async () => {
  const doFetch = vi.fn(async (input: string | URL | Request) => {
    const cursor = new URL(String(input)).searchParams.get("cursor");
    if (!cursor) return json(page([entry("a/one")], "c2"));
    return json(page([entry("a/two", { description: "y".repeat(400) })]));
  });
  const result = await fetchGithubRegistryServers({
    fetch: doFetch as unknown as typeof fetch,
    maxBodyBytes: 300,
  });
  assert.deepEqual(
    result.rows.map((row) => row.name),
    ["a/one"],
  );
  assert.equal(result.pages, 2);
  assert.equal(result.stoppedBy, "too_large");
  assert.ok(result.error?.includes("300 bytes"));
  assert.equal(GITHUB_REGISTRY_MAX_BODY_BYTES, 16 * 1024 * 1024);
});

test("a declared content-length over the bound is refused before reading", async () => {
  const doFetch = vi.fn(async () =>
    json(page([entry("a/one")]), { headers: { "content-length": "999999" } }),
  );
  const result = await fetchGithubRegistryServers({
    fetch: doFetch as unknown as typeof fetch,
    maxBodyBytes: 1000,
  });
  assert.equal(result.rows.length, 0);
  assert.equal(result.stoppedBy, "too_large");
});

test("a 429 stops the walk as rate limited; another failure as an error; both keep earlier rows", async () => {
  const limited = vi.fn(async (input: string | URL | Request) => {
    const cursor = new URL(String(input)).searchParams.get("cursor");
    if (!cursor) return json(page([entry("a/one")], "c2"));
    return new Response("slow down", { status: 429 });
  });
  const rateLimited = await fetchGithubRegistryServers({
    fetch: limited as unknown as typeof fetch,
  });
  assert.deepEqual(
    rateLimited.rows.map((row) => row.name),
    ["a/one"],
  );
  assert.equal(rateLimited.stoppedBy, "rate_limited");
  assert.equal(rateLimited.pages, 2);

  const failing = vi.fn(async (input: string | URL | Request) => {
    const cursor = new URL(String(input)).searchParams.get("cursor");
    if (!cursor) return json(page([entry("a/one")], "c2"));
    throw new TypeError("fetch failed");
  });
  const errored = await fetchGithubRegistryServers({
    fetch: failing as unknown as typeof fetch,
  });
  assert.deepEqual(
    errored.rows.map((row) => row.name),
    ["a/one"],
  );
  assert.equal(errored.stoppedBy, "error");
  assert.equal(errored.error, "fetch failed");
  assert.equal(logs.warn.mock.calls.length, 1);

  const serverError = await fetchGithubRegistryServers({
    fetch: (async () => new Response("", { status: 503 })) as typeof fetch,
  });
  assert.equal(serverError.rows.length, 0);
  assert.equal(serverError.stoppedBy, "error");
  assert.equal(serverError.error, "The registry answered 503");
});

test("a body that is not JSON, or not an object, is an error with no rows", async () => {
  const result = await fetchGithubRegistryServers({
    fetch: (async () => json("[]")) as typeof fetch,
  });
  assert.equal(result.rows.length, 0);
  assert.equal(result.stoppedBy, "error");
});
