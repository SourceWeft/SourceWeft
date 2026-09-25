import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { ContentError } from "../../modules/content/errors";
import { createRouteTestApp } from "../../test/hono";

// The review routes: who may call each, what reaches the review functions,
// what a bad body or query gets, and that nothing viewer-specific is cached.
const mocks = vi.hoisted(() => ({
  signedIn: true,
  admin: false,
  listSkillReviews: vi.fn(),
  upsertMySkillReview: vi.fn(),
  deleteMySkillReview: vi.fn(),
  setSkillReviewReply: vi.fn(),
  setSkillReviewStatus: vi.fn(),
}));

vi.mock("../middleware/auth-session", async () =>
  (await import("../../test/hono")).signedInWhen("user_1", mocks),
);
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/skills/market/reviews", () => ({
  listSkillReviews: mocks.listSkillReviews,
  upsertMySkillReview: mocks.upsertMySkillReview,
  deleteMySkillReview: mocks.deleteMySkillReview,
  setSkillReviewReply: mocks.setSkillReviewReply,
  setSkillReviewStatus: mocks.setSkillReviewStatus,
}));
vi.mock("../../modules/skills/market/auto-list", () => ({
  acknowledgeSkillVersion: vi.fn(),
}));

import { registerSkillReviewRoutes } from "./skills-reviews";

const createTestApp = () => createRouteTestApp(registerSkillReviewRoutes);

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const review = {
  id: "rev_1",
  rating: 4,
  body: "Good",
  status: "visible" as const,
  version: "1.0.0",
  reviewer: { name: "Ada", image: null },
  authorReply: null,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
};
const page = {
  items: [review],
  nextCursor: null,
  summary: {
    count: 1,
    average: 4,
    distribution: { "1": 0, "2": 0, "3": 0, "4": 1, "5": 0 },
  },
  viewer: { canReview: true, canReply: false, ownReview: review },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signedIn = true;
  mocks.admin = false;
  mocks.listSkillReviews.mockResolvedValue(page);
  mocks.upsertMySkillReview.mockResolvedValue(review);
  mocks.deleteMySkillReview.mockResolvedValue(true);
  mocks.setSkillReviewReply.mockResolvedValue({
    ...review,
    authorReply: { body: "Thanks", createdAt: review.createdAt },
  });
  mocks.setSkillReviewStatus.mockResolvedValue({
    reviewId: "rev_1",
    skillId: "skill_1",
    status: "hidden",
  });
});

test("the list is readable signed out, passes the query through, and is never shared-cached", async () => {
  const app = createTestApp();
  mocks.signedIn = false;
  const response = await app.request(
    "/v1/skills/pdf-tools/reviews?sort=highest&limit=5&cursor=abc",
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), page);
  assert.deepEqual(mocks.listSkillReviews.mock.calls[0]![0], {
    slug: "pdf-tools",
    viewer: null,
    request: { sort: "highest", limit: 5, cursor: "abc" },
  });
});

test("a signed-in viewer is passed with their admin standing; defaults fill the query", async () => {
  const app = createTestApp();
  mocks.admin = true;
  const response = await app.request("/v1/skills/pdf-tools/reviews?cursor=");
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.listSkillReviews.mock.calls[0]![0], {
    slug: "pdf-tools",
    viewer: { userId: "user_1", isMarketAdmin: true },
    // An empty cursor was not given.
    request: { cursor: undefined, sort: "newest", limit: 20 },
  });
});

test("a bad query is a 400; a skill the viewer cannot read is a 404", async () => {
  const app = createTestApp();
  for (const query of ["sort=best", "limit=0", "limit=51", "limit=many"]) {
    const response = await app.request(`/v1/skills/pdf-tools/reviews?${query}`);
    assert.equal(response.status, 400, query);
  }
  assert.equal(mocks.listSkillReviews.mock.calls.length, 0);
  mocks.listSkillReviews.mockResolvedValue(null);
  const missing = await app.request("/v1/skills/secret/reviews");
  assert.equal(missing.status, 404);
  const tooLong = await app.request(`/v1/skills/${"a".repeat(300)}/reviews`);
  assert.equal(tooLong.status, 404);
});

