import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../../response/api-response";
import { ContentError } from "../../../modules/content/errors";

const mocks = vi.hoisted(() => ({
  listCatalog: vi.fn(),
  listCatalogCategories: vi.fn(),
  getCatalogSkillDetail: vi.fn(),
  getCatalogSkillDetailBySlug: vi.fn(),
  getRegistryVersionDetail: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: () => "user_1",
  requireSession: async () => ({ user: { id: "user_1" } }),
}));
vi.mock("../../../modules/workspace", () => ({
  requireContentWorkspace: async () => ({
    id: "workspace_1",
    organizationId: "team_1",
  }),
}));
vi.mock("../../../modules/skills", () => ({ contentSkillsService: mocks }));
// Only the cursor codec is wanted from the service module; the real one drags
// in the database.
vi.mock("../../../modules/skills/service", () => ({
  decodeSkillCatalogCursor: (cursor: string) =>
    cursor === "good" ? { name: "A", id: "1" } : null,
}));
vi.mock("../../../modules/skills/registry/versions", () => ({
  listRegistryVersions: vi.fn(),
  switchRegistryVersion: vi.fn(),
}));
vi.mock("../../../modules/skills/registry/permissions", () => ({
  requireSkillWorkspace: vi.fn(),
}));

import { registerSkillRoutes } from "./skills";

function createTestApp() {
  const app = new Hono();
  const workspaceRoutes = new Hono();
  registerSkillRoutes(workspaceRoutes);
  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

const viewer = { teamId: "team_1", workspaceId: "workspace_1", userId: "user_1" };
const base = "/v1/workspaces/workspace_1/skills/catalog";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCatalog.mockResolvedValue({ items: [], nextCursor: null });
  mocks.getCatalogSkillDetail.mockResolvedValue({ skill: { slug: "by-id" } });
  mocks.getCatalogSkillDetailBySlug.mockResolvedValue({
    skill: { slug: "by-slug" },
  });
});

const noFilters = {
  category: undefined,
  trust: "all",
  capability: "all",
  installed: "all",
};

test("the catalog defaults to a page of 50 and passes paging and search through", async () => {
  assert.equal((await createTestApp().request(base)).status, 200);
  assert.deepEqual(mocks.listCatalog.mock.calls[0], [
    {
      ...viewer,
      limit: 50,
      cursor: undefined,
      query: undefined,
      sort: "recommended",
      filters: noFilters,
    },
  ]);

  const response = await createTestApp().request(
    `${base}?limit=100&cursor=good&q=%20pdf%20`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.listCatalog.mock.calls[1], [
    {
      ...viewer,
      limit: 100,
      cursor: "good",
      query: "pdf",
      sort: "recommended",
      filters: noFilters,
    },
  ]);
});

test("the market filters and the sort reach the service as given", async () => {
  const response = await createTestApp().request(
    `${base}?category=documents-office&trust=verified&capability=executable&installed=not_installed&sort=popular`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.listCatalog.mock.calls[0], [
    {
      ...viewer,
      limit: 50,
      cursor: undefined,
      query: undefined,
      sort: "popular",
      filters: {
        category: "documents-office",
        trust: "verified",
        capability: "executable",
        installed: "not_installed",
      },
    },
  ]);
});

test("an unknown filter value or sort is a validation error", async () => {
  for (const query of [
    "trust=ours",
    "capability=prompt",
    "installed=yes",
    "sort=trending",
    "category=",
  ]) {
    const response = await createTestApp().request(`${base}?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(
      ((await response.json()) as { code?: string }).code,
      "VALIDATION_ERROR",
      query,
    );
  }
  assert.equal(mocks.listCatalog.mock.calls.length, 0);
});

// A well-formed cursor of another sort is only known to be wrong by the
// service, whose error must reach the client under its own code.
test("a cursor used with another sort answers INVALID_CURSOR", async () => {
  mocks.listCatalog.mockRejectedValue(
    new ContentError(400, "INVALID_CURSOR", "Catalog cursor belongs to the 'name' sort, not 'popular'"),
  );
  const response = await createTestApp().request(
    `${base}?cursor=good&sort=popular`,
  );
  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "INVALID_CURSOR",
  );
});

test("categories is not shadowed by the catalogId route", async () => {
  mocks.listCatalogCategories.mockResolvedValue({
    items: [{ slug: "documents-office", name: "Documents & Office", description: null, count: 2 }],
  });
  const response = await createTestApp().request(`${base}/categories`);
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.listCatalogCategories.mock.calls, [
    [{ userId: "user_1" }],
  ]);
  assert.equal(mocks.getCatalogSkillDetail.mock.calls.length, 0);
  const body = (await response.json()) as {
    items: Array<{ slug: string; count: number }>;
  };
  assert.equal(body.items[0]?.count, 2);
});

test("bad catalog paging input is a validation error, not a query", async () => {
  for (const query of ["limit=0", "limit=101", "limit=abc", "cursor=bad", "cursor="]) {
    const response = await createTestApp().request(`${base}?${query}`);
    assert.equal(response.status, 400, query);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "VALIDATION_ERROR", query);
  }
  assert.equal(mocks.listCatalog.mock.calls.length, 0);
});

test("by-slug is not shadowed by the catalogId route", async () => {
  const response = await createTestApp().request(
    `${base}/by-slug/gh-owner-repo-pdf`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.getCatalogSkillDetailBySlug.mock.calls, [
    [{ ...viewer, slug: "gh-owner-repo-pdf" }],
  ]);
  assert.equal(mocks.getCatalogSkillDetail.mock.calls.length, 0);

  await createTestApp().request(`${base}/skill_1%3Aversion_1`);
  assert.deepEqual(mocks.getCatalogSkillDetail.mock.calls, [
    [{ ...viewer, catalogId: "skill_1:version_1" }],
  ]);
});

// Community skills are imported through `/skills/registry/submissions` only.
test("the synchronous submit endpoint is gone", async () => {
  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/skills/registry/submit",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: "acme/skills" }),
    },
  );
  assert.equal(response.status, 404);
});

// The service applies the full-text rule; the raw registry read does not.
test("a version's detail is read through the service", async () => {
  mocks.getRegistryVersionDetail.mockResolvedValue({ contentRestricted: true });
  const response = await createTestApp().request(
    `${base}/skill_1%3Aversion_1/versions/version_0`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.getRegistryVersionDetail.mock.calls, [
    [{ ...viewer, catalogId: "skill_1:version_1", versionId: "version_0" }],
  ]);
});
