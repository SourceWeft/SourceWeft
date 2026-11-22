import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

vi.mock("../../workspace/guards", () => ({
  requireContentWorkspace: async () => ({ id: "w1", organizationId: "team-1" }),
}));
vi.mock("../../workspace", () => ({
  workspaceService: {
    resolveBillingOrganizationId: async (input: {
      workspaceOrganizationId: string;
    }) => input.workspaceOrganizationId,
  },
}));
vi.mock("../repository", () => ({ findSourceRecordByExternalUri: vi.fn() }));
vi.mock("../web-provider", () => ({ createDefaultWebProvider: vi.fn() }));

import { BillingAdmissionError } from "../../../shared/model-gateway/index";
import type { RateLimitVerdict } from "../../../shared/rate-limit";
import type { CacheEntry, JsonCache } from "../../../shared/redis-cache";
import { findSourceRecordByExternalUri } from "../repository";
import { discoverSources, isSourceDiscoveryAvailable } from "./service";

const search = vi.fn();
const provider = { name: "fake", search, fetch: vi.fn() } as never;
const planQueries = vi.fn();
const consume = vi.fn();

/** An in-memory cache that remembers when each entry was stored. */
function memoryCache(now = () => 1_700_000_000_000) {
  const store = new Map<string, CacheEntry<unknown>>();
  const ttls = new Map<string, number>();
  const cache: JsonCache = {
    async get<T>(key: string) {
      return (store.get(key) as CacheEntry<T> | undefined) ?? null;
    },
    async set<T>(key: string, value: T, ttlSeconds: number) {
      store.set(key, { value, storedAt: now() });
      ttls.set(key, ttlSeconds);
    },
  };
  return { cache, store, ttls };
}

const input = {
  workspaceId: "w1",
  userId: "u1",
  topic: "solid state batteries",
  requestId: "r1",
};

let memory = memoryCache();
const deps = (overrides = {}) => ({
  billing: {} as never,
  getProvider: async () => provider,
  planQueries: planQueries as never,
  rateLimiter: { consume } as never,
  cache: memory.cache,
  findExistingSourceId: async () => null,
  ...overrides,
});

const ok = (result: Awaited<ReturnType<typeof discoverSources>>) => {
  assert.equal(result.kind, "ok");
  return result as Extract<typeof result, { kind: "ok" }>;
};

beforeEach(() => {
  search.mockReset();
  planQueries.mockReset().mockResolvedValue(["q1", "q2"]);
  consume.mockReset().mockResolvedValue({ allowed: true } as RateLimitVerdict);
  memory = memoryCache();
});

const hit = (url: string, title = "T") => ({ title, url, snippet: "s" });
const searchReturns = (byQuery: Record<string, ReturnType<typeof hit>[]>) =>
  search.mockImplementation(async ({ query }: { query: string }) => ({
    provider: "fake",
    query,
    count: byQuery[query]?.length ?? 0,
    results: byQuery[query] ?? [],
  }));

test("returns the planned queries and de-duplicated candidates", async () => {
  searchReturns({
    q1: [hit("https://a.com/1"), hit("https://shared.com/x")],
    q2: [hit("https://shared.com/x/"), hit("https://b.com/2")],
  });

  const result = ok(await discoverSources(input, deps()));

  assert.deepEqual(result.queries, ["q1", "q2"]);
  assert.deepEqual(
    result.candidates.map((item) => item.url),
    ["https://a.com/1", "https://shared.com/x", "https://b.com/2"],
  );
  assert.equal(result.cached, false);
  assert.equal(result.cachedAt, null);
});

test("searches ask for links and snippets only, never each page's full text", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [hit("https://b.com/2")] });

  await discoverSources(input, deps());

  for (const call of search.mock.calls) {
    assert.equal(call[0].limit, 5);
    assert.equal(call[0].includeContent, false);
  }
});

test("a page already in the workspace is marked, not hidden", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [] });

  const result = ok(
    await discoverSources(
      input,
      deps({
        findExistingSourceId: async ({ url }: { url: string }) =>
          url === "https://a.com/1" ? "source-9" : null,
      }),
    ),
  );

  assert.equal(result.candidates[0]?.existingSourceId, "source-9");
});

