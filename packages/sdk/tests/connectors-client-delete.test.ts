import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorsClient } from "../src/connectors-client";

class RecordingHttpClient {
  readonly deletes: string[] = [];
  readonly gets: string[] = [];

  async delete<T>(path: string): Promise<T> {
    this.deletes.push(path);
    return {} as T;
  }

  async get<T>(path: string): Promise<T> {
    this.gets.push(path);
    return {} as T;
  }
}

test("ConnectorsClient.delete hard deletes by default", async () => {
  const http = new RecordingHttpClient();
  const client = new ConnectorsClient(http as never);

  await client.delete("workspace 1", "connector/1");

  assert.deepEqual(http.deletes, [
    "/v1/workspaces/workspace%201/connectors/connector%2F1",
  ]);
});

test("ConnectorsClient.list can include disabled connectors", async () => {
  const http = new RecordingHttpClient();
  const client = new ConnectorsClient(http as never);

  await client.list("workspace_1", { includeDisabled: true });

  assert.deepEqual(http.gets, [
    "/v1/workspaces/workspace_1/connectors?includeDisabled=true",
  ]);
});

test("ConnectorsClient.delete can request disable", async () => {
  const http = new RecordingHttpClient();
  const client = new ConnectorsClient(http as never);

  await client.delete("workspace_1", "connector_1", {
    disable: true,
  });

  assert.deepEqual(http.deletes, [
    "/v1/workspaces/workspace_1/connectors/connector_1?disable=true",
  ]);
});

test("ConnectorsClient.deleteAccount does not force detach connectors", async () => {
  const http = new RecordingHttpClient();
  const client = new ConnectorsClient(http as never);

  await client.deleteAccount("workspace_1", "account_1");

  assert.deepEqual(http.deletes, [
    "/v1/workspaces/workspace_1/connectors/accounts/account_1",
  ]);
});
