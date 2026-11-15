// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  listBlogAdminPosts: vi.fn(),
  getBlogAdminPost: vi.fn(),
  setBlogAdminPostStatus: vi.fn(),
}));
vi.mock("../../../../../lib/blog-admin", async (original) => ({
  ...(await original<typeof import("../../../../../lib/blog-admin")>()),
  ...api,
}));

import { BlogArticle } from "./blog-article";
import { blogPost, blogPosts } from "./blog-posts.fixture";
import { button, flush, mountWithIntl, unmountAll } from "@/test/react";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
});

const body = '<h2 id="hello">Hello</h2><p>Body.</p>';

async function render(props: { articleId?: string; initialLocale?: string } = {}) {
  ({ container } = await mountWithIntl(
    <BlogArticle articleId={props.articleId ?? "what-is-mcp"} initialLocale={props.initialLocale} />,
  ));
  await flush(3);
}

async function click(label: string) {
  await act(async () => {
    button(label)!.click();
  });
  await flush(2);
}

test("opens on the first language version and previews it", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: blogPosts });
  api.getBlogAdminPost.mockResolvedValue({ ...blogPost(), contentHtml: body });
  await render();

  expect(api.getBlogAdminPost).toHaveBeenCalledWith("post_mcp_en");
  expect(container.querySelector("h1")?.textContent).toBe("What is MCP?");
  expect(container.querySelector(".blog-content h2")?.textContent).toBe("Hello");
  expect(container.textContent).toContain("/blog/what-is-mcp");
  expect(container.querySelector('a[href="/dashboard/admin/blog"]')?.textContent).toContain(
    "All articles",
  );
  expect(button("Unpublish")).toBeUndefined();
});

test("opens on the language in the address, and switching language keeps the address in step", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: blogPosts });
  api.getBlogAdminPost.mockResolvedValue({ ...blogPost(), contentHtml: body });
  await render({ initialLocale: "zh-CN" });
  expect(api.getBlogAdminPost).toHaveBeenCalledWith("post_mcp_cn");
  expect(container.querySelector("h1")?.textContent).toBe("什么是 MCP？");
  expect(button("Unpublish")).toBeDefined();

  await click("zh-TW · Draft");
  expect(api.getBlogAdminPost).toHaveBeenLastCalledWith("post_mcp_tw");
  expect(window.location.pathname + window.location.search).toBe(
    "/dashboard/admin/blog/what-is-mcp?locale=zh-TW",
  );
});

test("publishing updates the status and offers the public page", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: blogPosts });
  api.getBlogAdminPost.mockResolvedValue({ ...blogPost(), contentHtml: body });
  api.setBlogAdminPostStatus.mockResolvedValue({
    ...blogPost({ status: "published", publishedAt: "2026-11-17T00:00:00.000Z" }),
    contentHtml: body,
  });
  await render();

  await click("Publish");
  expect(api.setBlogAdminPostStatus).toHaveBeenCalledWith("post_mcp_en", "published");
  expect(button("en · Published")).toBeDefined();
  expect(button("Unpublish")).toBeDefined();
  expect(container.textContent).toContain("View on site");
});

test("a status change that fails keeps the article as it was and says so", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: blogPosts });
  api.getBlogAdminPost.mockResolvedValue({ ...blogPost(), contentHtml: body });
  api.setBlogAdminPostStatus.mockRejectedValue(new Error("Forbidden"));
  await render();
  await click("Publish");
  expect(container.textContent).toContain("Forbidden");
  expect(button("en · Draft")).toBeDefined();
});

test("an unknown article says so; a failed load says so", async () => {
  api.listBlogAdminPosts.mockResolvedValue({ items: blogPosts });
  await render({ articleId: "missing" });
  expect(container.textContent).toContain("There is no article with the ID missing.");
  expect(api.getBlogAdminPost).not.toHaveBeenCalled();

  await unmountAll();
  api.listBlogAdminPosts.mockRejectedValue(new Error("offline"));
  await render();
  expect(container.textContent).toContain("offline");
});
