import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
  connectorSelectionSearchResultSchema,
  type ConnectorActionInput,
} from "@sourceweft/contracts";
import { IDENTITY_QUERY, PROJECTS_QUERY, TEAMS_QUERY, TEAM_PROJECTS_QUERY } from "../src/documents";
import {
  LinearAdapterError,
  createLinearConnectorAdapter,
  parseLinearSelection,
} from "../src/adapter";

const TEAM_A = "11111111-1111-1111-1111-111111111111";
const TEAM_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_A = "33333333-3333-3333-3333-333333333333";
const PROJECT_B = "44444444-4444-4444-4444-444444444444";
const GONE_ID = "55555555-5555-5555-5555-555555555555";

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

/** Routes a fake fetcher between the OAuth token endpoint and the GraphQL
 * endpoint; a GraphQL request is routed again by its exact document string
 * (one of the constants in `src/documents.ts`) to a handler keyed by that
 * document, which receives the parsed `variables`. Records every call. An
 * unrouted document or an unconfigured token call throws. */
function router(handlers: {
  token?: (call: FetchCall) => Response | Promise<Response>;
  documents?: Map<string, DocumentHandler>;
}) {
  const calls: FetchCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    const call: FetchCall = { url: value, body: init?.body ?? null };
    calls.push(call);
    if (value.endsWith("/oauth/token")) {
      if (!handlers.token) throw new Error("Unexpected token request");
      return handlers.token(call);
    }
    if (value.endsWith("/graphql")) {
      // The token endpoint sends a form-urlencoded body; only the GraphQL
      // endpoint's body is JSON, so it is parsed lazily here.
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

function actionInput(
  actionType: string,
  request: Record<string, unknown>,
): ConnectorActionInput {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "linear",
    actionType,
    request,
    config: { items: [] },
    accessToken: "access-token",
    idempotencyKey: "idem-1",
  };
}

/** Mirrors the adapter's R6 cursor encoding (base64url of `{"t", "a"}`), so
 * tests can build a continuation cursor and independently decode one the
 * adapter returned, without depending on any adapter-internal export. */
function encodeCursor(teamId: string | null, after: string): string {
  return Buffer.from(JSON.stringify({ t: teamId, a: after }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { t: string | null; a: string } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    t: string | null;
    a: string;
  };
}

// ---------------------------------------------------------------------------
// OAuth exchange
// ---------------------------------------------------------------------------

test("exchange maps organization and viewer to the account", async () => {
  const { fetcher } = router({
    token: () =>
      json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "read",
      }),
    documents: new Map([
      [
        IDENTITY_QUERY,
        () =>
          json({
            data: {
              viewer: { id: "user-1", name: "Viewer", email: "viewer@example.com" },
              organization: { id: "org-1", name: "Acme Co", urlKey: "acme" },
            },
          }),
      ],
    ]),
  });
  const token = await adapter(fetcher).exchangeOAuthCode({
    code: "auth-code",
    redirectUri: "https://sourceweft.example/v1/connectors/oauth/linear/callback",
    scopes: ["read"],
  });
  assert.equal(token.accessToken, "access-token");
  assert.equal(token.providerAccountId, "org-1:user-1");
  assert.equal(token.providerAccountEmail, "viewer@example.com");
  assert.equal(token.displayName, "Acme Co");
});

// ---------------------------------------------------------------------------
// parseLinearSelection
// ---------------------------------------------------------------------------

test("parse accepts teams and projects", () => {
  const result = parseLinearSelection({
    items: [
      { id: TEAM_A, kind: "team" },
      { id: PROJECT_A, kind: "project" },
    ],
  });
  assert.deepEqual(result, { teamIds: [TEAM_A], projectIds: [PROJECT_A] });
});

test("parse rejects a repeated id", () => {
  assert.throws(
    () =>
      parseLinearSelection({
        items: [
          { id: TEAM_A, kind: "team" },
          { id: TEAM_A, kind: "team" },
        ],
      }),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_SELECTION",
  );
});

