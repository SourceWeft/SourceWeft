import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorActionInput } from "@sourceweft/contracts";
import { createGithubConnectorAdapter, type GithubAdapterConfig } from "../src/adapter";
import { GithubAdapterError } from "../src/errors";
import { decodeSearchCursor, encodeSearchCursor } from "../src/scope";

/*
 * Task 5 live tools. The fake fetcher routes GitHub's REST search/item
 * endpoints and the GraphQL endpoint (resolve, discussion search, discussion
 * read) and records every call, so a test can assert both the provider query
 * (scope limited to the selected repositories) and that every returned record
 * is re-checked against the selection. `retryBaseMs: 0` keeps retry/throttle
 * back-offs out of real time, as Task 4's tests do.
 */

type RecordedCall = {
  url: string;
  pathname: string;
  method: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  operation: string | null;
};

type GraphqlBody = { query: string; variables: Record<string, unknown> };

type Handlers = {
  resolve?: (ids: string[], call: RecordedCall) => Response | Promise<Response>;
  searchIssues?: (q: string, perPage: number, page: number, call: RecordedCall) => Response | Promise<Response>;
  searchDiscussions?: (
    vars: { q: string; first: number; after: string | null },
    call: RecordedCall,
  ) => Response | Promise<Response>;
  getIssue?: (owner: string, repo: string, number: number, call: RecordedCall) => Response | Promise<Response>;
  getComments?: (owner: string, repo: string, number: number, call: RecordedCall) => Response | Promise<Response>;
  getPull?: (owner: string, repo: string, number: number, call: RecordedCall) => Response | Promise<Response>;
  getDiscussion?: (
    vars: { owner: string; repo: string; number: number; comments: number },
    call: RecordedCall,
  ) => Response | Promise<Response>;
};

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function operationName(query: string): string | null {
  if (query.includes("ResolveRepositories")) return "resolve";
  if (query.includes("SearchDiscussions")) return "searchDiscussions";
  if (query.includes("GetDiscussion")) return "getDiscussion";
  return null;
}

const ISSUE_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;
const COMMENTS_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/;
const PULL_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/;

function router(handlers: Handlers) {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call: RecordedCall = {
      url: url.toString(),
      pathname: url.pathname,
      method,
      query: url.searchParams,
      body,
      operation: null,
    };

    if (url.pathname === "/graphql" && method === "POST") {
      const graphqlBody = body as unknown as GraphqlBody;
      const operation = operationName(graphqlBody.query);
      call.operation = operation;
      calls.push(call);
      if (operation === "resolve") {
        if (!handlers.resolve) throw new Error("Unexpected resolve call");
        return handlers.resolve((graphqlBody.variables.ids as string[]) ?? [], call);
      }
      if (operation === "searchDiscussions") {
        if (!handlers.searchDiscussions) throw new Error("Unexpected searchDiscussions call");
        const vars = graphqlBody.variables as { q: string; first: number; after: string | null };
        return handlers.searchDiscussions(vars, call);
      }
      if (operation === "getDiscussion") {
        if (!handlers.getDiscussion) throw new Error("Unexpected getDiscussion call");
        const vars = graphqlBody.variables as { owner: string; repo: string; number: number; comments: number };
        return handlers.getDiscussion(vars, call);
      }
      throw new Error("Unexpected graphql operation");
    }

    calls.push(call);

    if (url.pathname === "/search/issues" && method === "GET") {
      if (!handlers.searchIssues) throw new Error("Unexpected searchIssues call");
      const q = url.searchParams.get("q") ?? "";
      const perPage = Number(url.searchParams.get("per_page") ?? "0");
      const page = Number(url.searchParams.get("page") ?? "1");
      return handlers.searchIssues(q, perPage, page, call);
    }

    const commentsMatch = COMMENTS_PATH.exec(url.pathname);
    if (commentsMatch && method === "GET") {
      if (!handlers.getComments) throw new Error("Unexpected comments call");
      return handlers.getComments(
        commentsMatch[1] as string,
        commentsMatch[2] as string,
        Number(commentsMatch[3]),
        call,
      );
    }

    const issueMatch = ISSUE_PATH.exec(url.pathname);
    if (issueMatch && method === "GET") {
      if (!handlers.getIssue) throw new Error("Unexpected getIssue call");
      return handlers.getIssue(
        issueMatch[1] as string,
        issueMatch[2] as string,
        Number(issueMatch[3]),
        call,
      );
    }

    const pullMatch = PULL_PATH.exec(url.pathname);
    if (pullMatch && method === "GET") {
      if (!handlers.getPull) throw new Error("Unexpected getPull call");
      return handlers.getPull(
        pullMatch[1] as string,
        pullMatch[2] as string,
        Number(pullMatch[3]),
        call,
      );
    }

    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;

  return { fetcher, calls };
}

