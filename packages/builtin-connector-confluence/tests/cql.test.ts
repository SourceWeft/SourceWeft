import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "@sourceweft/atlassian-client";
import {
  buildScopeCql,
  buildSearchCql,
  buildTitleCql,
  cqlString,
  cqlTextTerm,
} from "../src/cql";

function assertInvalid(run: () => unknown, message?: string): void {
  assert.throws(run, (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONFLUENCE_INVALID_REQUEST");
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

test("scope with spaces only", () => {
  assert.equal(
    buildScopeCql({ spaceKeys: ["ENG", "DOCS"], pageIds: [] }),
    '(space in ("ENG", "DOCS"))',
  );
});

test("scope with pages only covers the pages and their descendants", () => {
  assert.equal(
    buildScopeCql({ spaceKeys: [], pageIds: ["123", "456"] }),
    "(ancestor in (123, 456) OR id in (123, 456))",
  );
});

test("scope with spaces and pages joins the parts with OR", () => {
  assert.equal(
    buildScopeCql({ spaceKeys: ["ENG"], pageIds: ["123"] }),
    '(space in ("ENG") OR ancestor in (123) OR id in (123))',
  );
});

test("an empty scope is rejected", () => {
  assertInvalid(() => buildScopeCql({ spaceKeys: [], pageIds: [] }));
});

test("a non-numeric page id is rejected", () => {
  for (const id of ["abc", "12 OR id = 1", "", "1".repeat(21), "12)", "-5"]) {
    assertInvalid(() => buildScopeCql({ spaceKeys: [], pageIds: [id] }));
  }
});

test("an empty space key is rejected", () => {
  assertInvalid(() => buildScopeCql({ spaceKeys: [""], pageIds: [] }));
});

test("search adds the text clause after the scope", () => {
  assert.equal(
    buildSearchCql({
      scope: { spaceKeys: ["ENG"], pageIds: [] },
      text: "release notes",
    }),
    'type = page AND (space in ("ENG")) AND text ~ "release notes"',
  );
});

test("search adds the date clause last and never uses now()", () => {
  const cql = buildSearchCql({
    scope: { spaceKeys: ["ENG"], pageIds: ["7"] },
    text: "plan",
    updatedAfter: "2026-11-12",
  });
  assert.equal(
    cql,
    'type = page AND (space in ("ENG") OR ancestor in (7) OR id in (7)) AND text ~ "plan" AND lastmodified >= "2026-11-12"',
  );
  assert.ok(!cql.includes("now("));
});

test("search rejects a malformed updatedAfter", () => {
  for (const value of ["2026-1-2", "now()", "2026-11-12 00:00", '2026-11-12" OR space = X', "-7d"]) {
    assertInvalid(() =>
      buildSearchCql({
        scope: { spaceKeys: ["ENG"], pageIds: [] },
        text: "plan",
        updatedAfter: value,
      }),
    );
  }
});

test("search rejects blank and punctuation-only text", () => {
  for (const text of ["", "   ", '"()"', "+-*?", "\\"]) {
    assertInvalid(
      () => buildSearchCql({ scope: { spaceKeys: ["ENG"], pageIds: [] }, text }),
      "The search text has no searchable words.",
    );
  }
});

test("search rejects an empty scope", () => {
  assertInvalid(() =>
    buildSearchCql({ scope: { spaceKeys: [], pageIds: [] }, text: "plan" }),
  );
});

test("title query for pages and spaces", () => {
  assert.equal(buildTitleCql("page", "Roadmap"), 'type = page AND title ~ "Roadmap"');
  assert.equal(buildTitleCql("space", "Eng"), 'type = space AND title ~ "Eng"');
});

test("title query with no searchable words is rejected", () => {
  assertInvalid(
    () => buildTitleCql("page", "  ()  "),
    "The search text has no searchable words.",
  );
});

// Exact expected CQL for each injection payload, so an implementation that
// escapes quotes but not backslashes fails rather than merely counting quotes.
const INJECTION_CASES = [
  {
    payload: '") OR space = SECRET OR ("',
    text: 'type = page AND (space in ("ENG")) AND text ~ "OR space = SECRET OR"',
    key: '(space in ("\\") OR space = SECRET OR (\\""))',
    title: 'type = page AND title ~ "OR space = SECRET OR"',
  },
  {
    payload: 'foo" OR text ~ "bar',
    text: 'type = page AND (space in ("ENG")) AND text ~ "foo OR text bar"',
    key: '(space in ("foo\\" OR text ~ \\"bar"))',
    title: 'type = page AND title ~ "foo OR text bar"',
  },
  {
    payload: "a) OR (b",
    text: 'type = page AND (space in ("ENG")) AND text ~ "a OR b"',
    key: '(space in ("a) OR (b"))',
    title: 'type = page AND title ~ "a OR b"',
  },
  {
    payload: "trailing\\",
    text: 'type = page AND (space in ("ENG")) AND text ~ "trailing"',
    key: '(space in ("trailing\\\\"))',
    title: 'type = page AND title ~ "trailing"',
  },
];

for (const { payload, text, key, title } of INJECTION_CASES) {
  test(`text injection lands in one string literal (${payload})`, () => {
    assert.equal(
      buildSearchCql({ scope: { spaceKeys: ["ENG"], pageIds: [] }, text: payload }),
      text,
    );
  });

  test(`space key injection lands in one string literal (${payload})`, () => {
    assert.equal(buildScopeCql({ spaceKeys: [payload], pageIds: [] }), key);
  });

  test(`title injection lands in one string literal (${payload})`, () => {
    assert.equal(buildTitleCql("page", payload), title);
  });
}

test("cqlString escapes backslashes before quotes", () => {
  assert.equal(cqlString('a\\b"c'), '"a\\\\b\\"c"');
});

test("cqlTextTerm collapses whitespace and strips CQL-significant characters", () => {
  assert.equal(cqlTextTerm('  foo   "bar" (baz)  '), "foo bar baz");
});
