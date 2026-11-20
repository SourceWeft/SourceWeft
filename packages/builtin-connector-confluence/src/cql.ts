// CQL builders for the Confluence agent tools. The agent never supplies CQL
// itself: every free-text input (search text, space keys, title queries) is
// escaped through `cqlString`, and search text and title queries are first
// cleaned through `cqlTextTerm`, so user-controlled text can only ever land
// inside one string literal and can never change the query's clause
// structure. Page ids are validated as digits and written unquoted.

import { invalidRequest } from "./shared";

const PAGE_ID = /^[0-9]{1,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NO_SEARCHABLE_WORDS = "The search text has no searchable words.";

export type ConfluenceCqlScope = { spaceKeys: string[]; pageIds: string[] };

/** Wraps `value` as a double-quoted CQL string literal, escaping backslashes
 * before quotes so the value can never close the literal early. The escaping is
 * fixed; implement exactly this. */
export function cqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Strips CQL-significant characters out of a free-text search term before
 * it is wrapped with {@link cqlString} for a `text ~ "..."` or `title ~ "..."`
 * clause. The cleaning is fixed; implement exactly this. */
export function cqlTextTerm(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[+\-&|!(){}\[\]^~*?\\:"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The scope clause: `(space in (...) OR ancestor in (...) OR id in (...))`
 * with only the non-empty parts. `ancestor` matches every descendant of a
 * page, so `ancestor in` plus `id in` covers a selected page and its whole
 * subtree. An empty scope is rejected: a query is never built without one.
 */
export function buildScopeCql(scope: ConfluenceCqlScope): string {
  if (scope.spaceKeys.length === 0 && scope.pageIds.length === 0) {
    throw invalidRequest("At least one space or page is required");
  }
  for (const key of scope.spaceKeys) {
    if (key.length === 0) throw invalidRequest("Invalid Confluence space key");
  }
  for (const id of scope.pageIds) {
    if (!PAGE_ID.test(id)) throw invalidRequest("Invalid Confluence page id");
  }

  const parts: string[] = [];
  if (scope.spaceKeys.length > 0) {
    parts.push(`space in (${scope.spaceKeys.map(cqlString).join(", ")})`);
  }
  if (scope.pageIds.length > 0) {
    const ids = scope.pageIds.join(", ");
    parts.push(`ancestor in (${ids})`, `id in (${ids})`);
  }
  return `(${parts.join(" OR ")})`;
}

/** Builds a page search: always `type = page`, always the scope clause, then
 * the cleaned text term, then (only when given) a modification-date lower
 * bound as a `YYYY-MM-DD` literal. Relative date functions are never emitted.
 * A term with no searchable word left after cleaning is rejected rather than
 * dropped, so the query can never degrade to "everything in scope". */
export function buildSearchCql(input: {
  scope: ConfluenceCqlScope;
  text: string;
  updatedAfter?: string;
}): string {
  const scope = buildScopeCql(input.scope);
  const term = cqlTextTerm(input.text);
  if (term.length === 0) throw invalidRequest(NO_SEARCHABLE_WORDS);

  let cql = `type = page AND ${scope} AND text ~ ${cqlString(term)}`;
  if (input.updatedAfter !== undefined) {
    if (!DATE.test(input.updatedAfter)) {
      throw invalidRequest("Invalid modification date");
    }
    cql += ` AND lastmodified >= ${cqlString(input.updatedAfter)}`;
  }
  return cql;
}

/** Builds a title lookup for pages or spaces. */
export function buildTitleCql(type: "page" | "space", query: string): string {
  if (type !== "page" && type !== "space") {
    throw invalidRequest("Invalid Confluence content type");
  }
  const term = cqlTextTerm(query);
  if (term.length === 0) throw invalidRequest(NO_SEARCHABLE_WORDS);
  return `type = ${type} AND title ~ ${cqlString(term)}`;
}
