import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "@sourceweft/atlassian-client";
import type { ConnectorActionInput } from "@sourceweft/contracts";
import { createJiraConnectorAdapter } from "../src/adapter";
import { decodeSiteCursor } from "../src/cursor";

const JIRA_SCOPE = "read:jira-work";
const ACCESS_TOKEN = "SECRET-ACCESS-TOKEN-should-never-appear-in-a-result";

type SiteFixture = { id: string; url: string; name: string; scopes: string[] };

type RecordedCall = {
  url: string;
  method: string;
  cloudId?: string;
  jql?: string;
  nextPageToken?: string;
};

type Handlers = {
  sites?: SiteFixture[] | (() => Response | Promise<Response>);
  searchJql?: (
    cloudId: string,
    body: Record<string, unknown>,
    url: URL,
  ) => Response | Promise<Response>;
  issue?: (cloudId: string, key: string, url: URL) => Response | Promise<Response>;
  comments?: (
    cloudId: string,
    key: string,
    url: URL,
  ) => Response | Promise<Response>;
  userSearch?: (cloudId: string, url: URL) => Response | Promise<Response>;
  projectSearch?: (cloudId: string, url: URL) => Response | Promise<Response>;
};

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function cloudId(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
}

const CLOUD_A = cloudId(1);
const CLOUD_B = cloudId(2);
const CLOUD_C = cloudId(3);

function buildFetcher(handlers: Handlers) {
  const calls: RecordedCall[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const value = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const call: RecordedCall = { url: value, method };

    if (
      value.startsWith(
        "https://api.atlassian.com/oauth/token/accessible-resources",
      )
    ) {
      calls.push(call);
      if (typeof handlers.sites === "function") return handlers.sites();
      return json(handlers.sites ?? []);
    }

    const jqlMatch = value.match(
      /\/ex\/jira\/([0-9a-f-]+)\/rest\/api\/3\/search\/jql/,
    );
    if (jqlMatch) {
      call.cloudId = jqlMatch[1]!;
      call.jql = typeof body?.jql === "string" ? body.jql : undefined;
      call.nextPageToken =
        typeof body?.nextPageToken === "string" ? body.nextPageToken : undefined;
      calls.push(call);
      if (!handlers.searchJql) throw new Error(`Unexpected search/jql: ${value}`);
      return handlers.searchJql(jqlMatch[1]!, body ?? {}, new URL(value));
    }

    const commentMatch = value.match(
      /\/ex\/jira\/([0-9a-f-]+)\/rest\/api\/3\/issue\/([^/]+)\/comment/,
    );
    if (commentMatch) {
      call.cloudId = commentMatch[1]!;
      calls.push(call);
      if (!handlers.comments) throw new Error(`Unexpected comment call: ${value}`);
      return handlers.comments(
        commentMatch[1]!,
        decodeURIComponent(commentMatch[2]!),
        new URL(value),
      );
    }

    const issueMatch = value.match(
      /\/ex\/jira\/([0-9a-f-]+)\/rest\/api\/3\/issue\/([^/?]+)/,
    );
    if (issueMatch) {
      call.cloudId = issueMatch[1]!;
      calls.push(call);
      if (!handlers.issue) throw new Error(`Unexpected issue call: ${value}`);
      return handlers.issue(
        issueMatch[1]!,
        decodeURIComponent(issueMatch[2]!),
        new URL(value),
      );
    }

    const userMatch = value.match(
      /\/ex\/jira\/([0-9a-f-]+)\/rest\/api\/3\/user\/search/,
    );
    if (userMatch) {
      call.cloudId = userMatch[1]!;
      calls.push(call);
      if (!handlers.userSearch)
        throw new Error(`Unexpected user/search call: ${value}`);
      return handlers.userSearch(userMatch[1]!, new URL(value));
    }

    const projectMatch = value.match(
      /\/ex\/jira\/([0-9a-f-]+)\/rest\/api\/3\/project\/search/,
    );
    if (projectMatch) {
      call.cloudId = projectMatch[1]!;
      calls.push(call);
      if (!handlers.projectSearch)
        throw new Error(`Unexpected project/search call: ${value}`);
      return handlers.projectSearch(projectMatch[1]!, new URL(value));
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

function projectItems(...ids: string[]): { items: Array<{ id: string; kind: string }> } {
  return { items: ids.map((id) => ({ id, kind: "project" })) };
}

function actionInput(
  actionType: string,
  request: Record<string, unknown>,
  config: Record<string, unknown>,
): ConnectorActionInput {
  return {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
    connectorType: "jira",
    actionType,
    request,
    config,
    accessToken: ACCESS_TOKEN,
    idempotencyKey: "idem-1",
  };
}

function site(n: number): SiteFixture {
  return {
    id: cloudId(n),
    url: `https://site${n}.atlassian.net`,
    name: `Site ${n}`,
    scopes: [JIRA_SCOPE],
  };
}

function issueFixture(opts: {
  id: string;
  key: string;
  projectId: string | null;
  projectKey?: string;
  projectName?: string;
}) {
  const fields: Record<string, unknown> = {
    summary: "An issue",
    status: { name: "Open" },
    issuetype: { name: "Task" },
    priority: { name: "High" },
    assignee: { displayName: "Alice" },
    updated: "2026-11-18T00:00:00.000Z",
  };
  if (opts.projectId !== null) {
    fields.project = {
      id: opts.projectId,
      key: opts.projectKey ?? "PROJ",
      name: opts.projectName ?? "Project",
    };
  }
  return { id: opts.id, key: opts.key, fields };
}

test("nothing selected returns JIRA_NOTHING_SELECTED without a request", async () => {
  const { fetcher, calls } = buildFetcher({});
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(actionInput("jira.issue.search", {}, { items: [] })),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 409 &&
      error.code === "JIRA_NOTHING_SELECTED" &&
      error.message ===
        "No Jira projects are selected for this connector. Ask the user to choose projects in the connector settings.",
  );
  assert.equal(calls.length, 0);
});

test("search sends the scope clause for each site", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [site(1), site(2)],
    searchJql: () => json({ issues: [] }),
  });
  const jira = adapter(fetcher);
  await jira.executeAction(
    actionInput(
      "jira.issue.search",
      {},
      projectItems(
        `project:${CLOUD_A}:10000`,
        `project:${CLOUD_A}:10001`,
        `project:${CLOUD_B}:20000`,
      ),
    ),
  );
  const jqlCalls = calls.filter((c) => c.jql !== undefined);
  assert.equal(jqlCalls.length, 2);
  assert.equal(jqlCalls[0]!.cloudId, CLOUD_A);
  assert.equal(
    jqlCalls[0]!.jql,
    "project in (10000, 10001) ORDER BY updated DESC",
  );
  assert.equal(jqlCalls[1]!.cloudId, CLOUD_B);
  assert.equal(jqlCalls[1]!.jql, "project in (20000) ORDER BY updated DESC");
});

