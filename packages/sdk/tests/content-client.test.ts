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
