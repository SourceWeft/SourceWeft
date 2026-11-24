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

test("checkConfig forwards a credential for a credential connector", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = new ConnectorsClient({
    post: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { ready: true };
    },
  } as never);

  await client.checkConfig("ws", {
    connectorType: "webdav",
    configJson: { endpoint: "https://dav.example.com", roots: ["/"] },
    credential: { username: "alice", secret: "app-pass" },
  });

  assert.deepEqual(calls, [
    {
      path: "/v1/workspaces/ws/connectors/check",
      body: {
        connectorType: "webdav",
        configJson: { endpoint: "https://dav.example.com", roots: ["/"] },
        credential: { username: "alice", secret: "app-pass" },
      },
    },
  ]);
});

test("rotateCredential puts the credential to the connector credential path", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = new ConnectorsClient({
    put: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { credentialConfigured: true, displayName: "alice" };
    },
  } as never);

  const result = await client.rotateCredential("ws / one", "conn / 1", {
    username: "alice",
    secret: "new-pass",
  });

  assert.deepEqual(result, { credentialConfigured: true, displayName: "alice" });
  assert.deepEqual(calls, [
    {
      path: "/v1/workspaces/ws%20%2F%20one/connectors/conn%20%2F%201/credential",
      body: { username: "alice", secret: "new-pass" },
    },
  ]);
});
