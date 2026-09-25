import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";

// The run-stats routes: who sees what, what is cached, and that a skill that is
// not public is a 404 to everyone but its author and the admins.
const mocks = vi.hoisted(() => ({
  signedIn: true,
  admin: false,
  claimant: null as string | null,
  skill: { id: "skill_1", isPublic: true } as {
    id: string;
    isPublic: boolean;
  } | null,
  findRunStatsSkill: vi.fn(),
  getPublicSkillRunStats: vi.fn(),
  getFullSkillRunStats: vi.fn(),
}));

vi.mock("../middleware/auth-session", async () =>
  (await import("../../test/hono")).signedInWhen("user_1", mocks),
);
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/skills/market/claims", () => ({
  getSkillMarketClaim: async () =>
    mocks.claimant ? { userId: mocks.claimant } : null,
}));
vi.mock("../../modules/skills/market/run-stats", () => ({
  findRunStatsSkill: mocks.findRunStatsSkill,
  getPublicSkillRunStats: mocks.getPublicSkillRunStats,
  getFullSkillRunStats: mocks.getFullSkillRunStats,
}));

import { registerSkillRunStatsRoutes } from "./skills-run-stats";

const createTestApp = () =>
  createRouteTestApp((app) => {
    registerSkillRunStatsRoutes(app);
    app.get("/v1/skills/collections/:slug", (c) =>
      c.json({ collection: c.req.param("slug") }),
    );
  });

const full = {
  skillId: "skill_1",
  runs: 2,
  successes: 1,
  successRate: 0.5,
  workspaces: 1,
  topErrors: [{ errorClass: "timeout", subject: null, count: 1 }],
  windowDays: 30,
  publiclyVisible: false,
  computedAt: "2026-09-22T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signedIn = true;
  mocks.admin = false;
  mocks.claimant = null;
  mocks.skill = { id: "skill_1", isPublic: true };
  mocks.findRunStatsSkill.mockImplementation(async () => mocks.skill);
  mocks.getPublicSkillRunStats.mockResolvedValue({ available: false });
  mocks.getFullSkillRunStats.mockResolvedValue(full);
});

test("public: a public skill's answer, cacheable, without a session", async () => {
  mocks.signedIn = false;
  const response = await createTestApp().request("/v1/skills/demo/run-stats");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /^public/);
  assert.deepEqual(await response.json(), { available: false });
  assert.deepEqual(mocks.findRunStatsSkill.mock.calls[0], [{ slug: "demo" }]);
});

test("public: available numbers pass through the contract", async () => {
  mocks.getPublicSkillRunStats.mockResolvedValue({
    available: true,
    runs: 12,
    successRate: 0.75,
    workspaces: 4,
    topErrors: [
      { errorClass: "missing_dependency", subject: "pptx", count: 3 },
    ],
    windowDays: 30,
  });
  const response = await createTestApp().request("/v1/skills/demo/run-stats");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { runs: number };
  assert.equal(body.runs, 12);
});

test("public: not public and not there are the same 404", async () => {
  mocks.skill = { id: "skill_1", isPublic: false };
  const app = createTestApp();
  assert.equal((await app.request("/v1/skills/demo/run-stats")).status, 404);
  mocks.skill = null;
  assert.equal((await app.request("/v1/skills/demo/run-stats")).status, 404);
  assert.equal(mocks.getPublicSkillRunStats.mock.calls.length, 0);
});

test("a reserved segment is left to the route it belongs to", async () => {
  const response = await createTestApp().request(
    "/v1/skills/collections/run-stats",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { collection: "run-stats" });
  assert.equal(mocks.findRunStatsSkill.mock.calls.length, 0);
});

test("full: signed out is 401", async () => {
  mocks.signedIn = false;
  const response = await createTestApp().request(
    "/v1/skills/demo/run-stats?full=1",
  );
  assert.equal(response.status, 401);
});

test("full: someone else is 403 on a public skill, 404 on a private one", async () => {
  mocks.claimant = "user_2";
  const app = createTestApp();
  assert.equal(
    (await app.request("/v1/skills/demo/run-stats?full=1")).status,
    403,
  );
  mocks.skill = { id: "skill_1", isPublic: false };
  assert.equal(
    (await app.request("/v1/skills/demo/run-stats?full=1")).status,
    404,
  );
  assert.equal(mocks.getFullSkillRunStats.mock.calls.length, 0);
});

test("full: the verified claimant gets every number, uncached, even private", async () => {
  mocks.claimant = "user_1";
  mocks.skill = { id: "skill_1", isPublic: false };
  const response = await createTestApp().request(
    "/v1/skills/demo/run-stats?full=1",
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), full);
});

test("full: a market admin too", async () => {
  mocks.admin = true;
  const response = await createTestApp().request(
    "/v1/skills/demo/run-stats?full=true",
  );
  assert.equal(response.status, 200);
});

test("admin route: admins only, by id", async () => {
  const app = createTestApp();
  const path = "/v1/skills/registry/admin/skills/skill_1/run-stats";
  assert.equal((await app.request(path)).status, 403);
  mocks.signedIn = false;
  assert.equal((await app.request(path)).status, 401);
  mocks.signedIn = true;
  mocks.admin = true;
  const response = await app.request(path);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), full);
  assert.deepEqual(mocks.findRunStatsSkill.mock.calls.at(-1), [
    { skillId: "skill_1" },
  ]);
  mocks.skill = null;
  assert.equal((await app.request(path)).status, 404);
});
