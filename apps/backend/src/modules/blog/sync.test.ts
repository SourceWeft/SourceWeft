import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  identities: vi.fn(),
  hide: vi.fn(),
}));
vi.mock("./notion-client", () => ({
  getBlogDataSource: async () => ({}),
  queryBlogPages: async () => [],
}));
vi.mock("./notion-properties", () => ({
  parseBlogPage: vi.fn(),
  validateBlogDataSourceTemplate: () => undefined,
}));
vi.mock("./notion-renderer", () => ({ renderNotionPageContent: vi.fn() }));
vi.mock("./public-storage", () => ({
  downloadAndUploadBlogAsset: vi.fn(),
  validatePublicS3Config: () => undefined,
}));
vi.mock("./repository", () => ({
  buildBlogAssetId: vi.fn(),
  buildBlogPostId: vi.fn(),
  listBlogPostIdentities: mocks.identities,
  markBlogPostHidden: mocks.hide,
  pruneBlogAssets: vi.fn(),
  upsertBlogAsset: vi.fn(),
  upsertBlogPost: vi.fn(),
  upsertBlogPostShell: vi.fn(),
}));

import { syncNotionBlog } from "./sync";

beforeEach(() => {
  mocks.identities.mockReset();
  mocks.hide.mockReset();
});

test("a Notion sync archives Notion rows that left Notion, and leaves Markdown rows alone", async () => {
  mocks.identities.mockResolvedValue([
    { id: "from_notion", articleId: "a", locale: "en", source: "notion" },
    { id: "from_markdown", articleId: "b", locale: "en", source: "markdown" },
  ]);

  const result = await syncNotionBlog();

  assert.equal(result.hidden, 1);
  assert.deepEqual(mocks.hide.mock.calls, [[{ id: "from_notion" }]]);
});

test("a dry run hides nothing", async () => {
  mocks.identities.mockResolvedValue([
    { id: "from_notion", articleId: "a", locale: "en", source: "notion" },
  ]);
  const result = await syncNotionBlog({ dryRun: true });
  assert.equal(result.hidden, 0);
  assert.equal(mocks.hide.mock.calls.length, 0);
});
