import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";
import { ApiError, ApiResponse } from "../response/api-response";

const mocks = vi.hoisted(() => ({
  findMarketSkill: vi.fn(),
  listMarketSkillCategories: vi.fn(),
  listMarketSkills: vi.fn(),
  listPublicSkillCollections: vi.fn(),
  findPublicSkillCollection: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("../../modules/skills/market/read-repository", () => ({
  findMarketSkill: mocks.findMarketSkill,
  listMarketSkillCategories: mocks.listMarketSkillCategories,
  listMarketSkills: mocks.listMarketSkills,
}));
vi.mock("../../modules/skills/market/collections", () => ({
  listPublicSkillCollections: mocks.listPublicSkillCollections,
  findPublicSkillCollection: mocks.findPublicSkillCollection,
}));
// Nothing here may ask who is calling. If a route ever does, this shows it.
vi.mock("../middleware/auth-session", () => ({
  getSessionUserId: vi.fn(),
  requireSession: mocks.requireSession,
}));

import {
  RESERVED_MARKET_SKILL_SLUGS,
  registerSkillPublicRoutes,
} from "./skills-public";

const createTestApp = () => createRouteTestApp(registerSkillPublicRoutes);

/** What the repository was asked for, less the parameters nobody gave. */
function listRequest() {
  return JSON.parse(
    JSON.stringify(mocks.listMarketSkills.mock.calls[0]?.[0] ?? null),
  ) as unknown;
}

const summary = {
  slug: "gh-anthropics-skills-pdf",
  name: "pdf",
  displayName: "PDF",
  description: "Work with PDF files",
  logo: {
    url: "https://github.com/anthropics.png?size=128",
    source: "publisher",
  },
  categories: ["documents-office"],
  verified: true,
  featured: true,
  capability: "executable",
  license: "MIT",
  author: "anthropics",
  repoUrl: "https://github.com/anthropics/skills",
  sourceUrl: `https://github.com/anthropics/skills/tree/${"a".repeat(40)}/pdf`,
  installCount: 3,
  listedAt: "2026-09-01T00:00:00.000Z",
  version: "aaaaaaaaaaaa",
  updatedAt: "2026-09-02T00:00:00.000Z",
  cliInstallable: true,
  stars: 1200,
  repoPushedAt: "2026-09-10T00:00:00.000Z",
  repoArchived: false,
  claimed: false,
};

const collection = {
  slug: "office-work",
  title: "Office work",
  summary: "Documents, sheets and slides",
  itemCount: 1,
  updatedAt: "2026-09-15T00:00:00.000Z",
};

const detail = {
  skill: summary,
  skillMd: "---\nname: pdf\n---\nBody\n",
  files: [
    {
      path: "SKILL.md",
      sizeBytes: 24,
      mimeType: "text/markdown",
      contentHash: "0".repeat(64),
    },
  ],
  versions: [
    {
      version: "aaaaaaaaaaaa",
      isCurrent: true,
      publishedAt: "2026-09-02T00:00:00.000Z",
      commitSha: "a".repeat(40),
      committedAt: null,
    },
  ],
  source: {
    repoUrl: summary.repoUrl,
    sourceUrl: summary.sourceUrl,
    commitSha: "a".repeat(40),
    committedAt: null,
    repoSubpath: "pdf",
  },
  scanFlags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMarketSkills.mockResolvedValue({
    items: [summary],
    nextCursor: null,
  });
  mocks.listMarketSkillCategories.mockResolvedValue({
    items: [
      {
        slug: "documents-office",
        name: "Documents",
        description: null,
        count: 1,
      },
    ],
    total: 1,
  });
  mocks.findMarketSkill.mockResolvedValue(detail);
  mocks.listPublicSkillCollections.mockResolvedValue({ items: [collection] });
  mocks.findPublicSkillCollection.mockResolvedValue({
    collection,
    items: [summary],
  });
});

// --- request parsing ---

test("the list is served without a session, with every filter parsed", async () => {
  const response = await createTestApp().request(
    "/v1/skills?query=pdf%20form&category=documents-office&verified=true&featured=false&capability=executable&sort=popular&limit=10&cursor=abc",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [summary],
    nextCursor: null,
  });
  assert.deepEqual(mocks.listMarketSkills.mock.calls[0]?.[0], {
    query: "pdf form",
    category: "documents-office",
    verified: true,
    featured: false,
    capability: "executable",
    sort: "popular",
    limit: 10,
    cursor: "abc",
  });
  assert.equal(mocks.requireSession.mock.calls.length, 0);
});

test("no parameters means no filters; the repository picks sort and page size", async () => {
  const response = await createTestApp().request("/v1/skills");
  assert.equal(response.status, 200);
  assert.deepEqual(listRequest(), {});
});

test("a parameter left empty is a parameter not given", async () => {
  const response = await createTestApp().request(
    "/v1/skills?query=&category=&verified=&featured=&capability=&sort=&limit=&cursor=",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(listRequest(), {});
});

test("verified reads true/false and 1/0, and refuses anything else", async () => {
  const app = createTestApp();
  for (const [raw, expected] of [
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ] as const) {
    mocks.listMarketSkills.mockClear();
    const response = await app.request(`/v1/skills?verified=${raw}`);
    assert.equal(response.status, 200, raw);
    assert.equal(mocks.listMarketSkills.mock.calls[0]?.[0].verified, expected);
  }
  mocks.listMarketSkills.mockClear();
  const response = await app.request("/v1/skills?verified=yes");
  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    code: string;
    details: { fieldErrors: Record<string, string[]> };
  };
  assert.equal(body.code, "VALIDATION_ERROR");
  assert.ok(body.details.fieldErrors.verified);
  assert.equal(mocks.listMarketSkills.mock.calls.length, 0);
});

test("featured reads as verified does, and refuses anything else", async () => {
  const app = createTestApp();
  for (const [raw, expected] of [
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ] as const) {
    mocks.listMarketSkills.mockClear();
    const response = await app.request(`/v1/skills?featured=${raw}`);
    assert.equal(response.status, 200, raw);
    assert.equal(mocks.listMarketSkills.mock.calls[0]?.[0].featured, expected);
  }
  mocks.listMarketSkills.mockClear();
  const response = await app.request("/v1/skills?featured=yes");
  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    details: { fieldErrors: Record<string, string[]> };
  };
  assert.ok(body.details.fieldErrors.featured);
  assert.equal(mocks.listMarketSkills.mock.calls.length, 0);
});