test('parse rejects kind "issue"', () => {
  assert.throws(
    () => parseLinearSelection({ items: [{ id: TEAM_A, kind: "issue" }] }),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_SELECTION",
  );
});

test("parse rejects 101 items", () => {
  const items = Array.from({ length: 101 }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    kind: "team",
  }));
  assert.throws(
    () => parseLinearSelection({ items }),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_SELECTION",
  );
});

test("missing items is an empty selection", () => {
  assert.deepEqual(parseLinearSelection({}), { teamIds: [], projectIds: [] });
});

// ---------------------------------------------------------------------------
// linear.browse
// ---------------------------------------------------------------------------

test("browse root lists teams sorted by name", async () => {
  const { fetcher, calls } = router({
    documents: new Map([
      [
        TEAMS_QUERY,
        (variables) => {
          assert.equal("filter" in variables, false);
          return json({
            data: {
              teams: {
                nodes: [
                  { id: TEAM_B, name: "Zeta", key: "ZET" },
                  { id: TEAM_A, name: "Acme", key: "ACM" },
                ],
                pageInfo: { hasNextPage: false, endCursor: "cursor-a" },
              },
            },
          });
        },
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(actionInput("linear.browse", {}));
  assert.deepEqual(result.result, {
    container: null,
    breadcrumbs: [],
    entries: [
      {
        id: TEAM_A,
        kind: "team",
        name: "Acme",
        detail: "ACM",
        selectable: true,
        expandable: true,
        disabledReason: null,
        size: null,
        modifiedAt: null,
      },
      {
        id: TEAM_B,
        kind: "team",
        name: "Zeta",
        detail: "ZET",
        selectable: true,
        expandable: true,
        disabledReason: null,
        size: null,
        modifiedAt: null,
      },
    ],
    cursor: result.result.cursor,
    hasMore: false,
    helpLink: null,
  });
  assert.deepEqual(decodeCursor(result.result.cursor as string), { t: null, a: "cursor-a" });
  assert.equal(calls.length, 1);
});

test("browse team lists its projects with the team as container", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        TEAM_PROJECTS_QUERY,
        (variables) => {
          assert.equal(variables.id, TEAM_A);
          assert.equal(variables.after, undefined);
          return json({
            data: {
              team: {
                id: TEAM_A,
                name: "Acme",
                key: "ACM",
                projects: {
                  nodes: [
                    { id: PROJECT_B, name: "Zeta Project", status: { name: "In Progress" } },
                    { id: PROJECT_A, name: "Acme Project", status: null },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "proj-cursor-1" },
                },
              },
            },
          });
        },
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("linear.browse", { containerId: TEAM_A }),
  );
  assert.deepEqual(result.result.container, {
    id: TEAM_A,
    kind: "team",
    name: "Acme",
    detail: "ACM",
  });
  assert.deepEqual(result.result.entries, [
    {
      id: PROJECT_A,
      kind: "project",
      name: "Acme Project",
      detail: null,
      selectable: true,
      expandable: false,
      disabledReason: null,
      size: null,
      modifiedAt: null,
    },
    {
      id: PROJECT_B,
      kind: "project",
      name: "Zeta Project",
      detail: "In Progress",
      selectable: true,
      expandable: false,
      disabledReason: null,
      size: null,
      modifiedAt: null,
    },
  ]);
  assert.deepEqual(result.result.breadcrumbs, []);
  assert.equal(result.result.hasMore, true);
  assert.deepEqual(decodeCursor(result.result.cursor as string), {
    t: TEAM_A,
    a: "proj-cursor-1",
  });
});

test("browse with cursor continues the same team without containerId", async () => {
  const { fetcher, calls } = router({
    documents: new Map([
      [
        TEAM_PROJECTS_QUERY,
        (variables) => {
          assert.equal(variables.id, TEAM_A);
          assert.equal(variables.after, "proj-cursor-1");
          return json({
            data: {
              team: {
                id: TEAM_A,
                name: "Acme",
                key: "ACM",
                projects: {
                  nodes: [{ id: PROJECT_A, name: "Acme Project", status: null }],
                  pageInfo: { hasNextPage: false, endCursor: "proj-cursor-2" },
                },
              },
            },
          });
        },
      ],
    ]),
  });
  const cursor = encodeCursor(TEAM_A, "proj-cursor-1");
  const result = await adapter(fetcher).executeAction(
    actionInput("linear.browse", { cursor }),
  );
  assert.equal(result.result.container, null);
  assert.deepEqual(result.result.breadcrumbs, []);
  assert.equal((result.result.entries as unknown[]).length, 1);
  assert.equal(calls.length, 1);
});

test("browse rejects a cursor that does not decode", async () => {
  const { fetcher, calls } = router({});
  await assert.rejects(
    adapter(fetcher).executeAction(actionInput("linear.browse", { cursor: "####" })),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("browse unknown team is LINEAR_NOT_FOUND", async () => {
  const { fetcher } = router({
    documents: new Map([[TEAM_PROJECTS_QUERY, () => json({ data: { team: null } })]]),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(actionInput("linear.browse", { containerId: TEAM_A })),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.statusCode === 404 &&
      error.code === "LINEAR_NOT_FOUND",
  );
});

// ---------------------------------------------------------------------------
// linear.search
// ---------------------------------------------------------------------------

test("search returns teams then projects without paging", async () => {
  const manyTeams = Array.from({ length: 26 }, (_, i) => ({
    id: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`,
    name: `Team ${i}`,
    key: `T${i}`,
  }));
  const { fetcher, calls } = router({
    documents: new Map([
      [
        TEAMS_QUERY,
        (variables) => {
          assert.deepEqual(variables.filter, { name: { containsIgnoreCase: "eng" } });
          return json({ data: { teams: { nodes: manyTeams } } });
        },
      ],
      [
        PROJECTS_QUERY,
        (variables) => {
          assert.equal(variables.first, 25);
          assert.deepEqual(variables.filter, { name: { containsIgnoreCase: "eng" } });
          return json({
            data: {
              projects: {
                nodes: [{ id: PROJECT_A, name: "Eng Project", status: { name: "Active" } }],
              },
            },
          });
        },
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("linear.search", { query: "eng" }),
  );
  const entries = result.result.entries as Array<{ id: string; kind: string }>;
  assert.equal(entries.length, 26);
  assert.ok(entries.slice(0, 25).every((entry) => entry.kind === "team"));
  assert.equal(entries[25]?.id, PROJECT_A);
  assert.equal(entries[25]?.kind, "project");
  assert.equal(result.result.cursor, "");
  assert.equal(result.result.hasMore, false);
  assert.equal(calls.length, 2);
});

test("blank query is rejected without a request", async () => {
  const { fetcher, calls } = router({});
  await assert.rejects(
    adapter(fetcher).executeAction(actionInput("linear.search", { query: "   " })),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("search with a cursor is rejected", async () => {
  const { fetcher, calls } = router({});
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput("linear.search", { query: "eng", cursor: "abc" }),
    ),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// linear.describe
// ---------------------------------------------------------------------------

test("describe marks missing ids", async () => {
  const ids = [TEAM_A, GONE_ID, PROJECT_A];
  const { fetcher } = router({
    documents: new Map([
      [
        TEAMS_QUERY,
        (variables) => {
          assert.deepEqual(variables.filter, { id: { in: ids } });
          return json({ data: { teams: { nodes: [{ id: TEAM_A, name: "Acme", key: "ACM" }] } } });
        },
      ],
      [
        PROJECTS_QUERY,
        (variables) => {
          assert.equal(variables.first, 100);
          assert.deepEqual(variables.filter, { id: { in: ids } });
          return json({
            data: {
              projects: {
                nodes: [{ id: PROJECT_A, name: "Proj", status: { name: "Done" } }],
              },
            },
          });
        },
      ],
    ]),
  });
  const result = await adapter(fetcher).executeAction(
    actionInput("linear.describe", { ids }),
  );
  assert.deepEqual(result.result.items, [
    { id: TEAM_A, kind: "team", name: "Acme", detail: "ACM", exists: true, meta: {} },
    { id: GONE_ID, kind: null, name: null, detail: null, exists: false, meta: {} },
    { id: PROJECT_A, kind: "project", name: "Proj", detail: "Done", exists: true, meta: {} },
  ]);
});

test("describe rejects 101 ids and a non-UUID id", async () => {
  const { fetcher, calls } = router({});
  const tooMany = Array.from({ length: 101 }, (_, i) =>
    `bbbbbbbb-0000-0000-0000-${String(i).padStart(12, "0")}`,
  );
  await assert.rejects(
    adapter(fetcher).executeAction(actionInput("linear.describe", { ids: tooMany })),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_REQUEST",
  );
  await assert.rejects(
    adapter(fetcher).executeAction(
      actionInput("linear.describe", { ids: ["not-a-uuid"] }),
    ),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Shared selection contract
// ---------------------------------------------------------------------------

test("selection results satisfy the shared contract", async () => {
  const browseFetcher = router({
    documents: new Map([
      [
        TEAMS_QUERY,
        () =>
          json({
            data: {
              teams: {
                nodes: [{ id: TEAM_A, name: "Acme", key: "ACM" }],
                pageInfo: { hasNextPage: false, endCursor: "cursor-a" },
              },
            },
          }),
      ],
    ]),
  }).fetcher;
  const browseResult = await adapter(browseFetcher).executeAction(
    actionInput("linear.browse", {}),
  );
  assert.deepEqual(
    connectorSelectionBrowseResultSchema.parse(browseResult.result),
    browseResult.result,
  );

  const searchFetcher = router({
    documents: new Map([
      [TEAMS_QUERY, () => json({ data: { teams: { nodes: [{ id: TEAM_A, name: "Acme", key: "ACM" }] } } })],
      [
        PROJECTS_QUERY,
        () =>
          json({
            data: {
              projects: { nodes: [{ id: PROJECT_A, name: "Proj", status: { name: "Active" } }] },
            },
          }),
      ],
    ]),
  }).fetcher;
  const searchResult = await adapter(searchFetcher).executeAction(
    actionInput("linear.search", { query: "a" }),
  );
  assert.deepEqual(
    connectorSelectionSearchResultSchema.parse(searchResult.result),
    searchResult.result,
  );

  const describeFetcher = router({
    documents: new Map([
      [TEAMS_QUERY, () => json({ data: { teams: { nodes: [{ id: TEAM_A, name: "Acme", key: "ACM" }] } } })],
      [PROJECTS_QUERY, () => json({ data: { projects: { nodes: [] } } })],
    ]),
  }).fetcher;
  const describeResult = await adapter(describeFetcher).executeAction(
    actionInput("linear.describe", { ids: [TEAM_A, GONE_ID] }),
  );
  assert.deepEqual(
    connectorSelectionDescribeResultSchema.parse(describeResult.result),
    describeResult.result,
  );
});

// ---------------------------------------------------------------------------
// Error surfacing / dispatch
// ---------------------------------------------------------------------------

test("action 401 surfaces LINEAR_REAUTH_REQUIRED", async () => {
  const { fetcher } = router({
    documents: new Map([
      [
        TEAMS_QUERY,
        () => json({ errors: [{ message: "Not authenticated" }] }, 401),
      ],
    ]),
  });
  await assert.rejects(
    adapter(fetcher).executeAction(actionInput("linear.browse", {})),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.statusCode === 401 &&
      error.code === "LINEAR_REAUTH_REQUIRED",
  );
});

test("unknown action is rejected", async () => {
  const { fetcher, calls } = router({});
  await assert.rejects(
    adapter(fetcher).executeAction(actionInput("linear.nope", {})),
    (error: unknown) =>
      error instanceof LinearAdapterError && error.code === "LINEAR_UNSUPPORTED_ACTION",
  );
  assert.equal(calls.length, 0);
});

test("manifest client_id is empty without a secret", () => {
  const withoutSecret = createLinearConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "client-id",
    clientSecret: "",
  });
  const manifest = withoutSecret.getManifest();
  assert.equal(manifest.auth.authorizationParams?.client_id, "");
});