function adapter(fetcher: typeof fetch, overrides: Partial<GithubAdapterConfig> = {}) {
  return createGithubConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "client-id",
    clientSecret: "client-secret",
    appSlug: "sourceweft-test",
    fetcher,
    retryBaseMs: 0,
    ...overrides,
  });
}

function actionInput(
  actionType: string,
  request: Record<string, unknown>,
  config: Record<string, unknown> = { items: [] },
): ConnectorActionInput {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "github",
    actionType,
    request,
    config,
    accessToken: "access-token",
    idempotencyKey: "idem-1",
  };
}

function selection(...ids: string[]): Record<string, unknown> {
  return { items: ids.map((id) => ({ id, kind: "repository" })) };
}

function repoNode(id: string, nameWithOwner: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    nameWithOwner,
    name: nameWithOwner.split("/")[1],
    url: `https://github.com/${nameWithOwner}`,
    description: null,
    isPrivate: false,
    isArchived: false,
    defaultBranchRef: { name: "main" },
    ...overrides,
  };
}

/** Answers a ResolveRepositories query from an id -> nameWithOwner map. */
function resolveFrom(map: Record<string, string | null>) {
  return (ids: string[]) =>
    json({
      data: {
        nodes: ids.map((id) => {
          const nameWithOwner = map[id];
          return nameWithOwner ? repoNode(id, nameWithOwner) : null;
        }),
      },
    });
}

function issueSearchRow(
  repositoryFullName: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    number: 1,
    title: "a title",
    state: "open",
    html_url: repositoryFullName
      ? `https://github.com/${repositoryFullName}/issues/1`
      : "https://github.com/unknown/issues/1",
    repository_url: repositoryFullName ? `https://api.github.com/repos/${repositoryFullName}` : null,
    user: { login: "octocat" },
    labels: [{ name: "bug" }],
    comments: 3,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function discussionNode(
  repositoryId: string | null,
  nameWithOwner: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    number: 7,
    title: "a discussion",
    url: nameWithOwner ? `https://github.com/${nameWithOwner}/discussions/7` : "https://github.com/x/discussions/7",
    body: "hello",
    createdAt: "2026-01-03T00:00:00Z",
    updatedAt: "2026-01-04T00:00:00Z",
    author: { login: "octocat" },
    repository: repositoryId ? { id: repositoryId, nameWithOwner } : null,
    comments: { totalCount: 2 },
    labels: { nodes: [{ name: "idea" }] },
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Guards
// --------------------------------------------------------------------------

test("empty selection is GITHUB_NOTHING_SELECTED without a request", async () => {
  const { fetcher, calls } = router({});
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(actionInput("github.items.search", { query: "bug" }, { items: [] })),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 409 &&
      error.code === "GITHUB_NOTHING_SELECTED",
  );
  assert.equal(calls.length, 0);
});

test("all selected repositories inaccessible is GITHUB_NOT_FOUND", async () => {
  const { fetcher, calls } = router({
    resolve: resolveFrom({ R_aa: null, R_bb: null }),
  });
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(actionInput("github.items.search", { query: "bug" }, selection("R_aa", "R_bb"))),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 404 &&
      error.code === "GITHUB_NOT_FOUND",
  );
  // Only the resolve request; no search request.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operation, "resolve");
});

