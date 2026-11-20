import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError, type AtlassianClientConfig } from "@sourceweft/atlassian-client";
import { createConfluenceClient } from "../src/confluence-client";

const CLOUD_ID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "access-token";
const BASE = "https://example.atlassian.net/wiki";

type RecordedCall = { url: string; init: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingFetcher(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

function config(fetcher: typeof fetch): AtlassianClientConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    errorPrefix: "CONFLUENCE",
    fetcher,
  };
}

function expectCall(calls: RecordedCall[], index: number): RecordedCall {
  const call = calls[index];
  assert.ok(call, `expected a recorded call at index ${index}`);
  return call;
}

function params(call: RecordedCall): URLSearchParams {
  return new URL(call.url).searchParams;
}

function pathOf(call: RecordedCall): string {
  return new URL(call.url).pathname;
}

async function assertRejectsWith(
  run: () => Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<void> {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

// --- spaces ---

test("listSpaces requests /wiki/api/v2/spaces with status, limit and cursor", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      results: [
        { id: "1001", key: "ENG", name: "Engineering", _links: { webui: "/spaces/ENG" } },
        { id: 1002, key: "DOCS", name: "Docs" },
      ],
      _links: {
        base: BASE,
        next: "/wiki/api/v2/spaces?limit=2&cursor=abc123",
      },
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.listSpaces(TOKEN, CLOUD_ID, { cursor: "prev", limit: 2 });

  assert.equal(calls.length, 1);
  const call = expectCall(calls, 0);
  assert.equal(call.init.method ?? "GET", "GET");
  assert.equal(pathOf(call), `/ex/confluence/${CLOUD_ID}/wiki/api/v2/spaces`);
  assert.equal(params(call).get("status"), "current");
  assert.equal(params(call).get("limit"), "2");
  assert.equal(params(call).get("cursor"), "prev");
  assert.equal(params(call).get("expand"), null);
  assert.deepEqual(result, {
    spaces: [
      { id: "1001", key: "ENG", name: "Engineering", webUrl: `${BASE}/spaces/ENG` },
      { id: "1002", key: "DOCS", name: "Docs", webUrl: null },
    ],
    next: "abc123",
  });
});

test("listSpaces has no next cursor on the last page and clamps the limit", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({ results: [], _links: { base: BASE } }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.listSpaces(TOKEN, CLOUD_ID, { limit: 5000 });

  assert.deepEqual(result, { spaces: [], next: null });
  assert.equal(params(expectCall(calls, 0)).get("limit"), "250");
});

test("listSpaces drops items without an id or a key", async () => {
  const { fetcher } = recordingFetcher(() =>
    json({
      results: [
        { id: "1", key: "KEEP", name: "Kept" },
        { id: "2", name: "No key" },
        { key: "NOID", name: "No id" },
      ],
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.listSpaces(TOKEN, CLOUD_ID, { limit: 25 });

  assert.deepEqual(
    result.spaces.map((s) => s.id),
    ["1"],
  );
});

test("a webUrl that is not https is not carried", async () => {
  const { fetcher } = recordingFetcher(() =>
    json({
      results: [{ id: "1", key: "A", name: "A", _links: { webui: "/spaces/A" } }],
      _links: { base: "javascript:alert(1)//" },
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.listSpaces(TOKEN, CLOUD_ID, { limit: 25 });

  assert.equal(result.spaces[0]?.webUrl, null);
});

test("getSpacesByIds sends ids as one comma list per batch of 250 and keeps request order", async () => {
  const ids = Array.from({ length: 600 }, (_, i) => String(1000 + i));
  const { fetcher, calls } = recordingFetcher((call) => {
    const asked = (params(call).get("ids") ?? "").split(",");
    // Answer each batch in reverse order and omit the first id of it.
    return json({
      results: asked
        .slice(1)
        .reverse()
        .map((id) => ({ id, key: `K${id}`, name: `Space ${id}` })),
    });
  });
  const client = createConfluenceClient(config(fetcher));

  const spaces = await client.getSpacesByIds(TOKEN, CLOUD_ID, ids);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => (params(c).get("ids") ?? "").split(",").length),
    [250, 250, 100],
  );
  for (const call of calls) {
    assert.equal(pathOf(call), `/ex/confluence/${CLOUD_ID}/wiki/api/v2/spaces`);
    assert.equal(params(call).get("status"), "current");
  }
  const expected = ids.filter((_, i) => i % 250 !== 0);
  assert.deepEqual(
    spaces.map((s) => s.id),
    expected,
  );
});

test("getSpacesByIds rejects a non-numeric id before any request", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({ results: [] }));
  const client = createConfluenceClient(config(fetcher));

  await assertRejectsWith(
    () => client.getSpacesByIds(TOKEN, CLOUD_ID, ["1", "2,3"]),
    400,
    "CONFLUENCE_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("getSpacesByIds with no ids makes no request", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({ results: [] }));
  const client = createConfluenceClient(config(fetcher));

  assert.deepEqual(await client.getSpacesByIds(TOKEN, CLOUD_ID, []), []);
  assert.equal(calls.length, 0);
});

test("searchSpaces filters by name and key case-insensitively", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      results: [
        { id: "1", key: "ENG", name: "Platform" },
        { id: "2", key: "OPS", name: "Engineering Handbook" },
        { id: "3", key: "HR", name: "People" },
        { id: "4", key: "eng2", name: "Other" },
      ],
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const spaces = await client.searchSpaces(TOKEN, CLOUD_ID, "ENG", 10);

  assert.deepEqual(
    spaces.map((s) => s.id),
    ["1", "2", "4"],
  );
  assert.equal(calls.length, 1);
  assert.equal(params(expectCall(calls, 0)).get("limit"), "250");
});

test("searchSpaces reads at most 5 pages of 250 and stops at the limit", async () => {
  let page = 0;
  const { fetcher, calls } = recordingFetcher(() => {
    page += 1;
    return json({
      results: [{ id: String(page), key: `K${page}`, name: "Nothing here" }],
      _links: { next: `/wiki/api/v2/spaces?cursor=c${page}` },
    });
  });
  const client = createConfluenceClient(config(fetcher));

  const none = await client.searchSpaces(TOKEN, CLOUD_ID, "zzz", 10);
  assert.deepEqual(none, []);
  assert.equal(calls.length, 5);
  assert.equal(params(expectCall(calls, 1)).get("cursor"), "c1");

  page = 0;
  calls.length = 0;
  const some = await client.searchSpaces(TOKEN, CLOUD_ID, "nothing", 2);
  assert.equal(some.length, 2);
  assert.equal(calls.length, 2);
});

// --- page lists ---

test("listSpaceRootPages requests root pages sorted by title", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      results: [
        { id: "10", status: "current", title: "Home", spaceId: "1001", parentId: null },
        { id: 11, status: "current", title: "Guide", spaceId: 1001, parentId: "10" },
      ],
      _links: { next: "/wiki/api/v2/spaces/1001/pages?depth=root&cursor=n1" },
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.listSpaceRootPages(TOKEN, CLOUD_ID, "1001", {
    cursor: "c0",
    limit: 50,
  });

  const call = expectCall(calls, 0);
  assert.equal(pathOf(call), `/ex/confluence/${CLOUD_ID}/wiki/api/v2/spaces/1001/pages`);
  assert.equal(params(call).get("depth"), "root");
  assert.equal(params(call).get("status"), "current");
  assert.equal(params(call).get("sort"), "title");
  assert.equal(params(call).get("limit"), "50");
  assert.equal(params(call).get("cursor"), "c0");
  assert.equal(params(call).get("body-format"), null);
  assert.deepEqual(result, {
    pages: [
      { id: "10", title: "Home", spaceId: "1001", parentId: null, status: "current" },
      { id: "11", title: "Guide", spaceId: "1001", parentId: "10", status: "current" },
    ],
    next: "n1",
  });
});

test("listChildPages uses /pages/{id}/children and only keeps current children", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      results: [
        { id: "21", status: "current", title: "Child A", spaceId: "1001" },
        { id: "22", status: "archived", title: "Child B", spaceId: "1001" },
        { id: "23", title: "No status", spaceId: "1001" },
        { status: "current", title: "No id" },
      ],
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.listChildPages(TOKEN, CLOUD_ID, "20", { limit: 25 });

  const call = expectCall(calls, 0);
  assert.equal(pathOf(call), `/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/20/children`);
  assert.ok(!call.url.includes("direct-children"));
  assert.ok(!call.url.includes("ancestors"));
  assert.equal(params(call).get("limit"), "25");
  assert.deepEqual(result, {
    pages: [
      { id: "21", title: "Child A", spaceId: "1001", parentId: null, status: "current" },
      { id: "23", title: "No status", spaceId: "1001", parentId: null, status: null },
    ],
    next: null,
  });
});

test("listChildPages rejects a non-numeric page id before any request", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({ results: [] }));
  const client = createConfluenceClient(config(fetcher));

  await assertRejectsWith(
    () => client.listChildPages(TOKEN, CLOUD_ID, "../spaces", { limit: 25 }),
    400,
    "CONFLUENCE_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("getPagesByIds batches 250 ids per request and keeps request order", async () => {
  const ids = Array.from({ length: 520 }, (_, i) => String(5000 + i));
  const { fetcher, calls } = recordingFetcher((call) => {
    const asked = (params(call).get("id") ?? "").split(",");
    return json({
      results: [...asked]
        .reverse()
        .filter((id) => id !== "5003")
        .map((id) => ({ id, status: "current", title: `T${id}`, spaceId: "9", parentId: null })),
    });
  });
  const client = createConfluenceClient(config(fetcher));

  const pages = await client.getPagesByIds(TOKEN, CLOUD_ID, ids);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => (params(c).get("id") ?? "").split(",").length),
    [250, 250, 20],
  );
  for (const call of calls) {
    assert.equal(pathOf(call), `/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages`);
    assert.equal(params(call).get("status"), "current");
    assert.equal(params(call).get("limit"), String((params(call).get("id") ?? "").split(",").length));
  }
  assert.deepEqual(
    pages.map((p) => p.id),
    ids.filter((id) => id !== "5003"),
  );
});

