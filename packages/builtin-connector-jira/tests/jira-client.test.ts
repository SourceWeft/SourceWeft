import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError, type AtlassianClientConfig } from "@sourceweft/atlassian-client";
import { createJiraClient } from "../src/jira-client";

const CLOUD_ID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "access-token";

type RecordedCall = { url: string; init: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingFetcher(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetcher, calls };
}

function config(fetcher: typeof fetch): AtlassianClientConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    errorPrefix: "JIRA",
    fetcher,
  };
}

function queryParams(call: RecordedCall, key: string): string[] {
  return new URL(call.url).searchParams.getAll(key);
}

function expectCall(calls: RecordedCall[], index: number): RecordedCall {
  const call = calls[index];
  assert.ok(call, `expected a recorded call at index ${index}`);
  return call;
}

test("listProjects requests project/search with query, startAt, maxResults, orderBy=name, expand=lead", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      values: [
        { id: "10000", key: "ABC", name: "Alpha", projectTypeKey: "software", lead: { displayName: "Lee" } },
      ],
      isLast: true,
      startAt: 0,
      maxResults: 25,
      total: 1,
    }),
  );
  const client = createJiraClient(config(fetcher));

  const result = await client.listProjects(TOKEN, CLOUD_ID, { query: "alp", startAt: 0, maxResults: 25 });

  assert.equal(calls.length, 1);
  const call = expectCall(calls, 0);
  assert.equal(call.init.method ?? "GET", "GET");
  assert.ok(call.url.includes(`/ex/jira/${CLOUD_ID}/rest/api/3/project/search`));
  const url = new URL(call.url);
  assert.equal(url.searchParams.get("query"), "alp");
  assert.equal(url.searchParams.get("startAt"), "0");
  assert.equal(url.searchParams.get("maxResults"), "25");
  assert.equal(url.searchParams.get("orderBy"), "name");
  assert.equal(url.searchParams.get("expand"), "lead");

  assert.deepEqual(result, {
    projects: [
      { id: "10000", key: "ABC", name: "Alpha", projectTypeKey: "software", leadName: "Lee" },
    ],
    isLast: true,
    nextStartAt: 1,
  });
});

test("getProjectsByIds chunks ids by 50 and repeats the id parameter per request", async () => {
  const projectIds = Array.from({ length: 120 }, (_, i) => String(10000 + i));
  const { fetcher, calls } = recordingFetcher((call) => {
    const ids = queryParams(call, "id");
    return json({ values: ids.map((id) => ({ id, key: `P${id}`, name: id })) });
  });
  const client = createJiraClient(config(fetcher));

  const projects = await client.getProjectsByIds(TOKEN, CLOUD_ID, projectIds);

  assert.equal(calls.length, 3);
  assert.equal(queryParams(expectCall(calls, 0), "id").length, 50);
  assert.equal(queryParams(expectCall(calls, 1), "id").length, 50);
  assert.equal(queryParams(expectCall(calls, 2), "id").length, 20);
  assert.equal(projects.length, 120);
});

test("getProjectsByIds returns no projects and makes no request for an empty id list", async () => {
  const { fetcher, calls } = recordingFetcher(() => json({ values: [] }));
  const client = createJiraClient(config(fetcher));

  const projects = await client.getProjectsByIds(TOKEN, CLOUD_ID, []);

  assert.deepEqual(projects, []);
  assert.equal(calls.length, 0);
});

test("searchIssues POSTs the jql, maxResults, nextPageToken and fixed fields list", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      issues: [
        {
          id: "90001",
          key: "ABC-1",
          fields: {
            summary: "Fix the thing",
            status: { name: "Open" },
            issuetype: { name: "Bug" },
            priority: { name: "High" },
            assignee: { displayName: "Ada" },
            updated: "2026-01-01T00:00:00.000Z",
            project: { id: "10000", key: "ABC", name: "Alpha" },
          },
        },
      ],
      nextPageToken: "page-2",
    }),
  );
  const client = createJiraClient(config(fetcher));

  const result = await client.searchIssues(TOKEN, CLOUD_ID, {
    jql: "project in (10000) ORDER BY updated DESC",
    nextPageToken: "page-1",
    maxResults: 25,
  });

  assert.equal(calls.length, 1);
  const call = expectCall(calls, 0);
  assert.equal(call.init.method, "POST");
  assert.ok(call.url.includes(`/ex/jira/${CLOUD_ID}/rest/api/3/search/jql`));
  const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.equal(body.jql, "project in (10000) ORDER BY updated DESC");
  assert.equal(body.maxResults, 25);
  assert.equal(body.nextPageToken, "page-1");
  assert.deepEqual(body.fields, ["summary", "status", "issuetype", "priority", "assignee", "updated", "project"]);

  assert.deepEqual(result, {
    issues: [
      {
        id: "90001",
        key: "ABC-1",
        projectId: "10000",
        projectKey: "ABC",
        projectName: "Alpha",
        summary: "Fix the thing",
        status: "Open",
        issueType: "Bug",
        priority: "High",
        assignee: "Ada",
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
    nextPageToken: "page-2",
  });
});

