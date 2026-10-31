import assert from "node:assert/strict";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { db } from "@sourceweft/db";
import {
  brandTokenPattern,
  findBrandPublisherDomains,
  findOfficialProductEntries,
  findOfficialProductGroupResolver,
  findProductGroupMembers,
  forgetOfficialProductEntries,
  OFFICIAL_ENTRIES_TTL_MS,
} from "./query";

function stubSelect(
  rows: Record<string, unknown>[] | Error,
): ReturnType<typeof vi.spyOn> {
  const query: Record<string, unknown> = {
    from: () => query,
    where: () =>
      rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  };
  return vi
    .spyOn(db, "select")
    .mockReturnValue(query as unknown as ReturnType<typeof db.select>);
}

const officialRow = {
  id: "id-1",
  identifier: "com.notion/mcp",
  name: "Notion",
  repoUrl: null,
  summary: "",
  description: "",
  status: "published",
  visibility: "public",
  owner: null,
  sourceUrl: null,
  transport: null,
  official: true,
  verified: false,
  desktopOnly: false,
  runtime: null,
  categoriesSetBy: "auto",
  createdAt: new Date("2026-09-03T00:00:00Z"),
  updatedAt: new Date("2026-09-03T00:00:00Z"),
  publishedAt: new Date("2026-09-03T00:00:00Z"),
  metadataJson: {
    publisher: {
      domain: "notion.com",
      source: "registry-namespace",
      endpointMatch: true,
    },
  },
} satisfies Parameters<typeof findProductGroupMembers>[0];

afterEach(() => {
  forgetOfficialProductEntries();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("large detail reads reuse the official grouping work across candidates and requests", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  let publicationReads = 0;
  class CountedDate extends Date {
    override getTime() {
      publicationReads += 1;
      return super.getTime();
    }
  }
  const officials = Array.from({ length: 2_000 }, (_, i) => ({
    ...officialRow,
    id: `official-${i}`,
    identifier: `com.brand${i}/mcp`,
    name: `Brand${i}`,
    publishedAt: new CountedDate(1_700_000_000_000 + i),
    metadataJson: {
      publisher: {
        domain: `brand${i}.example`,
        source: "registry-namespace",
        endpointMatch: true,
      },
    },
  }));
  const candidates = [
    officials[0]!,
    ...Array.from({ length: 199 }, (_, i) => ({
      ...officialRow,
      id: `integration-${i}`,
      identifier: `io.github.independent/helper-${i}`,
      name: "Independent helper",
      official: false,
      publishedAt: new Date(1_700_000_100_000 - i),
      metadataJson: {
        publisher: {
          domain: "brand0.example",
          source: "registry-namespace",
          endpointMatch: false,
        },
      },
    })),
  ];
  vi.spyOn(db, "select").mockImplementation(() => {
    let limit = 200;
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: (value: number) => {
        limit = value;
        return query;
      },
      offset: (value: number) =>
        Promise.resolve(candidates.slice(value, value + limit)),
      then: (resolve: (rows: typeof officials) => unknown) =>
        Promise.resolve(officials).then(resolve),
    };
    return query as unknown as ReturnType<typeof db.select>;
  });

  const first = await findProductGroupMembers(officials[0]!);
  assert.equal(first?.group.domain, "brand0.example");
  assert.deepEqual(
    first?.rows.map((row) => row.id),
    candidates.slice(0, 50).map((row) => row.id),
  );
  // Count actual work, not elapsed time: CI machine speed must not decide
  // whether grouping rebuilds and sorts every official for every candidate.
  assert.ok(
    publicationReads < officials.length * 8,
    `Official publication order was read ${publicationReads} times`,
  );
  const afterFirst = publicationReads;
  const second = await findProductGroupMembers(officials[0]!);
  assert.deepEqual(second, first);
  assert.equal(publicationReads, afterFirst);
});

