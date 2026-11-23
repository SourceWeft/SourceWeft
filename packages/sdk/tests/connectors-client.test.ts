import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorsClient } from "../src/connectors-client";

test("checkConfig posts the type and config to the pre-create check path", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = new ConnectorsClient({
    post: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { ready: true };
    },
  } as never);

  const result = await client.checkConfig("workspace / one", {
    connectorType: "rss",
    configJson: { feedUrl: "https://example.com/feed.xml" },
  });

  assert.deepEqual(result, { ready: true });
  assert.deepEqual(calls, [
    {
      path: "/v1/workspaces/workspace%20%2F%20one/connectors/check",
      body: {
        connectorType: "rss",
        configJson: { feedUrl: "https://example.com/feed.xml" },
      },
    },
  ]);
});
