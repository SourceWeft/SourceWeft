import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "@sourceweft/atlassian-client";
import {
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
  connectorSelectionSearchResultSchema,
  type ConnectorActionInput,
} from "@sourceweft/contracts";
import { createJiraConnectorAdapter } from "../src/adapter";

const JIRA_SCOPE = "read:jira-work";

type Call = { url: string };

type SiteFixture = { id: string; url: string; name: string; scopes: string[] };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cloudId(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
}

const CLOUD_A = cloudId(1);
const CLOUD_B = cloudId(2);

/** Routes a fake fetcher to the two Atlassian endpoints this adapter calls:
 * `GET /oauth/token/accessible-resources` and `GET /ex/jira/<cloudId>/rest/api/3/project/search`
 * (used for browse paging, search, and describe's `getProjectsByIds`). */
function buildFetcher(opts: {
  sites?: SiteFixture[] | (() => Response | Promise<Response>);
  projectSearch?: (cloudId: string, url: URL) => Response | Promise<Response>;
}) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const value = String(input);
    calls.push({ url: value });
    if (value.startsWith("https://api.atlassian.com/oauth/token/accessible-resources")) {
      if (typeof opts.sites === "function") return opts.sites();
      return json(opts.sites ?? []);
    }
    const match = value.match(
      /\/ex\/jira\/([0-9a-f-]+)\/rest\/api\/3\/project\/search/,
    );
    if (match) {
      if (!opts.projectSearch) {
        throw new Error(`Unexpected project/search call: ${value}`);
      }
      return opts.projectSearch(match[1]!, new URL(value));
    }
    throw new Error(`Unexpected request: ${value}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

function adapter(fetcher: typeof fetch) {
  return createJiraConnectorAdapter({
    baseUrl: "https://sourceweft.example",
    clientId: "jira-client-id",
    clientSecret: "jira-client-secret",
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
    connectorType: "jira",
    actionType,
    request,
    config: { items: [] },
    accessToken: "access-token",
    idempotencyKey: "idem-1",
  };
}

test("root lists only sites with the Jira read scope", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [
      { id: CLOUD_B, url: "https://zeta.atlassian.net", name: "Zeta", scopes: [JIRA_SCOPE] },
      {
        id: cloudId(3),
        url: "https://noscope.atlassian.net",
        name: "NoScope",
        scopes: ["offline_access"],
      },
      {
        id: CLOUD_A,
        url: "https://alpha.atlassian.net",
        name: "Alpha",
        scopes: [JIRA_SCOPE, "offline_access"],
      },
    ],
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(actionInput("jira.browse", {}));
  assert.deepEqual(result.result, {
    container: null,
    breadcrumbs: [],
    entries: [
      {
        id: `site:${CLOUD_A}`,
        kind: "site",
        name: "Alpha",
        detail: "alpha.atlassian.net",
        selectable: false,
        expandable: true,
        disabledReason: null,
        size: null,
        modifiedAt: null,
      },
      {
        id: `site:${CLOUD_B}`,
        kind: "site",
        name: "Zeta",
        detail: "zeta.atlassian.net",
        selectable: false,
        expandable: true,
        disabledReason: null,
        size: null,
        modifiedAt: null,
      },
    ],
    cursor: "",
    hasMore: false,
    helpLink: null,
  });
  assert.equal(calls.length, 1);
});

test("site lists projects and pages with a cursor", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [{ id: CLOUD_A, url: "https://alpha.atlassian.net", name: "Alpha", scopes: [JIRA_SCOPE] }],
    projectSearch: (_cloudId, url) => {
      const startAt = Number(url.searchParams.get("startAt") ?? "0");
      if (startAt === 0) {
        return json({
          values: [
            { id: "10000", key: "ONE", name: "Project One" },
            { id: "10001", key: "TWO", name: "Project Two" },
          ],
          isLast: false,
          startAt: 0,
        });
      }
      return json({
        values: [{ id: "10002", key: "THREE", name: "Project Three" }],
        isLast: true,
        startAt,
      });
    },
  });
  const jira = adapter(fetcher);

  const firstPage = await jira.executeAction(
    actionInput("jira.browse", { containerId: `site:${CLOUD_A}` }),
  );
  assert.deepEqual(firstPage.result.container, {
    id: `site:${CLOUD_A}`,
    kind: "site",
    name: "Alpha",
    detail: "alpha.atlassian.net",
  });
  assert.deepEqual(firstPage.result.breadcrumbs, []);
  assert.deepEqual(firstPage.result.entries, [
    {
      id: `project:${CLOUD_A}:10000`,
      kind: "project",
      name: "Project One",
      detail: "ONE",
      selectable: true,
      expandable: false,
      disabledReason: null,
      size: null,
      modifiedAt: null,
    },
    {
      id: `project:${CLOUD_A}:10001`,
      kind: "project",
      name: "Project Two",
      detail: "TWO",
      selectable: true,
      expandable: false,
      disabledReason: null,
      size: null,
      modifiedAt: null,
    },
  ]);
  assert.equal(firstPage.result.hasMore, true);
  const cursor = firstPage.result.cursor as string;
  assert.ok(cursor.length > 0);

  const secondPage = await jira.executeAction(actionInput("jira.browse", { cursor }));
  assert.equal(secondPage.result.container, null);
  assert.deepEqual(secondPage.result.breadcrumbs, []);
  assert.deepEqual(secondPage.result.entries, [
    {
      id: `project:${CLOUD_A}:10002`,
      kind: "project",
      name: "Project Three",
      detail: "THREE",
      selectable: true,
      expandable: false,
      disabledReason: null,
      size: null,
      modifiedAt: null,
    },
  ]);
  assert.equal(secondPage.result.hasMore, false);
  assert.equal(secondPage.result.cursor, "");
  assert.equal(
    calls.filter((call) => call.url.includes("accessible-resources")).length,
    1,
  );
});

test("cursor page has no container or breadcrumbs", async () => {
  const { fetcher } = buildFetcher({
    sites: [{ id: CLOUD_A, url: "https://alpha.atlassian.net", name: "Alpha", scopes: [JIRA_SCOPE] }],
    projectSearch: () =>
      json({
        values: [{ id: "10000", key: "ONE", name: "Project One" }],
        isLast: false,
        startAt: 0,
      }),
  });
  const jira = adapter(fetcher);
  const firstPage = await jira.executeAction(
    actionInput("jira.browse", { containerId: `site:${CLOUD_A}` }),
  );
  const cursor = firstPage.result.cursor as string;

  const secondPage = await jira.executeAction(actionInput("jira.browse", { cursor }));
  assert.equal(secondPage.result.container, null);
  assert.deepEqual(secondPage.result.breadcrumbs, []);
});

test("unknown site is not found", async () => {
  const { fetcher, calls } = buildFetcher({ sites: [] });
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(actionInput("jira.browse", { containerId: `site:${CLOUD_A}` })),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 404 &&
      error.code === "JIRA_NOT_FOUND",
  );
  assert.equal(calls.some((call) => call.url.includes("project/search")), false);
});

test("page-like container id is invalid", async () => {
  const { fetcher, calls } = buildFetcher({});
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(
      actionInput("jira.browse", { containerId: `page:${CLOUD_A}:10000` }),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 400 &&
      error.code === "JIRA_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("search fans out to at most five sites and caps at 20 each", async () => {
  const sites = Array.from({ length: 7 }, (_, i) => ({
    id: cloudId(i + 1),
    url: `https://site${i + 1}.atlassian.net`,
    name: `Site ${i + 1}`,
    scopes: [JIRA_SCOPE],
  }));
  const searchCalls: Array<{ cloudId: string; maxResults: string | null; query: string | null }> = [];
  const { fetcher } = buildFetcher({
    sites,
    projectSearch: (siteCloudId, url) => {
      searchCalls.push({
        cloudId: siteCloudId,
        maxResults: url.searchParams.get("maxResults"),
        query: url.searchParams.get("query"),
      });
      return json({
        values: [{ id: "10000", key: "ONE", name: "Match" }],
        isLast: true,
        startAt: 0,
      });
    },
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(actionInput("jira.search", { query: "match" }));

  assert.equal(searchCalls.length, 5);
  assert.deepEqual(
    searchCalls.map((call) => call.cloudId),
    sites.slice(0, 5).map((site) => site.id),
  );
  for (const call of searchCalls) {
    assert.equal(call.maxResults, "20");
    assert.equal(call.query, "match");
  }
  assert.equal((result.result.entries as unknown[]).length, 5);
  assert.equal(result.result.hasMore, false);
  assert.equal(result.result.cursor, "");
  const firstEntry = (result.result.entries as Array<{ detail: string }>)[0]!;
  assert.equal(firstEntry.detail, "ONE · Site 1");
});