test("discovery marks an added youtube video as existing", async () => {
  const mockedFind = findSourceRecordByExternalUri as ReturnType<typeof vi.fn>;
  mockedFind.mockReset().mockResolvedValue({ id: "yt-source-1" });
  searchReturns({
    q1: [hit("https://www.youtube.com/watch?v=aaaaaaaaaaa")],
    q2: [],
  });

  // No `findExistingSourceId` override: exercises the real default, which
  // must route a youtube video candidate to sourceType "youtube".
  const { findExistingSourceId: _unused, ...withoutOverride } = deps();

  const result = ok(await discoverSources(input, withoutOverride));

  assert.equal(
    result.candidates[0]?.url,
    "https://www.youtube.com/watch?v=aaaaaaaaaaa",
  );
  assert.equal(result.candidates[0]?.existingSourceId, "yt-source-1");
  const call = mockedFind.mock.calls.at(-1)?.[0];
  assert.equal(call.sourceType, "youtube");
  assert.equal(call.externalUri, "https://www.youtube.com/watch?v=aaaaaaaaaaa");
});

test("one failing search does not lose the others", async () => {
  search.mockImplementation(async ({ query }: { query: string }) => {
    if (query === "q1") throw new Error("provider down");
    return {
      provider: "fake",
      query,
      count: 1,
      results: [hit("https://b.com/2")],
    };
  });

  const result = ok(await discoverSources(input, deps()));

  assert.deepEqual(
    result.candidates.map((item) => item.url),
    ["https://b.com/2"],
  );
});

test("every search failing is reported as a search failure", async () => {
  search.mockRejectedValue(new Error("provider down"));

  await assert.rejects(discoverSources(input, deps()), /Web search failed/);
});

test("without a web provider discovery is unavailable and nothing is spent", async () => {
  await assert.rejects(
    discoverSources(input, deps({ getProvider: async () => null })),
    /not available/,
  );
  assert.equal(planQueries.mock.calls.length, 0);
  assert.equal(consume.mock.calls.length, 0);
  assert.equal(await isSourceDiscoveryAvailable(async () => null), false);
  assert.equal(await isSourceDiscoveryAvailable(async () => provider), true);
});

test("a requester without credits is refused before any search runs", async () => {
  planQueries.mockRejectedValue(
    new BillingAdmissionError({
      allowed: false,
      reason: "insufficient_credits",
      availableCredits: 0,
    } as never),
  );

  await assert.rejects(discoverSources(input, deps()), /not enough credits/);
  assert.equal(search.mock.calls.length, 0);
});

test("planning is charged to the requester's billing organization", async () => {
  searchReturns({ q1: [], q2: [] });

  await discoverSources(input, deps()).catch(() => undefined);

  const call = planQueries.mock.calls[0]?.[0];
  assert.equal(call.teamId, "team-1");
  assert.equal(call.userId, "u1");
  assert.equal(call.topic, "solid state batteries");
});

test("a refused request does no planning and no searching, and says which limit and when", async () => {
  consume.mockResolvedValue({
    allowed: false,
    scope: "hour",
    limit: 150,
    windowSeconds: 3600,
    retryAfterSeconds: 1380,
  });

  const result = await discoverSources(input, deps());

  assert.deepEqual(result, {
    kind: "limited",
    scope: "hour",
    limit: 150,
    windowSeconds: 3600,
    retryAfterSeconds: 1380,
  });
  assert.equal(planQueries.mock.calls.length, 0);
  assert.equal(search.mock.calls.length, 0);
});

test("the user's and the team's limits are checked together, on the billing team", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [] });

  await discoverSources(input, deps());

  assert.equal(consume.mock.calls.length, 1);
  const rules = consume.mock.calls[0]![0] as Array<{
    key: string;
    scope: string;
    limit: number;
  }>;
  assert.deepEqual(
    rules.map((rule) => [rule.key, rule.scope, rule.limit]),
    [
      ["source-discovery:user:u1", "minute", 10],
      ["source-discovery:user:u1", "hour", 150],
      ["source-discovery:user:u1", "day", 600],
      ["source-discovery:team:team-1", "team", 600],
    ],
  );
});

test("a limiter that cannot count refuses the request instead of letting it spend", async () => {
  consume.mockRejectedValue(new Error("redis down"));

  await assert.rejects(
    discoverSources(input, deps()),
    /unavailable for a moment/,
  );
  assert.equal(planQueries.mock.calls.length, 0);
  assert.equal(search.mock.calls.length, 0);
});