test("out-of-scope and uncheckable issues are dropped", async () => {
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    searchJql: () =>
      json({
        issues: [
          issueFixture({ id: "1", key: "IN-1", projectId: "10000", projectKey: "IN" }),
          issueFixture({ id: "2", key: "OUT-2", projectId: "99999", projectKey: "OUT" }),
          issueFixture({ id: "3", key: "NO-3", projectId: null }),
        ],
      }),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput("jira.issue.search", {}, projectItems(`project:${CLOUD_A}:10000`)),
  );
  const issues = result.result.issues as Array<{ key: string; citationKey: string }>;
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.key, "IN-1");
  assert.equal(issues[0]!.citationKey, `jira:${CLOUD_A}:1`);
  assert.equal(result.result.nextCursor, null);
});

test("search skips a site that is no longer accessible", async () => {
  const { fetcher, calls } = buildFetcher({
    // Only CLOUD_A is still accessible; CLOUD_B is selected but gone.
    sites: [site(1)],
    searchJql: () =>
      json({
        issues: [
          issueFixture({ id: "1", key: "IN-1", projectId: "10000", projectKey: "IN" }),
        ],
      }),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.issue.search",
      {},
      projectItems(`project:${CLOUD_A}:10000`, `project:${CLOUD_B}:20000`),
    ),
  );
  const issues = result.result.issues as Array<{ key: string }>;
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.key, "IN-1");
  assert.equal(
    result.result.note,
    `1 selected site can no longer be accessed: ${CLOUD_B}.`,
  );
  assert.equal(
    calls.some((c) => c.jql !== undefined && c.cloudId === CLOUD_B),
    false,
  );
});