// --------------------------------------------------------------------------
// Search
// --------------------------------------------------------------------------

test("issue search limits the query to the selected repositories", async () => {
  const recorded: string[] = [];
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one", R_bb: "acme/two" }),
    searchIssues: (q) => {
      recorded.push(q);
      return json({ total_count: 1, items: [issueSearchRow("acme/one")] });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.items.search", { query: "bug" }, selection("R_aa", "R_bb")),
  );

  assert.equal(recorded.length, 1);
  const q = recorded[0] as string;
  assert.match(q, /is:issue/);
  assert.match(q, /repo:acme\/one/);
  assert.match(q, /repo:acme\/two/);
  // The repo qualifiers are appended after the base query.
  assert.ok(q.endsWith("repo:acme/one repo:acme/two"), q);
  assert.deepEqual(result.result.searchedRepositories, ["acme/one", "acme/two"]);
  assert.deepEqual(result.result.skippedRepositories, []);
});

test("pull request search uses is:pr", async () => {
  const recorded: string[] = [];
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    searchIssues: (q) => {
      recorded.push(q);
      return json({
        total_count: 1,
        items: [issueSearchRow("acme/one", { pull_request: { url: "x" } })],
      });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.items.search", { query: "bug", type: "pull_request" }, selection("R_aa")),
  );

  assert.match(recorded[0] as string, /is:pr/);
  const items = result.result.items as Array<{ type: string }>;
  assert.equal(items[0]?.type, "pull_request");
});

test("state is appended", async () => {
  const recorded: string[] = [];
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    searchIssues: (q) => {
      recorded.push(q);
      return json({ total_count: 0, items: [] });
    },
  });
  const gh = adapter(fetcher);
  await gh.executeAction(
    actionInput("github.items.search", { query: "bug", state: "closed" }, selection("R_aa")),
  );
  assert.match(recorded[0] as string, /state:closed/);
});

test("results from other repositories are dropped", async () => {
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    searchIssues: () =>
      json({
        total_count: 2,
        items: [
          issueSearchRow("acme/one", { number: 1 }),
          issueSearchRow("evil/elsewhere", { number: 99 }),
        ],
      }),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.items.search", { query: "bug" }, selection("R_aa")),
  );
  const items = result.result.items as Array<{ number: number; repository: string }>;
  assert.deepEqual(items.map((item) => item.number), [1]);
  assert.equal(items[0]?.repository, "acme/one");
});

test("items whose repository cannot be determined are dropped", async () => {
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    searchIssues: () =>
      json({
        total_count: 2,
        items: [
          issueSearchRow("acme/one", { number: 1 }),
          // repository_url missing -> repository cannot be determined.
          issueSearchRow(null, { number: 2, repository_url: null }),
        ],
      }),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.items.search", { query: "bug" }, selection("R_aa")),
  );
  const items = result.result.items as Array<{ number: number }>;
  assert.deepEqual(items.map((item) => item.number), [1]);
});

test("repository parameter narrows to one repository", async () => {
  const recorded: string[] = [];
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one", R_bb: "acme/two" }),
    searchIssues: (q) => {
      recorded.push(q);
      return json({ total_count: 1, items: [issueSearchRow("acme/two")] });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.items.search", { query: "bug", repository: "acme/two" }, selection("R_aa", "R_bb")),
  );
  assert.equal(recorded.length, 1);
  const q = recorded[0] as string;
  assert.match(q, /repo:acme\/two/);
  assert.doesNotMatch(q, /repo:acme\/one/);
  assert.deepEqual(result.result.searchedRepositories, ["acme/two"]);
});

test("repository outside the selection is GITHUB_NOT_FOUND without a search request", async () => {
  const { fetcher, calls } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
  });
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(
      actionInput("github.items.search", { query: "bug", repository: "acme/other" }, selection("R_aa")),
    ),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 404 &&
      error.code === "GITHUB_NOT_FOUND",
  );
  assert.equal(calls.some((call) => call.pathname === "/search/issues"), false);
});

