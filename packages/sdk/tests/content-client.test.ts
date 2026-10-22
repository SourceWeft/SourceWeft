import assert from "node:assert/strict";
import test from "node:test";
import { ContentClient } from "../src/content-client";

function recordingClient() {
  const paths: string[] = [];
  const client = new ContentClient({
    get: async (path: string) => {
      paths.push(path);
      return { items: [], nextCursor: null };
    },
  } as never);
  return { client, paths };
}

test("listArtifactSummaries sends the bounded view with encoded pagination", async () => {
  const { client, paths } = recordingClient();

  await client.listArtifactSummaries("workspace / one", {
    cursor: "created + id",
    limit: 25,
  });

  assert.deepEqual(paths, [
    "/v1/workspaces/workspace%20%2F%20one/artifacts?view=summary&limit=25&cursor=created+%2B+id",
  ]);
});

test("listThreadModelSelectorCatalog requests the selector projection", async () => {
  const { client, paths } = recordingClient();

  await client.listThreadModelSelectorCatalog("workspace / one");

  assert.deepEqual(paths, [
    "/v1/workspaces/workspace%20%2F%20one/model-gateway/models?view=selector",
  ]);
});

for (const desktopOnly of [true, false, undefined]) {
  test(`MCP list pagination and category counts preserve device filter ${desktopOnly}`, async () => {
    const { client, paths } = recordingClient();
    const filter = { includeDesktopOnly: true, desktopOnly, query: "files" };
    await client.listWorkspaceMarketMcp("workspace", {
      ...filter,
      cursor: "page + two",
      limit: 100,
    });
    await client.getWorkspaceMarketMcpCategoryCounts("workspace", filter);
    for (const path of paths) {
      const url = new URL(path, "https://example.test");
      assert.equal(url.searchParams.get("includeDesktopOnly"), "true");
      assert.equal(
        url.searchParams.get("desktopOnly"),
        desktopOnly === undefined ? null : String(desktopOnly),
      );
      assert.equal(url.searchParams.get("query"), "files");
    }
    assert.equal(
      new URL(paths[0]!, "https://example.test").searchParams.get("cursor"),
      "page + two",
    );
  });
}

test("the workspace MCP list and detail ask for AI text in a locale only when given one", async () => {
  const { client, paths } = recordingClient();

  await client.listWorkspaceMarketMcp("workspace", { locale: "zh-TW" });
  await client.getWorkspaceMarketMcp("workspace", "io.github.o/weather", {
    locale: "zh-CN",
  });
  await client.getWorkspaceMarketMcp("workspace", "io.github.o/weather");

  assert.deepEqual(paths, [
    "/v1/workspaces/workspace/market/mcp?locale=zh-TW",
    "/v1/workspaces/workspace/market/mcp/io.github.o%2Fweather?locale=zh-CN",
    "/v1/workspaces/workspace/market/mcp/io.github.o%2Fweather",
  ]);
});

test("listSkillsCatalog stays parameterless by default and encodes paging when asked", async () => {
  const { client, paths } = recordingClient();

  await client.listSkillsCatalog("workspace / one");
  await client.listSkillsCatalog("workspace / one", {
    limit: 100,
    cursor: "page + two",
    q: "pdf tools",
  });
  await client.getSkillCatalogDetailBySlug("workspace / one", "gh-owner/x");

  assert.deepEqual(paths, [
    "/v1/workspaces/workspace%20%2F%20one/skills/catalog",
    "/v1/workspaces/workspace%20%2F%20one/skills/catalog?limit=100&cursor=page+%2B+two&q=pdf+tools",
    "/v1/workspaces/workspace%20%2F%20one/skills/catalog/by-slug/gh-owner%2Fx",
  ]);
});

