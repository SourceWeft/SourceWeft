// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  listBlogAdminPosts: vi.fn(),
  getBlogAdminPost: vi.fn(),
  setBlogAdminPostStatus: vi.fn(),
  importBlogMarkdown: vi.fn(),
}));
vi.mock("../../../../../lib/blog-admin", async (original) => ({
  ...(await original<typeof import("../../../../../lib/blog-admin")>()),
  ...api,
}));

import {
  BlogAdmin,
  blogPostPublicPath,
  filterBlogGroups,
  groupBlogPosts,
  visibilityOf,
} from "./blog-admin";
import { button, flush, mountWithIntl, typeInto, unmountAll } from "@/test/react";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

const post = (overrides: Record<string, unknown> = {}) => ({
  id: "post_mcp_en",
  articleId: "what-is-mcp",
  locale: "en",
  slug: "what-is-mcp",
  status: "draft",
  syncEnabled: true,
  title: "What is MCP?",
  excerpt: "An open protocol.",
  category: "Guides",
  tags: ["MCP"],
  readingTimeMinutes: 5,
  publishedAt: null,
  syncedAt: "2026-11-15T01:00:00.000Z",
  source: "markdown",
  ...overrides,
});

const posts = [
  post(),
  post({ id: "post_mcp_tw", locale: "zh-TW", slug: "what-is-mcp-zh-tw", title: "什麼是 MCP？" }),
  post({
    id: "post_mcp_cn",
    locale: "zh-CN",
    slug: "what-is-mcp-zh-cn",
    title: "什么是 MCP？",
    status: "published",
    publishedAt: "2026-11-16T00:00:00.000Z",
  }),
  post({
    id: "post_dir_en",
    articleId: "mcp-server-directories-compared",
    slug: "mcp-server-directories-compared",
    title: "MCP server directories compared",
    category: "Comparisons",
    syncedAt: "2026-11-16T02:00:00.000Z",
    status: "published",
    publishedAt: "2026-11-16T02:00:00.000Z",
  }),
];

async function render() {
  ({ container } = await mountWithIntl(<BlogAdmin />));
  await flush(2);
}

async function click(label: string) {
  await act(async () => {
    button(label)!.click();
  });
  await flush(2);
}

test("groups versions by article, in a fixed language order, newest first", () => {
  const groups = groupBlogPosts(posts as never);
  expect(groups.map((group) => group.articleId)).toEqual([
    "mcp-server-directories-compared",
    "what-is-mcp",
  ]);
  expect(groups[1]?.versions.map((version) => version.locale)).toEqual([
    "en",
    "zh-CN",
    "zh-TW",
  ]);
  expect(groups[1]?.title).toBe("What is MCP?");
});

test("search matches id, title and slug; the status filter matches any version", () => {
  const groups = groupBlogPosts(posts as never);
  expect(filterBlogGroups(groups, "什么是", "all").map((g) => g.articleId)).toEqual(["what-is-mcp"]);
  expect(filterBlogGroups(groups, "zh-tw", "all").map((g) => g.articleId)).toEqual(["what-is-mcp"]);
  expect(filterBlogGroups(groups, "", "draft").map((g) => g.articleId)).toEqual(["what-is-mcp"]);
  expect(filterBlogGroups(groups, "", "published")).toHaveLength(2);
  expect(filterBlogGroups(groups, "nothing", "all")).toHaveLength(0);
});

test("visibility and public address", () => {
  expect(visibilityOf({ status: "published", syncEnabled: true })).toBe("published");
  expect(visibilityOf({ status: "published", syncEnabled: false })).toBe("hidden");
  expect(visibilityOf({ status: "draft", syncEnabled: true })).toBe("draft");
  expect(blogPostPublicPath({ locale: "en", slug: "what-is-mcp" })).toBe("/blog/what-is-mcp");
  expect(blogPostPublicPath({ locale: "zh-TW", slug: "what-is-mcp-zh-tw" })).toBe(
    "/zh-TW/blog/what-is-mcp-zh-tw",
  );
});

test("lists articles with one status per language", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: posts });
  await render();
  expect(container.textContent).toContain("MCP server directories compared");
  expect(container.textContent).toContain("What is MCP?");
  expect(container.textContent).toContain("en · Draft");
  expect(container.textContent).toContain("zh-CN · Published");
  expect(container.textContent).toContain("zh-TW · Draft");
});

