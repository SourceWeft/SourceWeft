import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { db } from "@sourceweft/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  identifierForSearch,
  listMcp,
  parseMcpCategoryFilter,
} from "./read-repository";

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
    assert.match(query.sql, /"market_categories"\."slug" in \(/);
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