test("search drops a deleted project and retries once with the survivors", async () => {
  let searchCount = 0;
  const { fetcher, calls } = buildFetcher({
    sites: [site(1)],
    searchJql: () => {
      searchCount += 1;
      if (searchCount === 1) {
        return json({ errorMessages: ["project does not exist"] }, { status: 400 });
      }
      return json({
        issues: [
          issueFixture({ id: "1", key: "KEEP-1", projectId: "10000", projectKey: "KEEP" }),
        ],
      });
    },
    // 10001 was deleted: only 10000 resolves.
    projectSearch: (_cloudId, url) => {
      const ids = url.searchParams.getAll("id");
      return json({
        values: ids
          .filter((id) => id === "10000")
          .map((id) => ({ id, key: "KEEP", name: "Kept" })),
      });
    },
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.issue.search",
      {},
      projectItems(`project:${CLOUD_A}:10000`, `project:${CLOUD_A}:10001`),
    ),
  );

  const jqlCalls = calls.filter((c) => c.jql !== undefined);
  assert.equal(jqlCalls.length, 2);
  assert.equal(jqlCalls[0]!.jql, "project in (10000, 10001) ORDER BY updated DESC");
  assert.equal(jqlCalls[1]!.jql, "project in (10000) ORDER BY updated DESC");
  const issues = result.result.issues as Array<{ key: string }>;
  assert.deepEqual(issues.map((i) => i.key), ["KEEP-1"]);
});

test("a site whose projects are all gone is skipped with a note", async () => {
  let searchCount = 0;
  const { fetcher, calls } = buildFetcher({
    sites: [site(1)],
    searchJql: () => {
      searchCount += 1;
      return json({ errorMessages: ["project does not exist"] }, { status: 400 });
    },
    // Both selected projects are gone: nothing resolves.
    projectSearch: () => json({ values: [] }),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.issue.search",
      {},
      projectItems(`project:${CLOUD_A}:10000`, `project:${CLOUD_A}:10001`),
    ),
  );

  assert.equal(searchCount, 1);
  assert.deepEqual(result.result.issues, []);
  assert.equal(result.result.nextCursor, null);
  assert.equal(
    result.result.note,
    "1 selected site can no longer be accessed: Site 1.",
  );
});

test("a persistent rejection with a status throws an explaining JIRA_INVALID_REQUEST", async () => {
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    // Both searches are rejected; the projects still resolve.
    searchJql: () => json({ errorMessages: ["bad status"] }, { status: 400 }),
    projectSearch: (_cloudId, url) => {
      const ids = url.searchParams.getAll("id");
      return json({ values: ids.map((id) => ({ id, key: "KEEP", name: "Kept" })) });
    },
  });
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(
      actionInput(
        "jira.issue.search",
        { status: "Nonexistent" },
        projectItems(`project:${CLOUD_A}:10000`),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 400 &&
      error.code === "JIRA_INVALID_REQUEST" &&
      error.message ===
        "Jira rejected the search. The status or issue type may not exist in the selected projects; use the exact names shown in Jira.",
  );
});

test("a persistent rejection without a status or issue type rethrows the original error", async () => {
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    searchJql: () => json({ errorMessages: ["bad jql"] }, { status: 400 }),
    projectSearch: (_cloudId, url) => {
      const ids = url.searchParams.getAll("id");
      return json({ values: ids.map((id) => ({ id, key: "KEEP", name: "Kept" })) });
    },
  });
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(
      actionInput(
        "jira.issue.search",
        { text: "hello" },
        projectItems(`project:${CLOUD_A}:10000`),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 400 &&
      error.code === "JIRA_INVALID_REQUEST" &&
      error.message !==
        "Jira rejected the search. The status or issue type may not exist in the selected projects; use the exact names shown in Jira.",
  );
});

