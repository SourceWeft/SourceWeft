import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../response/api-response";

// The market admin's own screens: who may ask what, how the query string is
// read, and what each route hands the market module.
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: true,
  standing: null as Record<string, unknown> | null,
  listAdminSkills: vi.fn(),
  listSkillEvents: vi.fn(),
  listRecentEvents: vi.fn(),
  reinferOne: vi.fn(),
  reinferAll: vi.fn(),
  acknowledge: vi.fn(),
}));

vi.mock("../middleware/auth-session", () => ({
  getSessionUserId: () => "admin_1",
  requireSession: mocks.session,
}));
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/skills/market/admin-list", () => ({
  listSkillMarketAdminSkills: mocks.listAdminSkills,
}));
vi.mock("../../modules/skills/market/events", () => ({
  listSkillMarketEvents: mocks.listSkillEvents,
  listRecentSkillMarketEvents: mocks.listRecentEvents,
}));
vi.mock("../../modules/skills/market/listing", () => ({
  reinferSkillCategories: mocks.reinferOne,
  reinferAllSkillCategories: mocks.reinferAll,
}));
vi.mock("../../modules/skills/market/standing", () => ({
  getSkillMarketStanding: async () => mocks.standing,
}));
vi.mock("../../modules/skills/market/auto-list", () => ({
  acknowledgeSkillVersion: mocks.acknowledge,
}));

import { registerSkillMarketAdminRoutes } from "./skills-market-admin";

function createTestApp() {
  const app = new Hono();
  registerSkillMarketAdminRoutes(app);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

const admin = "/v1/skills/registry/admin";
const standing = {
  skillId: "skill_1",
  slug: "gh-owner-repo-pdf",
  visibility: "restricted",
  listingHold: false,
  listingHoldBy: null,
  verified: false,
  featured: false,
  featuredSetBy: null,
  categoriesSetBy: "auto",
  ratingCount: 0,
  ratingAvg: null,
  categorySlugs: ["documents-office"],
  installCount: 0,
  listedAt: null,
  claim: null,
};
const event = {
  id: "event_1",
  skillId: "skill_1",
  skillSlug: "gh-owner-repo-pdf",
  skillDisplayName: "pdf",
  repo: null,
  actorKind: "admin",
  actorUserId: "admin_1",
  actorName: "Ada",
  action: "verified.set",
  detail: { verified: { from: false, to: true } },
  createdAt: "2026-09-22T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "admin_1" } });
  mocks.admin = true;
  mocks.standing = standing;
  mocks.listAdminSkills.mockResolvedValue({ items: [], nextCursor: null });
  mocks.listSkillEvents.mockResolvedValue([event]);
  mocks.listRecentEvents.mockResolvedValue({
    items: [event],
    nextCursor: "c2",
  });
  mocks.reinferOne.mockResolvedValue({
    skillId: "skill_1",
    categorySlugs: ["documents-office"],
  });
  mocks.reinferAll.mockResolvedValue({ considered: 3, changed: 1 });
});

test("anyone signed in may ask whether they are a market admin", async () => {
  const app = createTestApp();
  assert.deepEqual(await (await app.request(`${admin}/me`)).json(), {
    isMarketAdmin: true,
  });
  mocks.admin = false;
  const asUser = await app.request(`${admin}/me`);
  assert.equal(asUser.status, 200);
  assert.deepEqual(await asUser.json(), { isMarketAdmin: false });
  mocks.session.mockResolvedValue(null);
  assert.equal((await app.request(`${admin}/me`)).status, 401);
});

test("every other route is a market admin's alone", async () => {
  mocks.admin = false;
  const app = createTestApp();
  for (const [path, init] of [
    [`${admin}/skills`, undefined],
    [`${admin}/skills/skill_1/events`, undefined],
    [`${admin}/events`, undefined],
    [`${admin}/skills/skill_1/reinfer-categories`, { method: "POST" }],
    [`${admin}/reinfer-categories`, { method: "POST" }],
  ] as const) {
    assert.equal((await app.request(path, init)).status, 403, path);
  }
  mocks.session.mockResolvedValue(null);
  assert.equal((await app.request(`${admin}/skills`)).status, 401);
  for (const fn of [
    mocks.listAdminSkills,
    mocks.listSkillEvents,
    mocks.listRecentEvents,
    mocks.reinferOne,
    mocks.reinferAll,
  ])
    assert.equal(fn.mock.calls.length, 0);
});

test("the all-skills list reads its filters from the query string", async () => {
  const app = createTestApp();
  const response = await app.request(
    `${admin}/skills?q=pdf&standing=held&featured=true&verified=false&claimed=true&flagged=false&reported=true&cursor=abc&limit=20`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [], nextCursor: null });
  assert.deepEqual(mocks.listAdminSkills.mock.calls[0], [
    {
      q: "pdf",
      standing: "held",
      featured: true,
      verified: false,
      claimed: true,
      flagged: false,
      reported: true,
      cursor: "abc",
      limit: 20,
    },
  ]);
  // Defaults: every filter absent, a page of 50.
  await app.request(`${admin}/skills`);
  assert.deepEqual(mocks.listAdminSkills.mock.calls[1], [{ limit: 50 }]);

  for (const query of [
    "standing=gone",
    "featured=yes",
    "limit=0",
    "limit=101",
  ]) {
    assert.equal(
      (await app.request(`${admin}/skills?${query}`)).status,
      400,
      query,
    );
  }
});

test("a skill's events and the global feed", async () => {
  const app = createTestApp();
  const own = await app.request(`${admin}/skills/skill_1/events?limit=5`);
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), { items: [event], nextCursor: null });
  assert.deepEqual(mocks.listSkillEvents.mock.calls[0], [
    { skillId: "skill_1", limit: 5 },
  ]);
  mocks.listSkillEvents.mockResolvedValue(null);
  assert.equal((await app.request(`${admin}/skills/nope/events`)).status, 404);

  const feed = await app.request(`${admin}/events?cursor=c1&limit=10`);
  assert.equal(feed.status, 200);
  assert.deepEqual(await feed.json(), { items: [event], nextCursor: "c2" });
  assert.deepEqual(mocks.listRecentEvents.mock.calls[0], [
    { cursor: "c1", limit: 10 },
  ]);
  assert.equal((await app.request(`${admin}/events?limit=500`)).status, 400);
});

test("re-inferring categories: one skill answers its standing, the bulk pass its counts", async () => {
  const app = createTestApp();
  const one = await app.request(`${admin}/skills/skill_1/reinfer-categories`, {
    method: "POST",
  });
  assert.equal(one.status, 200);
  assert.deepEqual(await one.json(), standing);
  assert.deepEqual(mocks.reinferOne.mock.calls[0], [
    { skillId: "skill_1", actorUserId: "admin_1" },
  ]);
  mocks.standing = null;
  assert.equal(
    (
      await app.request(`${admin}/skills/nope/reinfer-categories`, {
        method: "POST",
      })
    ).status,
    404,
  );
  assert.equal(mocks.reinferOne.mock.calls.length, 1);

  const all = await app.request(`${admin}/reinfer-categories`, {
    method: "POST",
  });
  assert.equal(all.status, 200);
  assert.deepEqual(await all.json(), { considered: 3, changed: 1 });
  assert.deepEqual(mocks.reinferAll.mock.calls[0], [
    { actorUserId: "admin_1" },
  ]);
});
