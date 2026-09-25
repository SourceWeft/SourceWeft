import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";

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
  setSkillFeatured: vi.fn(),
  revokeSkillClaim: vi.fn(),
  grantSkillClaim: vi.fn(),
  setVersionStatus: vi.fn(),
  getVersionForAudit: vi.fn(),
  recordVersionModeration: vi.fn(),
}));

vi.mock("../middleware/auth-session", async () =>
  (await import("../../test/hono")).signedInAs("admin_1"),
);
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/skills/registry/review", () => ({
  listRegistryReviewQueue: vi.fn(),
  setRegistrySkillVersionStatus: mocks.setVersionStatus,
}));
vi.mock("../../modules/skills/market/events", () => ({
  getVersionForAudit: mocks.getVersionForAudit,
  recordVersionModeration: mocks.recordVersionModeration,
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
  setSkillFeatured: mocks.setSkillFeatured,
}));
vi.mock("../../modules/skills/market/claims", () => ({
  revokeSkillClaim: mocks.revokeSkillClaim,
  grantSkillClaim: mocks.grantSkillClaim,
}));
vi.mock("../../modules/skills/market/standing", () => ({
  getSkillMarketStanding: async () => mocks.standing,
}));

import { registerSkillRegistryAdminRoutes } from "./skills-registry";

const createTestApp = () =>
  createRouteTestApp(registerSkillRegistryAdminRoutes);

const base = "/v1/skills/registry/admin/skills/skill_1";
const standing = {
  skillId: "skill_1",
  slug: "gh-owner-repo-pdf",
  visibility: "restricted",
  listingHold: false,
  listingHoldBy: null,
  verified: false,
  featured: false,
  featuredSetBy: null,
  categoriesSetBy: null,
  ratingCount: 0,
  ratingAvg: null,
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
    "setSkillFeatured",
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
    ["/featured", json("PUT", { featured: true })],
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
    ["/featured", json("PUT", { featured: true })],
    ["/categories", json("PUT", { categorySlugs: ["other"] })],
    ["/visibility", json("PUT", { visibility: "restricted" })],
  ] as const) {
    assert.equal((await app.request(`${base}${path}`, init)).status, 404, path);
  }
  assert.deepEqual(mocks.calls, []);
});

test("listing lifts the hold, through the one listing function", async () => {
  const response = await createTestApp().request(`${base}/list`, {
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), standing);
  assert.deepEqual(mocks.calls, ["listSkillPublicly"]);
  assert.deepEqual(mocks.listSkillPublicly.mock.calls, [
    [{ ...actor, releaseHold: true }],
  ]);
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
  assert.deepEqual(mocks.calls, ["listSkillPublicly"]);
  assert.deepEqual(mocks.listSkillPublicly.mock.calls, [
    [{ ...actor, releaseHold: true }],
  ]);

  mocks.calls.length = 0;
  await app.request(
    `${base}/visibility`,
    json("PUT", { visibility: "restricted" }),
  );
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
    [{ skillId: "skill_1", verified: true, actorUserId: "admin_1" }],
  ]);

  const categories = await app.request(
    `${base}/categories`,
    json("PUT", { categorySlugs: ["design-creative", "other"] }),
  );
  assert.equal(categories.status, 200);
  assert.deepEqual(mocks.setSkillCategories.mock.calls, [
    [
      {
        skillId: "skill_1",
        categorySlugs: ["design-creative", "other"],
        actorUserId: "admin_1",
      },
    ],
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

test("revoking a claim is a market admin's act, recorded with who did it", async () => {
  const path = "/v1/skills/registry/admin/claims/claim_1/revoke";
  mocks.admin = false;
  assert.equal(
    (await createTestApp().request(path, { method: "POST" })).status,
    403,
  );
  assert.equal(mocks.revokeSkillClaim.mock.calls.length, 0);

  mocks.admin = true;
  mocks.revokeSkillClaim.mockResolvedValue({
    claimId: "claim_1",
    repo: "ada/skills",
    status: "revoked",
  });
  const revoked = await createTestApp().request(path, { method: "POST" });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), {
    claimId: "claim_1",
    repo: "ada/skills",
    status: "revoked",
  });
  assert.deepEqual(mocks.revokeSkillClaim.mock.calls[0], [
    { claimId: "claim_1", actorUserId: "admin_1" },
  ]);

  mocks.revokeSkillClaim.mockResolvedValue(null);
  assert.equal(
    (await createTestApp().request(path, { method: "POST" })).status,
    404,
  );
});

