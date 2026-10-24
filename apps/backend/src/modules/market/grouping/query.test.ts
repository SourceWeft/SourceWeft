import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { db } from "@sourceweft/db";
import {
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
