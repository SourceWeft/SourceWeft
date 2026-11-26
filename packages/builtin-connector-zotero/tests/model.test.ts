import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCollectionTree,
  contentHashOf,
  groupLibrary,
  inScope,
  parseCollection,
  parseItem,
  toConnectorItem,
  type ZoteroCollection,
  type ZoteroItemGroup,
  type ZoteroObject,
} from "../src/model";

const rawCollection = (
  key: string,
  name: string,
  parent: string | false = false,
  version = 1,
) => ({ key, version, data: { key, name, parentCollection: parent } });

const collection = (
  key: string,
  name: string,
  parent: string | null = null,
): ZoteroCollection => ({ key, version: 1, name, parent });

const rawItem = (
  key: string,
  itemType: string,
  data: Record<string, unknown> = {},
  version = 1,
  href = `https://www.zotero.org/users/1/items/${key}`,
) => ({
  key,
  version,
  data: { key, version, itemType, ...data },
  links: { alternate: { href, type: "text/html" } },
});

const obj = (
  key: string,
  itemType: string,
  data: Record<string, unknown> = {},
  version = 1,
): ZoteroObject => {
  const parsed = parseItem(rawItem(key, itemType, data, version));
  assert.ok(parsed, `fixture ${key} should parse`);
  return parsed;
};

// ---------- collections ----------

test("parseCollection reads a top-level and a nested collection", () => {
  assert.deepEqual(
    parseCollection(rawCollection("AAAAAAAA", "Thesis", false, 7)),
    {
      key: "AAAAAAAA",
      version: 7,
      name: "Thesis",
      parent: null,
    },
  );
  assert.equal(
    parseCollection(rawCollection("BBBBBBBB", "Chapter", "AAAAAAAA"))?.parent,
    "AAAAAAAA",
  );
});

test("parseCollection returns null for malformed input", () => {
  for (const bad of [
    null,
    "x",
    42,
    [],
    {},
    { key: "AAAAAAAA", version: 1 },
    {
      key: "AAAAAAAA",
      version: "1",
      data: { name: "x", parentCollection: false },
    },
    { key: "", version: 1, data: { name: "x", parentCollection: false } },
    { key: "AAAAAAAA", version: 1, data: { name: 5, parentCollection: false } },
    {
      key: "AAAAAAAA",
      version: 1,
      data: { name: "", parentCollection: false },
    },
    { key: "AAAAAAAA", version: 1, data: { name: "x", parentCollection: 3 } },
  ]) {
    assert.equal(parseCollection(bad), null, JSON.stringify(bad));
  }
});

const sample = [
  collection("AAAAAAAA", "Thesis"),
  collection("BBBBBBBB", "Chapter 2", "AAAAAAAA"),
  collection("CCCCCCCC", "Section", "BBBBBBBB"),
  collection("DDDDDDDD", "Chapter 1", "AAAAAAAA"),
  collection("EEEEEEEE", "Other"),
];

test("expand returns the selection plus every descendant", () => {
  const tree = buildCollectionTree(sample);
  assert.deepEqual([...tree.expand(["BBBBBBBB"])].sort(), [
    "BBBBBBBB",
    "CCCCCCCC",
  ]);
  assert.deepEqual([...tree.expand(["AAAAAAAA"])].sort(), [
    "AAAAAAAA",
    "BBBBBBBB",
    "CCCCCCCC",
    "DDDDDDDD",
  ]);
  assert.deepEqual([...tree.expand(["CCCCCCCC", "EEEEEEEE"])].sort(), [
    "CCCCCCCC",
    "EEEEEEEE",
  ]);
});

test("expand ignores unknown keys", () => {
  const tree = buildCollectionTree(sample);
  assert.deepEqual([...tree.expand(["ZZZZZZZZ"])], []);
  assert.deepEqual([...tree.expand(["ZZZZZZZZ", "EEEEEEEE"])], ["EEEEEEEE"]);
});