test("the official-server list is read once per minute, not once per detail", async () => {
  const select = stubSelect([officialRow]);
  const t0 = 1_000_000;
  const first = await findOfficialProductEntries(t0);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0]!.publisher, {
    domain: "notion.com",
    source: "registry-namespace",
    endpointMatch: true,
  });
  await findOfficialProductEntries(t0 + 1);
  await findOfficialProductEntries(t0 + OFFICIAL_ENTRIES_TTL_MS - 1);
  assert.equal(select.mock.calls.length, 1);

  // At the TTL the list is read again.
  await findOfficialProductEntries(t0 + OFFICIAL_ENTRIES_TTL_MS);
  assert.equal(select.mock.calls.length, 2);

  // Forgetting it (a test that writes publishers) reads again at once.
  forgetOfficialProductEntries();
  await findOfficialProductEntries(t0 + OFFICIAL_ENTRIES_TTL_MS);
  assert.equal(select.mock.calls.length, 3);
});

test("a failed read is not remembered", async () => {
  const failure = new Error("database unavailable");
  let select = stubSelect(failure);
  await assert.rejects(
    findOfficialProductEntries(1),
    (error) => error === failure,
  );
  // The rejection handler that forgets the entry runs after the await above.
  await Promise.resolve();
  select.mockRestore();
  select = stubSelect([officialRow]);
  const entries = await findOfficialProductEntries(2);
  assert.equal(entries.length, 1);
  assert.equal(select.mock.calls.length, 1);
});

test("the compiled index shares the official snapshot TTL and explicit invalidation", async () => {
  const select = stubSelect([officialRow]);
  const first = await findOfficialProductGroupResolver(1_000_000);
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, () =>
      findOfficialProductGroupResolver(1_000_001),
    ),
  );
  assert.ok(concurrent.every((resolver) => resolver === first));
  assert.equal(select.mock.calls.length, 1);
  const fresh = await findOfficialProductGroupResolver(
    1_000_000 + OFFICIAL_ENTRIES_TTL_MS,
  );
  assert.notEqual(fresh, first);
  assert.equal(select.mock.calls.length, 2);
  forgetOfficialProductEntries();
  assert.notEqual(
    await findOfficialProductGroupResolver(1_000_000 + OFFICIAL_ENTRIES_TTL_MS),
    fresh,
  );
  assert.equal(select.mock.calls.length, 3);
});

test("a failed official read does not poison the compiled index", async () => {
  const error = new Error("official snapshot unavailable");
  const failing = stubSelect(error);
  await assert.rejects(
    findOfficialProductGroupResolver(1),
    (value) => value === error,
  );
  await Promise.resolve();
  failing.mockRestore();
  stubSelect([officialRow]);
  const resolver = await findOfficialProductGroupResolver(2);
  assert.equal(
    resolver.groupFor({
      ...officialRow,
      publisher: {
        domain: "notion.com",
        source: "registry-namespace",
        endpointMatch: true,
      },
    })?.domain,
    "notion.com",
  );
});

test("a failed compilation is retried against the same official snapshot", async () => {
  const error = new Error("publication ordering unavailable");
  let fail = true;
  class TransientDate extends Date {
    override getTime() {
      if (fail) throw error;
      return super.getTime();
    }
  }
  const select = stubSelect([
    { ...officialRow, publishedAt: new TransientDate(1_700_000_000_000) },
    { ...officialRow, id: "second", identifier: "com.notion/second" },
  ]);
  await assert.rejects(
    findOfficialProductGroupResolver(1),
    (value) => value === error,
  );
  fail = false;
  const resolver = await findOfficialProductGroupResolver(2);
  assert.equal(select.mock.calls.length, 1);
  assert.equal(
    resolver.groupFor({
      id: "client",
      identifier: "io.github.client/notion",
      name: "Notion",
      repoUrl: null,
      publishedAt: null,
      publisher: null,
    })?.domain,
    "notion.com",
  );
});