test("projectKeys narrows to matching selected projects without a key clause", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [site(1)],
    projectSearch: (_cloudId, url) => {
      const ids = url.searchParams.getAll("id");
      const byId: Record<string, string> = { "10000": "ENG", "10001": "OPS" };
      return json({
        values: ids.map((id) => ({ id, key: byId[id] ?? "X", name: `P${id}` })),
      });
    },
    searchJql: () => json({ issues: [] }),
  });
  const jira = adapter(fetcher);
  await jira.executeAction(
    actionInput(
      "jira.issue.search",
      { projectKeys: ["ENG"] },
      projectItems(`project:${CLOUD_A}:10000`, `project:${CLOUD_A}:10001`),
    ),
  );
  const jqlCalls = calls.filter((c) => c.jql !== undefined);
  assert.equal(jqlCalls.length, 1);
  assert.equal(jqlCalls[0]!.jql, "project in (10000) ORDER BY updated DESC");
  assert.ok(!jqlCalls[0]!.jql!.includes('"ENG"'));
});

test("a projectKeys value that matches nothing queries no site and returns an empty page", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [site(1)],
    projectSearch: (_cloudId, url) => {
      const ids = url.searchParams.getAll("id");
      const byId: Record<string, string> = { "10000": "ENG", "10001": "OPS" };
      return json({
        values: ids.map((id) => ({ id, key: byId[id] ?? "X", name: `P${id}` })),
      });
    },
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.issue.search",
      { projectKeys: ["ZZZ"] },
      projectItems(`project:${CLOUD_A}:10000`, `project:${CLOUD_A}:10001`),
    ),
  );
  assert.equal(calls.some((c) => c.jql !== undefined), false);
  assert.deepEqual(result.result.issues, []);
  assert.equal(result.result.nextCursor, null);
});

test("search text with no searchable words is rejected", async () => {
  const { fetcher, calls } = buildFetcher({});
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(
      actionInput(
        "jira.issue.search",
        { text: "()" },
        projectItems(`project:${CLOUD_A}:10000`),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 400 &&
      error.code === "JIRA_INVALID_REQUEST" &&
      error.message === "The search text has no searchable words.",
  );
  assert.equal(calls.length, 0);
});

test("an assignee name that matches nobody returns no issues", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [site(1)],
    userSearch: () => json([]),
    searchJql: () => json({ issues: [] }),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.issue.search",
      { assignee: "Nobody" },
      projectItems(`project:${CLOUD_A}:10000`),
    ),
  );
  const jql = calls.find((c) => c.jql !== undefined)!.jql;
  assert.equal(
    jql,
    "project in (10000) AND assignee is EMPTY AND assignee is not EMPTY ORDER BY updated DESC",
  );
  assert.deepEqual(result.result.issues, []);
});

test("every tool throws JIRA_NOT_FOUND when no selected site can be accessed", async () => {
  const selection = projectItems(`project:${CLOUD_A}:10000`);
  for (const [actionType, request] of [
    ["jira.issue.search", {}],
    ["jira.issue.read", { issueKey: "ENG-1" }],
    ["jira.project.list", {}],
  ] as const) {
    const { fetcher } = buildFetcher({ sites: [] });
    const jira = adapter(fetcher);
    await assert.rejects(
      jira.executeAction(actionInput(actionType, request, selection)),
      (error: unknown) =>
        error instanceof AtlassianApiError &&
        error.statusCode === 404 &&
        error.code === "JIRA_NOT_FOUND" &&
        error.message ===
          "None of the selected Jira sites can be accessed any more. Ask the user to reconnect Jira or choose projects again.",
    );
  }
});

test("list re-checks returned projects against the selection", async () => {
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    // The fake ignores the id filter and returns a project that is not selected.
    projectSearch: () =>
      json({
        values: [
          { id: "10000", key: "KEEP", name: "Kept", projectTypeKey: "software" },
          { id: "99999", key: "SNEAK", name: "Not selected", projectTypeKey: "software" },
        ],
      }),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.project.list",
      {},
      projectItems(`project:${CLOUD_A}:10000`),
    ),
  );
  const projects = result.result.projects as Array<{ key: string }>;
  assert.deepEqual(projects.map((p) => p.key), ["KEEP"]);
  assert.equal(result.result.unavailable, 0);
});