test("skill submissions address the async ingest endpoints with encoded ids and paging", async () => {
  const paths: string[] = [];
  const bodies: unknown[] = [];
  const client = new ContentClient({
    get: async (path: string) => {
      paths.push(`GET ${path}`);
      return {};
    },
    post: async (path: string, body: unknown) => {
      paths.push(`POST ${path}`);
      bodies.push(body);
      return {};
    },
  } as never);

  await client.createSkillSubmission("workspace / one", {
    source: "owner/repo",
    install: { skill: "pdf" },
  });
  await client.listSkillSubmissions("workspace / one");
  await client.listSkillSubmissions("workspace / one", {
    limit: 10,
    cursor: "page + two",
  });
  await client.getSkillSubmission("workspace / one", "sub/1");
  await client.retrySkillSubmission("workspace / one", "sub/1");

  const base = "/v1/workspaces/workspace%20%2F%20one/skills/registry/submissions";
  assert.deepEqual(paths, [
    `POST ${base}`,
    `GET ${base}`,
    `GET ${base}?limit=10&cursor=page+%2B+two`,
    `GET ${base}/sub%2F1`,
    `POST ${base}/sub%2F1/retry`,
  ]);
  assert.deepEqual(bodies[0], {
    source: "owner/repo",
    install: { skill: "pdf" },
  });
  // The synchronous `/skills/registry/submit` endpoint no longer exists.
  assert.equal("submitRegistrySkill" in client, false);
});

test("workspace category lists ask for the reader's language", async () => {
  const { client, paths } = recordingClient();
  await client.listWorkspaceMarketMcpCategories("workspace", {
    locale: "zh-TW",
  });
  await client.listWorkspaceMarketMcpCategories("workspace");
  await client.listSkillCatalogCategories("workspace", { locale: "zh-CN" });
  await client.listSkillCatalogCategories("workspace");
  assert.deepEqual(paths, [
    "/v1/workspaces/workspace/market/mcp/categories?locale=zh-TW",
    "/v1/workspaces/workspace/market/mcp/categories",
    "/v1/workspaces/workspace/skills/catalog/categories?locale=zh-CN",
    "/v1/workspaces/workspace/skills/catalog/categories",
  ]);
});

test("readArtifactVersionSourceFile addresses the member-only exact-version source route and returns the parsed JSON", async () => {
  const paths: string[] = [];
  const client = new ContentClient({
    get: async (path: string) => {
      paths.push(path);
      return { sources: [{ id: "S1" }] };
    },
  } as never);

  const document = await client.readArtifactVersionSourceFile(
    "workspace / one",
    "artifact 1",
    "version/1",
    "report.source.json",
  );

  assert.deepEqual(paths, [
    "/v1/workspaces/workspace%20%2F%20one/artifacts/artifact%201/versions/version%2F1/source-files/report.source.json",
  ]);
  assert.deepEqual(document, { sources: [{ id: "S1" }] });
});

test("stopThreadRun posts the run's stop key to the thread stream without streaming", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const client = new ContentClient({
    post: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      return {
        threadRun: {
          id: "run-1",
          idempotencyKey: "sourceweft-web-run:key-1",
          status: "cancelled",
          mode: "send",
        },
      };
    },
  } as never);

  const result = await client.stopThreadRun(
    "workspace / one",
    "thread?two",
    "sourceweft-web-run:key-1",
  );

  assert.deepEqual(calls, [
    {
      path: "/v1/workspaces/workspace%20%2F%20one/threads/thread%3Ftwo/stream",
      body: {
        idempotencyKey: "sourceweft-web-run:key-1:stop",
        stream: false,
      },
    },
  ]);
  assert.equal(result.threadRun.status, "cancelled");
});

test("listThreadMessages restores tool-call outputs compacted by the API", async () => {
  const operation = { operationType: "execute", status: "succeeded" };
  const client = new ContentClient({
    get: async () => ({
      items: [
        {
          id: "assistant-1",
          role: "assistant",
          metadata: {
            toolCallOperationPool: [operation],
            toolCalls: [
              {
                id: "call-1",
                tool: "execute",
                output: {
                  content: "done",
                  lc_kwargs: { id: "message-1" },
                  lcKwargsMirrored: ["content"],
                  operationRefs: [0],
                },
              },
            ],
          },
        },
        { id: "user-1", role: "user", metadata: {} },
      ],
      nextCursor: null,
    }),
  } as never);

  const page = await client.listThreadMessages("workspace-1", "thread-1");

  assert.deepEqual(page.items[0]?.metadata, {
    toolCalls: [
      {
        id: "call-1",
        tool: "execute",
        output: {
          content: "done",
          lc_kwargs: { id: "message-1", content: "done" },
          operations: [operation],
        },
      },
    ],
  });
  assert.deepEqual(page.items[1]?.metadata, {});
  assert.equal(page.nextCursor, null);
});
