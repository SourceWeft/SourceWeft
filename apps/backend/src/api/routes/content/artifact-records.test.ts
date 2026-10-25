import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createWorkspaceRouteTestApp } from "../../../test/hono";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  execute: vi.fn(),
  status: vi.fn(),
  approveShared: vi.fn(),
  revokeShared: vi.fn(),
  grantConsent: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.requireSession,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));

vi.mock("../../../modules/artifact-records", async () => {
  const { ContentError } = await import("../../../modules/content/errors");
  return {
    artifactRecordsService: {
      execute: mocks.execute,
      status: mocks.status,
      approveShared: mocks.approveShared,
      revokeShared: mocks.revokeShared,
      grantConsent: mocks.grantConsent,
    },
    artifactRecordError: (code: string, message: string) =>
      new ContentError(
        code === "forbidden" ? 403 : 400,
        `ARTIFACT_RECORD_${code.toUpperCase()}`,
        message,
      ),
  };
});

import { registerArtifactRecordRoutes } from "./artifact-records";

const app = () => createWorkspaceRouteTestApp(registerArtifactRecordRoutes);

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app().request(`/v1/workspaces/ws-1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "s", userId: "user-1" },
  });
  mocks.execute.mockResolvedValue({ op: "get", record: null });
});

test("the host's operation reaches the service with identity from the session", async () => {
  const response = await post("/artifacts/art-1/records", {
    versionId: "ver-1",
    operation: { op: "get", collection: "kv", id: "draft" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { op: "get", record: null });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(mocks.execute.mock.calls[0]![0], {
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "user-1",
    versionId: "ver-1",
    operation: { op: "get", scope: "user", collection: "kv", id: "draft" },
  });
});

test("requests that name host-owned fields or bad shapes are refused", async () => {
  for (const body of [
    {
      versionId: "ver-1",
      ownerUserId: "x",
      operation: { op: "get", collection: "kv", id: "a" },
    },
    {
      versionId: "ver-1",
      operation: { op: "get", collection: "kv", id: "a", artifactId: "b" },
    },
    { versionId: "ver-1", operation: { op: "drop", collection: "kv" } },
    { operation: { op: "get", collection: "kv", id: "a" } },
  ]) {
    const response = await post("/artifacts/art-1/records", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(
      (await response.json()).code,
      "ARTIFACT_RECORD_INVALID_REQUEST",
    );
  }
  assert.equal(mocks.execute.mock.calls.length, 0);
});

test("opaque origins, non-JSON bodies and oversized requests never reach the service", async () => {
  const body = {
    versionId: "v",
    operation: { op: "get", collection: "kv", id: "a" },
  };
  assert.equal(
    (await post("/artifacts/a/records", body, { origin: "null" })).status,
    403,
  );
  assert.equal(
    (await post("/artifacts/a/records", body, { "content-type": "text/plain" }))
      .status,
    400,
  );
  const huge = JSON.stringify({ ...body, pad: "x".repeat(400 * 1024) });
  assert.equal((await post("/artifacts/a/records", huge)).status, 400);
  assert.equal((await post("/artifacts/a/records", "{not json")).status, 400);
  assert.equal(mocks.execute.mock.calls.length, 0);
});

test("the body limit holds without a trustworthy Content-Length", async () => {
  const chunk = new TextEncoder().encode(`${"x".repeat(64 * 1024)}`);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(chunk);
      if (pulled >= 1000) controller.close();
    },
  });
  const response = await app().request(
    "/v1/workspaces/ws-1/artifacts/a/records",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error Node's fetch needs this for a streamed request body.
      duplex: "half",
    },
  );
  assert.equal(response.status, 400);
  // Reading stopped at the limit instead of draining all 1000 chunks.
  assert.ok(pulled < 20, `pulled ${pulled} chunks`);
  assert.equal(mocks.execute.mock.calls.length, 0);
});

test("unauthenticated requests are rejected", async () => {
  mocks.requireSession.mockResolvedValue(null);
  const response = await post("/artifacts/a/records", {
    versionId: "v",
    operation: { op: "get", collection: "kv", id: "a" },
  });
  assert.equal(response.status, 401);
});

test("approval and consent routes are JSON-only mutations bound to the version", async () => {
  mocks.approveShared.mockResolvedValue({ approvedAt: "t" });
  mocks.grantConsent.mockResolvedValue({ consented: true });
  mocks.revokeShared.mockResolvedValue({ revoked: true });
  const expected = {
    workspaceId: "ws-1",
    artifactId: "a",
    versionId: "v",
    userId: "user-1",
  };

  assert.equal(
    (await post("/artifacts/a/versions/v/records/approval", {})).status,
    200,
  );
  assert.deepEqual(mocks.approveShared.mock.calls[0]![0], expected);
  assert.equal(
    (
      await post("/artifacts/a/versions/v/records/approval", "", {
        "content-type": "application/x-www-form-urlencoded",
      })
    ).status,
    400,
  );
  assert.equal(mocks.approveShared.mock.calls.length, 1);

  assert.equal(
    (await post("/artifacts/a/versions/v/records/consent", {})).status,
    200,
  );
  assert.deepEqual(mocks.grantConsent.mock.calls[0]![0], expected);

  const revoke = await app().request(
    "/v1/workspaces/ws-1/artifacts/a/versions/v/records/approval",
    {
      method: "DELETE",
    },
  );
  assert.equal(revoke.status, 200);
  const opaque = await app().request(
    "/v1/workspaces/ws-1/artifacts/a/versions/v/records/approval",
    {
      method: "DELETE",
      headers: { origin: "null" },
    },
  );
  assert.equal(opaque.status, 403);
  assert.deepEqual(mocks.revokeShared.mock.calls[0]![0], expected);
});

test("status is a private, uncached read", async () => {
  mocks.status.mockResolvedValue({ storage: true });
  const response = await app().request(
    "/v1/workspaces/ws-1/artifacts/a/versions/v/records/status",
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(mocks.status.mock.calls[0]![0], {
    workspaceId: "ws-1",
    artifactId: "a",
    versionId: "v",
    userId: "user-1",
  });
});
