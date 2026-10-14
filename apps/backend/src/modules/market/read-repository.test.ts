import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { db } from "@sourceweft/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  identifierForSearch,
  findMcp,
  findMcpVersion,
  countMcpByCategory,
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