test("comment bodies over 2000 characters are flagged truncated", async () => {
  const longBody = "y".repeat(2500);
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    issue: () =>
      json(
        issueFixture({ id: "1", key: "CMT-1", projectId: "10000", projectKey: "CMT" }),
      ),
    comments: () =>
      json({
        comments: [
          {
            author: { displayName: "Long" },
            created: "2026-11-18T00:00:00.000Z",
            body: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: longBody }] },
              ],
            },
          },
          {
            author: { displayName: "Short" },
            created: "2026-11-18T00:00:00.000Z",
            body: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
            },
          },
        ],
        total: 2,
      }),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.issue.read",
      { issueKey: "CMT-1" },
      projectItems(`project:${CLOUD_A}:10000`),
    ),
  );
  const comments = (result.result.issue as { comments: Array<{ body: string; truncated: boolean }> })
    .comments;
  assert.equal(comments[0]!.body.length, 2000);
  assert.equal(comments[0]!.truncated, true);
  assert.equal(comments[1]!.truncated, false);
});

test("search pages each site independently", async () => {
  let firstCall = true;
  const { fetcher, calls } = buildFetcher({
    sites: [site(1), site(2)],
    searchJql: (siteCloudId) => {
      if (siteCloudId === CLOUD_A && firstCall) {
        return json({
          issues: [
            issueFixture({ id: "1", key: "A-1", projectId: "10000", projectKey: "A" }),
          ],
          nextPageToken: "tokA",
        });
      }
      return json({
        issues: [
          issueFixture({ id: "2", key: "B-2", projectId: "20000", projectKey: "B" }),
        ],
      });
    },
  });
  const jira = adapter(fetcher);
  const first = await jira.executeAction(
    actionInput(
      "jira.issue.search",
      {},
      projectItems(`project:${CLOUD_A}:10000`, `project:${CLOUD_B}:20000`),
    ),
  );
  const nextCursor = first.result.nextCursor as string;
  assert.equal(typeof nextCursor, "string");
  assert.deepEqual(decodeSiteCursor(nextCursor, [CLOUD_A, CLOUD_B]), {
    [CLOUD_A]: "tokA",
    [CLOUD_B]: null,
  });

  firstCall = false;
  const callsBefore = calls.length;
  const second = await jira.executeAction(
    actionInput(
      "jira.issue.search",
      { cursor: nextCursor },
      projectItems(`project:${CLOUD_A}:10000`, `project:${CLOUD_B}:20000`),
    ),
  );
  const followUpJql = calls
    .slice(callsBefore)
    .filter((c) => c.jql !== undefined);
  assert.equal(followUpJql.length, 1);
  assert.equal(followUpJql[0]!.cloudId, CLOUD_A);
  // The follow-up request carries the page token the first page returned.
  assert.equal(followUpJql[0]!.nextPageToken, "tokA");
  // CLOUD_A finished this round: no further pages.
  assert.equal(second.result.nextCursor, null);
});

test("bad cursors are rejected without a request", async () => {
  const selection = projectItems(
    `project:${CLOUD_A}:10000`,
    `project:${CLOUD_B}:20000`,
  );
  const wrongVersion = Buffer.from(
    JSON.stringify({ v: 2, sites: { [CLOUD_A]: null } }),
    "utf8",
  ).toString("base64url");
  const unselectedSite = Buffer.from(
    JSON.stringify({ v: 1, sites: { [CLOUD_C]: "tok" } }),
    "utf8",
  ).toString("base64url");
  const bad = ["not-base64-!!!", wrongVersion, unselectedSite, "a".repeat(5000)];
  for (const cursor of bad) {
    const { fetcher, calls } = buildFetcher({});
    const jira = adapter(fetcher);
    await assert.rejects(
      jira.executeAction(actionInput("jira.issue.search", { cursor }, selection)),
      (error: unknown) =>
        error instanceof AtlassianApiError &&
        error.statusCode === 400 &&
        error.code === "JIRA_INVALID_REQUEST",
    );
    assert.equal(calls.length, 0, `cursor ${cursor.slice(0, 12)} should not reach the network`);
  }
});

test("assignee name resolves to account ids per site", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [site(1), site(2)],
    userSearch: (siteCloudId) =>
      json(
        siteCloudId === CLOUD_A
          ? [{ accountId: "acc-A1" }, { accountId: "acc-A2" }]
          : [{ accountId: "acc-B1" }],
      ),
    searchJql: () => json({ issues: [] }),
  });
  const jira = adapter(fetcher);
  await jira.executeAction(
    actionInput(
      "jira.issue.search",
      { assignee: "Alice" },
      projectItems(`project:${CLOUD_A}:10000`, `project:${CLOUD_B}:20000`),
    ),
  );
  const userCalls = calls.filter((c) => c.url.includes("/user/search"));
  assert.equal(userCalls.length, 2);
  for (const c of userCalls) assert.ok(c.url.includes("query=Alice"));
  const jqlCalls = calls.filter((c) => c.jql !== undefined);
  assert.equal(
    jqlCalls[0]!.jql,
    'project in (10000) AND assignee in ("acc-A1", "acc-A2") ORDER BY updated DESC',
  );
  assert.equal(
    jqlCalls[1]!.jql,
    'project in (20000) AND assignee in ("acc-B1") ORDER BY updated DESC',
  );
});

