import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../../response/api-response";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  listThreadModelCatalog: vi.fn(),
  listThreadModelSelectorCatalog: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));

vi.mock("../../../modules/threads", () => ({
  contentThreadService: {
    listThreadModelCatalog: mocks.listThreadModelCatalog,
    listThreadModelSelectorCatalog: mocks.listThreadModelSelectorCatalog,
  },
}));

import { registerModelGatewayRoutes } from "./model-gateway";

function createTestApp() {
  const app = new Hono();
  const workspaceRoutes = new Hono();
  registerModelGatewayRoutes(workspaceRoutes);
  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

const selectorResult = {
  defaults: {
    llmProfileAlias: "chat-default",
    imageProfileAlias: "image-default",
    visionProfileAlias: "vision-default",
    llmModelAlias: "chat-default",
    imageModelAlias: "image-default",
    visionModelAlias: "vision-default",
  },
  kinds: { llm: [], image: [], vision: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockReturnValue("user-1");
  mocks.requireSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "session-1", userId: "user-1" },
  });
  mocks.listThreadModelCatalog.mockResolvedValue(selectorResult);
  mocks.listThreadModelSelectorCatalog.mockResolvedValue(selectorResult);
});

test("selector view returns compact private-cache headers", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/model-gateway/models?view=selector",
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "private, max-age=60, stale-while-revalidate=300",
  );
  assert.ok(response.headers.get("etag"));
  assert.deepEqual(mocks.listThreadModelSelectorCatalog.mock.calls[0]?.[0], {
    workspaceId: "workspace-1",
    userId: "user-1",
  });
  assert.equal(mocks.listThreadModelCatalog.mock.calls.length, 0);
});

test("matching selector ETag returns 304 after authorization", async () => {
  const app = createTestApp();
  const first = await app.request(
    "/v1/workspaces/workspace-1/model-gateway/models?view=selector",
  );
  const etag = first.headers.get("etag");
  assert.ok(etag);

  const second = await app.request(
    "/v1/workspaces/workspace-1/model-gateway/models?view=selector",
    { headers: { "if-none-match": etag } },
  );

  assert.equal(second.status, 304);
  assert.equal(mocks.requireSession.mock.calls.length, 2);
});

test("omitted view preserves the full compatibility catalog", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/model-gateway/models",
  );

  assert.equal(response.status, 200);
  assert.equal(mocks.listThreadModelCatalog.mock.calls.length, 1);
  assert.equal(mocks.listThreadModelSelectorCatalog.mock.calls.length, 0);
});

test("unknown model catalog projections are rejected without fallback", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace-1/model-gateway/models?view=pricing",
  );

  assert.equal(response.status, 400);
  assert.equal(mocks.listThreadModelCatalog.mock.calls.length, 0);
  assert.equal(mocks.listThreadModelSelectorCatalog.mock.calls.length, 0);
});
