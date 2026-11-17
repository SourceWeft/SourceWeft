import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
  connectorSelectionSearchResultSchema,
  type ConnectorActionInput,
} from "@sourceweft/contracts";
import { createGithubConnectorAdapter, type GithubAdapterConfig } from "../src/adapter";
import { GithubAdapterError } from "../src/errors";

type RecordedCall = { url: string; method: string; query: URLSearchParams; body: unknown };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installationAccount(id: number, login: string, type: string) {
  return { id, account: { login, type } };
}

function repoRow(nodeId: string, name: string, fullName: string, updatedAt: string) {
  return { node_id: nodeId, name, full_name: fullName, updated_at: updatedAt };
}

/** Routes a fake fetcher between the REST endpoints `GET /user/installations`
 * and `GET /user/installations/{id}/repositories` and the GraphQL endpoint,
 * recording every call. Unrouted endpoints throw, so a stray request fails
 * the test loudly. */
function router(handlers: {
  installations?: (page: number, call: RecordedCall) => Response | Promise<Response>;
  repositories?: (
    installationId: number,
    page: number,
    call: RecordedCall,
  ) => Response | Promise<Response>;
  graphql?: (body: { query: string; variables: unknown }, call: RecordedCall) => Response | Promise<Response>;
}) {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const call: RecordedCall = { url: url.toString(), method, query: url.searchParams, body };
    calls.push(call);

    if (url.pathname === "/user/installations" && method === "GET") {
      if (!handlers.installations) throw new Error("Unexpected installations call");
      const page = Number(url.searchParams.get("page") ?? "1");
      return handlers.installations(page, call);
    }
    const repoMatch = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (repoMatch && method === "GET") {
      if (!handlers.repositories) throw new Error("Unexpected repositories call");
      const installationId = Number(repoMatch[1]);
      const page = Number(url.searchParams.get("page") ?? "1");
      return handlers.repositories(installationId, page, call);
    }
    if (url.pathname === "/graphql" && method === "POST") {
      if (!handlers.graphql) throw new Error("Unexpected graphql call");
      return handlers.graphql(body as { query: string; variables: unknown }, call);
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function adapter(
  fetcher: typeof fetch,
  overrides: Partial<GithubAdapterConfig> = {},
) {
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
): ConnectorActionInput {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "github",
    actionType,
    request,
    config: { items: [] },
    accessToken: "access-token",
    idempotencyKey: "idem-1",
  };
}

const HELP_LINK = {
  code: "add_repositories",
  url: "https://github.com/apps/sourceweft-test/installations/new",
};

test("browse root lists installations sorted with the help link", async () => {
  const { fetcher, calls } = router({
    installations: () =>
      json({
        total_count: 2,
        installations: [
          installationAccount(2, "Zeta", "Organization"),
          installationAccount(1, "acme", "User"),
        ],
      }),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(actionInput("github.browse", {}));

  assert.deepEqual(result.result, {
    container: null,
    breadcrumbs: [],
    entries: [
      {
        id: "installation:1",
        kind: "account",
        name: "acme",
        detail: "User",
        selectable: false,
        expandable: true,
        disabledReason: null,
        size: null,
        modifiedAt: null,
      },
      {
        id: "installation:2",
        kind: "account",
        name: "Zeta",
        detail: "Organization",
        selectable: false,
        expandable: true,
        disabledReason: null,
        size: null,
        modifiedAt: null,
      },
    ],
    cursor: "",
    hasMore: false,
    helpLink: HELP_LINK,
  });
  assert.deepEqual(
    connectorSelectionBrowseResultSchema.parse(result.result),
    result.result,
  );
  assert.equal(calls.length, 1);
});

test("browse root with no installations returns the help link", async () => {
  const { fetcher } = router({
    installations: () => json({ total_count: 0, installations: [] }),
  });
  const gh = adapter(fetcher, { appSlug: "sourceweft-test" });
  const result = await gh.executeAction(actionInput("github.browse", {}));

  assert.deepEqual(result.result.entries, []);
  assert.equal(result.result.hasMore, false);
  assert.deepEqual(result.result.helpLink, {
    code: "add_repositories",
    url: "https://github.com/apps/sourceweft-test/installations/new",
  });
  assert.deepEqual(
    connectorSelectionBrowseResultSchema.parse(result.result),
    result.result,
  );
});

test("browse installation lists repositories with node ids", async () => {
  const { fetcher } = router({
    installations: () =>
      json({ total_count: 1, installations: [installationAccount(5, "acme", "Organization")] }),
    repositories: (installationId) => {
      assert.equal(installationId, 5);
      return json({
        total_count: 2,
        repositories: [
          repoRow("R_b", "beta", "acme/beta", "2026-01-01T00:00:00Z"),
          repoRow("R_a", "alpha", "acme/alpha", "2026-01-02T00:00:00Z"),
        ],
      });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.browse", { containerId: "installation:5" }),
  );

  assert.deepEqual(result.result, {
    container: { id: "installation:5", kind: "account", name: "acme", detail: null },
    breadcrumbs: [],
    entries: [
      {
        id: "R_a",
        kind: "repository",
        name: "alpha",
        detail: "acme/alpha",
        selectable: true,
        expandable: false,
        disabledReason: null,
        size: null,
        modifiedAt: "2026-01-02T00:00:00Z",
      },
      {
        id: "R_b",
        kind: "repository",
        name: "beta",
        detail: "acme/beta",
        selectable: true,
        expandable: false,
        disabledReason: null,
        size: null,
        modifiedAt: "2026-01-01T00:00:00Z",
      },
    ],
    cursor: "",
    hasMore: false,
    helpLink: HELP_LINK,
  });
  assert.deepEqual(
    connectorSelectionBrowseResultSchema.parse(result.result),
    result.result,
  );
});

test("browse rejects an installation the user does not have", async () => {
  const { fetcher, calls } = router({
    installations: () =>
      json({ total_count: 1, installations: [installationAccount(5, "acme", "Organization")] }),
  });
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(actionInput("github.browse", { containerId: "installation:99" })),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 404 &&
      error.code === "GITHUB_NOT_FOUND",
  );
  assert.equal(calls.some((call) => call.url.includes("/repositories")), false);
});

test("browse continuation returns no container", async () => {
  const { fetcher, calls } = router({
    repositories: (installationId, page) => {
      assert.equal(installationId, 5);
      assert.equal(page, 2);
      return json({
        total_count: 150,
        repositories: [repoRow("R_c", "gamma", "acme/gamma", "2026-01-03T00:00:00Z")],
      });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.browse", { cursor: "i:5:2" }),
  );

  assert.equal(result.result.container, null);
  assert.deepEqual(result.result.breadcrumbs, []);
  assert.equal((result.result.entries as unknown[]).length, 1);
  assert.deepEqual(result.result.helpLink, HELP_LINK);
  assert.equal(calls.some((call) => call.url.includes("/user/installations") && !call.url.includes("repositories")), false);
});

test("browse rejects containerId together with cursor", async () => {
  const { fetcher, calls } = router({});
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(
      actionInput("github.browse", { containerId: "installation:5", cursor: "r:2" }),
    ),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 400 &&
      error.code === "GITHUB_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("search filters by full name and stops after 10 pages", async () => {
  const PAGE_COUNT = 12;
  const PER_PAGE = 100;
  const { fetcher, calls } = router({
    installations: () =>
      json({ total_count: 1, installations: [installationAccount(7, "acme", "Organization")] }),
    repositories: (installationId, page) => {
      assert.equal(installationId, 7);
      const repositories = [];
      for (let i = 0; i < PER_PAGE; i += 1) {
        repositories.push(
          repoRow(`R_${page}_${i}`, `repo-${page}-${i}`, `acme/repo-${page}-${i}`, null as unknown as string),
        );
      }
      // One match on a page within budget (10) and one match past the
      // budget, so the test can tell whether the cutoff actually applies.
      if (page === 10) {
        repositories[0] = repoRow("R_found", "zzz-widget-in-budget", "acme/zzz-widget-in-budget", null as unknown as string);
      }
      if (page === 11) {
        repositories[0] = repoRow("R_missed", "zzz-widget-past-budget", "acme/zzz-widget-past-budget", null as unknown as string);
      }
      return json({ total_count: PAGE_COUNT * PER_PAGE, repositories });
    },
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(actionInput("github.search", { query: "widget" }));

  const repositoryCalls = calls.filter((call) => call.url.includes("/repositories"));
  assert.equal(repositoryCalls.length, 10);
  const ids = (result.result.entries as Array<{ id: string }>).map((entry) => entry.id);
  assert.deepEqual(ids, ["R_found"]);
  assert.equal(result.result.cursor, "");
  assert.equal(result.result.hasMore, false);
  assert.deepEqual(
    connectorSelectionSearchResultSchema.parse(result.result),
    result.result,
  );
});

test("search rejects a cursor", async () => {
  const { fetcher, calls } = router({});
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(actionInput("github.search", { query: "test", cursor: "abc" })),
    (error: unknown) =>
      error instanceof GithubAdapterError && error.code === "GITHUB_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("blank query is rejected without a request", async () => {
  const { fetcher, calls } = router({});
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(actionInput("github.search", { query: "   " })),
    (error: unknown) =>
      error instanceof GithubAdapterError && error.code === "GITHUB_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

function repoNode(id: string, nameWithOwner: string) {
  return {
    id,
    nameWithOwner,
    name: nameWithOwner.split("/")[1],
    url: `https://github.com/${nameWithOwner}`,
    description: null,
    isPrivate: false,
    isArchived: false,
    defaultBranchRef: { name: "main" },
  };
}

test("describe marks missing ids exists:false in request order", async () => {
  const { fetcher } = router({
    graphql: () =>
      json({
        data: {
          nodes: [repoNode("R_one1", "acme/one"), null, repoNode("R_two2", "acme/two")],
        },
      }),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.describe", { ids: ["R_one1", "R_missing", "R_two2"] }),
  );

  assert.deepEqual(result.result.items, [
    { id: "R_one1", kind: "repository", name: "one", detail: "acme/one", exists: true, meta: {} },
    { id: "R_missing", kind: null, name: null, detail: null, exists: false, meta: {} },
    { id: "R_two2", kind: "repository", name: "two", detail: "acme/two", exists: true, meta: {} },
  ]);
  assert.deepEqual(
    connectorSelectionDescribeResultSchema.parse(result.result),
    result.result,
  );
});

test("describe keeps resolvable ids when GraphQL reports partial errors", async () => {
  const { fetcher } = router({
    graphql: () =>
      json({
        data: { nodes: [repoNode("R_one1", "acme/one"), null] },
        errors: [
          {
            type: "NOT_FOUND",
            message: "Could not resolve to a node with the global id of 'R_bad'",
          },
        ],
      }),
  });
  const gh = adapter(fetcher);
  const result = await gh.executeAction(
    actionInput("github.describe", { ids: ["R_one1", "R_bad"] }),
  );

  assert.deepEqual(result.result.items, [
    { id: "R_one1", kind: "repository", name: "one", detail: "acme/one", exists: true, meta: {} },
    { id: "R_bad", kind: null, name: null, detail: null, exists: false, meta: {} },
  ]);
});

test("describe rejects 101 ids", async () => {
  const { fetcher, calls } = router({});
  const gh = adapter(fetcher);
  const ids = Array.from({ length: 101 }, (_, i) => `R_${String(i).padStart(4, "0")}`);
  await assert.rejects(
    gh.executeAction(actionInput("github.describe", { ids })),
    (error: unknown) =>
      error instanceof GithubAdapterError && error.code === "GITHUB_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("selection action 401 surfaces GITHUB_REAUTH_REQUIRED", async () => {
  const { fetcher } = router({
    installations: () => json({ message: "Bad credentials" }, 401),
  });
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(actionInput("github.browse", {})),
    (error: unknown) =>
      error instanceof GithubAdapterError &&
      error.statusCode === 401 &&
      error.code === "GITHUB_REAUTH_REQUIRED",
  );
});

test("unknown action is rejected", async () => {
  const { fetcher, calls } = router({});
  const gh = adapter(fetcher);
  await assert.rejects(
    gh.executeAction(actionInput("github.nope", {})),
    (error: unknown) =>
      error instanceof GithubAdapterError && error.code === "GITHUB_ACTION_UNSUPPORTED",
  );
  assert.equal(calls.length, 0);
});
