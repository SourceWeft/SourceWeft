import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createWorkspaceRouteTestApp, readJson } from "../../../test/hono";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  requireSession: mocks.requireSession,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../../../modules/sharing/shared-collections", () => ({
  listArtifactShareCollections: mocks.list,
}));

import { registerArtifactSharedCollectionRoutes } from "./artifact-shared-collections";

const app = () =>
  createWorkspaceRouteTestApp(registerArtifactSharedCollectionRoutes);
const get = () =>
  app().request("/v1/workspaces/ws-1/artifacts/art-1/records/collections");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "s", userId: "user-1" },
  });
});

test("returns the artifact's shared collections for an authorized caller", async () => {
  mocks.list.mockResolvedValue({
    ok: true,
    value: [{ collection: "posts", count: 3 }],
  });
  const response = await get();
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.deepEqual(body.collections, [{ collection: "posts", count: 3 }]);
  assert.deepEqual(mocks.list.mock.calls[0]?.[0], {
    workspaceId: "ws-1",
    artifactId: "art-1",
    userId: "user-1",
  });
});

test("maps forbidden and not_found like the share routes", async () => {
  mocks.list.mockResolvedValue({ ok: false, reason: "forbidden" });
  assert.equal((await get()).status, 403);
  mocks.list.mockResolvedValue({ ok: false, reason: "not_found" });
  const response = await get();
  assert.equal(response.status, 404);
  assert.equal((await readJson(response)).code, "ARTIFACT_NOT_FOUND");
});

test("requires a session", async () => {
  mocks.requireSession.mockResolvedValue(null);
  assert.equal((await get()).status, 401);
  assert.equal(mocks.list.mock.calls.length, 0);
});
