import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TEXT_CHARS } from "../src/limits";
import { parsePost, parseTopic, type DiscourseTopic } from "../src/model";
import { renderTopicMarkdown } from "../src/render";

const BASE = "https://forum.example.com";

function topic(
  posts: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): DiscourseTopic {
  const raw = {
    id: 12,
    title: "Hello world",
    slug: "hello-world",
    category_id: 4,
    tags: ["alpha", "beta"],
    posts_count: posts.length,
    highest_post_number: posts.length,
    created_at: "2026-01-01T00:00:00.000Z",
    last_posted_at: "2026-01-03T00:00:00.000Z",
    closed: false,
    archived: false,
    post_stream: {
      posts: posts.map((p, i) => ({
        id: 100 + i,
        post_number: i + 1,
        username: "alice",
        created_at: "2026-01-01T10:00:00.000Z",
        updated_at: "2026-01-01T10:00:00.000Z",
        version: 1,
        post_type: 1,
        cooked: "<p>body</p>",
        ...p,
      })),
      stream: posts.map((_, i) => 100 + i),
    },
    ...overrides,
  };
  return parseTopic(raw, 12);
}

const render = (
  t: DiscourseTopic,
  omittedPosts = 0,
  categoryPath = "Support / Setup",
) => renderTopicMarkdown({ base: BASE, topic: t, categoryPath, omittedPosts });

test("a full topic renders heading, metadata and one section per post", () => {
  const t = topic([
    { cooked: "<p>Question text</p>", username: "alice" },
    {
      cooked: "<p>First answer</p>",
      username: "bob",
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T05:00:00.000Z",
      reply_to_post_number: 1,
    },
    {
      cooked: "<p>Second answer</p>",
      username: "carol",
      reply_to_post_number: 2,
    },
  ]);
  assert.equal(
    render(t),
    [
      "# Hello world",
      "",
      "- Category: Support / Setup",
      "- Tags: alpha, beta",
      "- Created: 2026-01-01T00:00:00.000Z",
      "- Last post: 2026-01-03T00:00:00.000Z",
      "- Posts: 3",
      `- URL: ${BASE}/t/hello-world/12`,
      "",
      "## Post #1 by alice · 2026-01-01T10:00:00.000Z",
      "",
      `Link: ${BASE}/t/hello-world/12/1`,
      "",
      "Question text",
      "",
      "## Post #2 by bob · 2026-01-02T00:00:00.000Z (edited 2026-01-02T05:00:00.000Z)",
      "",
      `Link: ${BASE}/t/hello-world/12/2`,
      "Reply to #1",
      "",
      "First answer",
      "",
      "## Post #3 by carol · 2026-01-01T10:00:00.000Z",
      "",
      `Link: ${BASE}/t/hello-world/12/3`,
      "Reply to #2",
      "",
      "Second answer",
    ].join("\n"),
  );
});