test("an unknown sort, capability or out-of-range limit is a 400, never a guess", async () => {
  const app = createTestApp();
  for (const [query, field] of [
    ["sort=trending", "sort"],
    ["capability=prompt", "capability"],
    ["limit=0", "limit"],
    ["limit=101", "limit"],
    ["limit=2.5", "limit"],
    ["limit=many", "limit"],
    [`query=${"x".repeat(201)}`, "query"],
    [`cursor=${"x".repeat(1025)}`, "cursor"],
  ] as const) {
    const response = await app.request(`/v1/skills?${query}`);
    assert.equal(response.status, 400, query);
    const body = (await response.json()) as {
      code: string;
      details: { fieldErrors: Record<string, string[]> };
    };
    assert.equal(body.code, "VALIDATION_ERROR", query);
    assert.ok(body.details.fieldErrors[field], query);
  }
  assert.equal(mocks.listMarketSkills.mock.calls.length, 0);
});

test("the limit bounds themselves are accepted", async () => {
  const app = createTestApp();
  for (const limit of [1, 100]) {
    mocks.listMarketSkills.mockClear();
    const response = await app.request(`/v1/skills?limit=${limit}`);
    assert.equal(response.status, 200);
    assert.equal(mocks.listMarketSkills.mock.calls[0]?.[0].limit, limit);
  }
});

test("a cursor the repository refuses comes back as 400 INVALID_CURSOR", async () => {
  const { ContentError } = await import("../../modules/content/errors");
  mocks.listMarketSkills.mockRejectedValue(
    new ContentError(400, "INVALID_CURSOR", "Skill cursor is not valid"),
  );
  const response = await createTestApp().request("/v1/skills?cursor=nonsense");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "INVALID_CURSOR",
    message: "Skill cursor is not valid",
  });
});

// --- routing ---

test("categories is a route of its own, not a skill called 'categories'", async () => {
  const response = await createTestApp().request("/v1/skills/categories");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [
      {
        slug: "documents-office",
        name: "Documents",
        description: null,
        count: 1,
      },
    ],
    total: 1,
  });
  assert.equal(mocks.findMarketSkill.mock.calls.length, 0);
});

