import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ children: vi.fn() }));
vi.mock("./notion-client", () => ({
  listBlockChildren: mocks.children,
}));
vi.mock("./public-storage", () => ({
  downloadAndUploadBlogAsset: vi.fn(),
}));
vi.mock("./repository", () => ({
  buildBlogAssetId: vi.fn(),
  upsertBlogAsset: vi.fn(),
}));

import { renderNotionPageContent } from "./notion-renderer";

const text = (value: string, extra: Record<string, unknown> = {}) => ({
  plain_text: value,
  ...extra,
});

const row = (...cells: unknown[][]) => ({
  id: "row",
  type: "table_row",
  table_row: { cells },
});

function render(blocksByParent: Record<string, unknown[]>) {
  mocks.children.mockImplementation(
    async (id: string) => blocksByParent[id] ?? [],
  );
  return renderNotionPageContent({
    pageId: "page",
    articleId: "a1",
    locale: "en",
    postId: "p1",
    postTitle: "Post",
    dryRun: true,
  });
}

beforeEach(() => {
  mocks.children.mockReset();
});

test("a table with a column header renders a thead and body rows", async () => {
  const out = await render({
    page: [
      {
        id: "t1",
        type: "table",
        has_children: true,
        table: { has_column_header: true, has_row_header: false },
      },
    ],
    t1: [
      row([text("Server")], [text("Runs")]),
      row([text("Supabase")], [text("Remote")]),
    ],
  });

  assert.equal(
    out.contentHtml,
    '<div class="blog-table"><table><thead><tr><th scope="col">Server</th><th scope="col">Runs</th></tr></thead><tbody><tr><td>Supabase</td><td>Remote</td></tr></tbody></table></div>',
  );
  assert.equal(out.contentText, "Server | Runs\nSupabase | Remote");
});

test("a table without a column header has no thead; a row header marks the first cell", async () => {
  const out = await render({
    page: [
      {
        id: "t1",
        type: "table",
        has_children: true,
        table: { has_column_header: false, has_row_header: true },
      },
    ],
    t1: [row([text("Speed")], [text("One command")])],
  });

  assert.equal(
    out.contentHtml,
    '<div class="blog-table"><table><tbody><tr><th scope="row">Speed</th><td>One command</td></tr></tbody></table></div>',
  );
});

test("cells keep links, bold and inline code, and escape markup", async () => {
  const out = await render({
    page: [
      {
        id: "t1",
        type: "table",
        has_children: true,
        table: { has_column_header: false },
      },
    ],
    t1: [
      row(
        [text("Neon", { href: "https://sourceweft.com/mcp/com.neon%2Fmcp" })],
        [
          text("OAuth", { annotations: { bold: true } }),
          text(" or "),
          text("<key>", { annotations: { code: true } }),
        ],
      ),
    ],
  });

  assert.match(
    out.contentHtml,
    /<td><a href="https:\/\/sourceweft\.com\/mcp\/com\.neon%2Fmcp"[^>]*>Neon<\/a><\/td>/,
  );
  assert.match(
    out.contentHtml,
    /<td><strong>OAuth<\/strong> or <code>&lt;key&gt;<\/code><\/td>/,
  );
});

test("a table with no rows renders nothing", async () => {
  const out = await render({
    page: [
      { id: "t1", type: "table", has_children: true, table: {} },
    ],
    t1: [],
  });
  assert.equal(out.contentHtml, "");
});
