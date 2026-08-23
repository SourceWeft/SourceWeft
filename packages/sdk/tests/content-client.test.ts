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
