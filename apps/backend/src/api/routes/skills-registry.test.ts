import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../response/api-response";

// The market admin routes: who may call them, which market function each one
// goes through, and that every one answers with the stored standing.
const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  admin: true,
  standing: null as Record<string, unknown> | null,
  listSkillPublicly: vi.fn(),
  delistSkill: vi.fn(),
  releaseSkillListingHold: vi.fn(),
  setSkillVerified: vi.fn(),
  setSkillCategories: vi.fn(),
}));

vi.mock("../middleware/auth-session", () => ({
  getSessionUserId: () => "admin_1",
  requireSession: async () => ({ user: { id: "admin_1" } }),
}));
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/skills/registry/review", () => ({
  listRegistryReviewQueue: vi.fn(),
  setRegistrySkillVersionStatus: vi.fn(),
}));
vi.mock("../../modules/skills/registry/versions", () => ({
  getRegistryVersionDetail: vi.fn(),
}));
vi.mock("../../modules/skills/market/listing", () => ({
  listSkillPublicly: mocks.listSkillPublicly,
  delistSkill: mocks.delistSkill,
  releaseSkillListingHold: mocks.releaseSkillListingHold,
  setSkillVerified: mocks.setSkillVerified,
  setSkillCategories: mocks.setSkillCategories,
}));
vi.mock("../../modules/skills/market/standing", () => ({
  getSkillMarketStanding: async () => mocks.standing,
}));

import { registerSkillRegistryAdminRoutes } from "./skills-registry";

function createTestApp() {
  const app = new Hono();
  registerSkillRegistryAdminRoutes(app);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

const base = "/v1/skills/registry/admin/skills/skill_1";
const standing = {
  skillId: "skill_1",
  slug: "gh-owner-repo-pdf",
  visibility: "restricted",
  listingHold: false,
  listingHoldBy: null,
  verified: false,
  categorySlugs: ["documents-office"],
  installCount: 0,
  listedAt: null,
};
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const actor = { skillId: "skill_1", actorUserId: "admin_1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.admin = true;
  mocks.standing = standing;
  for (const name of [
    "listSkillPublicly",
    "delistSkill",
    "releaseSkillListingHold",
    "setSkillVerified",
    "setSkillCategories",
  ] as const) {
    mocks[name].mockImplementation(async () => {
      mocks.calls.push(name);
      return { skillId: "skill_1" };
    });
  }
});

test("every market admin route refuses someone who is not a market admin", async () => {
  mocks.admin = false;
  const app = createTestApp();
  for (const [path, init] of [
    ["/market", undefined],
    ["/list", { method: "POST" }],
    ["/delist", { method: "POST" }],
    ["/verified", json("PUT", { verified: true })],
    ["/categories", json("PUT", { categorySlugs: ["other"] })],
    ["/visibility", json("PUT", { visibility: "public" })],
  ] as const) {
    assert.equal((await app.request(`${base}${path}`, init)).status, 403, path);
  }
  assert.deepEqual(mocks.calls, []);
});

test("the standing is read as stored, and 404s for what is not a registry skill", async () => {
  const found = await createTestApp().request(`${base}/market`);
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), standing);

  mocks.standing = null;
  const app = createTestApp();
  for (const [path, init] of [
    ["/market", undefined],
    ["/list", { method: "POST" }],
    ["/delist", { method: "POST" }],
    ["/verified", json("PUT", { verified: true })],
    ["/categories", json("PUT", { categorySlugs: ["other"] })],
    ["/visibility", json("PUT", { visibility: "restricted" })],
  ] as const) {
    assert.equal((await app.request(`${base}${path}`, init)).status, 404, path);
  }
  assert.deepEqual(mocks.calls, []);
});

test("listing lifts the hold first, then lists through the one listing function", async () => {
  const response = await createTestApp().request(`${base}/list`, {
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), standing);
  assert.deepEqual(mocks.calls, ["releaseSkillListingHold", "listSkillPublicly"]);
  assert.deepEqual(mocks.releaseSkillListingHold.mock.calls, [
    [{ skillId: "skill_1" }],
  ]);
  assert.deepEqual(mocks.listSkillPublicly.mock.calls, [[actor]]);
});

test("delisting goes through delistSkill, which is what sets the hold", async () => {
  const response = await createTestApp().request(`${base}/delist`, {
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.calls, ["delistSkill"]);
  assert.deepEqual(mocks.delistSkill.mock.calls, [[actor]]);
});

// The older route must not be a way around the hold in either direction.
test("the visibility route is list and delist under another name", async () => {
  const app = createTestApp();
  const made = await app.request(
    `${base}/visibility`,
    json("PUT", { visibility: "public" }),
  );
  assert.equal(made.status, 200);
  assert.deepEqual(await made.json(), standing);
  assert.deepEqual(mocks.calls, ["releaseSkillListingHold", "listSkillPublicly"]);

  mocks.calls.length = 0;
  await app.request(`${base}/visibility`, json("PUT", { visibility: "restricted" }));
  assert.deepEqual(mocks.calls, ["delistSkill"]);

  const bad = await app.request(
    `${base}/visibility`,
    json("PUT", { visibility: "team" }),
  );
  assert.equal(bad.status, 400);
});

test("verified and categories validate their body and answer the standing", async () => {
  const app = createTestApp();
  const verified = await app.request(
    `${base}/verified`,
    json("PUT", { verified: true }),
  );
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), standing);
  assert.deepEqual(mocks.setSkillVerified.mock.calls, [
    [{ skillId: "skill_1", verified: true }],
  ]);

  const categories = await app.request(
    `${base}/categories`,
    json("PUT", { categorySlugs: ["design-creative", "other"] }),
  );
  assert.equal(categories.status, 200);
  assert.deepEqual(mocks.setSkillCategories.mock.calls, [
    [{ skillId: "skill_1", categorySlugs: ["design-creative", "other"] }],
  ]);

  for (const [path, body] of [
    ["/verified", { verified: "yes" }],
    ["/verified", { verified: true, extra: 1 }],
    ["/categories", { categorySlugs: [] }],
    ["/categories", { categorySlugs: ["a", "b", "c", "d", "e", "f"] }],
  ] as const) {
    const response = await app.request(`${base}${path}`, json("PUT", body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});