test("reserved path segments are a 404 without a lookup", async () => {
  assert.deepEqual([...RESERVED_MARKET_SKILL_SLUGS].sort(), [
    "categories",
    "category-counts",
    "collections",
    "registry",
  ]);
  const app = createTestApp();
  for (const slug of ["registry", "category-counts"]) {
    const response = await app.request(`/v1/skills/${slug}`);
    assert.equal(response.status, 404, slug);
    assert.deepEqual(await response.json(), {
      code: "NOT_FOUND",
      message: "Skill not found",
    });
  }
  assert.equal(mocks.findMarketSkill.mock.calls.length, 0);
});

test("the admin API's deeper paths are not swallowed by the slug route", async () => {
  const app = new Hono();
  // Registration order as in `createApp`: admin routes first.
  app.get("/v1/skills/registry/admin/listing-queue", (c) => c.text("admin"));
  registerSkillPublicRoutes(app);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));

  const admin = await app.request("/v1/skills/registry/admin/listing-queue");
  assert.equal(await admin.text(), "admin");
  const deeper = await app.request("/v1/skills/registry/admin/unknown");
  assert.equal(deeper.status, 404);
  assert.equal(mocks.findMarketSkill.mock.calls.length, 0);
});

test("a skill is looked up by its decoded slug; one that is not public is a plain 404", async () => {
  const app = createTestApp();
  const found = await app.request("/v1/skills/gh-anthropics-skills-pdf");
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), detail);
  assert.equal(
    mocks.findMarketSkill.mock.calls[0]?.[0],
    "gh-anthropics-skills-pdf",
  );

  mocks.findMarketSkill.mockResolvedValue(null);
  const missing = await app.request("/v1/skills/gh-someone-private-skill");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    code: "NOT_FOUND",
    message: "Skill not found",
  });

  mocks.findMarketSkill.mockClear();
  const absurd = await app.request(`/v1/skills/${"x".repeat(300)}`);
  assert.equal(absurd.status, 404);
  assert.equal(mocks.findMarketSkill.mock.calls.length, 0);
});

// --- caching ---

test("responses carry an ETag and public Cache-Control, and honor If-None-Match", async () => {
  const app = createTestApp();
  for (const path of [
    "/v1/skills",
    "/v1/skills/categories",
    "/v1/skills/gh-anthropics-skills-pdf",
  ]) {
    const first = await app.request(path);
    assert.equal(first.status, 200, path);
    assert.equal(first.headers.get("cache-control"), "public, max-age=60");
    const etag = first.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]{32}"$/);

    const revalidated = await app.request(path, {
      headers: { "if-none-match": etag! },
    });
    assert.equal(revalidated.status, 304, path);
    assert.equal(await revalidated.text(), "");
    assert.equal(revalidated.headers.get("etag"), etag);

    const stale = await app.request(path, {
      headers: { "if-none-match": '"something-older"' },
    });
    assert.equal(stale.status, 200, path);
  }
});

test("the ETag follows the content", async () => {
  const app = createTestApp();
  const before = (await app.request("/v1/skills")).headers.get("etag");
  mocks.listMarketSkills.mockResolvedValue({
    items: [{ ...summary, installCount: 4 }],
    nextCursor: null,
  });
  const after = (await app.request("/v1/skills")).headers.get("etag");
  assert.notEqual(before, after);
});

// --- contract ---

test("a row the contract does not accept is our 500, not the caller's 400", async () => {
  mocks.listMarketSkills.mockResolvedValue({
    items: [{ ...summary, listedAt: null }],
    nextCursor: null,
  });
  const response = await createTestApp().request("/v1/skills");
  assert.equal(response.status, 500);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "MARKET_SKILL_INVALID",
  );
});

test("a file whose hash is not a sha256 refuses the whole detail", async () => {
  // A client verifies every download against the manifest, so a manifest with
  // a hole in it is worse than none.
  mocks.findMarketSkill.mockResolvedValue({
    ...detail,
    files: [{ ...detail.files[0], contentHash: "hash" }],
  });
  const response = await createTestApp().request(
    "/v1/skills/gh-anthropics-skills-pdf",
  );
  assert.equal(response.status, 500);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "MARKET_SKILL_INVALID",
  );
});

