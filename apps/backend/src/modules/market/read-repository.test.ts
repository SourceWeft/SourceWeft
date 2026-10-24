import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { db } from "@sourceweft/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  decodeListCursor,
  encodeListCursor,
  identifierForSearch,
  findMcp,
  findMcpVersion,
  countMcpByCategory,
  itemIcon,
  listMcp,
  parseMcpCategoryFilter,
} from "./read-repository";

for (const code of ["ECONNREFUSED", "ETIMEDOUT", "08006", "57P01", "XX000"]) {
  test(`public catalog reads propagate database errors (${code})`, async () => {
    const failure = Object.assign(new Error("database unavailable"), { code });
    // Throw from the real query's await boundary, including Drizzle's wrapper.
    const wrapped = new Error("Failed query", { cause: failure });
    for (const error of [failure, wrapped]) {
      const query: Record<string, unknown> = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        innerJoin: () => query,
        groupBy: () => query,
        limit: () => query,
        then: (_resolve: unknown, reject: (reason: unknown) => unknown) =>
          reject(error),
      };
      const select = vi
        .spyOn(db, "select")
        .mockReturnValue(query as unknown as ReturnType<typeof db.select>);
      try {
        for (const read of [
          () => findMcp("io.github.acme/server"),
          () => findMcpVersion("io.github.acme/server"),
          () => listMcp({}),
          () => countMcpByCategory({}),
        ])
          await assert.rejects(read, (actual) => actual === error);
      } finally {
        select.mockRestore();
      }
    }
  });
}

test("a successful lookup with no record remains not found", async () => {
  const select = vi.spyOn(db, "select").mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => [] }) }),
  } as unknown as ReturnType<typeof db.select>);
  try {
    assert.equal(await findMcp("missing"), null);
    assert.equal(await findMcpVersion("missing"), null);
  } finally {
    select.mockRestore();
  }
});

test("search identifiers ignore the generic GitHub registry namespace", () => {
  assert.equal(
    identifierForSearch("io.github.wulfkaal/corpus"),
    "wulfkaal/corpus",
  );
  assert.equal(
    identifierForSearch("io.github.github/github-mcp-server"),
    "github/github-mcp-server",
  );
  assert.equal(identifierForSearch("com.github.acme/server"), "acme/server");
});

test("category filters accept single, multiple, duplicate and empty selections", () => {
  assert.deepEqual(parseMcpCategoryFilter(), []);
  assert.deepEqual(parseMcpCategoryFilter(" , "), []);
  assert.deepEqual(parseMcpCategoryFilter("files-storage"), ["files-storage"]);
  assert.deepEqual(
    parseMcpCategoryFilter("files-storage, databases,files-storage"),
    ["files-storage", "databases"],
  );
});