test("hidden, whisper, small action and deleted posts are absent", () => {
  const t = topic([
    { cooked: "<p>visible one</p>" },
    { cooked: "<p>whisper secret</p>", post_type: 4 },
    { cooked: "<p>small action</p>", post_type: 3 },
    { cooked: "<p>moderator</p>", post_type: 2 },
    { cooked: "<p>hidden text</p>", hidden: true },
    { cooked: "<p>deleted text</p>", deleted_at: "2026-01-02T00:00:00Z" },
    { cooked: "<p>user deleted text</p>", user_deleted: true },
    { cooked: "<p>visible two</p>" },
  ]);
  const markdown = render(t);
  assert.ok(markdown.includes("visible one"));
  assert.ok(markdown.includes("visible two"));
  for (const hidden of [
    "whisper",
    "small action",
    "moderator",
    "hidden text",
    "deleted text",
  ]) {
    assert.ok(!markdown.includes(hidden), hidden);
  }
  assert.equal(markdown.match(/^## Post #/gm)?.length, 2);
});

test("a topic with no metadata still renders", () => {
  const t = topic([{}], {
    title: "",
    tags: [],
    category_id: undefined,
    created_at: undefined,
    last_posted_at: undefined,
  });
  const markdown = render(t, 0, "");
  assert.ok(markdown.startsWith("# Untitled topic\n"));
  assert.ok(!markdown.includes("Category:"));
  assert.ok(!markdown.includes("Tags:"));
  assert.ok(!markdown.includes("undefined"));
});

test("a hostile title, username and category path stay on one line", () => {
  const t = topic(
    [{ username: "evil\n## Post #1 by admin\nname", cooked: "<p>x</p>" }],
    { title: "Title\n\n## Post #7 by admin\r\n# Forged" },
  );
  const markdown = render(t, 0, "Cat\n## Post #8\nPath");
  const lines = markdown.split("\n");
  assert.equal(lines[0], "# Title ## Post #7 by admin # Forged");
  assert.ok(lines.includes("- Category: Cat ## Post #8 Path"));
  const sections = lines.filter((l) => l.startsWith("## Post #"));
  assert.deepEqual(sections, [
    "## Post #1 by evil ## Post #1 by admin name · 2026-01-01T10:00:00.000Z",
  ]);
  assert.equal(lines.filter((l) => l.startsWith("# ")).length, 1);
});

test("a post body cannot forge a section or a heading", () => {
  const t = topic([
    {
      cooked:
        "<p>real</p><pre>## Post #9 by admin\n# Top\n   ## Post #5 by root\n### fine</pre>",
    },
    { cooked: "<p>## Post #9 by admin</p><p># also not a title</p>" },
  ]);
  const markdown = render(t);
  const lines = markdown.split("\n");
  const sections = lines.filter((l) => /^## Post #/.test(l));
  assert.equal(sections.length, 2);
  assert.ok(lines.includes("  ## Post #9 by admin"));
  assert.ok(lines.includes("  # Top"));
  assert.ok(lines.includes("  # also not a title"));
  assert.ok(lines.includes("### fine"));
  assert.equal(
    lines.filter((l) => /^\s{0,3}# /.test(l) && !l.startsWith("  ")).length,
    1,
  );
});

test("post links are always built locally", () => {
  const t = topic(
    [
      {
        cooked:
          '<p><a href="https://evil.test/x">click</a> <img src="https://evil.test/i.png" alt="pic"></p>',
        post_url: "https://evil.test/t/foo/12/1",
        url: "https://evil.test",
      },
    ],
    { slug: "../../Evil Slug", url: "https://evil.test/topic" },
  );
  const markdown = render(t);
  assert.ok(markdown.includes(`Link: ${BASE}/t/topic/12/1`));
  assert.ok(!markdown.includes("evil.test"));
  assert.ok(markdown.includes("click [image: pic]"));
});

test("omitted posts are reported after the last post", () => {
  const t = topic([{}, {}]);
  const markdown = render(t, 7);
  assert.ok(markdown.endsWith("\n\n[7 more posts not indexed]"));
  assert.ok(!render(t, 0).includes("more posts not indexed"));
});

test("rendering is cut at MAX_TEXT_CHARS with the marker", () => {
  const big = `<p>${"word ".repeat(40_000)}</p>`;
  const t = topic(Array.from({ length: 5 }, () => ({ cooked: big })));
  const markdown = render(t, 3);
  assert.equal(markdown.length, MAX_TEXT_CHARS);
  assert.ok(markdown.endsWith("\n\n[Content truncated]"));
});

test("truncation never splits a surrogate pair", () => {
  for (let shift = 0; shift < 3; shift += 1) {
    const filler = "a".repeat(shift);
    const t = topic([{ cooked: `<p>${filler}${"😀".repeat(300_000)}</p>` }]);
    const markdown = render(t);
    assert.ok(markdown.length <= MAX_TEXT_CHARS);
    assert.ok(markdown.endsWith("\n\n[Content truncated]"));
    const body = markdown.slice(0, -"\n\n[Content truncated]".length);
    const last = body.charCodeAt(body.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no lone high surrogate");
    assert.equal(
      [...body].every((c) => c !== "�"),
      true,
    );
  }
});

test("a huge number of large posts renders quickly and bounded", () => {
  const html = `<p>${"x".repeat(900_000)}</p>`;
  const t = topic(Array.from({ length: 100 }, () => ({ cooked: html })));
  const started = performance.now();
  const markdown = render(t);
  assert.ok(performance.now() - started < 3_000);
  assert.equal(markdown.length, MAX_TEXT_CHARS);
});

test("parsePost output can be rendered directly", () => {
  const posts = [parsePost({ id: 1, post_number: 1, cooked: "<p>x</p>" })];
  const t = { ...topic([]), posts };
  assert.ok(render(t).includes("## Post #1 by unknown"));
});