test("an empty blog says how to add the first article; a failed load says so", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: [] });
  await render();
  expect(container.textContent).toContain("No articles yet");

  await unmountAll();
  api.listBlogAdminPosts.mockRejectedValue(new Error("offline"));
  await render();
  expect(container.textContent).toContain("offline");
});

test("selecting an article previews it, and publishing updates the list", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: posts });
  api.getBlogAdminPost.mockResolvedValue({
    ...post(),
    contentHtml: '<h2 id="hello">Hello</h2><p>Body.</p>',
  });
  api.setBlogAdminPostStatus.mockResolvedValue({
    ...post({ status: "published", publishedAt: "2026-11-17T00:00:00.000Z" }),
    contentHtml: '<h2 id="hello">Hello</h2><p>Body.</p>',
  });
  await render();

  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent?.includes("What is MCP?"))!
      .click();
  });
  await flush(2);
  expect(api.getBlogAdminPost).toHaveBeenCalledWith("post_mcp_en");
  expect(container.querySelector(".blog-content h2")?.textContent).toBe("Hello");
  expect(container.textContent).toContain("/blog/what-is-mcp");
  expect(button("Unpublish")).toBeUndefined();

  await click("Publish");
  expect(api.setBlogAdminPostStatus).toHaveBeenCalledWith("post_mcp_en", "published");
  expect(container.textContent).toContain("en · Published");
  expect(button("Unpublish")).toBeDefined();
  expect(container.textContent).toContain("View on site");
});

test("a status change that fails keeps the article as it was and says so", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: posts });
  api.getBlogAdminPost.mockResolvedValue({ ...post(), contentHtml: "<p>Body.</p>" });
  api.setBlogAdminPostStatus.mockRejectedValue(new Error("Forbidden"));
  await render();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent?.includes("What is MCP?"))!
      .click();
  });
  await flush(2);
  await click("Publish");
  expect(container.textContent).toContain("Forbidden");
  expect(container.textContent).toContain("en · Draft");
});

// jsdom's File has no text(); browsers do.
function textFile(content: string, name: string) {
  const file = new File([content], name, { type: "text/markdown" });
  Object.defineProperty(file, "text", { value: async () => content });
  return file;
}

function upload(files: File[]) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="blog-import-input"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  return act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("importing files sends their text, reports the result and reloads", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: [] });
  api.importBlogMarkdown.mockResolvedValue({
    dryRun: false,
    posts: [
      { path: "en.md", articleId: "a", locale: "en", slug: "a", title: "A", created: true },
      { path: "zh-CN.md", articleId: "a", locale: "zh-CN", slug: "a-zh-cn", title: "A", created: false },
    ],
  });
  await render();
  await upload([
    textFile("---\narticleId: a\n---\nBody", "en.md"),
    textFile("---\narticleId: a\n---\n正文", "zh-CN.md"),
  ]);
  await flush(3);

  expect(api.importBlogMarkdown).toHaveBeenCalledWith([
    { path: "en.md", content: "---\narticleId: a\n---\nBody" },
    { path: "zh-CN.md", content: "---\narticleId: a\n---\n正文" },
  ]);
  expect(container.textContent).toContain("Imported 2 files: 1 new, 1 updated.");
  expect(api.listBlogAdminPosts).toHaveBeenCalledTimes(2);
});

test("a refused import lists every problem per file", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: [] });
  api.importBlogMarkdown.mockRejectedValue({
    message: "Invalid request body",
    details: {
      problems: [{ path: "bad.md", message: "- articleId is required\n- excerpt is required" }],
    },
  });
  await render();
  await upload([textFile("x", "bad.md")]);
  await flush(3);

  expect(container.textContent).toContain("Nothing was imported");
  expect(container.textContent).toContain("bad.md");
  expect(container.textContent).toContain("articleId is required");
  expect(api.listBlogAdminPosts).toHaveBeenCalledTimes(1);
});

test("search narrows the list", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: posts });
  await render();
  await typeInto(container.querySelector<HTMLInputElement>('input[aria-label="Search articles"]')!, "directories");
  expect(container.textContent).toContain("MCP server directories compared");
  expect(container.textContent).not.toContain("What is MCP?");
});
