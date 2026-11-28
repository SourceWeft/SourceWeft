import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";

// The admin overview: who may ask, and that the numbers come from each
// section's own source.
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: true,
  listing: vi.fn(),
}));

vi.mock("../middleware/auth-session", () => ({
  getSessionUserId: () => "admin_1",
  requireSession: mocks.session,
}));
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/market/review", () => ({
  countReviewQueue: async () => 2,
}));
vi.mock("../../modules/skills/registry/review", () => ({
  countRegistryReviewQueue: async () => 3,
}));
vi.mock("../../modules/skills/market/auto-list", () => ({
  countSkillListingQueue: mocks.listing,
  acknowledgeSkillVersion: vi.fn(),
}));
vi.mock("../../modules/skills/market/reports", () => ({
  countOpenSkillReports: async () => 4,
}));
vi.mock("../../modules/blog/repository", () => ({
  countBlogPostsForAdmin: async () => ({ drafts: 24, published: 1 }),
}));
vi.mock("../../modules/skills/market/admin-list", () => ({}));
vi.mock("../../modules/skills/market/events", () => ({}));
vi.mock("../../modules/skills/market/listing", () => ({}));
vi.mock("../../modules/skills/market/standing", () => ({}));

import { registerAdminOverviewRoutes } from "./admin-overview";

const createTestApp = () => createRouteTestApp(registerAdminOverviewRoutes);

beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue({ user: { id: "admin_1" } });
  mocks.admin = true;
  mocks.listing.mockReset().mockResolvedValue(5);
});

test("an admin gets every section's number, uncached", async () => {
  const response = await createTestApp().request("/v1/admin/overview");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    pending: { mcpReview: 2, skillReview: 3, skillListing: 5, reports: 4 },
    blog: { drafts: 24, published: 1 },
  });
});

test("signed out is 401 and a non-admin is 403, before anything is counted", async () => {
  mocks.session.mockResolvedValue(null);
  assert.equal(
    (await createTestApp().request("/v1/admin/overview")).status,
    401,
  );

  mocks.session.mockResolvedValue({ user: { id: "user_1" } });
  mocks.admin = false;
  assert.equal(
    (await createTestApp().request("/v1/admin/overview")).status,
    403,
  );
  assert.equal(mocks.listing.mock.calls.length, 0);
});
