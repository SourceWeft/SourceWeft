import assert from "node:assert/strict";
import test from "node:test";
import { ContentClient } from "../src/content-client";

function recordingClient() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = new ContentClient({
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return {};
    },
    post: async (path: string, body: unknown) => {
      calls.push({ method: "POST", path, body });
      return {};
    },
  } as never);
  return { client, calls };
}

const request = {
  threadId: "thread 1",
  artifactType: "quiz" as const,
  sourceIds: ["src_1"],
  options: { size: "fewer" as const },
};

test("study generation methods call the workspace study routes", async () => {
  const { client, calls } = recordingClient();
  await client.estimateStudy("ws / 1", request);
  await client.generateStudyArtifact("ws / 1", request);
  await client.regenerateStudyArtifact("ws / 1", "art/1", { focus: "dates" });
  await client.regenerateStudyArtifact("ws / 1", "art/1");
  await client.getStudyFreshness("ws / 1", "art/1");

  assert.deepEqual(
    calls.map(({ method, path }) => `${method} ${path}`),
    [
      "POST /v1/workspaces/ws%20%2F%201/study/estimate",
      "POST /v1/workspaces/ws%20%2F%201/study/artifacts",
      "POST /v1/workspaces/ws%20%2F%201/study/artifacts/art%2F1/regenerate",
      "POST /v1/workspaces/ws%20%2F%201/study/artifacts/art%2F1/regenerate",
      "GET /v1/workspaces/ws%20%2F%201/study/artifacts/art%2F1/freshness",
    ],
  );
  assert.deepEqual(calls[1]?.body, request);
  assert.deepEqual(calls[2]?.body, { focus: "dates" });
  assert.deepEqual(calls[3]?.body, {});
});
