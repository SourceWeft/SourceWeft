import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";

// The report routes: who may send and read reports, what the body must hold,
// and how each outcome of the market module is answered. The module itself is
// covered against PostgreSQL in `reports.database.test.ts`.
const mocks = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  admin: true,
  createSkillReport: vi.fn(),
  listSkillReports: vi.fn(),
  resolveSkillReport: vi.fn(),
  notifySkillReportAdmins: vi.fn(),
}));

vi.mock("../middleware/auth-session", () => ({
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
  requireSession: async () => mocks.session,
}));
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/skills/market/reports", () => ({
  createSkillReport: mocks.createSkillReport,
  listSkillReports: mocks.listSkillReports,
  resolveSkillReport: mocks.resolveSkillReport,
  notifySkillReportAdmins: mocks.notifySkillReportAdmins,
}));
// The public routes' module is imported for its reserved slugs only.
vi.mock("../../modules/skills/market/read-repository", () => ({}));
vi.mock("../../modules/skills/market/collections", () => ({}));
vi.mock("../../modules/skills/market/auto-list", () => ({}));

import { registerSkillReportRoutes } from "./skills-reports";

const createTestApp = () => createRouteTestApp(registerSkillReportRoutes);

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const created = {
  ok: true,
  report: {
    id: "report_1",
    status: "open",
    createdAt: "2026-09-22T00:00:00.000Z",
  },
  skill: { skillId: "skill_1", slug: "gh-a-b-pdf", displayName: "PDF" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = null;
  mocks.admin = true;
  mocks.createSkillReport.mockResolvedValue(created);
  mocks.notifySkillReportAdmins.mockResolvedValue(undefined);
});

test("a visitor who is not signed in must leave an email address", async () => {
  const app = createTestApp();
  const refused = await app.request(
    "/v1/skills/gh-a-b-pdf/reports",
    post({ reason: "copyright", details: "Mine" }),
  );
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, "SKILL_REPORT_CONTACT_REQUIRED");
  assert.equal(mocks.createSkillReport.mock.calls.length, 0);

  const accepted = await app.request(
    "/v1/skills/gh-a-b-pdf/reports",
    post(
      { reason: "copyright", details: "Mine", contactEmail: "me@example.com" },
      { "x-forwarded-for": "198.51.100.1, 203.0.113.7" },
    ),
  );
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), created.report);
  assert.deepEqual(mocks.createSkillReport.mock.calls[0]![0], {
    slug: "gh-a-b-pdf",
    reason: "copyright",
    details: "Mine",
    contactEmail: "me@example.com",
    reviewId: undefined,
    reporterUserId: null,
    // The right-most hop: the one our proxy appended.
    clientIp: "203.0.113.7",
  });
  assert.equal(mocks.notifySkillReportAdmins.mock.calls.length, 1);
});

test("a signed-in reporter needs no email and is recorded as the reporter", async () => {
  mocks.session = { user: { id: "user_1" } };
  const response = await createTestApp().request(
    "/v1/skills/gh-a-b-pdf/reports",
    post(
      { reason: "spam", reviewId: "review_1" },
      { "cf-connecting-ip": "192.0.2.4" },
    ),
  );
  assert.equal(response.status, 201);
  const input = mocks.createSkillReport.mock.calls[0]![0];
  assert.equal(input.reporterUserId, "user_1");
  assert.equal(input.reviewId, "review_1");
  assert.equal(input.contactEmail, undefined);
  assert.equal(input.clientIp, "192.0.2.4");
});

test("a bad body is a validation error, and reserved or overlong slugs are 404s", async () => {
  const app = createTestApp();
  for (const body of [
    { reason: "boring", contactEmail: "me@example.com" },
    { reason: "spam", contactEmail: "nope" },
    {
      reason: "spam",
      contactEmail: "me@example.com",
      details: "a".repeat(4001),
    },
  ]) {
    const response = await app.request(
      "/v1/skills/gh-a-b-pdf/reports",
      post(body),
    );
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
  }
  const invalid = await app.request("/v1/skills/gh-a-b-pdf/reports", post("{"));
  assert.equal((await invalid.json()).code, "INVALID_JSON");

  const body = { reason: "spam", contactEmail: "me@example.com" };
  for (const slug of ["registry", "categories", "x".repeat(300)]) {
    const response = await app.request(
      `/v1/skills/${slug}/reports`,
      post(body),
    );
    assert.equal(response.status, 404, slug.slice(0, 20));
  }
  assert.equal(mocks.createSkillReport.mock.calls.length, 0);
});