test("blank query is rejected without a request", async () => {
  const { fetcher, calls } = buildFetcher({});
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(actionInput("jira.search", { query: "   " })),
    (error: unknown) =>
      error instanceof AtlassianApiError && error.code === "JIRA_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("search accepts an empty cursor and rejects a non-empty one without a request", async () => {
  const { fetcher: rejectingFetcher, calls: rejectingCalls } = buildFetcher({});
  const jiraRejecting = adapter(rejectingFetcher);
  await assert.rejects(
    jiraRejecting.executeAction(
      actionInput("jira.search", { query: "match", cursor: "abc" }),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError && error.code === "JIRA_INVALID_REQUEST",
  );
  assert.equal(rejectingCalls.length, 0);

  const { fetcher: acceptingFetcher, calls: acceptingCalls } = buildFetcher({
    sites: [{ id: CLOUD_A, url: "https://alpha.atlassian.net", name: "Alpha", scopes: [JIRA_SCOPE] }],
    projectSearch: () => json({ values: [], isLast: true, startAt: 0 }),
  });
  const jiraAccepting = adapter(acceptingFetcher);
  const result = await jiraAccepting.executeAction(
    actionInput("jira.search", { query: "match", cursor: "" }),
  );
  assert.deepEqual(result.result, { entries: [], cursor: "", hasMore: false });
  assert.ok(acceptingCalls.length > 0);
});

test("describe keeps request order and marks missing projects", async () => {
  const idExistingA = `project:${CLOUD_A}:10000`;
  const idMissingA = `project:${CLOUD_A}:10001`;
  const idExistingB = `project:${CLOUD_B}:20000`;
  const { fetcher } = buildFetcher({
    sites: [
      { id: CLOUD_A, url: "https://alpha.atlassian.net", name: "Alpha", scopes: [JIRA_SCOPE] },
      { id: CLOUD_B, url: "https://beta.atlassian.net", name: "Beta", scopes: [JIRA_SCOPE] },
    ],
    projectSearch: (siteCloudId, url) => {
      const ids = url.searchParams.getAll("id");
      if (siteCloudId === CLOUD_A) {
        return json({
          values: ids
            .filter((id) => id === "10000")
            .map((id) => ({ id, key: "ONE", name: "Project One" })),
        });
      }
      if (siteCloudId === CLOUD_B) {
        return json({
          values: ids.map((id) => ({ id, key: "TWENTY", name: "Project Twenty" })),
        });
      }
      throw new Error(`Unexpected cloud id: ${siteCloudId}`);
    },
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput("jira.describe", { ids: [idMissingA, idExistingB, idExistingA] }),
  );
  assert.deepEqual(result.result.items, [
    { id: idMissingA, kind: null, name: null, detail: null, exists: false, meta: {} },
    {
      id: idExistingB,
      kind: "project",
      name: "Project Twenty",
      detail: "TWENTY",
      exists: true,
      meta: { key: "TWENTY", siteUrl: "https://beta.atlassian.net" },
    },
    {
      id: idExistingA,
      kind: "project",
      name: "Project One",
      detail: "ONE",
      exists: true,
      meta: { key: "ONE", siteUrl: "https://alpha.atlassian.net" },
    },
  ]);
});

test("describe marks items on a lost site as missing", async () => {
  const idLost = `project:${CLOUD_A}:10000`;
  const { fetcher } = buildFetcher({
    sites: [],
    projectSearch: () => json({ errorMessages: ["not found"] }, 404),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput("jira.describe", { ids: [idLost] }),
  );
  assert.deepEqual(result.result.items, [
    { id: idLost, kind: null, name: null, detail: null, exists: false, meta: {} },
  ]);
});

test("describe rejects 101 ids", async () => {
  const { fetcher, calls } = buildFetcher({});
  const jira = adapter(fetcher);
  const ids = Array.from({ length: 101 }, (_, i) => `project:${CLOUD_A}:${10000 + i}`);
  await assert.rejects(
    jira.executeAction(actionInput("jira.describe", { ids })),
    (error: unknown) =>
      error instanceof AtlassianApiError && error.code === "JIRA_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("every result parses with the contract schemas", async () => {
  const { fetcher: browseFetcher } = buildFetcher({
    sites: [{ id: CLOUD_A, url: "https://alpha.atlassian.net", name: "Alpha", scopes: [JIRA_SCOPE] }],
    projectSearch: () =>
      json({
        values: [{ id: "10000", key: "ONE", name: "Project One" }],
        isLast: false,
        startAt: 0,
      }),
  });
  const browseRoot = await adapter(browseFetcher).executeAction(
    actionInput("jira.browse", {}),
  );
  assert.deepEqual(
    connectorSelectionBrowseResultSchema.strict().parse(browseRoot.result),
    browseRoot.result,
  );

  const browseFirstPage = await adapter(browseFetcher).executeAction(
    actionInput("jira.browse", { containerId: `site:${CLOUD_A}` }),
  );
  assert.deepEqual(
    connectorSelectionBrowseResultSchema.strict().parse(browseFirstPage.result),
    browseFirstPage.result,
  );
  const cursor = browseFirstPage.result.cursor as string;

  const { fetcher: cursorFetcher } = buildFetcher({
    sites: [{ id: CLOUD_A, url: "https://alpha.atlassian.net", name: "Alpha", scopes: [JIRA_SCOPE] }],
    projectSearch: () =>
      json({
        values: [{ id: "10001", key: "TWO", name: "Project Two" }],
        isLast: true,
        startAt: 1,
      }),
  });
  const browseCursorPage = await adapter(cursorFetcher).executeAction(
    actionInput("jira.browse", { cursor }),
  );
  assert.deepEqual(
    connectorSelectionBrowseResultSchema.strict().parse(browseCursorPage.result),
    browseCursorPage.result,
  );

  const { fetcher: searchFetcher } = buildFetcher({
    sites: [{ id: CLOUD_A, url: "https://alpha.atlassian.net", name: "Alpha", scopes: [JIRA_SCOPE] }],
    projectSearch: () =>
      json({
        values: [{ id: "10000", key: "ONE", name: "Project One" }],
        isLast: true,
        startAt: 0,
      }),
  });
  const search = await adapter(searchFetcher).executeAction(
    actionInput("jira.search", { query: "project" }),
  );
  assert.deepEqual(
    connectorSelectionSearchResultSchema.strict().parse(search.result),
    search.result,
  );

  const { fetcher: describeFetcher } = buildFetcher({
    sites: [{ id: CLOUD_A, url: "https://alpha.atlassian.net", name: "Alpha", scopes: [JIRA_SCOPE] }],
    projectSearch: (_cloudId, url) => {
      const ids = url.searchParams.getAll("id");
      return json({
        values: ids
          .filter((id) => id === "10000")
          .map((id) => ({ id, key: "ONE", name: "Project One" })),
      });
    },
  });
  const describe = await adapter(describeFetcher).executeAction(
    actionInput("jira.describe", {
      ids: [`project:${CLOUD_A}:10000`, `project:${CLOUD_A}:10001`],
    }),
  );
  assert.deepEqual(
    connectorSelectionDescribeResultSchema.strict().parse(describe.result),
    describe.result,
  );
});

test("action 401 surfaces JIRA_REAUTH_REQUIRED", async () => {
  const { fetcher } = buildFetcher({
    sites: () => json({ error: "unauthorized" }, 401),
  });
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(actionInput("jira.browse", {})),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 401 &&
      error.code === "JIRA_REAUTH_REQUIRED",
  );
});

test("unknown action is JIRA_UNSUPPORTED_ACTION", async () => {
  const { fetcher, calls } = buildFetcher({});
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(actionInput("jira.nope", {})),
    (error: unknown) =>
      error instanceof AtlassianApiError && error.code === "JIRA_UNSUPPORTED_ACTION",
  );
  assert.equal(calls.length, 0);
});