test("an expired official snapshot replaces the index contents", async () => {
  const firstSelect = stubSelect([officialRow]);
  const first = await findOfficialProductGroupResolver(1);
  firstSelect.mockRestore();
  const secondSelect = stubSelect([
    {
      ...officialRow,
      identifier: "com.slack/mcp",
      metadataJson: {
        publisher: {
          domain: "slack.com",
          source: "registry-namespace",
          endpointMatch: true,
        },
      },
    },
  ]);
  assert.equal(
    await findOfficialProductGroupResolver(OFFICIAL_ENTRIES_TTL_MS),
    first,
  );
  assert.equal(secondSelect.mock.calls.length, 0);
  const fresh = await findOfficialProductGroupResolver(
    OFFICIAL_ENTRIES_TTL_MS + 1,
  );
  const candidate = {
    id: "client",
    identifier: "io.github.client/notion",
    name: "Notion",
    repoUrl: null,
    publishedAt: null,
    publisher: null,
  };
  assert.equal(first.groupFor(candidate)?.domain, "notion.com");
  assert.equal(fresh.groupFor(candidate), null);
  assert.equal(
    fresh.groupFor({ ...candidate, name: "Slack" })?.domain,
    "slack.com",
  );
  assert.equal(secondSelect.mock.calls.length, 1);
});

test("a cold large index yields to unrelated requests before compilation completes", async () => {
  let publisherReads = 0;
  const officials = Array.from({ length: 20_000 }, (_, i) => ({
    ...officialRow,
    id: `cold-${i}`,
    identifier: `com.brand${i}/mcp`,
    metadataJson: {
      get publisher() {
        publisherReads += 1;
        return {
          domain: `brand${i}.example`,
          source: "registry-namespace",
          endpointMatch: true,
        };
      },
    },
  }));
  stubSelect(officials);
  let compiled = false;
  const pending = findOfficialProductGroupResolver().then((resolver) => {
    compiled = true;
    return resolver;
  });
  await nextEventLoopTurn();
  // Health handlers and socket callbacks get an event-loop turn while the
  // shared cold build is still in progress; no machine-dependent deadline.
  assert.equal(compiled, false);
  assert.ok(publisherReads > 0);
  const resolver = await pending;
  assert.equal(
    resolver.groupFor({
      ...officialRow,
      publisher: {
        domain: "brand0.example",
        source: "registry-namespace",
        endpointMatch: false,
      },
    })?.domain,
    "brand0.example",
  );
});

test("the brand's pattern is built from letters and digits, either case, with token boundaries", () => {
  assert.equal(brandTokenPattern(["note"]).includes("[nN][oO][tT][eE]"), true);
  assert.equal(
    brandTokenPattern(["claw", "link"]).includes(
      "[cC][lL][aA][wW][^[:alnum:]]*[lL][iI][nN][kK]",
    ),
    true,
  );
  // Digits are kept; anything else is escaped, never live regex syntax.
  assert.equal(brandTokenPattern(["web3"]).includes("[wW][eE][bB]3"), true);
  assert.equal(brandTokenPattern(["a.b"]).includes("[aA]\\.[bB]"), true);
});

test("brand search domains are the official servers' domains whose brand is the query", async () => {
  stubSelect([
    officialRow,
    {
      ...officialRow,
      id: "id-2",
      identifier: "so.notion/other",
      metadataJson: {
        publisher: {
          domain: "mcp.notion.so",
          source: "registry-namespace",
          endpointMatch: true,
        },
      },
    },
    {
      ...officialRow,
      id: "id-3",
      identifier: "com.slack/mcp",
      metadataJson: {
        publisher: {
          domain: "slack.com",
          source: "registry-namespace",
          endpointMatch: true,
        },
      },
    },
  ]);
  assert.deepEqual(await findBrandPublisherDomains(" Notion "), [
    "notion.com",
    "mcp.notion.so",
  ]);
  assert.deepEqual(await findBrandPublisherDomains("slack"), ["slack.com"]);
  assert.deepEqual(await findBrandPublisherDomains("notio"), []);
  assert.deepEqual(await findBrandPublisherDomains("  "), []);
});