test("expand terminates on a parent cycle", () => {
  const tree = buildCollectionTree([
    collection("AAAAAAAA", "A", "BBBBBBBB"),
    collection("BBBBBBBB", "B", "AAAAAAAA"),
  ]);
  assert.deepEqual([...tree.expand(["AAAAAAAA"])].sort(), [
    "AAAAAAAA",
    "BBBBBBBB",
  ]);
});

test("pathOf joins names from the root", () => {
  const tree = buildCollectionTree(sample);
  assert.equal(tree.pathOf("CCCCCCCC"), "Thesis / Chapter 2 / Section");
  assert.equal(tree.pathOf("BBBBBBBB"), "Thesis / Chapter 2");
  assert.equal(tree.pathOf("EEEEEEEE"), "Other");
});

test("pathOf terminates on cycles and orphans", () => {
  const tree = buildCollectionTree([
    collection("AAAAAAAA", "A", "BBBBBBBB"),
    collection("BBBBBBBB", "B", "AAAAAAAA"),
    collection("CCCCCCCC", "Lost", "NOPENOPE"),
  ]);
  assert.equal(typeof tree.pathOf("AAAAAAAA"), "string");
  assert.match(tree.pathOf("AAAAAAAA"), /A/);
  assert.equal(tree.pathOf("CCCCCCCC"), "Lost");
  assert.equal(tree.pathOf("ZZZZZZZZ"), "");
});

test("children sorts case-insensitively by name", () => {
  const tree = buildCollectionTree([
    collection("AAAAAAAA", "banana"),
    collection("BBBBBBBB", "Apple"),
    collection("CCCCCCCC", "cherry"),
    collection("DDDDDDDD", "Nested", "AAAAAAAA"),
  ]);
  assert.deepEqual(
    tree.children(null).map((c) => c.name),
    ["Apple", "banana", "cherry"],
  );
  assert.deepEqual(
    tree.children("AAAAAAAA").map((c) => c.name),
    ["Nested"],
  );
  assert.deepEqual(tree.children("ZZZZZZZZ"), []);
});

// ---------- parseItem ----------

test("parseItem reads the common fields", () => {
  const item = parseItem(
    rawItem(
      "ITEM0001",
      "journalArticle",
      {
        title: "A",
        collections: ["AAAAAAAA", "BBBBBBBB"],
      },
      9,
    ),
  );
  assert.ok(item);
  assert.equal(item.key, "ITEM0001");
  assert.equal(item.version, 9);
  assert.equal(item.itemType, "journalArticle");
  assert.equal(item.parentItem, null);
  assert.deepEqual(item.collections, ["AAAAAAAA", "BBBBBBBB"]);
  assert.equal(item.data.title, "A");
  assert.equal(item.webUrl, "https://www.zotero.org/users/1/items/ITEM0001");
});

test("parseItem keeps parentItem and the deleted flag, drops non-string collections", () => {
  const item = parseItem(
    rawItem("CHILD001", "note", {
      parentItem: "ITEM0001",
      deleted: 1,
      collections: ["AAAAAAAA", 7, null],
    }),
  );
  assert.ok(item);
  assert.equal(item.parentItem, "ITEM0001");
  assert.equal(item.data.deleted, 1);
  assert.deepEqual(item.collections, ["AAAAAAAA"]);
});

test("parseItem treats parentItem false as no parent", () => {
  assert.equal(
    parseItem(rawItem("ITEM0001", "book", { parentItem: false }))?.parentItem,
    null,
  );
});

test("parseItem rejects malformed objects", () => {
  for (const bad of [
    null,
    undefined,
    "x",
    7,
    [],
    {},
    { version: 1, data: { itemType: "book" } },
    { key: "", version: 1, data: { itemType: "book" } },
    { key: "ITEM0001", version: "1", data: { itemType: "book" } },
    { key: "ITEM0001", version: Number.NaN, data: { itemType: "book" } },
    { key: "ITEM0001", version: 1 },
    { key: "ITEM0001", version: 1, data: [] },
    { key: "ITEM0001", version: 1, data: { itemType: 3 } },
  ]) {
    assert.equal(parseItem(bad), null, JSON.stringify(bad));
  }
});

