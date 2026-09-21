import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../response/api-response";

// The market admin's collection routes and the "keep public" decision: who may
// call them, what reaches the collection functions, and what a bad body gets.
const mocks = vi.hoisted(() => ({
  admin: true,
  signedIn: true,
  listSkillCollectionsForAdmin: vi.fn(),
  createSkillCollection: vi.fn(),
  updateSkillCollection: vi.fn(),
  setSkillCollectionItems: vi.fn(),
  deleteSkillCollection: vi.fn(),
  acknowledgeSkillVersion: vi.fn(),
}));

vi.mock("../middleware/auth-session", () => ({
  getSessionUserId: () => "admin_1",
  requireSession: async () =>
    mocks.signedIn ? { user: { id: "admin_1" } } : null,
}));
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/skills/market/collections", () => ({
  listSkillCollectionsForAdmin: mocks.listSkillCollectionsForAdmin,
  createSkillCollection: mocks.createSkillCollection,
  updateSkillCollection: mocks.updateSkillCollection,
  setSkillCollectionItems: mocks.setSkillCollectionItems,
  deleteSkillCollection: mocks.deleteSkillCollection,
}));
vi.mock("../../modules/skills/market/auto-list", () => ({
  acknowledgeSkillVersion: mocks.acknowledgeSkillVersion,
}));

import { registerSkillCollectionAdminRoutes } from "./skills-collections-admin";
import { registerSkillMarketAdminRoutes } from "./skills-market-admin";

function createTestApp() {
  const app = new Hono();
  registerSkillMarketAdminRoutes(app);
  registerSkillCollectionAdminRoutes(app);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

const base = "/v1/skills/registry/admin/collections";
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const collection = {
  id: "col_1",
  slug: "office-work",
  title: "Office work",
  summary: "",
  position: 0,
  published: false,
  items: [],
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin = true;
  mocks.signedIn = true;
  mocks.listSkillCollectionsForAdmin.mockResolvedValue([collection]);
  mocks.createSkillCollection.mockResolvedValue(collection);
  mocks.updateSkillCollection.mockResolvedValue(collection);
  mocks.setSkillCollectionItems.mockResolvedValue(collection);
  mocks.deleteSkillCollection.mockResolvedValue(true);
  mocks.acknowledgeSkillVersion.mockResolvedValue({
    skillId: "skill_1",
    skillVersionId: "ver_1",
    acknowledgedAt: "2026-09-21T00:00:00.000Z",
  });
});

test("only a market admin gets in: 401 signed out, 403 otherwise", async () => {
  const app = createTestApp();
  const requests: Array<[string, RequestInit?]> = [
    [base],
    [base, json("POST", { slug: "a", title: "A" })],
    [`${base}/col_1`, json("PATCH", { title: "B" })],
    [`${base}/col_1/items`, json("PUT", { slugs: [] })],
    [`${base}/col_1`, { method: "DELETE" }],
    [
      "/v1/skills/registry/admin/listing-queue/ver_1/acknowledge",
      { method: "POST" },
    ],
  ];
  for (const [signedIn, admin, status] of [
    [false, false, 401],
    [true, false, 403],
  ] as const) {
    mocks.signedIn = signedIn;
    mocks.admin = admin;
    for (const [path, init] of requests) {
      const response = await app.request(path, init);
      assert.equal(response.status, status, `${init?.method ?? "GET"} ${path}`);
    }
  }
  for (const fn of [
    mocks.listSkillCollectionsForAdmin,
    mocks.createSkillCollection,
    mocks.updateSkillCollection,
    mocks.setSkillCollectionItems,
    mocks.deleteSkillCollection,
    mocks.acknowledgeSkillVersion,
  ])
    assert.equal(fn.mock.calls.length, 0);
});

test("collections are listed, created, updated, filled and deleted", async () => {
  const app = createTestApp();
  const listed = await app.request(base);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { items: [collection] });

  const created = await app.request(
    base,
    json("POST", { slug: "office-work", title: " Office work " }),
  );
  assert.equal(created.status, 201);
  assert.deepEqual(mocks.createSkillCollection.mock.calls[0]?.[0], {
    slug: "office-work",
    title: "Office work",
  });

  await app.request(
    `${base}/col_1`,
    json("PATCH", { published: true, position: 3 }),
  );
  assert.deepEqual(mocks.updateSkillCollection.mock.calls[0], [
    "col_1",
    { published: true, position: 3 },
  ]);

  await app.request(`${base}/col_1/items`, json("PUT", { slugs: ["a", "b"] }));
  assert.deepEqual(mocks.setSkillCollectionItems.mock.calls[0], [
    "col_1",
    ["a", "b"],
  ]);

  const deleted = await app.request(`${base}/col_1`, { method: "DELETE" });
  assert.deepEqual(await deleted.json(), { deleted: true });
});

test("a body the contract does not accept is a 400, and nothing is written", async () => {
  const app = createTestApp();
  for (const [path, init] of [
    [base, json("POST", { slug: "Not A Slug", title: "x" })],
    [base, json("POST", { slug: "ok", title: "" })],
    [base, json("POST", { slug: "ok", title: "x", extra: 1 })],
    [`${base}/col_1`, json("PATCH", { slug: "renamed" })],
    [`${base}/col_1/items`, json("PUT", { slugs: "a" })],
    [base, { method: "POST", body: "{not json" }],
  ] as const) {
    const response = await app.request(path, init);
    assert.equal(response.status, 400, `${path} ${init.body}`);
  }
  assert.equal(mocks.createSkillCollection.mock.calls.length, 0);
  assert.equal(mocks.updateSkillCollection.mock.calls.length, 0);
  assert.equal(mocks.setSkillCollectionItems.mock.calls.length, 0);
});

test("an unknown collection is a 404", async () => {
  mocks.updateSkillCollection.mockResolvedValue(null);
  mocks.setSkillCollectionItems.mockResolvedValue(null);
  mocks.deleteSkillCollection.mockResolvedValue(false);
  const app = createTestApp();
  for (const [path, init] of [
    [`${base}/nope`, json("PATCH", { title: "x" })],
    [`${base}/nope/items`, json("PUT", { slugs: [] })],
    [`${base}/nope`, { method: "DELETE" }],
  ] as const) {
    assert.equal((await app.request(path, init)).status, 404, path);
  }
});

test("keeping a public skill's new version records who kept it", async () => {
  const app = createTestApp();
  const response = await app.request(
    "/v1/skills/registry/admin/listing-queue/ver_1/acknowledge",
    { method: "POST" },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    skillId: "skill_1",
    skillVersionId: "ver_1",
    acknowledgedAt: "2026-09-21T00:00:00.000Z",
  });
  assert.deepEqual(mocks.acknowledgeSkillVersion.mock.calls[0]?.[0], {
    skillVersionId: "ver_1",
    actorUserId: "admin_1",
  });

  mocks.acknowledgeSkillVersion.mockResolvedValue(null);
  const missing = await app.request(
    "/v1/skills/registry/admin/listing-queue/ver_old/acknowledge",
    { method: "POST" },
  );
  assert.equal(missing.status, 404);
});
