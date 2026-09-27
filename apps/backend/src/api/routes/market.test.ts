import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";

const mocks = vi.hoisted(() => ({
  countMcpByCategory: vi.fn(),
  findMcp: vi.fn(),
  listMcp: vi.fn(),
  isMarketAdmin: vi.fn(),
  requireSession: vi.fn(),
  readmeStatus: vi.fn(),
  refetch: vi.fn(),
  overviewState: vi.fn(),
  overviewStatus: vi.fn(),
  regenerate: vi.fn(),
  setHidden: vi.fn(),
}));

vi.mock("../../modules/market/read-repository", () => ({
  countMcpByCategory: mocks.countMcpByCategory,
  findMcp: mocks.findMcp,
  findMcpVersion: vi.fn(),
  listMcp: mocks.listMcp,
}));
vi.mock("../../modules/market/overview/admin", () => ({
  findMcpOverviewAdminState: mocks.overviewState,
  getMcpOverviewStatus: mocks.overviewStatus,
  regenerateMcpOverview: mocks.regenerate,
  setMcpOverviewHidden: mocks.setHidden,
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

const aiOverview = {
  summary: "讓助理按次付費呼叫資料 API。",
  whatItDoes: "提供付費資料工具。",
  whenToUse: "需要付費資料時。",
  requirements: "Node.js",
  cautions: null,
  locale: "zh-TW",
  generatedAt: "2026-09-28T00:00:00.000Z",
};

test("the detail answer carries the AI overview in the asked-for locale", async () => {
  mocks.findMcp.mockResolvedValue({
    item: {
      id: "i",
      aiSummary: aiOverview.summary,
      overviewLocales: ["en", "zh-TW"],
    },
    versions: [],
    readme: null,
    aiOverview,
  });

  const response = await createTestApp().request(
    `/v1/mcp/${encodeURIComponent("io.github.acme/weather")}?locale=zh-TW`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.aiOverview, aiOverview);
  assert.deepEqual(body.item.overviewLocales, ["en", "zh-TW"]);
  assert.deepEqual(mocks.findMcp.mock.calls[0], [
    "io.github.acme/weather",
    { locale: "zh-TW" },
  ]);

  // English when not asked; a language the market does not write is refused.
  await createTestApp().request("/v1/mcp/io.github.acme%2Fweather");
  assert.deepEqual(mocks.findMcp.mock.calls[1]?.[1], { locale: undefined });
  const invalid = await createTestApp().request(
    "/v1/mcp/io.github.acme%2Fweather?locale=fr",
  );
  assert.equal(invalid.status, 400);
  assert.equal(mocks.findMcp.mock.calls.length, 2);
});

test("the list passes the locale of its AI summaries", async () => {
  mocks.listMcp.mockResolvedValue({ items: [], nextCursor: null });
  const response = await createTestApp().request(
    "/v1/mcp?locale=zh-CN&limit=5",
  );
  assert.equal(response.status, 200);
  assert.equal(mocks.listMcp.mock.calls[0]?.[0].locale, "zh-CN");
  assert.equal(mocks.listMcp.mock.calls[0]?.[0].limit, 5);
  const invalid = await createTestApp().request("/v1/mcp?locale=de");
  assert.equal(invalid.status, 400);
});

test("overview admin endpoints are for market admins only", async () => {
  mocks.requireSession.mockResolvedValue(null);
  for (const [path, method] of [
    ["/v1/market/admin/mcp/overview/status", "GET"],
    ["/v1/market/admin/mcp/io.github.acme%2Fweather/overview", "GET"],
    [
      "/v1/market/admin/mcp/io.github.acme%2Fweather/overview/regenerate",
      "POST",
    ],
    ["/v1/market/admin/mcp/io.github.acme%2Fweather/overview/hidden", "POST"],
  ] as const) {
    const response = await createTestApp().request(path, {
      method,
      ...(method === "POST"
        ? {
            body: JSON.stringify({ hidden: true }),
            headers: { "content-type": "application/json" },
          }
        : {}),
    });
    assert.equal(response.status, 401, path);
  }
  mocks.requireSession.mockResolvedValue({ user: { id: "someone" } });
  mocks.isMarketAdmin.mockReturnValue(false);
  const forbidden = await createTestApp().request(
    "/v1/market/admin/mcp/io.github.acme%2Fweather/overview/regenerate",
    { method: "POST" },
  );
  assert.equal(forbidden.status, 403);
  for (const mock of [
    mocks.overviewState,
    mocks.overviewStatus,
    mocks.regenerate,
    mocks.setHidden,
  ]) {
    assert.equal(mock.mock.calls.length, 0);
  }
});

test("an admin reads one server's overview state", async () => {
  mocks.requireSession.mockResolvedValue({ user: { id: "admin" } });
  mocks.isMarketAdmin.mockReturnValue(true);
  const overview = {
    summary: "s",
    whatItDoes: "w",
    whenToUse: "u",
    requirements: "",
    cautions: null,
    suggestedCategories: ["finance"],
  };
  mocks.overviewState.mockResolvedValueOnce({
    identifier: "io.github.acme/weather",
    serverId: "mcp-1",
    versionId: "mcpv-1",
    version: "1.0.0",
    eligible: true,
    readmeStatus: "ok",
    inputSha256: "f".repeat(64),
    skipReason: null,
    categoriesSource: "ai",
    analysis: {
      mcpServerVersionId: "mcpv-1",
      requestId: "r",
      status: "ready",
      force: false,
      resultKey: "k",
      modelConfigurationKey: null,
      promptVersion: "1",
      taxonomyVersion: "t",
      classification: {
        status: "ready",
        categories: [{ slug: "finance", evidence: "DeFi yields" }],
        rationale: "Finance.",
      },
      error: null,
      updatedAt: new Date("2026-09-28T00:00:00Z"),
    },
    overviews: [
      {
        locale: "en",
        overview,
        model: "m",
        hidden: false,
        generatedAt: new Date("2026-09-28T00:00:00Z"),
        inputSha256: "f".repeat(64),
        current: true,
      },
    ],
    systemModel: {
      enabled: true,
      configured: true,
      ready: true,
      provider: "openrouter",
      model: "m",
      problems: [],
      reason: null,
    },
  });

  const response = await createTestApp().request(
    `/v1/market/admin/mcp/${encodeURIComponent("io.github.acme/weather")}/overview`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    mocks.overviewState.mock.calls[0]?.[0],
    "io.github.acme/weather",
  );
  assert.equal(body.analysis.updatedAt, "2026-09-28T00:00:00.000Z");
  assert.equal(body.analysis.error, null);
  assert.equal(body.overviews[0].generatedAt, "2026-09-28T00:00:00.000Z");
  assert.equal(body.overviews[0].hidden, false);
  assert.equal(body.categoriesSource, "ai");
  assert.equal(body.systemModel.ready, true);
  // Nothing but the contract leaves: no request id or result key.
  assert.equal("requestId" in body.analysis, false);

  mocks.overviewState.mockResolvedValueOnce(null);
  const missing = await createTestApp().request(
    "/v1/market/admin/mcp/io.github.nobody%2Fnothing/overview",
  );
  assert.equal(missing.status, 404);
});

test("an admin regenerates and hides one server's overview", async () => {
  mocks.requireSession.mockResolvedValue({ user: { id: "admin" } });
  mocks.isMarketAdmin.mockReturnValue(true);
  mocks.regenerate
    .mockResolvedValueOnce({
      identifier: "io.github.acme/weather",
      versionId: "mcpv-1",
      queued: true,
    })
    .mockResolvedValueOnce(null);
  const queued = await createTestApp().request(
    "/v1/market/admin/mcp/io.github.acme%2Fweather/overview/regenerate",
    { method: "POST" },
  );
  assert.equal(queued.status, 202);
  assert.deepEqual(mocks.regenerate.mock.calls[0]?.[0], {
    identifier: "io.github.acme/weather",
    actorUserId: "admin",
  });
  const none = await createTestApp().request(
    "/v1/market/admin/mcp/io.github.nobody%2Fnothing/overview/regenerate",
    { method: "POST" },
  );
  assert.equal(none.status, 404);

  mocks.setHidden.mockResolvedValueOnce({
    identifier: "io.github.acme/weather",
    versionId: "mcpv-1",
    hidden: true,
    updated: 3,
  });
  const hidden = await createTestApp().request(
    "/v1/market/admin/mcp/io.github.acme%2Fweather/overview/hidden",
    {
      method: "POST",
      body: JSON.stringify({ hidden: true }),
      headers: { "content-type": "application/json" },
    },
  );
  assert.equal(hidden.status, 200);
  assert.deepEqual(await hidden.json(), {
    identifier: "io.github.acme/weather",
    versionId: "mcpv-1",
    hidden: true,
    updated: 3,
  });
  assert.deepEqual(mocks.setHidden.mock.calls[0]?.[0], {
    identifier: "io.github.acme/weather",
    hidden: true,
    actorUserId: "admin",
  });
  const invalid = await createTestApp().request(
    "/v1/market/admin/mcp/io.github.acme%2Fweather/overview/hidden",
    {
      method: "POST",
      body: JSON.stringify({ hidden: "yes" }),
      headers: { "content-type": "application/json" },
    },
  );
  assert.equal(invalid.status, 400);
  assert.equal(mocks.setHidden.mock.calls.length, 1);
});

test("the overview admin status reports readiness and coverage", async () => {
  mocks.requireSession.mockResolvedValue({ user: { id: "admin" } });
  mocks.isMarketAdmin.mockReturnValue(true);
  const status = {
    systemModel: {
      enabled: false,
      configured: false,
      ready: false,
      provider: null,
      model: null,
      problems: ["disabled"],
      reason: "SYSTEM_MODEL_ENABLED is not true",
    },
    eligible: 10,
    readmePending: 2,
    withOverview: 6,
    missing: 4,
    hidden: 1,
    inProgress: 1,
    failed: 1,
  };
  mocks.overviewStatus.mockResolvedValue(status);
  const response = await createTestApp().request(
    "/v1/market/admin/mcp/overview/status",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), status);
  // The literal route is not taken for a server called "overview".
  assert.equal(mocks.overviewState.mock.calls.length, 0);
});
