import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorActionInput } from "@sourceweft/contracts";
import { ISSUE_QUERY, PROJECTS_QUERY, SEARCH_ISSUES_QUERY, TEAMS_QUERY } from "../src/documents";
import { LinearAdapterError, createLinearConnectorAdapter } from "../src/adapter";

const TEAM_A = "11111111-1111-1111-1111-111111111111";
const TEAM_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_A = "33333333-3333-3333-3333-333333333333";
const PROJECT_B = "44444444-4444-4444-4444-444444444444";

/** A selection with one team and one project. The issue scope is therefore
 * "team TEAM_A OR project PROJECT_A". */
const SELECTION = {
  items: [
    { id: TEAM_A, kind: "team" },
    { id: PROJECT_A, kind: "project" },
  ],
};
const EXPECTED_ISSUE_SCOPE = {
  or: [{ team: { id: { in: [TEAM_A] } } }, { project: { id: { in: [PROJECT_A] } } }],
};
const EXPECTED_PROJECT_SCOPE = {
  or: [
    { id: { in: [PROJECT_A] } },
    { accessibleTeams: { some: { id: { in: [TEAM_A] } } } },
  ],
};

type FetchCall = { url: string; body: unknown };
type DocumentHandler = (
  variables: Record<string, unknown>,
  call: FetchCall,
) => Response | Promise<Response>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function router(handlers: {
  token?: (call: FetchCall) => Response | Promise<Response>;
  documents?: Map<string, DocumentHandler>;
}) {
  const calls: FetchCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    const call: FetchCall = { url: value, body: init?.body ?? null };
    calls.push(call);
    if (value.endsWith("/graphql")) {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const handler = handlers.documents?.get(body.query);
      if (!handler) throw new Error(`Unexpected GraphQL document: ${body.query}`);
      return handler(body.variables, call);
    }
    throw new Error(`Unexpected request: ${value}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

function adapter(fetcher: typeof fetch) {
  return createLinearConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "client-id",
    clientSecret: "client-secret",
    fetcher,
  });
}

function toolInput(
  actionType: string,
  request: Record<string, unknown>,
  config: Record<string, unknown>,
): ConnectorActionInput {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "linear",
    actionType,
    request,
    config,
    accessToken: "access-token",
    idempotencyKey: "idem-1",
  };
}

function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    identifier: "ENG-1",
    title: "Fix the thing",
    url: "https://linear.app/acme/issue/ENG-1",
    priorityLabel: "High",
    updatedAt: "2026-11-10T00:00:00.000Z",
    state: { name: "In Progress", type: "started" },
    assignee: { name: "Alice" },
    team: { id: TEAM_A, key: "ENG", name: "Engineering" },
    project: { id: PROJECT_A, name: "Launch" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// search_linear_issues
// ---------------------------------------------------------------------------

test("sends term and scope filter as variables", async () => {
  const { fetcher, calls } = router({
    documents: new Map([
      [
        SEARCH_ISSUES_QUERY,
        (variables) => {
          assert.equal(variables.term, "bug");
          assert.equal(variables.after, undefined);
          assert.deepEqual(variables.filter, { and: [EXPECTED_ISSUE_SCOPE] });
          return json({
            data: { searchIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          });
        },
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.issue.search", { query: "  bug  " }, SELECTION),
  );
  assert.deepEqual(result.result, { issues: [], nextCursor: null });
  assert.equal(calls.length, 1);
});

test("state, assignee me, assignee name and updatedWithinDays add filter parts", async () => {
  const FIXED = Date.parse("2026-11-18T12:00:00.000Z");
  const realNow = Date.now;
  Date.now = () => FIXED;
  try {
    const { fetcher } = router({
      documents: new Map([
        [
          SEARCH_ISSUES_QUERY,
          (variables) => {
            assert.deepEqual(variables.filter, {
              and: [
                EXPECTED_ISSUE_SCOPE,
                { state: { name: { eqIgnoreCase: "Done" } } },
                { assignee: { isMe: { eq: true } } },
                { updatedAt: { gte: "2026-11-11T12:00:00.000Z" } },
              ],
            });
            return json({
              data: { searchIssues: { nodes: [], pageInfo: { hasNextPage: false } } },
            });
          },
        ],
      ]),
    });
    await adapter(fetcher).executeAction(
      toolInput(
        "linear.issue.search",
        { query: "x", state: "Done", assignee: "me", updatedWithinDays: 7 },
        SELECTION,
      ),
    );
  } finally {
    Date.now = realNow;
  }

  const { fetcher: namedFetcher } = router({
    documents: new Map([
      [
        SEARCH_ISSUES_QUERY,
        (variables) => {
          assert.deepEqual(variables.filter, {
            and: [EXPECTED_ISSUE_SCOPE, { assignee: { name: { containsIgnoreCase: "Alice" } } }],
          });
          return json({ data: { searchIssues: { nodes: [], pageInfo: { hasNextPage: false } } } });
        },
      ],
    ]),
  });
  await adapter(namedFetcher).executeAction(
    toolInput("linear.issue.search", { query: "x", assignee: "Alice" }, SELECTION),
  );
});

test("post-check drops out-of-scope issues", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        SEARCH_ISSUES_QUERY,
        () =>
          json({
            data: {
              searchIssues: {
                nodes: [
                  issueNode({ id: "aaaaaaaa-0000-0000-0000-00000000000a", identifier: "ENG-10" }),
                  issueNode({
                    id: "aaaaaaaa-0000-0000-0000-00000000000b",
                    identifier: "OPS-7",
                    team: { id: TEAM_B, key: "OPS", name: "Ops" },
                    project: { id: PROJECT_B, name: "Other" },
                  }),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.issue.search", { query: "x" }, SELECTION),
  );
  const issues = result.result.issues as Array<{ identifier: string }>;
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.identifier, "ENG-10");
});

test("maps summary fields and next cursor", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        SEARCH_ISSUES_QUERY,
        () =>
          json({
            data: {
              searchIssues: {
                nodes: [issueNode({ assignee: null, project: null })],
                pageInfo: { hasNextPage: true, endCursor: "next-1" },
              },
            },
          }),
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.issue.search", { query: "x" }, SELECTION),
  );
  assert.deepEqual(result.result, {
    issues: [
      {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        identifier: "ENG-1",
        title: "Fix the thing",
        url: "https://linear.app/acme/issue/ENG-1",
        state: { name: "In Progress", type: "started" },
        assignee: null,
        priority: "High",
        team: { key: "ENG", name: "Engineering" },
        project: null,
        updatedAt: "2026-11-10T00:00:00.000Z",
      },
    ],
    nextCursor: "next-1",
  });
});

test("blank query is rejected without a request", async () => {
  const { fetcher, calls } = router({});
  await assert.rejects(
    adapter(fetcher).executeAction(toolInput("linear.issue.search", { query: "   " }, SELECTION)),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("stale selection returns empty results", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        SEARCH_ISSUES_QUERY,
        () =>
          json({ data: { searchIssues: { nodes: [], pageInfo: { hasNextPage: false } } } }),
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.issue.search", { query: "x" }, SELECTION),
  );
  assert.deepEqual(result.result, { issues: [], nextCursor: null });
});

test("malformed response is a failure, not an empty result", async () => {
  // A 2xx body that carries `data` but no `searchIssues` connection: the client
  // returns the object, and the tool's own shape guard rejects it as 502
  // (a `{}` body with no `data` at all is the client's 503 case, tested there).
  const { fetcher } = router({
    documents: new Map([[SEARCH_ISSUES_QUERY, () => json({ data: {} })]]),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(toolInput("linear.issue.search", { query: "x" }, SELECTION)),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.statusCode === 502 &&
      error.code === "LINEAR_REQUEST_FAILED",
  );
});

test("429 from the client surfaces LINEAR_RATE_LIMITED", async () => {
  const { fetcher } = router({
    documents: new Map([
      [SEARCH_ISSUES_QUERY, () => json({ errors: [{ message: "rate limited" }] }, 429)],
    ]),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(toolInput("linear.issue.search", { query: "x" }, SELECTION)),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_RATE_LIMITED",
  );
});

// ---------------------------------------------------------------------------
// read_linear_issue
// ---------------------------------------------------------------------------

function issueDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...issueNode(),
    description: "A description",
    createdAt: "2026-11-01T00:00:00.000Z",
    labels: { nodes: [{ name: "bug" }, { name: "urgent" }] },
    comments: {
      nodes: [
        { body: "second", createdAt: "2026-11-05T00:00:00.000Z", user: { name: "Bob" } },
        { body: "first", createdAt: "2026-11-02T00:00:00.000Z", user: { name: "Alice" } },
      ],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  };
}

test("reads by identifier and returns comments oldest first", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        ISSUE_QUERY,
        (variables) => {
          assert.equal(variables.id, "ENG-1");
          return json({ data: { issue: issueDetail() } });
        },
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.issue.read", { id: "ENG-1" }, SELECTION),
  );
  assert.equal(result.externalId, "aaaaaaaa-0000-0000-0000-000000000001");
  assert.deepEqual(result.result.labels, ["bug", "urgent"]);
  assert.equal(result.result.createdAt, "2026-11-01T00:00:00.000Z");
  assert.equal(result.result.descriptionTruncated, false);
  assert.deepEqual(result.result.comments, [
    { author: "Alice", createdAt: "2026-11-02T00:00:00.000Z", body: "first" },
    { author: "Bob", createdAt: "2026-11-05T00:00:00.000Z", body: "second" },
  ]);
  assert.equal(result.result.commentsTruncated, false);
  assert.equal(result.result.commentsNote, null);
});

test("comments are returned in ascending order whatever order Linear sends", async () => {
  const shuffled = {
    nodes: [
      { body: "c", createdAt: "2026-11-09T00:00:00.000Z", user: { name: "C" } },
      { body: "a", createdAt: "2026-11-03T00:00:00.000Z", user: null },
      { body: "b", createdAt: "2026-11-06T00:00:00.000Z", user: { name: "B" } },
    ],
    pageInfo: { hasNextPage: false },
  };
  const { fetcher } = router({
    documents: new Map([
      [ISSUE_QUERY, () => json({ data: { issue: issueDetail({ comments: shuffled }) } })],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.issue.read", { id: "ENG-1" }, SELECTION),
  );
  assert.deepEqual(
    (result.result.comments as Array<{ body: string }>).map((c) => c.body),
    ["a", "b", "c"],
  );
});

test("truncates a 25,000-character description and flags it", async () => {
  const description = "x".repeat(25000);
  const { fetcher } = router({
    documents: new Map([
      [ISSUE_QUERY, () => json({ data: { issue: issueDetail({ description }) } })],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.issue.read", { id: "ENG-1" }, SELECTION),
  );
  assert.equal((result.result.description as string).length, 20000);
  assert.equal(result.result.descriptionTruncated, true);
});

test("truncated comments carry the note", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        ISSUE_QUERY,
        () =>
          json({
            data: {
              issue: issueDetail({
                comments: {
                  nodes: [{ body: "c", createdAt: "2026-11-02T00:00:00.000Z", user: null }],
                  pageInfo: { hasNextPage: true },
                },
              }),
            },
          }),
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.issue.read", { id: "ENG-1" }, SELECTION),
  );
  assert.equal(result.result.commentsTruncated, true);
  assert.equal(
    result.result.commentsNote,
    "Showing 20 of this issue's comments; it has more. Open the issue link for the full thread.",
  );
});

test("out-of-scope, missing and forbidden issues give the same LINEAR_NOT_FOUND message", async () => {
  const cases: DocumentHandler[] = [
    // Out of scope: a real issue whose team and project are both unselected.
    () =>
      json({
        data: {
          issue: issueDetail({
            team: { id: TEAM_B, key: "OPS", name: "Ops" },
            project: { id: PROJECT_B, name: "Other" },
          }),
        },
      }),
    // Missing: Linear returns a null issue.
    () => json({ data: { issue: null } }),
    // Forbidden: the client maps "Entity not found" to LINEAR_NOT_FOUND.
    () => json({ errors: [{ message: "Entity not found" }] }, 200),
  ];
  for (const handler of cases) {
    const { fetcher } = router({ documents: new Map([[ISSUE_QUERY, handler]]) });
    await assert.rejects(
      adapter(fetcher).executeAction(toolInput("linear.issue.read", { id: "ENG-1" }, SELECTION)),
      (error: unknown) =>
        error instanceof LinearAdapterError &&
        error.statusCode === 404 &&
        error.code === "LINEAR_NOT_FOUND" &&
        error.message === "Linear issue not found",
    );
  }
});

test("an unrecognised provider error on read is the same not-found", async () => {
  const { fetcher } = router({
    documents: new Map([
      [ISSUE_QUERY, () => json({ errors: [{ message: "Something else" }] }, 200)],
    ]),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(toolInput("linear.issue.read", { id: "ENG-1" }, SELECTION)),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.statusCode === 404 &&
      error.code === "LINEAR_NOT_FOUND" &&
      error.message === "Linear issue not found",
  );
});

test("a rate limit on read is not folded", async () => {
  const { fetcher } = router({
    documents: new Map([
      [ISSUE_QUERY, () => json({ errors: [{ message: "rate limited" }] }, 429)],
    ]),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(toolInput("linear.issue.read", { id: "ENG-1" }, SELECTION)),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_RATE_LIMITED",
  );
});

test("rejects an id with spaces or a slash without a request", async () => {
  const { fetcher, calls } = router({});
  for (const id of ["ENG 123", "ENG/123"]) {
    await assert.rejects(
      adapter(fetcher).executeAction(toolInput("linear.issue.read", { id }, SELECTION)),
      (error: unknown) =>
        error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_REQUEST",
    );
  }
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// list_linear_projects
// ---------------------------------------------------------------------------

function projectNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROJECT_A,
    name: "Launch",
    url: "https://linear.app/acme/project/launch",
    progress: 0.5,
    targetDate: "2026-12-01",
    status: { name: "In Progress" },
    lead: { name: "Alice" },
    teams: { nodes: [{ id: TEAM_A, name: "Engineering", key: "ENG" }] },
    ...overrides,
  };
}

test("lists in-scope projects and drops others", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        PROJECTS_QUERY,
        (variables) => {
          assert.equal(variables.first, 100);
          assert.deepEqual(variables.filter, EXPECTED_PROJECT_SCOPE);
          return json({
            data: {
              projects: {
                nodes: [
                  projectNode(),
                  projectNode({
                    id: PROJECT_B,
                    name: "Unrelated",
                    teams: { nodes: [{ id: TEAM_B, name: "Ops", key: "OPS" }] },
                  }),
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          });
        },
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.project.list", {}, SELECTION),
  );
  assert.deepEqual(result.result, {
    projects: [
      {
        id: PROJECT_A,
        name: "Launch",
        status: "In Progress",
        lead: "Alice",
        progress: 0.5,
        targetDate: "2026-12-01",
        url: "https://linear.app/acme/project/launch",
        teams: ["ENG"],
      },
    ],
    truncated: false,
  });
});

test("flags truncated", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        PROJECTS_QUERY,
        () =>
          json({
            data: { projects: { nodes: [projectNode()], pageInfo: { hasNextPage: true } } },
          }),
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.project.list", {}, SELECTION),
  );
  assert.equal(result.result.truncated, true);
});

// ---------------------------------------------------------------------------
// Gates and shared invariants
// ---------------------------------------------------------------------------

test("nothing selected returns LINEAR_NOTHING_SELECTED without a request", async () => {
  const requests: Array<[string, Record<string, unknown>]> = [
    ["linear.issue.search", { query: "x" }],
    ["linear.issue.read", { id: "ENG-1" }],
    ["linear.project.list", {}],
  ];
  for (const [actionType, request] of requests) {
    const { fetcher, calls } = router({});
    await assert.rejects(
      adapter(fetcher).executeAction(toolInput(actionType, request, { items: [] })),
      (error: unknown) =>
        error instanceof LinearAdapterError &&
        error.statusCode === 409 &&
        error.code === "LINEAR_NOTHING_SELECTED",
    );
    assert.equal(calls.length, 0);
  }
});

test("selection actions work with an empty selection", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        TEAMS_QUERY,
        () =>
          json({
            data: {
              teams: {
                nodes: [{ id: TEAM_A, name: "Engineering", key: "ENG" }],
                pageInfo: { hasNextPage: false, endCursor: "c1" },
              },
            },
          }),
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    toolInput("linear.browse", {}, { items: [] }),
  );
  assert.equal((result.result.entries as unknown[]).length, 1);
});

test("results carry no rawResponseJson", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        SEARCH_ISSUES_QUERY,
        () => json({ data: { searchIssues: { nodes: [], pageInfo: { hasNextPage: false } } } }),
      ],
      [ISSUE_QUERY, () => json({ data: { issue: issueDetail() } })],
      [PROJECTS_QUERY, () => json({ data: { projects: { nodes: [], pageInfo: { hasNextPage: false } } } })],
    ]),
  });
  const connector = adapter(fetcher);
  for (const [actionType, request] of [
    ["linear.issue.search", { query: "x" }],
    ["linear.issue.read", { id: "ENG-1" }],
    ["linear.project.list", {}],
  ] as Array<[string, Record<string, unknown>]>) {
    const result = await connector.executeAction(toolInput(actionType, request, SELECTION));
    assert.equal("rawResponseJson" in result, false);
  }
});