test("what the contract does not name does not go out", async () => {
  mocks.findMarketSkill.mockResolvedValue({
    ...detail,
    files: [{ ...detail.files[0], contentText: "secret", objectKey: "k" }],
  });
  const response = await createTestApp().request(
    "/v1/skills/gh-anthropics-skills-pdf",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), detail);
});

// --- collections ---

test("collections are routes of their own, not a skill called 'collections'", async () => {
  const app = createTestApp();
  const list = await app.request("/v1/skills/collections");
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "public, max-age=60");
  assert.deepEqual(await list.json(), { items: [collection] });

  const one = await app.request("/v1/skills/collections/office-work");
  assert.equal(one.status, 200);
  assert.deepEqual(await one.json(), { collection, items: [summary] });
  assert.equal(
    mocks.findPublicSkillCollection.mock.calls[0]?.[0],
    "office-work",
  );
  assert.equal(mocks.findMarketSkill.mock.calls.length, 0);
});

test("a collection that is not published is a plain 404", async () => {
  mocks.findPublicSkillCollection.mockResolvedValue(null);
  const response = await createTestApp().request(
    "/v1/skills/collections/drafts",
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    code: "NOT_FOUND",
    message: "Collection not found",
  });
});

test("a summary from an older server still parses, with the new facts at their defaults", async () => {
  const { marketSkillSummarySchema } =
    await import("@sourceweft/market-contracts");
  const {
    cliInstallable: _cli,
    stars: _stars,
    repoPushedAt: _pushed,
    repoArchived: _archived,
    claimed: _claimed,
    ...older
  } = summary;
  const parsed = marketSkillSummarySchema.parse(older);
  assert.equal(parsed.stars, 0);
  assert.equal(parsed.repoPushedAt, null);
  assert.equal(parsed.repoArchived, false);
  assert.equal(parsed.claimed, false);
  assert.equal(parsed.cliInstallable, undefined);
});

// --- AI overview language (§17.4) ---

test("locale is passed to the list and the detail, and an unknown one is a 400", async () => {
  const app = createTestApp();
  assert.equal((await app.request("/v1/skills?locale=zh-TW")).status, 200);
  assert.equal(mocks.listMarketSkills.mock.calls[0]?.[0].locale, "zh-TW");
  assert.equal((await app.request("/v1/skills?locale=fr")).status, 400);

  const found = await app.request(
    "/v1/skills/gh-anthropics-skills-pdf?locale=zh-CN",
  );
  assert.equal(found.status, 200);
  assert.deepEqual(mocks.findMarketSkill.mock.calls[0]?.[1], {
    locale: "zh-CN",
  });
  assert.equal(
    (await app.request("/v1/skills/gh-anthropics-skills-pdf?locale=de")).status,
    400,
  );
  // No locale: the repository's default (English).
  await app.request("/v1/skills/gh-anthropics-skills-pdf");
  assert.deepEqual(mocks.findMarketSkill.mock.calls[1]?.[1], {
    locale: undefined,
  });
});

test("aiSummary and aiOverview are optional for answers from older servers", async () => {
  const { getMarketSkillResponseSchema } =
    await import("@sourceweft/market-contracts");
  const parsed = getMarketSkillResponseSchema.parse(detail);
  assert.equal(parsed.aiOverview, undefined);
  assert.equal(parsed.skill.aiSummary, undefined);
  const withOverview = getMarketSkillResponseSchema.parse({
    ...detail,
    skill: { ...summary, aiSummary: "One line." },
    aiOverview: {
      summary: "One line.",
      whatItDoes: "Fills PDF forms.",
      whenToUse: "When a form arrives.",
      requirements: "",
      locale: "en",
      generatedAt: "2026-09-22T00:00:00.000Z",
    },
  });
  assert.equal(withOverview.aiOverview?.locale, "en");
});

test("a collection is read in the locale asked for; an unknown one is a 400", async () => {
  const app = createTestApp();
  const found = await app.request(
    "/v1/skills/collections/starter?locale=zh-CN",
  );
  assert.equal(found.status, 200);
  assert.deepEqual(mocks.findPublicSkillCollection.mock.calls[0]?.[1], {
    locale: "zh-CN",
  });
  await app.request("/v1/skills/collections/starter");
  assert.deepEqual(mocks.findPublicSkillCollection.mock.calls[1]?.[1], {
    locale: undefined,
  });
  assert.equal(
    (await app.request("/v1/skills/collections/starter?locale=xx")).status,
    400,
  );
});