test("parseItem nulls a web URL on a foreign host or without https", () => {
  const url = (href: unknown) =>
    parseItem(rawItem("ITEM0001", "book", {}, 1, href as string))?.webUrl;
  assert.equal(
    url("https://www.zotero.org/users/1/items/ITEM0001"),
    "https://www.zotero.org/users/1/items/ITEM0001",
  );
  assert.equal(url("https://evil.example/users/1/items/ITEM0001"), null);
  assert.equal(url("https://www.zotero.org.evil.example/x"), null);
  assert.equal(url("https://evil@www.zotero.org/x"), null);
  assert.equal(url("http://www.zotero.org/users/1/items/ITEM0001"), null);
  assert.equal(url("javascript:alert(1)"), null);
  assert.equal(url("not a url"), null);
  assert.equal(url(42), null);
  const noLinks = parseItem({
    key: "ITEM0001",
    version: 1,
    data: { itemType: "book" },
  });
  assert.equal(noLinks?.webUrl, null);
});

const only = (library: { parents: ZoteroItemGroup[] }): ZoteroItemGroup => {
  const [group] = library.parents;
  assert.ok(group, "expected a group");
  return group;
};

// ---------- grouping ----------

test("groupLibrary attaches notes, attachments and annotations to their parent", () => {
  const parent = obj("PARENT01", "journalArticle", { title: "P" });
  const note = obj("NOTE0001", "note", {
    parentItem: "PARENT01",
    note: "<p>n</p>",
  });
  const attachment = obj("ATTACH01", "attachment", { parentItem: "PARENT01" });
  const a1 = obj("ANNOT001", "annotation", { parentItem: "ATTACH01" });
  const a2 = obj("ANNOT002", "annotation", { parentItem: "ATTACH01" });
  const { parents } = groupLibrary([a2, attachment, note, a1, parent]);
  assert.equal(parents.length, 1);
  const group = only({ parents });
  assert.equal(group.item.key, "PARENT01");
  assert.deepEqual(
    group.notes.map((n) => n.key),
    ["NOTE0001"],
  );
  assert.equal(group.attachments.length, 1);
  assert.equal(group.attachments[0]?.attachment.key, "ATTACH01");
  assert.deepEqual(group.attachments[0]?.annotations.map((a) => a.key).sort(), [
    "ANNOT001",
    "ANNOT002",
  ]);
});

test("groupLibrary keeps a standalone note and drops a standalone attachment", () => {
  const { parents } = groupLibrary([
    obj("NOTE0001", "note", { note: "<p>hi</p>" }),
    obj("ATTACH01", "attachment"),
    obj("BOOK0001", "book"),
  ]);
  assert.deepEqual(parents.map((g) => g.item.key).sort(), [
    "BOOK0001",
    "NOTE0001",
  ]);
  const note = parents.find((g) => g.item.key === "NOTE0001");
  assert.deepEqual(note?.notes, []);
  assert.deepEqual(note?.attachments, []);
});

test("groupLibrary drops orphan children and orphan annotations", () => {
  const { parents } = groupLibrary([
    obj("BOOK0001", "book"),
    obj("NOTE0001", "note", { parentItem: "GONE0001" }),
    obj("ATTACH01", "attachment", { parentItem: "GONE0001" }),
    obj("ANNOT001", "annotation", { parentItem: "GONE0002" }),
    obj("ANNOT002", "annotation"),
  ]);
  assert.deepEqual(
    parents.map((g) => g.item.key),
    ["BOOK0001"],
  );
  assert.deepEqual(parents[0]?.notes, []);
  assert.deepEqual(parents[0]?.attachments, []);
});

