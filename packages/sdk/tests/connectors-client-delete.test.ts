import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorsClient } from "../src/connectors-client";

class RecordingHttpClient {
  readonly deletes: string[] = [];

  async delete<T>(path: string): Promise<T> {
    this.deletes.push(path);
    return {} as T;
  }
}

test("ConnectorsClient.delete keeps indexed content by default", async () => {
  const http = new RecordingHttpClient();
  const client = new ConnectorsClient(http as never);

  await client.delete("workspace 1", "connector/1");

  assert.deepEqual(http.deletes, [
    "/v1/workspaces/workspace%201/connectors/connector%2F1",
  ]);
});

test("ConnectorsClient.delete can request indexed content purge", async () => {
  const http = new RecordingHttpClient();
  const client = new ConnectorsClient(http as never);

  await client.delete("workspace_1", "connector_1", {
    purgeIndexedContent: true,
  });

  assert.deepEqual(http.deletes, [
    "/v1/workspaces/workspace_1/connectors/connector_1?purgeIndexedContent=true",
  ]);
});

test("ConnectorsClient.deleteAccount can force detach connectors", async () => {
  const http = new RecordingHttpClient();
  const client = new ConnectorsClient(http as never);

  await client.deleteAccount("workspace_1", "account_1", { force: true });

  assert.deepEqual(http.deletes, [
    "/v1/workspaces/workspace_1/connectors/accounts/account_1?force=true",
  ]);
});