test("query with repo: is rejected without a request", async () => {
  const { fetcher, calls } = router({});
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(
      actionInput("github.items.search", { query: "bug repo:acme/one" }, selection("R_aa")),
    ),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 400 &&
      error.code === "GITHUB_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("many repositories are searched in at most five requests and merged round robin", async () => {
  // Long names so the packer fits two repositories per 256-char query and makes
  // two provider queries, letting the round-robin merge interleave the batches.
  const owner = "acme";
  const name = (n: number) => `${owner}/${"x".repeat(95)}${n}`;
  const ids = ["R_01", "R_02", "R_03", "R_04"];
  const map: Record<string, string> = {};
  ids.forEach((id, index) => {
    map[id] = name(index);
  });

  const searchQs: string[] = [];
  const { fetcher, calls } = router({
    resolve: resolveFrom(map),
    searchIssues: (q) => {
      const index = searchQs.length;
      searchQs.push(q);
      // Each batch returns two items tagged by batch so ordering is visible.
      const repoInBatch = Object.values(map).find((full) => q.includes(`repo:${full}`)) as string;
      return json({
        total_count: 2,
        items: [
          issueSearchRow(repoInBatch, { number: index * 10 + 1 }),
          issueSearchRow(repoInBatch, { number: index * 10 + 2 }),
        ],
      });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.items.search", { query: "bug" }, selection(...ids)),
  );

  const searchCalls = calls.filter((call) => call.pathname === "/search/issues");
  assert.ok(searchCalls.length >= 2, `expected multiple queries, got ${searchCalls.length}`);
  assert.ok(searchCalls.length <= 5, `expected at most five, got ${searchCalls.length}`);
  const numbers = (result.result.items as Array<{ number: number }>).map((item) => item.number);
  // Round robin: first item of each batch, then second item of each batch.
  assert.deepEqual(numbers, [1, 11, 2, 12]);
});

test("repositories that do not fit are reported as skipped", async () => {
  const longName = `acme/${"x".repeat(260)}`;
  const { fetcher } = router({
    resolve: resolveFrom({ R_short: "acme/one", R_long: longName }),
    searchIssues: () => json({ total_count: 1, items: [issueSearchRow("acme/one")] }),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.items.search", { query: "bug" }, selection("R_short", "R_long")),
  );
  assert.deepEqual(result.result.searchedRepositories, ["acme/one"]);
  assert.deepEqual(result.result.skippedRepositories, [longName]);
});

test("renamed repository is searched under its current name", async () => {
  const recorded: string[] = [];
  const { fetcher } = router({
    // The node id now resolves to a new owner/name after a rename.
    resolve: resolveFrom({ R_aa: "new-owner/new-name" }),
    searchIssues: (q) => {
      recorded.push(q);
      return json({ total_count: 1, items: [issueSearchRow("new-owner/new-name")] });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.items.search", { query: "bug" }, selection("R_aa")),
  );
  assert.match(recorded[0] as string, /repo:new-owner\/new-name/);
  assert.deepEqual(result.result.searchedRepositories, ["new-owner/new-name"]);
});

test("next cursor advances the page and stops at 1,000 results", async () => {
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    searchIssues: (_q, _perPage, page) =>
      json({ total_count: 5000, items: [issueSearchRow("acme/one", { number: page })] }),
  });
  const gh = adapter(fetcher);

  const first = await gh.executeAction(
    actionInput("github.items.search", { query: "bug" }, selection("R_aa")),
  );
  const nextCursor = first.result.nextCursor as string;
  assert.ok(typeof nextCursor === "string" && nextCursor.length > 0);
  assert.deepEqual(decodeSearchCursor(nextCursor), { page: 2, after: undefined });

  // page 50 with perPage 20 reaches exactly 1,000 results -> no further page.
  const atCeiling = await gh.executeAction(
    actionInput(
      "github.items.search",
      { query: "bug", cursor: encodeSearchCursor({ page: 50 }) },
      selection("R_aa"),
    ),
  );
  assert.equal(atCeiling.result.nextCursor, null);
});

test("discussion search checks the repository node id and carries per-query cursors", async () => {
  // Two long names so the packer makes two discussion queries (one repo each).
  const nameA = `acme/${"a".repeat(120)}`;
  const nameB = `acme/${"b".repeat(120)}`;
  const recorded: Array<{ q: string; after: string | null }> = [];
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: nameA, R_bb: nameB }),
    searchDiscussions: (vars) => {
      recorded.push({ q: vars.q, after: vars.after });
      const inA = vars.q.includes(`repo:${nameA}`);
      const node = inA
        ? discussionNode("R_aa", nameA, { number: 1 })
        : discussionNode("R_bb", nameB, { number: 2 });
      // Also return one node from a repository outside the selection.
      const foreign = discussionNode("R_evil", "evil/elsewhere", { number: 99 });
      return json({
        data: {
          search: {
            pageInfo: { endCursor: inA ? "curA" : "curB", hasNextPage: true },
            nodes: [node, foreign],
          },
        },
      });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.items.search", { query: "bug", type: "discussion" }, selection("R_aa", "R_bb")),
  );

  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded.map((entry) => entry.after), [null, null]);
  const items = result.result.items as Array<{ type: string; number: number; repository: string }>;
  // The foreign-repository node (99) is filtered out by node id; the two in
  // scope are merged round robin.
  assert.deepEqual(items.map((item) => item.number).sort(), [1, 2]);
  assert.ok(items.every((item) => item.type === "discussion"));
  // nextCursor carries each query's endCursor.
  const decoded = decodeSearchCursor(result.result.nextCursor as string);
  assert.deepEqual(decoded?.after, ["curA", "curB"]);

  // Continuation with one query's after set to null skips that query.
  const recorded2: Array<{ q: string; after: string | null }> = [];
  const { fetcher: fetcher2 } = router({
    resolve: resolveFrom({ R_aa: nameA, R_bb: nameB }),
    searchDiscussions: (vars) => {
      recorded2.push({ q: vars.q, after: vars.after });
      return json({
        data: {
          search: {
            pageInfo: { endCursor: "curA2", hasNextPage: false },
            nodes: [discussionNode("R_aa", nameA, { number: 1 })],
          },
        },
      });
    },
  });
  const gh2 = adapter(fetcher2);
  const continued = await gh2.executeAction(
    actionInput(
      "github.items.search",
      { query: "bug", type: "discussion", cursor: encodeSearchCursor({ after: ["curA", null] }) },
      selection("R_aa", "R_bb"),
    ),
  );
  assert.equal(recorded2.length, 1);
  assert.equal(recorded2[0]?.after, "curA");
  // Both queries end null -> nextCursor is null.
  assert.equal(continued.result.nextCursor, null);
});

