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

// Exact expected JQL for each injection payload, so an implementation that
// escapes quotes but not backslashes (see the backslash payload) fails rather
// than merely counting quotes. `String.raw` keeps the backslashes literal.
const INJECTION_CASES = [
  {
    payload: String.raw`") OR project = SECRET OR ("`,
    text: String.raw`project in (10000) AND text ~ "OR project = SECRET OR" ORDER BY updated DESC`,
    status: String.raw`project in (10000) AND status = "\") OR project = SECRET OR (\"" ORDER BY updated DESC`,
    issueType: String.raw`project in (10000) AND issuetype = "\") OR project = SECRET OR (\"" ORDER BY updated DESC`,
  },
  {
    payload: String.raw`foo" OR text ~ "bar`,
    text: String.raw`project in (10000) AND text ~ "foo OR text bar" ORDER BY updated DESC`,
    status: String.raw`project in (10000) AND status = "foo\" OR text ~ \"bar" ORDER BY updated DESC`,
    issueType: String.raw`project in (10000) AND issuetype = "foo\" OR text ~ \"bar" ORDER BY updated DESC`,
  },
  {
    payload: String.raw`a) OR (b`,
    text: String.raw`project in (10000) AND text ~ "a OR b" ORDER BY updated DESC`,
    status: String.raw`project in (10000) AND status = "a) OR (b" ORDER BY updated DESC`,
    issueType: String.raw`project in (10000) AND issuetype = "a) OR (b" ORDER BY updated DESC`,
  },
  {
    payload: String.raw`x\" OR 1=1`,
    text: String.raw`project in (10000) AND text ~ "x OR 1=1" ORDER BY updated DESC`,
    status: String.raw`project in (10000) AND status = "x\\\" OR 1=1" ORDER BY updated DESC`,
    issueType: String.raw`project in (10000) AND issuetype = "x\\\" OR 1=1" ORDER BY updated DESC`,
  },
];

for (const { payload, text, status, issueType } of INJECTION_CASES) {
  test(`text injection lands in one string literal (${payload})`, () => {
    assert.equal(buildIssueJql(input({ text: payload })), text);
  });

  test(`status injection lands in one string literal (${payload})`, () => {
    assert.equal(buildIssueJql(input({ status: payload })), status);
  });

  test(`issueType injection lands in one string literal (${payload})`, () => {
    assert.equal(buildIssueJql(input({ issueType: payload })), issueType);
  });
}

test("jqlString escapes backslashes before quotes", () => {
  assert.equal(jqlString('a\\b"c'), '"a\\\\b\\"c"');
});

test("jqlTextTerm collapses whitespace and strips JQL-significant characters", () => {
  assert.equal(jqlTextTerm('  foo   "bar" (baz)  '), "foo bar baz");
});