test("searchIssues maps an absent nextPageToken to null (last page)", async () => {
  const { fetcher } = recordingFetcher(() => json({ issues: [] }));
  const client = createJiraClient(config(fetcher));

  const result = await client.searchIssues(TOKEN, CLOUD_ID, {
    jql: "project in (10000) ORDER BY updated DESC",
    maxResults: 25,
  });

  assert.equal(result.nextPageToken, null);
});

test("getIssue requests the fixed fields list with the key path-encoded", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      id: "90001",
      key: "ABC-1",
      fields: {
        summary: "Fix the thing",
        status: { name: "Open" },
        issuetype: { name: "Bug" },
        priority: { name: "High" },
        assignee: { displayName: "Ada" },
        reporter: { displayName: "Grace" },
        labels: ["urgent", "backend"],
        created: "2025-12-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        description: { type: "doc", content: [] },
        project: { id: "10000", key: "ABC", name: "Alpha" },
      },
    }),
  );
  const client = createJiraClient(config(fetcher));

  const issue = await client.getIssue(TOKEN, CLOUD_ID, "ABC/1 weird");

  assert.equal(calls.length, 1);
  const call = expectCall(calls, 0);
  assert.ok(call.url.includes(`/rest/api/3/issue/${encodeURIComponent("ABC/1 weird")}`));
  const url = new URL(call.url);
  assert.equal(
    url.searchParams.get("fields"),
    "summary,status,issuetype,priority,assignee,reporter,labels,created,updated,description,project",
  );

  assert.deepEqual(issue, {
    id: "90001",
    key: "ABC-1",
    projectId: "10000",
    projectKey: "ABC",
    projectName: "Alpha",
    summary: "Fix the thing",
    status: "Open",
    issueType: "Bug",
    priority: "High",
    assignee: "Ada",
    updated: "2026-01-01T00:00:00.000Z",
    reporter: "Grace",
    labels: ["urgent", "backend"],
    created: "2025-12-01T00:00:00.000Z",
    description: { type: "doc", content: [] },
  });
});

test("getIssue 404 returns null", async () => {
  const { fetcher } = recordingFetcher(() => json({}, 404));
  const client = createJiraClient(config(fetcher));

  const issue = await client.getIssue(TOKEN, CLOUD_ID, "ABC-404");

  assert.equal(issue, null);
});

test("getIssue missing nested fields map to null and labels default to an empty array", async () => {
  const { fetcher } = recordingFetcher(() =>
    json({
      id: "90002",
      key: "ABC-2",
      fields: { summary: "No extras" },
    }),
  );
  const client = createJiraClient(config(fetcher));

  const issue = await client.getIssue(TOKEN, CLOUD_ID, "ABC-2");

  assert.deepEqual(issue, {
    id: "90002",
    key: "ABC-2",
    projectId: null,
    projectKey: null,
    projectName: null,
    summary: "No extras",
    status: null,
    issueType: null,
    priority: null,
    assignee: null,
    updated: null,
    reporter: null,
    labels: [],
    created: null,
    description: null,
  });
});

test("401 surfaces JIRA_REAUTH_REQUIRED", async () => {
  const { fetcher } = recordingFetcher(() => json({}, 401));
  const client = createJiraClient(config(fetcher));

  await assert.rejects(client.getIssue(TOKEN, CLOUD_ID, "ABC-1"), (error) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "JIRA_REAUTH_REQUIRED");
    return true;
  });
});

test("listComments requests maxResults and orderBy=created and maps comments and total", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json({
      comments: [
        { author: { displayName: "Ada" }, created: "2026-01-01T00:00:00.000Z", body: { type: "doc" } },
        { created: "2026-01-02T00:00:00.000Z" },
      ],
      total: 7,
    }),
  );
  const client = createJiraClient(config(fetcher));

  const result = await client.listComments(TOKEN, CLOUD_ID, "ABC-1", 20);

  assert.equal(calls.length, 1);
  const call = expectCall(calls, 0);
  const url = new URL(call.url);
  assert.ok(call.url.includes("/rest/api/3/issue/ABC-1/comment"));
  assert.equal(url.searchParams.get("maxResults"), "20");
  assert.equal(url.searchParams.get("orderBy"), "created");

  assert.deepEqual(result, {
    comments: [
      { author: "Ada", created: "2026-01-01T00:00:00.000Z", body: { type: "doc" } },
      { author: null, created: "2026-01-02T00:00:00.000Z", body: null },
    ],
    total: 7,
  });
});

test("findAccountIds requests user/search with query and maxResults and returns account ids", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    json([
      { accountId: "acc-1", displayName: "Ada" },
      { accountId: "acc-2", displayName: "Ada Two" },
    ]),
  );
  const client = createJiraClient(config(fetcher));

  const ids = await client.findAccountIds(TOKEN, CLOUD_ID, "Ada", 5);

  assert.equal(calls.length, 1);
  const call = expectCall(calls, 0);
  const url = new URL(call.url);
  assert.ok(call.url.includes("/rest/api/3/user/search"));
  assert.equal(url.searchParams.get("query"), "Ada");
  assert.equal(url.searchParams.get("maxResults"), "5");
  assert.deepEqual(ids, ["acc-1", "acc-2"]);
});