test("getPagesByIds never returns a page that was not asked for", async () => {
  const { fetcher } = recordingFetcher(() =>
    json({
      results: [
        { id: "1", status: "current", title: "Asked", spaceId: "9" },
        { id: "999", status: "current", title: "Stray", spaceId: "9" },
      ],
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const pages = await client.getPagesByIds(TOKEN, CLOUD_ID, ["1", "2"]);

  assert.deepEqual(
    pages.map((p) => p.id),
    ["1"],
  );
});

test("page titles are cut at the selection name limit", async () => {
  const { fetcher } = recordingFetcher(() =>
    json({
      results: [
        { id: "1", status: "current", title: "t".repeat(3000), spaceId: "9" },
      ],
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const pages = await client.getPagesByIds(TOKEN, CLOUD_ID, ["1"]);

  assert.equal(pages[0]?.title, "t".repeat(1024));
});

test("getPagesByIds with no ids makes no request", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({ results: [] }));
  const client = createConfluenceClient(config(fetcher));

  assert.deepEqual(await client.getPagesByIds(TOKEN, CLOUD_ID, []), []);
  assert.equal(calls.length, 0);
});

test("getPagesByIds rejects an id that is not numeric", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({ results: [] }));
  const client = createConfluenceClient(config(fetcher));

  await assertRejectsWith(
    () => client.getPagesByIds(TOKEN, CLOUD_ID, ["12", "13,14"]),
    400,
    "CONFLUENCE_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("a list response whose results is not an array is a 503", async () => {
  const bodies: unknown[] = [{ results: "nope" }, {}, [], null, "text"];
  for (const body of bodies) {
    const { fetcher } = recordingFetcher(() => json(body));
    const client = createConfluenceClient(config(fetcher));
    await assertRejectsWith(
      () => client.listSpaces(TOKEN, CLOUD_ID, { limit: 5 }),
      503,
      "CONFLUENCE_UNAVAILABLE",
    );
    await assertRejectsWith(
      () => client.listSpaceRootPages(TOKEN, CLOUD_ID, "1", { limit: 5 }),
      503,
      "CONFLUENCE_UNAVAILABLE",
    );
    await assertRejectsWith(
      () => client.listChildPages(TOKEN, CLOUD_ID, "1", { limit: 5 }),
      503,
      "CONFLUENCE_UNAVAILABLE",
    );
    await assertRejectsWith(
      () => client.getPagesByIds(TOKEN, CLOUD_ID, ["1"]),
      503,
      "CONFLUENCE_UNAVAILABLE",
    );
    await assertRejectsWith(
      () => client.search(TOKEN, CLOUD_ID, { cql: "type = page", limit: 5 }),
      503,
      "CONFLUENCE_UNAVAILABLE",
    );
  }
});

// --- single page ---

test("getPage requests the ADF body and parses the JSON string", async () => {
  const adf = { type: "doc", version: 1, content: [{ type: "paragraph" }] };
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      id: "30",
      status: "current",
      title: "Runbook",
      spaceId: "1001",
      parentId: "20",
      version: { number: 7, createdAt: "2026-11-01T10:00:00.000Z" },
      body: { atlas_doc_format: { representation: "atlas_doc_format", value: JSON.stringify(adf) } },
      _links: { base: BASE, webui: "/spaces/ENG/pages/30/Runbook" },
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const page = await client.getPage(TOKEN, CLOUD_ID, "30");

  const call = expectCall(calls, 0);
  assert.equal(pathOf(call), `/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/30`);
  assert.equal(params(call).get("body-format"), "atlas_doc_format");
  assert.deepEqual(page, {
    id: "30",
    title: "Runbook",
    spaceId: "1001",
    parentId: "20",
    status: "current",
    version: 7,
    updated: "2026-11-01T10:00:00.000Z",
    adf,
    webUrl: `${BASE}/spaces/ENG/pages/30/Runbook`,
  });
});

test("getPage with an unparsable ADF string or no body has adf null", async () => {
  for (const body of [
    { atlas_doc_format: { value: "{not json" } },
    { atlas_doc_format: { value: 42 } },
    {},
  ]) {
    const { fetcher } = recordingFetcher(() =>
      json({ id: "30", title: "T", spaceId: "1", status: "current", body }),
    );
    const client = createConfluenceClient(config(fetcher));

    const page = await client.getPage(TOKEN, CLOUD_ID, "30");

    assert.ok(page);
    assert.equal(page.adf, null);
    assert.equal(page.version, null);
    assert.equal(page.updated, null);
    assert.equal(page.webUrl, null);
  }
});

test("getPage returns null for a missing (404) and a forbidden (403) page", async () => {
  for (const status of [404, 403]) {
    const { fetcher } = recordingFetcher(() => json({}, status));
    const client = createConfluenceClient(config(fetcher));
    assert.equal(await client.getPage(TOKEN, CLOUD_ID, "30"), null);
  }
});

test("getPage propagates every other error", async () => {
  const { fetcher } = recordingFetcher(() => json({}, 500));
  const client = createConfluenceClient(config(fetcher));
  await assertRejectsWith(
    () => client.getPage(TOKEN, CLOUD_ID, "30"),
    503,
    "CONFLUENCE_UNAVAILABLE",
  );

  const unauthorized = recordingFetcher(() => json({}, 401));
  await assertRejectsWith(
    () => createConfluenceClient(config(unauthorized.fetcher)).getPage(TOKEN, CLOUD_ID, "30"),
    401,
    "CONFLUENCE_REAUTH_REQUIRED",
  );
});

test("getPage with a non-object response is a 503 and one without an id is null", async () => {
  const bad = recordingFetcher(() => json("text"));
  await assertRejectsWith(
    () => createConfluenceClient(config(bad.fetcher)).getPage(TOKEN, CLOUD_ID, "30"),
    503,
    "CONFLUENCE_UNAVAILABLE",
  );

  const noId = recordingFetcher(() => json({ title: "No id" }));
  assert.equal(
    await createConfluenceClient(config(noId.fetcher)).getPage(TOKEN, CLOUD_ID, "30"),
    null,
  );
});

test("getPage rejects a non-numeric page id before any request", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({}));
  const client = createConfluenceClient(config(fetcher));

  await assertRejectsWith(
    () => client.getPage(TOKEN, CLOUD_ID, "30/../../x"),
    400,
    "CONFLUENCE_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

// --- search ---

test("search calls the v1 search endpoint with cql and limit and never sends expand", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      results: [
        {
          content: {
            id: 40,
            type: "page",
            status: "current",
            space: { id: 999, key: "OTHER" },
            ancestors: [{ id: "1" }],
          },
          title: "Deploy guide",
          excerpt: "How to @@@hl@@@deploy@@@endhl@@@ it",
          url: "/spaces/ENG/pages/40/Deploy+guide",
          lastModified: "2026-11-02T09:00:00.000Z",
        },
      ],
      _links: {
        base: BASE,
        next: "/rest/api/search?cql=type%3Dpage&limit=20&cursor=nxt",
      },
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.search(TOKEN, CLOUD_ID, {
    cql: 'type = page AND text ~ "deploy"',
    cursor: "cur",
    limit: 20,
  });

  assert.equal(calls.length, 1);
  const call = expectCall(calls, 0);
  assert.equal(pathOf(call), `/ex/confluence/${CLOUD_ID}/wiki/rest/api/search`);
  assert.equal(params(call).get("cql"), 'type = page AND text ~ "deploy"');
  assert.equal(params(call).get("limit"), "20");
  assert.equal(params(call).get("cursor"), "cur");
  assert.equal(params(call).get("expand"), null);
  assert.ok(!call.url.includes("expand"));
  assert.deepEqual(result, {
    hits: [
      {
        pageId: "40",
        title: "Deploy guide",
        excerpt: "How to deploy it",
        lastModified: "2026-11-02T09:00:00.000Z",
        webUrl: `${BASE}/spaces/ENG/pages/40/Deploy+guide`,
      },
    ],
    next: "nxt",
  });
  // Scope data never comes from a hit.
  assert.deepEqual(Object.keys(result.hits[0] ?? {}).sort(), [
    "excerpt",
    "lastModified",
    "pageId",
    "title",
    "webUrl",
  ]);
});

test("search strips highlight markers and cuts the excerpt at 500 characters", async () => {
  const long = `${"a".repeat(498)}@@@hl@@@bcd@@@endhl@@@${"z".repeat(100)}`;
  const { fetcher } = recordingFetcher(() =>
    json({
      results: [
        { content: { id: "1" }, title: "T", excerpt: long, url: "/x" },
        { content: { id: "2" }, title: "U", excerpt: "@@@hl@@@only@@@endhl@@@" },
      ],
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.search(TOKEN, CLOUD_ID, { cql: "type = page", limit: 20 });

  assert.equal(result.hits[0]?.excerpt.length, 500);
  assert.ok(!result.hits[0]?.excerpt.includes("@@@"));
  assert.equal(result.hits[1]?.excerpt, "only");
  assert.equal(result.hits[0]?.lastModified, null);
  assert.equal(result.hits[0]?.webUrl, null);
});

test("search drops hits without a content id and has no next cursor on the last page", async () => {
  const { fetcher } = recordingFetcher(() =>
    json({
      results: [
        { content: { id: "1" }, title: "Kept", excerpt: "" },
        { content: {}, title: "No id", excerpt: "" },
        { title: "Space result", excerpt: "" },
        { content: { id: "" }, title: "Blank id", excerpt: "" },
      ],
      _links: { base: BASE },
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.search(TOKEN, CLOUD_ID, { cql: "type = page", limit: 20 });

  assert.deepEqual(
    result.hits.map((h) => h.pageId),
    ["1"],
  );
  assert.equal(result.next, null);
});

test("search uses the hit title and falls back to the content title", async () => {
  const { fetcher } = recordingFetcher(() =>
    json({
      results: [{ content: { id: "1", title: "From content" }, excerpt: "e" }],
    }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.search(TOKEN, CLOUD_ID, { cql: "type = page", limit: 20 });

  assert.equal(result.hits[0]?.title, "From content");
});

test("search next is null when the next link carries no cursor", async () => {
  const { fetcher } = recordingFetcher(() =>
    json({ results: [], _links: { next: "/rest/api/search?cql=x&start=20" } }),
  );
  const client = createConfluenceClient(config(fetcher));

  const result = await client.search(TOKEN, CLOUD_ID, { cql: "type = page", limit: 20 });

  assert.equal(result.next, null);
});