test("groupLibrary drops trashed items and children, and orphans their children", () => {
  const { parents } = groupLibrary([
    obj("BOOK0001", "book"),
    obj("NOTE0001", "note", { parentItem: "BOOK0001", deleted: 1 }),
    obj("ATTACH01", "attachment", { parentItem: "BOOK0001" }),
    obj("ANNOT001", "annotation", { parentItem: "ATTACH01", deleted: true }),
    obj("ANNOT002", "annotation", { parentItem: "ATTACH01" }),
    obj("BOOK0002", "book", { deleted: 1 }),
    obj("NOTE0002", "note", { parentItem: "BOOK0002" }),
    obj("TRASHATT", "attachment", { parentItem: "BOOK0001", deleted: 1 }),
    obj("ANNOT003", "annotation", { parentItem: "TRASHATT" }),
    obj("NOTE0003", "note", { deleted: 1 }),
  ]);
  assert.deepEqual(
    parents.map((g) => g.item.key),
    ["BOOK0001"],
  );
  const group = only({ parents });
  assert.deepEqual(group.notes, []);
  assert.deepEqual(
    group.attachments.map((a) => a.attachment.key),
    ["ATTACH01"],
  );
  assert.deepEqual(
    group.attachments[0]?.annotations.map((a) => a.key),
    ["ANNOT002"],
  );
});

test("groupLibrary does not treat deleted: false or 0 as trashed", () => {
  const { parents } = groupLibrary([
    obj("BOOK0001", "book", { deleted: false }),
    obj("BOOK0002", "book", { deleted: 0 }),
  ]);
  assert.equal(parents.length, 2);
});

// ---------- scope ----------

test("inScope: null means whole library, otherwise collections intersect", () => {
  const group = only(
    groupLibrary([
      obj("BOOK0001", "book", { collections: ["AAAAAAAA", "BBBBBBBB"] }),
    ]),
  );
  assert.equal(inScope(group, null), true);
  assert.equal(inScope(group, new Set(["BBBBBBBB", "ZZZZZZZZ"])), true);
  assert.equal(inScope(group, new Set(["ZZZZZZZZ"])), false);
  assert.equal(inScope(group, new Set()), false);
});

test("inScope uses the parent's collections, not the children's", () => {
  const group = only(
    groupLibrary([
      obj("BOOK0001", "book", { collections: [] }),
      obj("NOTE0001", "note", {
        parentItem: "BOOK0001",
        collections: ["AAAAAAAA"],
      }),
    ]),
  );
  assert.equal(inScope(group, new Set(["AAAAAAAA"])), false);
});

// ---------- content hash ----------

const fullLibrary = (
  overrides: { note?: number; annotation?: number; parent?: number } = {},
) =>
  only(
    groupLibrary([
      obj("PARENT01", "book", { title: "T" }, overrides.parent ?? 1),
      obj("NOTE0001", "note", { parentItem: "PARENT01" }, overrides.note ?? 1),
      obj("NOTE0002", "note", { parentItem: "PARENT01" }, 1),
      obj("ATTACH01", "attachment", { parentItem: "PARENT01" }, 1),
      obj(
        "ANNOT001",
        "annotation",
        { parentItem: "ATTACH01" },
        overrides.annotation ?? 1,
      ),
    ]),
  );

test("contentHashOf is a hex sha256 and is stable", () => {
  const hash = contentHashOf(fullLibrary(), ["A / B"]);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(contentHashOf(fullLibrary(), ["A / B"]), hash);
});

test("contentHashOf changes when only a child note version changes", () => {
  assert.notEqual(
    contentHashOf(fullLibrary({ note: 2 }), []),
    contentHashOf(fullLibrary(), []),
  );
});

test("contentHashOf changes when only an annotation version changes", () => {
  assert.notEqual(
    contentHashOf(fullLibrary({ annotation: 2 }), []),
    contentHashOf(fullLibrary(), []),
  );
});

test("contentHashOf changes when the parent version changes", () => {
  assert.notEqual(
    contentHashOf(fullLibrary({ parent: 2 }), []),
    contentHashOf(fullLibrary(), []),
  );
});

test("contentHashOf changes when a collection path changes", () => {
  const group = fullLibrary();
  assert.notEqual(
    contentHashOf(group, ["A / B"]),
    contentHashOf(group, ["A / C"]),
  );
  assert.notEqual(contentHashOf(group, ["A"]), contentHashOf(group, []));
});

