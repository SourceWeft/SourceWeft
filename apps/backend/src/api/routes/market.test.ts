import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";

const mocks = vi.hoisted(() => ({
  countMcpByCategory: vi.fn(),
  findMcp: vi.fn(),
  isMarketAdmin: vi.fn(),
  requireSession: vi.fn(),
  readmeStatus: vi.fn(),
  refetch: vi.fn(),
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
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: mocks.isMarketAdmin,
}));
vi.mock("../../modules/market/readme/readme-admin", () => ({
  readMcpReadmeAdminStatus: mocks.readmeStatus,
  requestMcpReadmeRefetch: mocks.refetch,
}));
vi.mock("../middleware/auth-session", () => ({
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
  requireSession: mocks.requireSession,
}));

import { registerMarketRoutes } from "./market";

const createTestApp = () => createRouteTestApp(registerMarketRoutes);

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

test("the detail answer carries the latest version's README", async () => {
  const readme = {
    status: "ok",
    markdown: "# Weather",
    source: {
      repoUrl: "https://github.com/acme/weather",
      ref: "c".repeat(40),
      path: "README.md",
      blobUrl: `https://github.com/acme/weather/blob/${"c".repeat(40)}/README.md`,
      rawUrl: `https://raw.githubusercontent.com/acme/weather/${"c".repeat(40)}/README.md`,
    },
  };
  mocks.findMcp.mockResolvedValue({ item: { id: "i" }, versions: [], readme });

  const response = await createTestApp().request(
    `/v1/mcp/${encodeURIComponent("io.github.acme/weather")}`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    item: { id: "i" },
    versions: [],
    readme,
  });
  assert.equal(mocks.findMcp.mock.calls[0]?.[0], "io.github.acme/weather");
});

test("README admin endpoints are for market admins only", async () => {
  mocks.requireSession.mockResolvedValue(null);
  const anonymous = await createTestApp().request(
    "/v1/market/admin/mcp/readme/status",
  );
  assert.equal(anonymous.status, 401);

  mocks.requireSession.mockResolvedValue({ user: { id: "someone" } });
  mocks.isMarketAdmin.mockReturnValue(false);
  const forbidden = await createTestApp().request(
    `/v1/market/admin/mcp/${encodeURIComponent("io.github.acme/weather")}/readme/refetch`,
    { method: "POST" },
  );
  assert.equal(forbidden.status, 403);
  assert.equal(mocks.refetch.mock.calls.length, 0);
  assert.equal(mocks.readmeStatus.mock.calls.length, 0);
});

test("an admin refetch resets and queues one server's README", async () => {
  mocks.requireSession.mockResolvedValue({ user: { id: "admin" } });
  mocks.isMarketAdmin.mockReturnValue(true);
  mocks.refetch.mockResolvedValueOnce({
    identifier: "io.github.acme/weather",
    version: "1.0.0",
    status: "pending",
    queued: true,
  });

  const accepted = await createTestApp().request(
    `/v1/market/admin/mcp/${encodeURIComponent("io.github.acme/weather")}/readme/refetch`,
    { method: "POST" },
  );
  assert.equal(accepted.status, 202);
  assert.equal(mocks.refetch.mock.calls[0]?.[0], "io.github.acme/weather");
  assert.deepEqual(await accepted.json(), {
    identifier: "io.github.acme/weather",
    version: "1.0.0",
    status: "pending",
    queued: true,
  });

  mocks.refetch.mockResolvedValueOnce(null);
  const missing = await createTestApp().request(
    "/v1/market/admin/mcp/io.github.nobody%2Fnothing/readme/refetch",
    { method: "POST" },
  );
  assert.equal(missing.status, 404);
});

test("the README admin status reports coverage and the worker's last batch", async () => {
  mocks.requireSession.mockResolvedValue({ user: { id: "admin" } });
  mocks.isMarketAdmin.mockReturnValue(true);
  const status = {
    byStatus: {
      pending: 3,
      ok: 5,
      not_found: 1,
      too_large: 0,
      unsupported_host: 1,
      error: 0,
    },
    due: 3,
    stopped: 0,
    lastBatch: { tokenPresent: false, processed: 4 },
  };
  mocks.readmeStatus.mockResolvedValue(status);

  const response = await createTestApp().request(
    "/v1/market/admin/mcp/readme/status",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), status);
});