test("a repeated search is answered from cache: no limit used, no model, no provider", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [hit("https://b.com/2")] });
  await discoverSources(input, deps());
  consume.mockClear();
  planQueries.mockClear();
  search.mockClear();

  const again = ok(await discoverSources(input, deps()));

  assert.equal(again.cached, true);
  assert.deepEqual(
    again.candidates.map((item) => item.url),
    ["https://a.com/1", "https://b.com/2"],
  );
  assert.equal(consume.mock.calls.length, 0);
  assert.equal(planQueries.mock.calls.length, 0);
  assert.equal(search.mock.calls.length, 0);
});

test("a cached answer is never refused, even when the user is over a limit", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [] });
  await discoverSources(input, deps());
  consume.mockResolvedValue({
    allowed: false,
    scope: "minute",
    limit: 10,
    windowSeconds: 60,
    retryAfterSeconds: 30,
  });

  const again = await discoverSources(input, deps());

  assert.equal(again.kind, "ok");
});

test("the same topic typed differently hits the same cache entry", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [] });
  await discoverSources(input, deps());
  planQueries.mockClear();

  const again = ok(
    await discoverSources(
      { ...input, topic: "  Solid  STATE   batteries " },
      deps(),
    ),
  );

  assert.equal(again.cached, true);
  assert.equal(planQueries.mock.calls.length, 0);
});

test("the cached answer says how old it is", async () => {
  let clock = 1_700_000_000_000;
  memory = memoryCache(() => clock);
  searchReturns({ q1: [hit("https://a.com/1")], q2: [] });
  await discoverSources(input, deps());
  clock += 600_000;

  const again = ok(await discoverSources(input, deps()));

  assert.equal(again.cachedAt, new Date(1_700_000_000_000).toISOString());
});

test("whether a page is already a source is checked fresh, not taken from the cache", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [] });
  await discoverSources(input, deps());

  const again = ok(
    await discoverSources(
      input,
      deps({ findExistingSourceId: async () => "source-new" }),
    ),
  );

  assert.equal(again.cached, true);
  assert.equal(again.candidates[0]?.existingSourceId, "source-new");
});

test("a failed search is not cached, and an empty one only for a short while", async () => {
  search.mockImplementation(async ({ query }: { query: string }) => {
    if (query === "q1") throw new Error("provider down");
    return { provider: "fake", query, count: 0, results: [] };
  });

  const result = ok(await discoverSources(input, deps()));

  assert.equal(result.candidates.length, 0);
  const searchEntries = [...memory.store.keys()].filter((key) =>
    key.includes(":search:"),
  );
  assert.equal(searchEntries.length, 1);
  assert.equal(memory.ttls.get(searchEntries[0]!), 300);
});

test("non-empty hits are kept for an hour and the plan for a day", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [hit("https://b.com/2")] });

  await discoverSources(input, deps());

  const ttlOf = (part: string) =>
    [...memory.ttls]
      .filter(([key]) => key.includes(part))
      .map(([, ttl]) => ttl);
  assert.deepEqual(ttlOf(":plan:"), [86_400]);
  assert.deepEqual(ttlOf(":search:"), [3600, 3600]);
});

test("when only some searches are cached, only the missing ones run and the limit is used", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [hit("https://b.com/2")] });
  await discoverSources(input, deps());
  for (const key of [...memory.store.keys()]) {
    if (
      key.includes(":search:") &&
      JSON.stringify(memory.store.get(key)).includes("b.com")
    ) {
      memory.store.delete(key);
    }
  }
  consume.mockClear();
  planQueries.mockClear();
  search.mockClear();

  const result = ok(await discoverSources(input, deps()));

  assert.equal(result.cached, false);
  assert.equal(consume.mock.calls.length, 1);
  assert.equal(planQueries.mock.calls.length, 0);
  assert.deepEqual(
    search.mock.calls.map((call) => call[0].query),
    ["q2"],
  );
});

test("a new topic that plans a query already searched reuses those hits", async () => {
  searchReturns({ q1: [hit("https://a.com/1")], q2: [hit("https://b.com/2")] });
  await discoverSources(input, deps());
  search.mockClear();

  const other = ok(
    await discoverSources({ ...input, topic: "a different topic" }, deps()),
  );

  assert.equal(search.mock.calls.length, 0);
  assert.equal(other.cached, false);
  assert.equal(other.candidates.length, 2);
});