test("featured is an admin's choice, answered with the stored standing", async () => {
  // What `setSkillFeatured` stores, as the standing then reads it back.
  mocks.setSkillFeatured.mockImplementation(async () => {
    mocks.calls.push("setSkillFeatured");
    mocks.standing = { ...standing, featured: true, featuredSetBy: "admin" };
    return { skillId: "skill_1", featured: true };
  });
  const app = createTestApp();
  const featured = await app.request(
    `${base}/featured`,
    json("PUT", { featured: true }),
  );
  assert.equal(featured.status, 200);
  assert.deepEqual(mocks.setSkillFeatured.mock.calls, [
    [{ skillId: "skill_1", featured: true, actorUserId: "admin_1" }],
  ]);
  assert.deepEqual(await featured.json(), {
    ...standing,
    featured: true,
    featuredSetBy: "admin",
    categoriesSetBy: null,
    ratingCount: 0,
    ratingAvg: null,
  });

  for (const body of [
    { featured: "yes" },
    { featured: true, setBy: "sync" },
    {},
  ]) {
    const response = await app.request(`${base}/featured`, json("PUT", body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(mocks.setSkillFeatured.mock.calls.length, 1);
});

test("granting a claim is a market admin's act, by repository and email", async () => {
  const path = "/v1/skills/registry/admin/claims";
  const body = { repo: "acme/skills", email: "author@example.com" };
  mocks.admin = false;
  assert.equal(
    (await createTestApp().request(path, json("POST", body))).status,
    403,
  );
  assert.equal(mocks.grantSkillClaim.mock.calls.length, 0);

  mocks.admin = true;
  const claim = {
    id: "claim_2",
    repo: "acme/skills",
    method: "admin_grant",
    status: "verified",
    createdAt: "2026-09-21T00:00:00.000Z",
    verifiedAt: "2026-09-21T00:00:00.000Z",
  };
  mocks.grantSkillClaim.mockResolvedValue({ claim, userId: "user_7" });
  const granted = await createTestApp().request(
    path,
    json("POST", { repo: "acme/skills", email: " Author@Example.com " }),
  );
  assert.equal(granted.status, 201);
  assert.deepEqual(await granted.json(), { claim, userId: "user_7" });
  assert.deepEqual(mocks.grantSkillClaim.mock.calls[0], [
    { ...body, actorUserId: "admin_1" },
  ]);

  for (const invalid of [
    { repo: "acme/skills" },
    { repo: "acme", email: "author@example.com" },
    { repo: "acme/skills", email: "nope" },
    { ...body, userId: "user_7" },
  ]) {
    const response = await createTestApp().request(path, json("POST", invalid));
    assert.equal(response.status, 400, JSON.stringify(invalid));
  }
  assert.equal(mocks.grantSkillClaim.mock.calls.length, 1);

  const { ContentError } = await import("../../modules/content/errors");
  for (const [status, code] of [
    [404, "SKILL_CLAIM_USER_NOT_FOUND"],
    [409, "SKILL_REPO_ALREADY_CLAIMED"],
  ] as const) {
    mocks.grantSkillClaim.mockRejectedValueOnce(
      new ContentError(status, code, code),
    );
    const response = await createTestApp().request(path, json("POST", body));
    assert.equal(response.status, status);
    assert.match(await response.text(), new RegExp(code));
  }
});

test("review-queue decisions are audited as what they were: publish, reject, revoke", async () => {
  const app = createTestApp();
  const publish = "/v1/skills/registry/admin/submissions/v_1/publish";
  const reject = "/v1/skills/registry/admin/submissions/v_1/reject";

  mocks.getVersionForAudit.mockResolvedValue({
    skillId: "skill_1",
    status: "draft",
  });
  mocks.setVersionStatus.mockResolvedValue({
    skillVersionId: "v_1",
    status: "published",
  });
  assert.equal(
    (await app.request(publish, json("POST", { visibility: "public" }))).status,
    200,
  );
  assert.deepEqual(mocks.recordVersionModeration.mock.calls.at(-1), [
    {
      skillVersionId: "v_1",
      before: { skillId: "skill_1", status: "draft" },
      target: "published",
      actorUserId: "admin_1",
      visibility: "public",
    },
  ]);

  mocks.getVersionForAudit.mockResolvedValue({
    skillId: "skill_1",
    status: "published",
  });
  mocks.setVersionStatus.mockResolvedValue({
    skillVersionId: "v_1",
    status: "deprecated",
  });
  assert.equal(
    (await app.request(reject, json("POST", { reason: "malware" }))).status,
    200,
  );
  assert.deepEqual(mocks.recordVersionModeration.mock.calls.at(-1), [
    {
      skillVersionId: "v_1",
      before: { skillId: "skill_1", status: "published" },
      target: "deprecated",
      actorUserId: "admin_1",
      reason: "malware",
    },
  ]);

  // Nothing decided, nothing recorded.
  mocks.recordVersionModeration.mockClear();
  mocks.setVersionStatus.mockResolvedValue(null);
  assert.equal(
    (await app.request(reject, json("POST", { reason: "x" }))).status,
    404,
  );
  assert.equal(mocks.recordVersionModeration.mock.calls.length, 0);
});
