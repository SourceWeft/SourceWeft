import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "@sourceweft/atlassian-client";
import { buildIssueJql, jqlString, jqlTextTerm, type JqlInput } from "../src/jql";

function input(overrides: Partial<JqlInput> = {}): JqlInput {
  return { projectIds: ["10000"], ...overrides };
}

test("scope clause comes first and ids are unquoted", () => {
  const jql = buildIssueJql({ projectIds: ["10000", "10001"] });
  assert.equal(jql, "project in (10000, 10001) ORDER BY updated DESC");
});

test("every optional clause in order", () => {
  const jql = buildIssueJql({
    projectIds: ["10000"],
    projectKeys: ["ABC", "DEF"],
    text: "release notes",
    status: "Open",
    issueType: "Bug",
    assignee: { kind: "accounts", accountIds: ["acc-1", "acc-2"] },
    updatedWithinDays: 7,
    orderBy: "created",
  });
  assert.equal(
    jql,
    [
      "project in (10000)",
      'project in ("ABC", "DEF")',
      'text ~ "release notes"',
      'status = "Open"',
      'issuetype = "Bug"',
      'assignee in ("acc-1", "acc-2")',
      "updated >= -7d",
    ].join(" AND ") + " ORDER BY created DESC",
  );
});

test("default order is updated desc", () => {
  const jql = buildIssueJql(input());
  assert.equal(jql, "project in (10000) ORDER BY updated DESC");
  assert.ok(jql.endsWith("ORDER BY updated DESC"));
});

test("me uses currentUser()", () => {
  const jql = buildIssueJql(input({ assignee: { kind: "me" } }));
  assert.equal(
    jql,
    "project in (10000) AND assignee = currentUser() ORDER BY updated DESC",
  );
});

test("empty account list matches nothing", () => {
  const jql = buildIssueJql(
    input({ assignee: { kind: "accounts", accountIds: [] } }),
  );
  assert.equal(
    jql,
    "project in (10000) AND assignee is EMPTY AND assignee is not EMPTY ORDER BY updated DESC",
  );
});

test("non-numeric project id is rejected", () => {
  assert.throws(
    () => buildIssueJql({ projectIds: ["abc"] }),
    (error) => {
      assert.ok(error instanceof AtlassianApiError);
      assert.equal(error.code, "JIRA_INVALID_REQUEST");
      return true;
    },
  );
});

test("empty project id list is rejected", () => {
  assert.throws(
    () => buildIssueJql({ projectIds: [] }),
    (error) => {
      assert.ok(error instanceof AtlassianApiError);
      assert.equal(error.code, "JIRA_INVALID_REQUEST");
      return true;
    },
  );
});

test("blank text adds no clause", () => {
  const jql = buildIssueJql(input({ text: "   " }));
  assert.equal(jql, "project in (10000) ORDER BY updated DESC");
});

const INJECTION_PAYLOADS = [
  '") OR project = SECRET OR ("',
  'foo" OR text ~ "bar',
  "a) OR (b",
  'x\\" OR 1=1',
];

for (const payload of INJECTION_PAYLOADS) {
  test(`jql builders neutralise injection via text (${payload})`, () => {
    const jql = buildIssueJql(input({ text: payload }));
    assert.ok(jql.startsWith("project in (10000) AND "));
    assertExactlyOneQuotedClause(jql);
    assertNoInjectionChars(jqlTextTerm(payload));
  });

  test(`jql builders neutralise injection via status (${payload})`, () => {
    const jql = buildIssueJql(input({ status: payload }));
    assert.ok(jql.startsWith("project in (10000) AND "));
    assertExactlyOneQuotedClause(jql);
  });

  test(`jql builders neutralise injection via issueType (${payload})`, () => {
    const jql = buildIssueJql(input({ issueType: payload }));
    assert.ok(jql.startsWith("project in (10000) AND "));
    assertExactlyOneQuotedClause(jql);
  });
}

/** Exactly one unescaped opening quote (and therefore exactly one closing
 * quote) means the payload produced a single well-formed string literal —
 * it could not inject an extra clause or an extra quoted literal. */
function assertExactlyOneQuotedClause(jql: string): void {
  const unescapedQuotes = jql.match(/(?<!\\)"/g) ?? [];
  assert.equal(unescapedQuotes.length, 2);
}

function assertNoInjectionChars(term: string): void {
  for (const char of ['"', "(", ")", "\\"]) {
    assert.ok(!term.includes(char), `jqlTextTerm output must not contain ${char}`);
  }
}

test("jqlString escapes backslashes before quotes", () => {
  assert.equal(jqlString('a\\b"c'), '"a\\\\b\\"c"');
});

test("jqlTextTerm collapses whitespace and strips JQL-significant characters", () => {
  assert.equal(jqlTextTerm('  foo   "bar" (baz)  '), "foo bar baz");
});
