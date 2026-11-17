import assert from "node:assert/strict";
import test from "node:test";
import { GithubAdapterError } from "../src/errors";
import {
  assertAgentQuery,
  buildBaseQuery,
  decodeSearchCursor,
  encodeSearchCursor,
  mergeRoundRobin,
  packRepositoryQueries,
  parseGithubSelection,
  repositoryNameFromApiUrl,
  truncateText,
} from "../src/scope";

function assertGithubError(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof GithubAdapterError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, code);
      return true;
    },
  );
}

test("selection rejects duplicates, bad ids, wrong kind and 21 items", () => {
  assertGithubError(
    () =>
      parseGithubSelection({
        items: [
          { id: "R_kgDOAbCdEf", kind: "repository" },
          { id: "R_kgDOAbCdEf", kind: "repository" },
        ],
      }),
    "GITHUB_INVALID_SELECTION",
  );

  assertGithubError(
    () =>
      parseGithubSelection({
        items: [{ id: "not valid!", kind: "repository" }],
      }),
    "GITHUB_INVALID_SELECTION",
  );

  assertGithubError(
    () =>
      parseGithubSelection({
        items: [{ id: "R_kgDOAbCdEf", kind: "account" }],
      }),
    "GITHUB_INVALID_SELECTION",
  );

  const twentyOne = Array.from({ length: 21 }, (_, index) => ({
    id: `R_kgDOAbCdE${index}`,
    kind: "repository",
  }));
  assertGithubError(
    () => parseGithubSelection({ items: twentyOne }),
    "GITHUB_INVALID_SELECTION",
  );
});

test("missing items is an empty selection", () => {
  assert.deepEqual(parseGithubSelection({}), []);
});

test("legacy and new node ids are accepted", () => {
  const result = parseGithubSelection({
    items: [
      { id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5", kind: "repository" },
      { id: "R_kgDOAbCdEf", kind: "repository" },
    ],
  });
  assert.deepEqual(result, [
    { id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5", kind: "repository" },
    { id: "R_kgDOAbCdEf", kind: "repository" },
  ]);
});

test("scope qualifiers are rejected in any case and position", () => {
  for (const query of [
    "REPO:a/b bug",
    "bug -repo:a/b",
    "crash org:acme",
    "user:me fix",
    "owner:x",
  ]) {
    assertGithubError(() => assertAgentQuery(query), "GITHUB_INVALID_REQUEST");
  }
});

test("ordinary colons pass", () => {
  assert.equal(assertAgentQuery("error: timeout"), "error: timeout");
  assert.equal(assertAgentQuery("fix: login"), "fix: login");
});

test("query of 121 chars is rejected", () => {
  const tooLong = "a".repeat(121);
  assertGithubError(
    () => assertAgentQuery(tooLong),
    "GITHUB_INVALID_REQUEST",
  );
  const justRight = "a".repeat(120);
  assert.equal(assertAgentQuery(justRight), justRight);
});

test("base query adds is:issue, is:pr or nothing, and state", () => {
  assert.equal(
    buildBaseQuery({ query: "crash", kind: "issue" }),
    "crash is:issue",
  );
  assert.equal(
    buildBaseQuery({ query: "crash", kind: "pull_request" }),
    "crash is:pr",
  );
  assert.equal(
    buildBaseQuery({ query: "crash", kind: "discussion" }),
    "crash",
  );
  assert.equal(
    buildBaseQuery({ query: "crash", kind: "issue", state: "open" }),
    "crash is:issue state:open",
  );
  assert.equal(
    buildBaseQuery({ query: "crash", kind: "pull_request", state: "closed" }),
    "crash is:pr state:closed",
  );
});

test("packing never exceeds 256 chars", () => {
  const repositories = Array.from(
    { length: 20 },
    (_, index) =>
      `organization-number-${index}/repository-with-a-long-name-${index}`,
  );
  const base = "a".repeat(120);

  const { queries, skipped } = packRepositoryQueries(base, repositories);

  assert.ok(queries.length <= 5);
  for (const { q } of queries) {
    assert.ok(q.length <= 256);
  }

  const coveredRepositories = [
    ...queries.flatMap((query) => query.repositories),
    ...skipped,
  ];
  assert.deepEqual([...coveredRepositories].sort(), [...repositories].sort());
  assert.equal(coveredRepositories.length, repositories.length);
  assert.equal(new Set(coveredRepositories).size, repositories.length);
});

test("a single short selection is one query", () => {
  const { queries, skipped } = packRepositoryQueries("crash is:issue", [
    "acme/widgets",
  ]);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0], {
    q: "crash is:issue repo:acme/widgets",
    repositories: ["acme/widgets"],
  });
  assert.deepEqual(skipped, []);
});

test("round robin interleaves and stops at the limit", () => {
  const result = mergeRoundRobin(
    [["a1", "a2", "a3"], ["b1"], ["c1", "c2"]],
    5,
  );
  assert.deepEqual(result, ["a1", "b1", "c1", "a2", "c2"]);
});

test("cursor round-trips and rejects garbage", () => {
  const value = { page: 3, after: ["x", null, "y"] };
  const encoded = encodeSearchCursor(value);
  assert.deepEqual(decodeSearchCursor(encoded), value);

  assert.equal(decodeSearchCursor(undefined), null);

  assertGithubError(
    () => decodeSearchCursor("not-valid-base64url-json"),
    "GITHUB_INVALID_REQUEST",
  );
  assertGithubError(
    () => decodeSearchCursor(encodeSearchCursor({ page: 1 })),
    "GITHUB_INVALID_REQUEST",
  );
  assertGithubError(
    () => decodeSearchCursor(encodeSearchCursor({ page: 101 })),
    "GITHUB_INVALID_REQUEST",
  );
  assertGithubError(
    () =>
      decodeSearchCursor(
        encodeSearchCursor({ after: ["a", "b", "c", "d", "e", "f"] }),
      ),
    "GITHUB_INVALID_REQUEST",
  );
});

test("truncateText cuts at the limit and flags it", () => {
  assert.deepEqual(truncateText("abcdef", 4), {
    text: "abcd",
    truncated: true,
  });
  assert.deepEqual(truncateText("abc", 4), { text: "abc", truncated: false });
  assert.deepEqual(truncateText(null, 4), { text: "", truncated: false });
  assert.deepEqual(truncateText(undefined, 4), {
    text: "",
    truncated: false,
  });
});

test("repositoryNameFromApiUrl rejects other hosts", () => {
  assert.equal(
    repositoryNameFromApiUrl("https://api.github.com/repos/acme/widgets"),
    "acme/widgets",
  );
  assert.equal(
    repositoryNameFromApiUrl("https://evil.example.com/repos/acme/widgets"),
    null,
  );
  assert.equal(
    repositoryNameFromApiUrl("https://api.github.com/repos/acme"),
    null,
  );
  assert.equal(
    repositoryNameFromApiUrl("http://api.github.com/repos/acme/widgets"),
    null,
  );
});