test("state with discussion is rejected", async () => {
  const { fetcher, calls } = router({});
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(
      actionInput(
        "github.items.search",
        { query: "bug", type: "discussion", state: "open" },
        selection("R_aa"),
      ),
    ),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 400 &&
      error.code === "GITHUB_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("rate limit surfaces GITHUB_RATE_LIMITED with details.retryAfterSeconds", async () => {
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    searchIssues: () =>
      json({ message: "rate limited" }, 429, { "retry-after": "30" }),
  });
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(actionInput("github.items.search", { query: "bug" }, selection("R_aa"))),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 429 &&
      error.code === "GITHUB_RATE_LIMITED" &&
      error.details?.retryAfterSeconds === 30,
  );
});

// --------------------------------------------------------------------------
// Read
// --------------------------------------------------------------------------

function issueResponse(repositoryFullName: string, overrides: Record<string, unknown> = {}) {
  return {
    number: 5,
    title: "an issue",
    state: "open",
    html_url: `https://github.com/${repositoryFullName}/issues/5`,
    repository_url: `https://api.github.com/repos/${repositoryFullName}`,
    user: { login: "octocat" },
    labels: [{ name: "bug" }, { name: "help wanted" }],
    assignees: [{ login: "maintainer" }],
    comments: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    body: "the issue body",
    ...overrides,
  };
}

