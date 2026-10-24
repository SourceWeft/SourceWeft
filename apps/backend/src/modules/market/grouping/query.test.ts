import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { db } from "@sourceweft/db";
import {
  brandTokenPattern,
  findBrandPublisherDomains,
  findOfficialProductEntries,
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
  publishedAt: new Date("2026-09-03T00:00:00Z"),
  metadataJson: {
    publisher: {
      domain: "notion.com",
      source: "registry-namespace",
      endpointMatch: true,
    },
  },
};

afterEach(() => {
  forgetOfficialProductEntries();
  vi.restoreAllMocks();
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