test("writing needs a session; the body is validated and trimmed", async () => {
  const app = createTestApp();
  const url = "/v1/skills/pdf-tools/reviews/mine";
  mocks.signedIn = false;
  for (const request of [json("PUT", { rating: 5 }), { method: "DELETE" }]) {
    const response = await app.request(url, request);
    assert.equal(response.status, 401);
  }
  mocks.signedIn = true;

  for (const body of [
    {},
    { rating: 0 },
    { rating: 6 },
    { rating: 4.5 },
    { rating: "5" },
    { rating: 5, body: "x".repeat(2001) },
    { rating: 5, extra: true },
  ]) {
    const response = await app.request(url, json("PUT", body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const badJson = await app.request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(badJson.status, 400);
  assert.equal(mocks.upsertMySkillReview.mock.calls.length, 0);

  // Past the limit only as untrimmed whitespace: accepted, trimmed.
  const response = await app.request(
    url,
    json("PUT", { rating: 5, body: `  ${"y".repeat(2000)}\u0000  ` }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { review });
  assert.deepEqual(mocks.upsertMySkillReview.mock.calls[0]![0], {
    slug: "pdf-tools",
    userId: "user_1",
    rating: 5,
    body: "y".repeat(2000),
  });

  // A rating alone is a review with no text.
  await app.request(url, json("PUT", { rating: 3 }));
  assert.equal(mocks.upsertMySkillReview.mock.calls[1]![0].body, "");
});

test("module refusals keep their status: 403 not installed, 429 rate limited", async () => {
  const app = createTestApp();
  const url = "/v1/skills/pdf-tools/reviews/mine";
  mocks.upsertMySkillReview.mockRejectedValueOnce(
    new ContentError(403, "SKILL_REVIEW_NOT_INSTALLED", "no"),
  );
  const forbidden = await app.request(url, json("PUT", { rating: 5 }));
  assert.equal(forbidden.status, 403);
  assert.equal(
    ((await forbidden.json()) as { code: string }).code,
    "SKILL_REVIEW_NOT_INSTALLED",
  );
  mocks.upsertMySkillReview.mockRejectedValueOnce(
    new ContentError(429, "SKILL_REVIEW_RATE_LIMITED", "slow down"),
  );
  const limited = await app.request(url, json("PUT", { rating: 5 }));
  assert.equal(limited.status, 429);
});

test("deleting one's own review", async () => {
  const app = createTestApp();
  const response = await app.request("/v1/skills/pdf-tools/reviews/mine", {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.deepEqual(mocks.deleteMySkillReview.mock.calls[0]![0], {
    slug: "pdf-tools",
    userId: "user_1",
  });
});

test("replying: a session, a non-empty body; DELETE removes it", async () => {
  const app = createTestApp();
  const url = "/v1/skills/pdf-tools/reviews/rev_1/reply";
  mocks.signedIn = false;
  assert.equal(
    (await app.request(url, json("PUT", { body: "Thanks" }))).status,
    401,
  );
  mocks.signedIn = true;
  for (const body of [{}, { body: "   " }, { body: "x".repeat(2001) }]) {
    const response = await app.request(url, json("PUT", body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const response = await app.request(url, json("PUT", { body: " Thanks " }));
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.setSkillReviewReply.mock.calls[0]![0], {
    slug: "pdf-tools",
    reviewId: "rev_1",
    userId: "user_1",
    body: "Thanks",
  });
  const removed = await app.request(url, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(mocks.setSkillReviewReply.mock.calls[1]![0].body, null);
});

test("moderation is a market admin's: 401 signed out, 403 otherwise", async () => {
  const app = createTestApp();
  const url = "/v1/skills/registry/admin/reviews/rev_1/status";
  mocks.signedIn = false;
  assert.equal(
    (await app.request(url, json("POST", { status: "hidden" }))).status,
    401,
  );
  mocks.signedIn = true;
  assert.equal(
    (await app.request(url, json("POST", { status: "hidden" }))).status,
    403,
  );
  assert.equal(mocks.setSkillReviewStatus.mock.calls.length, 0);

  mocks.admin = true;
  for (const body of [{}, { status: "deleted" }, { status: "hidden", x: 1 }]) {
    const response = await app.request(url, json("POST", body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const response = await app.request(
    url,
    json("POST", { status: "hidden", reason: " spam " }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reviewId: "rev_1",
    skillId: "skill_1",
    status: "hidden",
  });
  assert.deepEqual(mocks.setSkillReviewStatus.mock.calls[0]![0], {
    reviewId: "rev_1",
    actorUserId: "user_1",
    status: "hidden",
    reason: "spam",
  });

  mocks.setSkillReviewStatus.mockResolvedValue(null);
  const missing = await app.request(url, json("POST", { status: "visible" }));
  assert.equal(missing.status, 404);
});