function commentRow(body: string, overrides: Record<string, unknown> = {}) {
  return {
    user: { login: "commenter" },
    body,
    created_at: "2026-01-03T00:00:00Z",
    html_url: "https://github.com/acme/one/issues/5#comment-1",
    ...overrides,
  };
}

test("issue returns body, labels and the earliest 20 comments with the total", async () => {
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    getIssue: () => json(issueResponse("acme/one", { comments: 25 })),
    getComments: (_owner, _repo, _number, call) => {
      assert.equal(call.query.get("per_page"), "20");
      return json(Array.from({ length: 20 }, (_, i) => commentRow(`comment ${i}`)));
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.item.read", { repository: "acme/one", number: 5, type: "issue" }, selection("R_aa")),
  );
  const r = result.result;
  assert.equal(r.type, "issue");
  assert.equal(r.repository, "acme/one");
  assert.equal(r.body, "the issue body");
  assert.equal(r.bodyTruncated, false);
  assert.deepEqual(r.labels, ["bug", "help wanted"]);
  assert.deepEqual(r.assignees, ["maintainer"]);
  assert.equal((r.comments as unknown[]).length, 20);
  assert.equal(r.commentCount, 25);
  assert.equal(r.commentsTruncated, true);
  assert.equal(r.pullRequest, undefined);
});

test("body over 20,000 chars is cut and flagged", async () => {
  const body = "b".repeat(20_050);
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    getIssue: () => json(issueResponse("acme/one", { body })),
    getComments: () => json([]),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.item.read", { repository: "acme/one", number: 5, type: "issue" }, selection("R_aa")),
  );
  assert.equal((result.result.body as string).length, 20_000);
  assert.equal(result.result.bodyTruncated, true);
});

test("comment over 4,000 chars is cut and flagged", async () => {
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    getIssue: () => json(issueResponse("acme/one")),
    getComments: () => json([commentRow("c".repeat(4_050)), commentRow("short")]),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.item.read", { repository: "acme/one", number: 5, type: "issue" }, selection("R_aa")),
  );
  const comments = result.result.comments as Array<{ body: string; truncated: boolean }>;
  assert.equal(comments[0]?.body.length, 4_000);
  assert.equal(comments[0]?.truncated, true);
  assert.equal(comments[1]?.truncated, false);
});

test("pull request adds merge state and branches and no diff", async () => {
  const { fetcher, calls } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    getIssue: () => json(issueResponse("acme/one", { pull_request: { url: "x" } })),
    getComments: () => json([]),
    getPull: () =>
      json({
        ...issueResponse("acme/one"),
        merged: true,
        draft: false,
        base: { ref: "main" },
        head: { ref: "feature" },
        changed_files: 4,
        additions: 100,
        deletions: 20,
      }),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.item.read", { repository: "acme/one", number: 5, type: "pull_request" }, selection("R_aa")),
  );
  assert.equal(result.result.type, "pull_request");
  assert.deepEqual(result.result.pullRequest, {
    merged: true,
    draft: false,
    baseBranch: "main",
    headBranch: "feature",
    changedFiles: 4,
    additions: 100,
    deletions: 20,
  });
  // No diff/file-content endpoint was requested.
  assert.equal(calls.some((call) => call.pathname.includes("/files")), false);
});

test("discussion is read through GraphQL", async () => {
  const { fetcher, calls } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    getDiscussion: (vars) => {
      assert.equal(vars.owner, "acme");
      assert.equal(vars.repo, "one");
      assert.equal(vars.number, 7);
      assert.equal(vars.comments, 20);
      return json({
        data: {
          repository: {
            discussion: {
              number: 7,
              title: "a discussion",
              url: "https://github.com/acme/one/discussions/7",
              body: "discussion body",
              createdAt: "2026-01-03T00:00:00Z",
              updatedAt: "2026-01-04T00:00:00Z",
              author: { login: "octocat" },
              labels: { nodes: [{ name: "idea" }] },
              comments: {
                totalCount: 1,
                nodes: [
                  {
                    body: "a reply",
                    createdAt: "2026-01-05T00:00:00Z",
                    url: "https://github.com/acme/one/discussions/7#c1",
                    author: { login: "replier" },
                  },
                ],
              },
            },
          },
        },
      });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.item.read", { repository: "acme/one", number: 7, type: "discussion" }, selection("R_aa")),
  );
  assert.equal(result.result.type, "discussion");
  assert.equal(result.result.body, "discussion body");
  assert.deepEqual(result.result.labels, ["idea"]);
  assert.equal((result.result.comments as unknown[]).length, 1);
  assert.equal(result.result.commentCount, 1);
  // No REST issue endpoint was used for the discussion.
  assert.equal(calls.some((call) => call.pathname.startsWith("/repos/")), false);
});