test("assignee me uses currentUser()", async () => {
  const { fetcher, calls } = buildFetcher({
    sites: [site(1)],
    searchJql: () => json({ issues: [] }),
  });
  const jira = adapter(fetcher);
  await jira.executeAction(
    actionInput(
      "jira.issue.search",
      { assignee: "me" },
      projectItems(`project:${CLOUD_A}:10000`),
    ),
  );
  assert.equal(
    calls.some((c) => c.url.includes("/user/search")),
    false,
  );
  const jql = calls.find((c) => c.jql !== undefined)!.jql;
  assert.equal(
    jql,
    "project in (10000) AND assignee = currentUser() ORDER BY updated DESC",
  );
});

test("read returns the issue from the first site that has it in scope", async () => {
  const { fetcher } = buildFetcher({
    sites: [site(1), site(2)],
    issue: (siteCloudId, key) => {
      assert.equal(key, "SCOPE-7");
      if (siteCloudId === CLOUD_A) {
        // Found on A, but its project is not selected there.
        return json(
          issueFixture({
            id: "700",
            key: "SCOPE-7",
            projectId: "99999",
            projectKey: "OUT",
          }),
        );
      }
      return json(
        issueFixture({
          id: "701",
          key: "SCOPE-7",
          projectId: "20000",
          projectKey: "IN",
          projectName: "In Scope",
        }),
      );
    },
    comments: () => json({ comments: [], total: 0 }),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.issue.read",
      { issueKey: "scope-7" },
      projectItems(`project:${CLOUD_A}:10000`, `project:${CLOUD_B}:20000`),
    ),
  );
  const issue = result.result.issue as Record<string, unknown>;
  assert.equal(issue.key, "SCOPE-7");
  assert.equal(issue.citationKey, `jira:${CLOUD_B}:701`);
  assert.equal(issue.projectKey, "IN");
  assert.equal(issue.url, `https://site2.atlassian.net/browse/SCOPE-7`);
  assert.equal(issue.commentCount, 0);
  assert.deepEqual(issue.comments, []);
});

test("read of an issue in an unselected project is not found", async () => {
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    issue: () =>
      json(
        issueFixture({
          id: "900",
          key: "OUT-9",
          projectId: "99999",
          projectKey: "OUT",
        }),
      ),
  });
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(
      actionInput(
        "jira.issue.read",
        { issueKey: "OUT-9" },
        projectItems(`project:${CLOUD_A}:10000`),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 404 &&
      error.code === "JIRA_NOT_FOUND" &&
      error.message === "Jira issue not found",
  );
});

test("read rejects a malformed key without a request", async () => {
  const { fetcher, calls } = buildFetcher({});
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(
      actionInput(
        "jira.issue.read",
        { issueKey: "not a key!" },
        projectItems(`project:${CLOUD_A}:10000`),
      ),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 400 &&
      error.code === "JIRA_INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("long description is truncated and flagged", async () => {
  const longText = "x".repeat(25000);
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    issue: () =>
      json({
        id: "500",
        key: "LONG-5",
        fields: {
          summary: "Long",
          project: { id: "10000", key: "LONG", name: "Long Project" },
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: longText }] },
            ],
          },
        },
      }),
    comments: () => json({ comments: [], total: 0 }),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.issue.read",
      { issueKey: "LONG-5" },
      projectItems(`project:${CLOUD_A}:10000`),
    ),
  );
  const issue = result.result.issue as Record<string, unknown>;
  assert.equal((issue.description as string).length, 20000);
  assert.equal(issue.descriptionTruncated, true);
});

