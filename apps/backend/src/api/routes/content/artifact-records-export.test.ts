import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createWorkspaceRouteTestApp } from "../../../test/hono";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  exportRecords: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.requireSession,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));

vi.mock("../../../modules/artifact-records", async () => {
  const { ContentError } = await import("../../../modules/content/errors");
  return {
    artifactRecordsExportService: {
      export: mocks.exportRecords,
      clear: mocks.clear,
    },
    artifactRecordError: (code: string, message: string) =>
      new ContentError(
        code === "forbidden" ? 403 : 400,
        `ARTIFACT_RECORD_${code.toUpperCase()}`,
        message,
      ),
  };
});
// The sibling records route module is imported for its origin check only.
vi.mock("./artifact-records", async () => {
  const { ContentError } = await import("../../../modules/content/errors");
  return {
    rejectOpaqueOrigin: (c: {
      req: { header(name: string): string | undefined };
    }) => {
      if (c.req.header("origin") === "null")
        throw new ContentError(403, "ARTIFACT_RECORD_FORBIDDEN", "opaque");
    },
  };
});

import { registerArtifactRecordExportRoutes } from "./artifact-records-export";

const app = () =>
  createWorkspaceRouteTestApp(registerArtifactRecordExportRoutes);

function request(method: string, path: string, headers = {}) {
  return app().request(`/v1/workspaces/ws-1${path}`, { method, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "s", userId: "user-1" },
  });
  mocks.exportRecords.mockImplementation(async () => ({
    filename: "art-1-user-records.json",
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"records":[]}'));
        controller.close();
      },
    }),
  }));
  mocks.clear.mockResolvedValue({ removed: 2 });
});

test("export streams an attachment with identity from the session only", async () => {
  const response = await request(
    "GET",
    "/artifacts/art-1/records/export?scope=user&ownerUserId=someone-else",
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"records":[]}');
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="art-1-user-records\.json"$/u,
  );
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/u,
  );
  assert.deepEqual(mocks.exportRecords.mock.calls[0]![0], {
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "user-1",
    scope: "user",
    collection: undefined,
  });
});

test("clear returns the removed count and passes the collection", async () => {
  const response = await request(
    "DELETE",
    "/artifacts/art-1/records?scope=shared&collection=scores",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: 2 });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(mocks.clear.mock.calls[0]![0], {
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "user-1",
    scope: "shared",
    collection: "scores",
  });
});

test("scope is required and collection must be a valid name", async () => {
  for (const [method, path] of [
    ["GET", "/artifacts/a/records/export"],
    ["GET", "/artifacts/a/records/export?scope=everyone"],
    ["DELETE", "/artifacts/a/records"],
    ["DELETE", "/artifacts/a/records?scope=all"],
    ["DELETE", "/artifacts/a/records?scope=user&collection=a%20b"],
    ["DELETE", "/artifacts/a/records?scope=user&collection="],
  ] as const) {
    const response = await request(method, path);
    assert.equal(response.status, 400, `${method} ${path}`);
  }
  assert.equal(mocks.exportRecords.mock.calls.length, 0);
  assert.equal(mocks.clear.mock.calls.length, 0);
});

test("signed-out callers and opaque origins never reach the service", async () => {
  mocks.requireSession.mockResolvedValueOnce(null);
  assert.equal(
    (await request("DELETE", "/artifacts/a/records?scope=user")).status,
    401,
  );
  assert.equal(
    (
      await request("GET", "/artifacts/a/records/export?scope=user", {
        origin: "null",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("DELETE", "/artifacts/a/records?scope=user", {
        origin: "null",
      })
    ).status,
    403,
  );
  assert.equal(mocks.exportRecords.mock.calls.length, 0);
  assert.equal(mocks.clear.mock.calls.length, 0);
});
