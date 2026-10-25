import assert from "node:assert/strict";
import { test } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  cursorCondition,
  decodeQueryCursor,
  encodeQueryCursor,
  filterCondition,
  orderClauses,
  queryFingerprint,
} from "./query";

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment);

test("filters bind paths and values as parameters, never as SQL text", () => {
  const hostile = "x'); drop table artifact_records; --";
  const query = render(
    filterCondition({ path: "title", op: "eq", value: hostile }),
  );
  assert.equal(query.sql.includes("drop table"), false);
  assert.ok(query.params.includes(JSON.stringify(hostile)));
  assert.ok(query.params.includes(JSON.stringify({ title: hostile })));
  assert.match(query.sql, /#> array\[\$\d+\]::text\[\]/u);
});

test("scalar equality uses the GIN containment probe plus exact equality", () => {
  const scalar = render(
    filterCondition({ path: "meta.status", op: "eq", value: "done" }),
  );
  assert.match(scalar.sql, /@> \$\d+::jsonb and/u);
  assert.ok(
    scalar.params.includes(JSON.stringify({ meta: { status: "done" } })),
  );
  assert.deepEqual(scalar.params.slice(1, 3), ["meta", "status"]);

  const structured = render(
    filterCondition({ path: "tags", op: "eq", value: ["a", "b"] }),
  );
  assert.equal(structured.sql.includes("@>"), false);
  assert.match(structured.sql, / = \$\d+::jsonb$/u);
});

test("array-index paths skip the containment probe", () => {
  const indexed = render(
    filterCondition({ path: "items.0", op: "eq", value: "x" }),
  );
  assert.equal(indexed.sql.includes("@>"), false);
  assert.match(indexed.sql, / = \$\d+::jsonb$/u);
  assert.equal(
    render(
      filterCondition({ path: "items.name", op: "eq", value: "x" }),
    ).sql.includes("@>"),
    true,
  );
});

test("each operator maps to a fixed SQL shape", () => {
  assert.match(
    render(filterCondition({ path: "a", op: "ne", value: 1 })).sql,
    /is distinct from \$\d+::jsonb/u,
  );
  assert.match(
    render(filterCondition({ path: "a", op: "in", value: [1, "x", null] })).sql,
    /in \(\$\d+::jsonb, \$\d+::jsonb, \$\d+::jsonb\)/u,
  );
  assert.match(
    render(filterCondition({ path: "a", op: "contains", value: ["x"] })).sql,
    /\) @> \$\d+::jsonb/u,
  );
  assert.match(
    render(filterCondition({ path: "a", op: "exists" })).sql,
    /is not null/u,
  );
  const range = render(filterCondition({ path: "due", op: "gte", value: 3 }));
  assert.match(range.sql, /jsonb_typeof\(.*\) = \$\d+ and .* >= \$\d+::jsonb/u);
  assert.ok(range.params.includes("number"));
  const text = render(
    filterCondition({ path: "due", op: "lt", value: "2026" }),
  );
  assert.ok(text.params.includes("string"));
});

test("ordering always ends on record id for a total order", () => {
  const clauses = orderClauses([{ path: "priority", dir: "desc" }]).map(
    (clause) => render(clause).sql,
  );
  assert.equal(clauses.length, 2);
  assert.match(clauses[0]!, /coalesce\(.*'null'::jsonb\) desc$/u);
  assert.match(clauses[1]!, /"record_id" asc$/u);
});

test("cursor conditions expand lexicographically across mixed directions", () => {
  const condition = render(
    cursorCondition([{ path: "priority", dir: "desc" }], {
      fingerprint: "f",
      values: [3],
      id: "task-9",
    }),
  );
  assert.match(condition.sql, /< \$\d+::jsonb or \(coalesce/u);
  assert.match(condition.sql, /"record_id" > \$\d+\)\)$/u);
  assert.ok(condition.params.includes("3"));
  assert.ok(condition.params.includes("task-9"));
});

test("cursors round-trip and are bound to the query that produced them", () => {
  const fingerprint = queryFingerprint({
    scope: "user",
    collection: "tasks",
    where: [],
    orderBy: [{ path: "priority", dir: "asc" }],
  });
  const encoded = encodeQueryCursor({
    fingerprint,
    values: [{ a: 1 }],
    id: "x",
  });
  assert.deepEqual(
    decodeQueryCursor(encoded, { fingerprint, sortKeyCount: 1 }),
    { fingerprint, values: [{ a: 1 }], id: "x" },
  );
  const other = queryFingerprint({
    scope: "shared",
    collection: "tasks",
    where: [],
    orderBy: [{ path: "priority", dir: "asc" }],
  });
  assert.notEqual(other, fingerprint);
  assert.equal(
    decodeQueryCursor(encoded, { fingerprint: other, sortKeyCount: 1 }),
    null,
  );
  assert.equal(
    decodeQueryCursor(encoded, { fingerprint, sortKeyCount: 0 }),
    null,
  );
  assert.equal(
    decodeQueryCursor("not-base64-json", { fingerprint, sortKeyCount: 1 }),
    null,
  );
});
