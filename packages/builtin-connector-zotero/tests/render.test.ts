import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TEXT_CHARS } from "../src/limits";
import { groupLibrary, parseItem, type ZoteroObject } from "../src/model";
import { renderItemMarkdown } from "../src/render";

const obj = (
  key: string,
  itemType: string,
  data: Record<string, unknown> = {},
  version = 1,
): ZoteroObject => {
  const parsed = parseItem({
    key,
    version,
    data: { key, version, itemType, ...data },
  });
  assert.ok(parsed, `fixture ${key} should parse`);
  return parsed;
};

function groupOf(...objects: ZoteroObject[]) {
  const [group] = groupLibrary(objects).parents;
  assert.ok(group, "expected a group");
  return group;
}

const render = (
  group: ReturnType<typeof groupOf>,
  collectionPaths: string[] = [],
) =>
  renderItemMarkdown({
    group,
    collectionPaths,
    libraryType: "user",
    libraryId: "1",
  });

test("a full article renders every section in order", () => {
  const group = groupOf(
    obj("ARTICLE1", "journalArticle", {
      title: "Deep Weaving",
      creators: [
        { creatorType: "author", firstName: "Jane", lastName: "Doe" },
        { creatorType: "author", name: "Acme Lab" },
      ],
      date: "2024-05-01",
      publicationTitle: "Nature",
      DOI: "10.1000/xyz",
      ISBN: "978-3-16-148410-0",
      url: "https://example.org/paper",
      abstractNote: "We weave things.",
      tags: [{ tag: "weaving" }, { tag: "ai" }],
    }),
    obj("NOTE0001", "note", {
      parentItem: "ARTICLE1",
      note: "<p>First note</p>",
    }),
    obj("NOTE0002", "note", {
      parentItem: "ARTICLE1",
      note: "<p>Second <b>note</b></p>",
    }),
    obj("ATTACH01", "attachment", {
      parentItem: "ARTICLE1",
      title: "Paper.pdf",
      contentType: "application/pdf",
      linkMode: "imported_file",
    }),
    obj("ANNOT001", "annotation", {
      parentItem: "ATTACH01",
      annotationType: "highlight",
      annotationText: "A quoted passage",
      annotationComment: "Important",
      annotationPageLabel: "12",
    }),
    obj("ANNOT002", "annotation", {
      parentItem: "ATTACH01",
      annotationType: "highlight",
      annotationText: "Another passage",
      annotationPosition: JSON.stringify({ pageIndex: 3, rects: [] }),
    }),
    obj("ANNOT003", "annotation", {
      parentItem: "ATTACH01",
      annotationType: "image",
      annotationPageLabel: "5",
    }),
    obj("ANNOT004", "annotation", {
      parentItem: "ATTACH01",
      annotationType: "note",
      annotationComment: "Only a comment",
      annotationPageLabel: "7",
    }),
  );
  const markdown = render(group, ["Reading / 2024"]);
  const headings = markdown.split("\n").filter((line) => /^#{1,3} /.test(line));
  assert.deepEqual(headings, [
    "# Deep Weaving",
    "## Abstract",
    "## Collections",
    "## Tags",
    "## Notes",
    "## Attachments",
    "## Annotations",
    "### Paper.pdf",
  ]);
  for (const expected of [
    "- Item type: journalArticle",
    "- Creators: Jane Doe, Acme Lab",
    "- Date: 2024-05-01",
    "- Publication: Nature",
    "- DOI: 10.1000/xyz",
    "- ISBN: 978-3-16-148410-0",
    "- URL: https://example.org/paper",
    "- Library: user 1",
    "We weave things.",
    "- Reading / 2024",
    "- weaving",
    "- ai",
    "First note",
    "Second note",
    "- Paper.pdf (application/pdf), imported_file",
    "- p. 12, highlight",
    "> A quoted passage",
    "Comment: Important",
    "- p. 4, highlight",
    "> Another passage",
    "Comment: Only a comment",
  ]) {
    assert.ok(markdown.includes(expected), `missing ${expected}`);
  }
  // The two notes are separated by a rule; the image annotation is skipped.
  assert.match(markdown, /First note\n\n---\n\nSecond note/);
  assert.ok(!markdown.includes("image"));
  assert.ok(!markdown.includes("p. 5"));
  // The comment-only annotation keeps its locator and type but has no quote.
  assert.match(markdown, /- p\. 7, note\n\nComment: Only a comment/);
});

test("an item with no metadata renders just its title and item type", () => {
  const markdown = render(groupOf(obj("BARE0001", "book", {})));
  assert.equal(markdown, "# Untitled\n\n- Item type: book\n- Library: user 1");
});

test("empty sections are omitted", () => {
  const markdown = render(
    groupOf(obj("BOOK0001", "book", { title: "T", tags: [], creators: [] })),
  );
  assert.ok(!markdown.includes("## "));
});

test("a standalone note renders its text under its title", () => {
  const markdown = render(
    groupOf(
      obj("NOTE0001", "note", {
        note: "<h1>Meeting</h1><p>Agenda item</p><ul><li>one</li></ul>",
      }),
    ),
  );
  assert.equal(markdown, "# Meeting\n\nMeeting\n\nAgenda item\n\n- one");
  assert.ok(!markdown.includes("## "));
});

test("hostile field values are skipped and never throw", () => {
  const group = groupOf(
    obj("HOSTILE1", "book", {
      title: "Hostile",
      abstractNote: { evil: true },
      creators: "nobody",
      tags: [null, 3, { tag: 7 }, { tag: "ok" }],
      date: 20240101,
      DOI: ["x"],
    }),
    obj("NOTE0001", "note", { parentItem: "HOSTILE1", note: { html: 1 } }),
    obj("ATTACH01", "attachment", {
      parentItem: "HOSTILE1",
      title: 42,
      contentType: {},
      linkMode: ["x"],
    }),
    obj("ANNOT001", "annotation", {
      parentItem: "ATTACH01",
      annotationText: ["a"],
      annotationComment: 5,
      annotationPageLabel: {},
      annotationPosition: { pageIndex: "x" },
    }),
    obj("ANNOT002", "annotation", {
      parentItem: "ATTACH01",
      annotationText: "kept",
      annotationPosition: "{not json",
    }),
    obj("ANNOT003", "annotation", {
      parentItem: "ATTACH01",
      annotationText: "also kept",
      annotationPosition: JSON.stringify({ pageIndex: -1 }),
    }),
    obj("ANNOT004", "annotation", {
      parentItem: "ATTACH01",
      annotationText: "third",
      annotationPosition: JSON.stringify({ pageIndex: 1e99 }),
    }),
  );
  const markdown = render(group);
  assert.ok(!markdown.includes("## Abstract"));
  assert.ok(!markdown.includes("## Notes"));
  assert.ok(!markdown.includes("[object Object]"));
  assert.ok(!markdown.includes("Creators"));
  assert.ok(markdown.includes("- ok"));
  assert.ok(markdown.includes("> kept"));
  assert.ok(markdown.includes("> also kept"));
  assert.ok(markdown.includes("> third"));
  assert.ok(!markdown.includes("p. "));
});

test("annotation text with Markdown control characters stays quoted text", () => {
  const group = groupOf(
    obj("ARTICLE1", "book", { title: "T" }),
    obj("ATTACH01", "attachment", { parentItem: "ARTICLE1", title: "A.pdf" }),
    obj("ANNOT001", "annotation", {
      parentItem: "ATTACH01",
      annotationType: "highlight",
      annotationText:
        "# Heading\r\n- bullet\n```\n---\n[x](javascript:alert(1))\n\n<script>",
    }),
  );
  const markdown = render(group);
  const lines = markdown.split("\n");
  const start = lines.indexOf("> # Heading");
  assert.ok(start > 0);
  assert.deepEqual(lines.slice(start, start + 7), [
    "> # Heading",
    "> - bullet",
    "> ```",
    "> ---",
    "> [x](javascript:alert(1))",
    "> ",
    "> <script>",
  ]);
  assert.ok(!lines.includes("# Heading"));
  assert.ok(!lines.includes("---"));
  assert.ok(!lines.includes("```"));
});

test("metadata and titles stay on one line", () => {
  const markdown = render(
    groupOf(
      obj("BOOK0001", "book", {
        title: "Two\nLines\r\n# Injected",
        publicationTitle: "A\n## Fake",
      }),
    ),
  );
  assert.ok(markdown.startsWith("# Two Lines # Injected\n"));
  assert.ok(markdown.includes("- Publication: A ## Fake"));
  assert.ok(!markdown.split("\n").includes("## Fake"));
});

test("an attachment with only empty annotations has no annotations section", () => {
  const markdown = render(
    groupOf(
      obj("BOOK0001", "book", { title: "T" }),
      obj("ATTACH01", "attachment", { parentItem: "BOOK0001", title: "A.pdf" }),
      obj("ANNOT001", "annotation", {
        parentItem: "ATTACH01",
        annotationType: "image",
      }),
    ),
  );
  assert.ok(markdown.includes("## Attachments"));
  assert.ok(!markdown.includes("## Annotations"));
});

test("an attachment link mode and content type are optional", () => {
  const markdown = render(
    groupOf(
      obj("BOOK0001", "book", { title: "T" }),
      obj("ATTACH01", "attachment", { parentItem: "BOOK0001", title: "Link" }),
      obj("ATTACH02", "attachment", {
        parentItem: "BOOK0001",
        filename: "f.epub",
        contentType: "application/epub+zip",
      }),
    ),
  );
  assert.ok(markdown.includes("\n- Link\n"));
  assert.ok(markdown.includes("- f.epub (application/epub+zip)"));
});

test("output is cut at MAX_TEXT_CHARS with the exact final marker", () => {
  const big = "<p>" + "word ".repeat(200_000) + "</p>";
  const markdown = render(
    groupOf(
      obj("BOOK0001", "book", { title: "T" }),
      obj("NOTE0001", "note", { parentItem: "BOOK0001", note: big }),
      obj("NOTE0002", "note", { parentItem: "BOOK0001", note: big }),
    ),
  );
  assert.equal(markdown.length, MAX_TEXT_CHARS);
  assert.ok(markdown.endsWith("\n\n[Content truncated]"));
});

test("output below the limit is not marked", () => {
  const markdown = render(groupOf(obj("BOOK0001", "book", { title: "T" })));
  assert.ok(!markdown.includes("[Content truncated]"));
});

test("a truncation never leaves half a surrogate pair", () => {
  const emoji = "😀".repeat(400_000);
  const markdown = render(
    groupOf(
      obj("BOOK0001", "book", { title: "T" }),
      obj("NOTE0001", "note", {
        parentItem: "BOOK0001",
        note: `<p>${emoji}</p>`,
      }),
    ),
  );
  assert.ok(
    !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
      markdown,
    ),
  );
  assert.ok(markdown.length <= MAX_TEXT_CHARS);
  assert.ok(markdown.endsWith("[Content truncated]"));
});
