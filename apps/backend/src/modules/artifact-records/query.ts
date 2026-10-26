import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { artifactRecords } from "@sourceweft/db";
import type {
  ArtifactRecordFilter,
  ArtifactRecordOrder,
} from "@sourceweft/contracts/artifact-records";

/**
 * Translates the page's query DSL into parameterized SQL over `data jsonb`.
 *
 * Nothing the page sends is ever spliced into SQL text: paths become a
 * `text[]` of bound parameters for `#>`, values become bound `jsonb`
 * parameters, and the only raw fragments are operators and directions chosen
 * from fixed tables below. The caller always adds the
 * artifact/scope/owner/collection prefix, so a query can only narrow the
 * caller's own partition.
 */

function pathExpression(path: string): SQL {
  const parts = path.split(".");
  return sql`(${artifactRecords.data} #> array[${sql.join(
    parts.map((part) => sql`${part}`),
    sql`, `,
  )}]::text[])`;
}

function jsonParameter(value: unknown): SQL {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function isScalar(value: unknown) {
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
}

/** `{a: {b: value}}` for path `a.b`, the containment probe GIN can answer. */
function containmentProbe(path: string, value: unknown) {
  return path
    .split(".")
    .reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
}

function hasIndexSegment(path: string) {
  return path.split(".").some((part) => /^[0-9]+$/u.test(part));
}

const COMPARISON_OPERATORS = {
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
} as const;

export function filterCondition(filter: ArtifactRecordFilter): SQL {
  const target = pathExpression(filter.path);
  switch (filter.op) {
    case "eq":
      // Structural equality is exact; the containment probe only lets the GIN
      // index narrow candidates for scalars (containment alone would also
      // match arrays holding the scalar). `#>` reads an all-digit segment as
      // an array index while the probe would spell it as an object key, so
      // such paths use the exact comparison alone.
      return isScalar(filter.value) && !hasIndexSegment(filter.path)
        ? sql`(${artifactRecords.data} @> ${jsonParameter(
            containmentProbe(filter.path, filter.value),
          )} and ${target} = ${jsonParameter(filter.value)})`
        : sql`${target} = ${jsonParameter(filter.value)}`;
    case "ne":
      return sql`${target} is distinct from ${jsonParameter(filter.value)}`;
    case "in":
      return sql`${target} in (${sql.join(
        filter.value.map(jsonParameter),
        sql`, `,
      )})`;
    case "contains":
      return sql`${target} @> ${jsonParameter(filter.value)}`;
    case "exists":
      return sql`${target} is not null`;
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      // Only like-typed values compare; a string never orders against a number.
      return sql`(jsonb_typeof(${target}) = ${
        typeof filter.value === "number" ? "number" : "string"
      } and ${target} ${sql.raw(COMPARISON_OPERATORS[filter.op])} ${jsonParameter(
        filter.value,
      )})`;
  }
}

/** Missing fields sort as JSON null, so every key is non-NULL in SQL. */
function sortExpression(path: string): SQL {
  return sql`coalesce(${pathExpression(path)}, 'null'::jsonb)`;
}

type SortKey = { expression: SQL; descending: boolean; isId: boolean };

function sortKeys(orderBy: readonly ArtifactRecordOrder[]): SortKey[] {
  return [
    ...orderBy.map((order) => ({
      expression: sortExpression(order.path),
      descending: order.dir === "desc",
      isId: false,
    })),
    // Record ids are unique in a partition, so this makes the order total.
    {
      expression: sql`${artifactRecords.recordId}`,
      descending: false,
      isId: true,
    },
  ];
}

export function orderClauses(orderBy: readonly ArtifactRecordOrder[]): SQL[] {
  return sortKeys(orderBy).map(
    (key) => sql`${key.expression} ${sql.raw(key.descending ? "desc" : "asc")}`,
  );
}

/** Selected alongside each row so the next cursor can be built from it. */
export function sortValueSelections(orderBy: readonly ArtifactRecordOrder[]) {
  return orderBy.map((order) => sortExpression(order.path));
}

export type QueryCursor = {
  fingerprint: string;
  values: unknown[];
  id: string;
};

/** Ties a cursor to the query that produced it; a cursor for another query is rejected. */
export function queryFingerprint(input: {
  scope: string;
  collection: string;
  where: readonly ArtifactRecordFilter[];
  orderBy: readonly ArtifactRecordOrder[];
  idPrefix?: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.scope,
        input.collection,
        input.where,
        input.orderBy,
        input.idPrefix ?? null,
      ]),
    )
    .digest("base64url")
    .slice(0, 16);
}

export function encodeQueryCursor(cursor: QueryCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.fingerprint, cursor.values, cursor.id]),
  ).toString("base64url");
}

export function decodeQueryCursor(
  value: string,
  expected: { fingerprint: string; sortKeyCount: number },
): QueryCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed[0] !== expected.fingerprint ||
    !Array.isArray(parsed[1]) ||
    parsed[1].length !== expected.sortKeyCount ||
    typeof parsed[2] !== "string"
  )
    return null;
  return { fingerprint: parsed[0], values: parsed[1], id: parsed[2] };
}

/**
 * Rows strictly after the cursor in the query's own order: the usual
 * lexicographic expansion `(k1 after c1) or (k1 = c1 and (k2 after c2 or …))`,
 * which also handles mixed ascending and descending keys.
 */
export function cursorCondition(
  orderBy: readonly ArtifactRecordOrder[],
  cursor: QueryCursor,
): SQL {
  const keys = sortKeys(orderBy);
  const values: unknown[] = [...cursor.values, cursor.id];
  const parameter = (index: number) =>
    keys[index]!.isId
      ? sql`${values[index] as string}`
      : jsonParameter(values[index]);
  const build = (index: number): SQL => {
    const key = keys[index]!;
    const after = sql`${key.expression} ${sql.raw(key.descending ? "<" : ">")} ${parameter(index)}`;
    if (index === keys.length - 1) return after;
    return sql`(${after} or (${key.expression} = ${parameter(index)} and ${build(index + 1)}))`;
  };
  return build(0);
}
