import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../../response/api-response";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  listArtifacts: vi.fn(),
  listArtifactSummaries: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));

vi.mock("../../../modules/artifacts", () => ({
  contentArtifactsService: {
    listArtifacts: mocks.listArtifacts,
    listArtifactSummaries: mocks.listArtifactSummaries,
  },
}));

vi.mock("../../../modules/sharing", () => ({
  sharingService: {},
}));

import { registerArtifactRoutes } from "./artifacts";

function createTestApp() {
  const app = new Hono();
  const workspaceRoutes = new Hono();
  registerArtifactRoutes(workspaceRoutes);
  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockReturnValue("user-1");
  mocks.requireSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "session-1", userId: "user-1" },
  });
  mocks.listArtifacts.mockResolvedValue({ items: [], nextCursor: null });
  mocks.listArtifactSummaries.mockResolvedValue({ items: [], nextCursor: null });
});

test("artifact list summary view dispatches to the bounded projection", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts?view=summary&limit=25&cursor=next",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(mocks.listArtifactSummaries.mock.calls[0]?.[0], {
    workspaceId: "workspace-1",
    userId: "user-1",
    limit: 25,
    cursor: "next",
  });
  assert.equal(mocks.listArtifacts.mock.calls.length, 0);
});

test("artifact list without a view preserves the compatibility response", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts?limit=10",
  );

  assert.equal(response.status, 200);
  assert.equal(mocks.listArtifacts.mock.calls.length, 1);
  assert.equal(mocks.listArtifactSummaries.mock.calls.length, 0);
});

test("artifact list rejects unknown projections without falling back", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/artifacts?view=compact",
  );

  assert.equal(response.status, 400);
  assert.equal(mocks.listArtifacts.mock.calls.length, 0);
  assert.equal(mocks.listArtifactSummaries.mock.calls.length, 0);
  assert.equal((await response.json() as { code: string }).code, "VALIDATION_ERROR");
});