test("contentHashOf ignores child and collection-path order", () => {
  const forward = only(
    groupLibrary([
      obj("PARENT01", "book"),
      obj("NOTE0001", "note", { parentItem: "PARENT01" }),
      obj("NOTE0002", "note", { parentItem: "PARENT01" }),
      obj("ATTACH01", "attachment", { parentItem: "PARENT01" }),
      obj("ATTACH02", "attachment", { parentItem: "PARENT01" }),
    ]),
  );
  const reversed = only(
    groupLibrary([
      obj("ATTACH02", "attachment", { parentItem: "PARENT01" }),
      obj("ATTACH01", "attachment", { parentItem: "PARENT01" }),
      obj("NOTE0002", "note", { parentItem: "PARENT01" }),
      obj("NOTE0001", "note", { parentItem: "PARENT01" }),
      obj("PARENT01", "book"),
    ]),
  );
  assert.equal(
    contentHashOf(forward, ["A", "B"]),
    contentHashOf(reversed, ["B", "A"]),
  );
});

test("contentHashOf does not collide when a child key moves between kinds", () => {
  const asNote = only(
    groupLibrary([
      obj("PARENT01", "book"),
      obj("CHILD001", "note", { parentItem: "PARENT01" }),
    ]),
  );
  const none = only(groupLibrary([obj("PARENT01", "book")]));
  assert.notEqual(contentHashOf(asNote, []), contentHashOf(none, []));
});

// ---------- toConnectorItem ----------