test("each outcome of the module has its own answer, and a limit sets Retry-After", async () => {
  const app = createTestApp();
  const body = { reason: "spam", contactEmail: "me@example.com" };
  const cases = [
    [{ ok: false, reason: "skill_not_found" }, 404, "NOT_FOUND"],
    [{ ok: false, reason: "review_not_found" }, 404, "SKILL_REVIEW_NOT_FOUND"],
    [
      { ok: false, reason: "rate_limited", retryAfterSeconds: 90 },
      429,
      "SKILL_REPORT_RATE_LIMITED",
    ],
  ] as const;
  for (const [result, status, code] of cases) {
    mocks.createSkillReport.mockResolvedValueOnce(result);
    const response = await app.request(
      "/v1/skills/gh-a-b-pdf/reports",
      post(body),
    );
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).code, code);
    if (status === 429) assert.equal(response.headers.get("retry-after"), "90");
  }
  assert.equal(mocks.notifySkillReportAdmins.mock.calls.length, 0);
});

test("a mail failure never fails the report", async () => {
  mocks.notifySkillReportAdmins.mockReturnValue(new Promise(() => {}));
  const response = await createTestApp().request(
    "/v1/skills/gh-a-b-pdf/reports",
    post({ reason: "broken", contactEmail: "me@example.com" }),
  );
  assert.equal(response.status, 201);
});

test("the admin queue and resolve refuse anyone who is not a market admin", async () => {
  const app = createTestApp();
  const list = "/v1/skills/registry/admin/reports";
  const resolve = "/v1/skills/registry/admin/reports/report_1/resolve";
  assert.equal((await app.request(list)).status, 401);
  assert.equal(
    (await app.request(resolve, post({ action: "dismiss" }))).status,
    401,
  );
  mocks.session = { user: { id: "user_1" } };
  mocks.admin = false;
  assert.equal((await app.request(list)).status, 403);
  assert.equal(
    (await app.request(resolve, post({ action: "dismiss" }))).status,
    403,
  );
  assert.equal(mocks.listSkillReports.mock.calls.length, 0);
  assert.equal(mocks.resolveSkillReport.mock.calls.length, 0);
});

test("the admin queue reads status, cursor and limit from the query", async () => {
  mocks.session = { user: { id: "admin_1" } };
  mocks.listSkillReports.mockResolvedValue({ items: [], nextCursor: null });
  const app = createTestApp();
  const defaults = await app.request("/v1/skills/registry/admin/reports");
  assert.equal(defaults.status, 200);
  assert.deepEqual(await defaults.json(), { items: [], nextCursor: null });
  assert.deepEqual(mocks.listSkillReports.mock.calls[0]![0], {
    status: "open",
    cursor: undefined,
    limit: 50,
  });

  await app.request(
    "/v1/skills/registry/admin/reports?status=dismissed&cursor=abc&limit=10",
  );
  assert.deepEqual(mocks.listSkillReports.mock.calls[1]![0], {
    status: "dismissed",
    cursor: "abc",
    limit: 10,
  });

  for (const query of ["status=closed", "limit=0", "limit=abc", "limit=500"]) {
    const response = await app.request(
      `/v1/skills/registry/admin/reports?${query}`,
    );
    assert.equal(response.status, 400, query);
  }
});

test("resolve passes the decision and the admin through, and 404s an unknown report", async () => {
  mocks.session = { user: { id: "admin_1" } };
  const app = createTestApp();
  const path = "/v1/skills/registry/admin/reports/report_1/resolve";
  mocks.resolveSkillReport.mockResolvedValueOnce({
    reportId: "report_1",
    status: "actioned",
    action: "withdraw_skill",
    resolvedReportIds: ["report_1", "report_2"],
  });
  const response = await app.request(
    path,
    post({
      action: "withdraw_skill",
      resolution: "Copied",
      alsoResolveSameTarget: true,
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).resolvedReportIds, [
    "report_1",
    "report_2",
  ]);
  assert.deepEqual(mocks.resolveSkillReport.mock.calls[0]![0], {
    reportId: "report_1",
    action: "withdraw_skill",
    resolution: "Copied",
    alsoResolveSameTarget: true,
    actorUserId: "admin_1",
  });

  mocks.resolveSkillReport.mockResolvedValueOnce(null);
  assert.equal(
    (await app.request(path, post({ action: "dismiss" }))).status,
    404,
  );
  assert.equal(
    (await app.request(path, post({ action: "delete" }))).status,
    400,
  );
});