test("repository outside the selection is GITHUB_NOT_FOUND without an item request", async () => {
  const { fetcher, calls } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
  });
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(
      actionInput("github.item.read", { repository: "acme/other", number: 5, type: "issue" }, selection("R_aa")),
    ),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 404 &&
      error.code === "GITHUB_NOT_FOUND",
  );
  assert.equal(calls.some((call) => call.pathname.startsWith("/repos/")), false);
});

test("item answered from another repository is GITHUB_NOT_FOUND", async () => {
  const { fetcher, calls } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    // A rename redirect: the issue is answered from a different repository.
    getIssue: () => json(issueResponse("other-owner/other-repo")),
    getComments: () => json([]),
  });
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(
      actionInput("github.item.read", { repository: "acme/one", number: 5, type: "issue" }, selection("R_aa")),
    ),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 404 &&
      error.code === "GITHUB_NOT_FOUND",
  );
  // The mismatch is caught after the issue fetch, before comments are fetched.
  assert.equal(calls.some((call) => call.pathname.endsWith("/comments")), false);
});

test("missing item is GITHUB_NOT_FOUND", async () => {
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    getIssue: () => json({ message: "Not Found" }, 404),
  });
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(
      actionInput("github.item.read", { repository: "acme/one", number: 5, type: "issue" }, selection("R_aa")),
    ),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 404 &&
      error.code === "GITHUB_NOT_FOUND",
  );
});

// --------------------------------------------------------------------------
// List
// --------------------------------------------------------------------------

test("lists selected repositories and counts unavailable ones", async () => {
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one", R_gone: null, R_bb: "acme/two" }),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.repositories.list", {}, selection("R_aa", "R_gone", "R_bb")),
  );
  assert.equal(result.result.unavailableCount, 1);
  const repositories = result.result.repositories as Array<{ name: string; visibility: string; defaultBranch: string }>;
  assert.deepEqual(repositories.map((repo) => repo.name), ["acme/one", "acme/two"]);
  assert.ok(repositories.every((repo) => repo.visibility === "public"));
  assert.ok(repositories.every((repo) => repo.defaultBranch === "main"));
});

// --------------------------------------------------------------------------
// Secret hygiene
// --------------------------------------------------------------------------

test("results never contain the access token", async () => {
  const token = "ghs_SUPERSECRETTOKENvalue0123456789abcd";
  const { fetcher } = router({
    resolve: resolveFrom({ R_aa: "acme/one" }),
    searchIssues: () => json({ total_count: 1, items: [issueSearchRow("acme/one")] }),
    getIssue: () => json(issueResponse("acme/one")),
    getComments: () => json([commentRow("hello")]),
  });
  const gh = adapter(fetcher);

  const search = await gh.executeAction({
    ...actionInput("github.items.search", { query: "bug" }, selection("R_aa")),
    accessToken: token,
  });
  const read = await gh.executeAction({
    ...actionInput("github.item.read", { repository: "acme/one", number: 5, type: "issue" }, selection("R_aa")),
    accessToken: token,
  });
  const list = await gh.executeAction({
    ...actionInput("github.repositories.list", {}, selection("R_aa")),
    accessToken: token,
  });

  for (const result of [search.result, read.result, list.result]) {
    assert.ok(!JSON.stringify(result).includes(token));
  }
});