const article = () =>
  only(
    groupLibrary([
      obj(
        "ARTICLE1",
        "journalArticle",
        {
          title: "Deep Learning",
          creators: [
            { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
            { creatorType: "author", name: "OpenAI Research" },
            { creatorType: "editor", lastName: "Turing" },
          ],
          date: "2024-05-01",
          publicationTitle: "Nature",
          DOI: "10.1000/xyz",
          ISBN: "978-3-16-148410-0",
          url: "https://example.com/paper",
          dateModified: "2024-06-01T12:30:00Z",
          tags: [{ tag: "ml", type: 1 }, { tag: "ai" }],
          collections: ["AAAAAAAA"],
        },
        12,
      ),
    ]),
  );

test("toConnectorItem maps a full article", () => {
  const group = article();
  const item = toConnectorItem(group, "user", "12345", ["Thesis / Chapter 2"]);
  assert.equal(item.externalId, "zotero:ARTICLE1");
  assert.equal(
    item.externalUri,
    "https://www.zotero.org/users/1/items/ARTICLE1",
  );
  assert.equal(item.title, "Deep Learning");
  assert.equal(item.mimeType, "text/markdown");
  assert.equal(item.sizeBytes, null);
  assert.deepEqual(item.externalUpdatedAt, new Date("2024-06-01T12:30:00Z"));
  assert.equal(item.contentHash, contentHashOf(group, ["Thesis / Chapter 2"]));
  assert.deepEqual(item.metadata, {
    itemKey: "ARTICLE1",
    version: 12,
    itemType: "journalArticle",
    libraryType: "user",
    libraryId: "12345",
    creators: ["Ada Lovelace", "OpenAI Research", "Turing"],
    date: "2024-05-01",
    publicationTitle: "Nature",
    doi: "10.1000/xyz",
    isbn: "978-3-16-148410-0",
    url: "https://example.com/paper",
    collections: ["Thesis / Chapter 2"],
    tags: ["ml", "ai"],
  });
});

test("toConnectorItem omits missing fields and titles an empty item Untitled", () => {
  const group = only(groupLibrary([obj("BARE0001", "book")]));
  const item = toConnectorItem(group, "group", "99", []);
  assert.equal(item.title, "Untitled");
  assert.equal(item.externalUpdatedAt, null);
  assert.deepEqual(item.metadata, {
    itemKey: "BARE0001",
    version: 1,
    itemType: "book",
    libraryType: "group",
    libraryId: "99",
  });
  assert.equal("creators" in item.metadata, false);
  assertNoUndefinedOrEmpty(item.metadata);
});

test("toConnectorItem titles a standalone note from its first non-empty line", () => {
  const group = only(
    groupLibrary([
      obj("NOTE0001", "note", {
        note: "<div><p></p><p>  Meeting &amp; ideas  </p><p>second</p></div>",
      }),
    ]),
  );
  const item = toConnectorItem(group, "user", "1", []);
  assert.equal(item.title, "Meeting & ideas");
});

test("toConnectorItem caps a note title at 200 characters", () => {
  const group = only(
    groupLibrary([
      obj("NOTE0001", "note", { note: `<p>${"x".repeat(500)}</p>` }),
    ]),
  );
  assert.equal(toConnectorItem(group, "user", "1", []).title.length, 200);
});

test("toConnectorItem uses Untitled for an empty standalone note", () => {
  const group = only(
    groupLibrary([obj("NOTE0001", "note", { note: "<p> </p>" })]),
  );
  assert.equal(toConnectorItem(group, "user", "1", []).title, "Untitled");
});

test("toConnectorItem tolerates hostile field types", () => {
  const group = only(
    groupLibrary([
      obj("HOSTILE1", "book", {
        title: 42,
        creators: "not an array",
        date: { a: 1 },
        publicationTitle: ["x"],
        DOI: 7,
        ISBN: null,
        url: false,
        dateModified: 12345,
        tags: "nope",
      }),
    ]),
  );
  const item = toConnectorItem(group, "user", "1", []);
  assert.equal(item.title, "Untitled");
  assert.equal(item.externalUpdatedAt, null);
  assert.deepEqual(item.metadata, {
    itemKey: "HOSTILE1",
    version: 1,
    itemType: "book",
    libraryType: "user",
    libraryId: "1",
  });
});

test("toConnectorItem skips unusable creators and tags", () => {
  const group = only(
    groupLibrary([
      obj("HOSTILE2", "book", {
        creators: [
          null,
          5,
          "x",
          {},
          { firstName: "", lastName: "" },
          { name: " " },
          { firstName: "Solo" },
        ],
        tags: [null, 3, { tag: "" }, { tag: 4 }, { tag: "ok" }],
        dateModified: "garbage",
      }),
    ]),
  );
  const item = toConnectorItem(group, "user", "1", []);
  assert.deepEqual(item.metadata.creators, ["Solo"]);
  assert.deepEqual(item.metadata.tags, ["ok"]);
  assert.equal(item.externalUpdatedAt, null);
});

test("toConnectorItem caps lengths and entry counts", () => {
  const group = only(
    groupLibrary([
      obj("BIG00001", "book", {
        title: "t".repeat(5000),
        date: "d".repeat(5000),
        publicationTitle: "p".repeat(5000),
        creators: Array.from({ length: 300 }, (_, i) => ({
          name: `Name ${i}`,
        })),
        tags: Array.from({ length: 300 }, (_, i) => ({ tag: `tag${i}` })),
      }),
    ]),
  );
  const paths = Array.from({ length: 300 }, (_, i) => `Path ${i}`);
  const item = toConnectorItem(group, "user", "1", paths);
  assert.equal(item.title.length, 1000);
  assert.equal((item.metadata.date as string).length, 2000);
  assert.equal((item.metadata.publicationTitle as string).length, 2000);
  assert.equal((item.metadata.creators as string[]).length, 100);
  assert.equal((item.metadata.tags as string[]).length, 100);
  assert.equal((item.metadata.collections as string[]).length, 100);
  assert.equal(
    item.contentHash,
    contentHashOf(group, item.metadata.collections as string[]),
    "the hash covers exactly the stored (filtered and capped) paths",
  );
});

function assertNoUndefinedOrEmpty(value: unknown): void {
  if (value === undefined) assert.fail("undefined in metadata");
  if (value === "") assert.fail("empty string in metadata");
  if (Array.isArray(value)) value.forEach(assertNoUndefinedOrEmpty);
  else if (value && typeof value === "object")
    Object.values(value).forEach(assertNoUndefinedOrEmpty);
}