test("multiple categories use an EXISTS union before database pagination", async () => {
  // Keep the real category subquery so its SQL is checked, but intercept the
  // outer query to avoid requiring a running database.
  const categoryQuery = db.select({ one: sql`1` });
  let predicate: SQL | undefined;
  const limit = vi.fn().mockResolvedValue([]);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn((condition: SQL) => {
    predicate = condition;
    return { orderBy };
  });
  const select = vi.spyOn(db, "select");
  select.mockReturnValueOnce(categoryQuery as ReturnType<typeof db.select>);
  select.mockReturnValueOnce({
    from: () => ({ where }),
  } as unknown as ReturnType<typeof db.select>);
  try {
    const result = await listMcp({
      category: "files-storage,databases,files-storage",
      limit: 20,
    });
    assert.deepEqual(result, { items: [], nextCursor: null });
    assert.ok(predicate);
    const query = new PgDialect().sqlToQuery(predicate);
    assert.match(query.sql, /exists \(select/);
    assert.match(query.sql, /"mcp_categories"\."slug" in \(/);
    assert.equal(
      query.params.filter((value) => value === "files-storage").length,
      1,
    );
    assert.ok(query.params.includes("databases"));
    assert.equal(limit.mock.calls[0]?.[0], 21);
  } finally {
    select.mockRestore();
  }
});

test("issue #367: a search ranks servers whose publisher runs the endpoint first; a browse does not", async () => {
  for (const query of ["notion", undefined]) {
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const select = vi.spyOn(db, "select").mockReturnValue({
      from: () => ({ where }),
    } as unknown as ReturnType<typeof db.select>);
    try {
      await listMcp({ query });
      const keys = (orderBy.mock.calls[0] as SQL[]).map(
        (key) => new PgDialect().sqlToQuery(key).sql,
      );
      if (query) {
        assert.equal(keys.length, 3);
        assert.match(
          keys[0]!,
          /^\(case when \("mcp_servers"\."metadata_json" #>> '\{publisher,endpointMatch\}'\)::boolean then 1 else 0 end\) desc$/,
        );
      } else {
        assert.equal(keys.length, 2);
      }
      assert.match(keys.at(-2)!, /"published_at" desc$/);
      assert.match(keys.at(-1)!, /"mcp_servers"\."id" desc$/);
    } finally {
      select.mockRestore();
    }
  }
});

test("issue #367: the list cursor carries the rank key and still reads the older two-part form", () => {
  const publishedAt = new Date("2026-10-24T00:00:00.000Z");
  const ranked = encodeListCursor(1, publishedAt, "mcp-1");
  assert.deepEqual(decodeListCursor(ranked), {
    endpointMatch: 1,
    publishedAt,
    id: "mcp-1",
  });
  assert.deepEqual(decodeListCursor(encodeListCursor(0, null, "mcp-2")), {
    endpointMatch: 0,
    publishedAt: new Date(0),
    id: "mcp-2",
  });
  const legacy = Buffer.from(`${publishedAt.getTime()}|mcp-3`).toString(
    "base64url",
  );
  assert.deepEqual(decodeListCursor(legacy), {
    endpointMatch: 0,
    publishedAt,
    id: "mcp-3",
  });
  for (const bad of [
    Buffer.from("2|1|mcp").toString("base64url"),
    Buffer.from("1|1|").toString("base64url"),
    Buffer.from("1|x|mcp").toString("base64url"),
    Buffer.from("1|1|mcp|extra").toString("base64url"),
    Buffer.from("mcp").toString("base64url"),
  ]) {
    assert.equal(decodeListCursor(bad), null);
  }
  assert.equal(decodeListCursor(undefined), null);
});

test("issue #367: list items carry the manifest's icon source, or derive one for older manifests", () => {
  // A manifest the icon chain wrote: both fields pass through.
  assert.deepEqual(
    itemIcon({
      meta: {
        iconUrl: "https://assets.test/market/mcp-icons/notion.com/a.png",
        iconSource: "favicon",
      },
      repoUrl: null,
      identifier: "com.notion/mcp",
    }),
    {
      iconUrl: "https://assets.test/market/mcp-icons/notion.com/a.png",
      iconSource: "favicon",
    },
  );
  assert.deepEqual(
    itemIcon({
      meta: { iconSource: "placeholder" },
      repoUrl: "https://github.com/makenotion/notion-next",
      identifier: "com.notion/mcp",
    }),
    { iconUrl: null, iconSource: "placeholder" },
  );
  // Older manifests: a registry icon, else the GitHub avatar, else nothing.
  assert.deepEqual(
    itemIcon({
      meta: { iconUrl: "https://cdn.acme.test/icon.png" },
      repoUrl: null,
      identifier: "com.acme/mcp",
    }),
    { iconUrl: "https://cdn.acme.test/icon.png", iconSource: "registry" },
  );
  assert.deepEqual(
    itemIcon({ meta: {}, repoUrl: null, identifier: "io.github.acme/server" }),
    {
      iconUrl: "https://github.com/acme.png?size=128",
      iconSource: "github-avatar",
    },
  );
  assert.deepEqual(
    itemIcon({
      meta: {},
      repoUrl: "https://github.com/makenotion/notion-next",
      identifier: "com.notion/mcp",
    }),
    {
      iconUrl: "https://github.com/makenotion.png?size=128",
      iconSource: "github-avatar",
    },
  );
  assert.deepEqual(
    itemIcon({
      meta: { iconSource: "bogus" },
      repoUrl: null,
      identifier: "com.notion/mcp",
    }),
    { iconUrl: null, iconSource: "placeholder" },
  );
});
