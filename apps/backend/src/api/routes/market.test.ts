import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../response/api-response";

const mocks = vi.hoisted(() => ({
  countMcpByCategory: vi.fn(),
  findMcp: vi.fn(),
}));

vi.mock("../../modules/market/read-repository", () => ({
  countMcpByCategory: mocks.countMcpByCategory,
  findMcp: mocks.findMcp,
  findMcpVersion: vi.fn(),
  listMcp: vi.fn(),
}));
vi.mock("../../modules/market/review", () => ({
  listReviewQueue: vi.fn(),
  setSubmissionStatus: vi.fn(),
}));
vi.mock("../../modules/market/submission", () => ({
  MarketSubmissionError: class extends Error {},
  submitMcpFromGitHub: vi.fn(),
}));
vi.mock("../../modules/market/admin", () => ({ isMarketAdmin: vi.fn() }));
vi.mock("../middleware/auth-session", () => ({
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
}));

import { registerMarketRoutes } from "./market";

function createTestApp() {
  const app = new Hono();
  registerMarketRoutes(app);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("public category counts are served without a session and before the identifier route", async () => {
  mocks.countMcpByCategory.mockResolvedValue({
    counts: { "developer-tools": 3 },
    total: 5,
  });

  const response = await createTestApp().request(
    "/v1/mcp/category-counts?query=git&includeDesktopOnly=true",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    counts: { "developer-tools": 3 },
    total: 5,
  });
  assert.match(response.headers.get("cache-control") ?? "", /public/);
  assert.deepEqual(mocks.countMcpByCategory.mock.calls[0]?.[0], {
    desktopOnly: undefined,
    includeDesktopOnly: true,
    query: "git",
  });
  assert.equal(mocks.findMcp.mock.calls.length, 0);
});
