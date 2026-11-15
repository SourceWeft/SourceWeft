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

import { BlogAdmin } from "./blog-admin";
import { blogPosts as posts } from "./blog-posts.fixture";
import { flush, mountWithIntl, typeInto, unmountAll } from "@/test/react";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

async function render() {
  ({ container } = await mountWithIntl(<BlogAdmin />));
  await flush(2);
}

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

test("each article and each language version links to the article's own page", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: posts });
  await render();
  const hrefs = [...container.querySelectorAll("tbody a")].map((node) => node.getAttribute("href"));
  expect(hrefs).toContain("/dashboard/admin/blog/what-is-mcp");
  expect(hrefs).toContain("/dashboard/admin/blog/what-is-mcp?locale=zh-CN");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(container.textContent).toContain("2 of 2 articles");
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