test("21 comments return 20 and the total", async () => {
  const comments = Array.from({ length: 21 }, (_, i) => ({
    author: { displayName: `Author ${i}` },
    created: "2026-11-18T00:00:00.000Z",
    body: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: `Comment ${i}` }] },
      ],
    },
  }));
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    issue: () =>
      json(
        issueFixture({
          id: "600",
          key: "CMT-6",
          projectId: "10000",
          projectKey: "CMT",
        }),
      ),
    comments: () => json({ comments, total: 21 }),
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.issue.read",
      { issueKey: "CMT-6" },
      projectItems(`project:${CLOUD_A}:10000`),
    ),
  );
  const issue = result.result.issue as Record<string, unknown>;
  assert.equal((issue.comments as unknown[]).length, 20);
  assert.equal(issue.commentCount, 21);
  const firstComment = (issue.comments as Array<{ body: string }>)[0]!;
  assert.equal(firstComment.body, "Comment 0");
});

test("list reports unavailable projects", async () => {
  const { fetcher } = buildFetcher({
    // CLOUD_A accessible; CLOUD_B selected but gone.
    sites: [site(1)],
    projectSearch: (siteCloudId, url) => {
      assert.equal(siteCloudId, CLOUD_A);
      const ids = url.searchParams.getAll("id");
      // 10001 was deleted: only 10000 resolves.
      return json({
        values: ids
          .filter((id) => id === "10000")
          .map((id) => ({
            id,
            key: "KEEP",
            name: "Kept Project",
            projectTypeKey: "software",
            lead: { displayName: "Lead Person" },
          })),
      });
    },
  });
  const jira = adapter(fetcher);
  const result = await jira.executeAction(
    actionInput(
      "jira.project.list",
      {},
      projectItems(
        `project:${CLOUD_A}:10000`,
        `project:${CLOUD_A}:10001`,
        `project:${CLOUD_B}:20000`,
      ),
    ),
  );
  assert.deepEqual(result.result, {
    projects: [
      {
        key: "KEEP",
        name: "Kept Project",
        projectType: "software",
        lead: "Lead Person",
        url: "https://site1.atlassian.net/browse/KEEP",
        siteName: "Site 1",
      },
    ],
    // 10001 deleted on A, plus 20000 on the lost site B.
    unavailable: 2,
  });
});

test("429 surfaces JIRA_RATE_LIMITED with retryAfterSeconds", async () => {
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    searchJql: () =>
      json({ errorMessages: ["rate limited"] }, {
        status: 429,
        headers: { "Retry-After": "42" },
      }),
  });
  const jira = adapter(fetcher);
  await assert.rejects(
    jira.executeAction(
      actionInput("jira.issue.search", {}, projectItems(`project:${CLOUD_A}:10000`)),
    ),
    (error: unknown) =>
      error instanceof AtlassianApiError &&
      error.statusCode === 429 &&
      error.code === "JIRA_RATE_LIMITED" &&
      error.details?.retryAfterSeconds === 42,
  );
});

test("results contain no token", async () => {
  const { fetcher } = buildFetcher({
    sites: [site(1)],
    searchJql: () =>
      json({
        issues: [
          issueFixture({ id: "1", key: "T-1", projectId: "10000", projectKey: "T" }),
        ],
      }),
    issue: () =>
      json(
        issueFixture({
          id: "1",
          key: "T-1",
          projectId: "10000",
          projectKey: "T",
        }),
      ),
    comments: () => json({ comments: [], total: 0 }),
    projectSearch: (_cloudId, url) => {
      const ids = url.searchParams.getAll("id");
      return json({
        values: ids.map((id) => ({ id, key: "T", name: "T Project" })),
      });
    },
  });
  const jira = adapter(fetcher);
  const selection = projectItems(`project:${CLOUD_A}:10000`);
  const search = await jira.executeAction(
    actionInput("jira.issue.search", {}, selection),
  );
  const read = await jira.executeAction(
    actionInput("jira.issue.read", { issueKey: "T-1" }, selection),
  );
  const list = await jira.executeAction(
    actionInput("jira.project.list", {}, selection),
  );
  // Check the whole action result each tool returns, not only its `result`
  // payload: no token anywhere, and no raw-response field on the envelope.
  for (const actionResult of [search, read, list]) {
    assert.equal(JSON.stringify(actionResult).includes(ACCESS_TOKEN), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(actionResult, "rawResponseJson"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(actionResult, "resultJson"),
      false,
    );
  }
});
