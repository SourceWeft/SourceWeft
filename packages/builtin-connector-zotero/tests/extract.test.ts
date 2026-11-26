import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorItemSkipError,
  type ConnectorItem,
} from "@sourceweft/contracts";
import { createZoteroClient } from "../src/client";
import { ZoteroError } from "../src/errors";
import { extractZoteroItem } from "../src/extract";
import { contentHashOf, groupLibrary, parseItem } from "../src/model";
import { scanLibrary } from "../src/scan";
import {
  startFakeZotero,
  type FakeLibrary,
  type FakeObject,
} from "./helpers/fake-zotero";

const KEY = "abcdEFGH12345678abcdEFGH";

const raw = (
  key: string,
  itemType: string,
  data: Record<string, unknown> = {},
  version = 1,
): FakeObject => ({
  key,
  version,
  data: { key, version, itemType, ...data },
});

function setup(library: FakeLibrary) {
  const fake = startFakeZotero({ version: 5, ...library });
  const client = createZoteroClient({
    fetch: fake.fetch,
    credential: { secret: KEY },
    libraryPrefix: "users/1",
    sleep: async () => undefined,
  });
  return { fake, client };
}

const discovered = (overrides: Partial<ConnectorItem> = {}): ConnectorItem => ({
  externalId: "zotero:ARTICLE1",
  externalUri: "https://www.zotero.org/users/1/items/ARTICLE1",
  title: "Old title",
  mimeType: "text/markdown",
  sizeBytes: null,
  externalUpdatedAt: null,
  contentHash: "stale",
  metadata: {
    itemKey: "ARTICLE1",
    libraryType: "user",
    libraryId: "1",
    collections: ["Reading / 2024"],
  },
  ...overrides,
});

const article = raw("ARTICLE1", "journalArticle", {
  title: "Deep Weaving",
  abstractNote: "We weave.",
  collections: ["COLL0001"],
});

const richLibrary: FakeLibrary = {
  items: [article],
  children: {
    ARTICLE1: [
      raw("NOTE0001", "note", {
        parentItem: "ARTICLE1",
        note: "<p>My note</p>",
      }),
      raw("ATTACH01", "attachment", {
        parentItem: "ARTICLE1",
        title: "Paper.pdf",
        contentType: "application/pdf",
        linkMode: "imported_file",
      }),
      raw("ATTACH02", "attachment", {
        parentItem: "ARTICLE1",
        title: "Trashed.pdf",
        deleted: 1,
      }),
      raw("NOTE0002", "note", {
        parentItem: "ARTICLE1",
        note: "<p>Trashed note</p>",
        deleted: true,
      }),
    ],
    ATTACH01: [
      raw("ANNOT001", "annotation", {
        parentItem: "ATTACH01",
        annotationType: "highlight",
        annotationText: "quoted",
        annotationPageLabel: "3",
      }),
    ],
  },
};
// The fake serves children only for known item keys.
richLibrary.items = [
  article,
  raw("ATTACH01", "attachment", { parentItem: "ARTICLE1" }),
  raw("ATTACH02", "attachment", { parentItem: "ARTICLE1" }),
];

test("extract fetches the item, its children and one child list per live attachment", async () => {
  const { fake, client } = setup(richLibrary);
  const result = await extractZoteroItem({ client, item: discovered() });
  assert.deepEqual(
    fake.requests.map((request) => request.path),
    [
      "/users/1/items/ARTICLE1",
      "/users/1/items/ARTICLE1/children",
      "/users/1/items/ATTACH01/children",
    ],
  );
  assert.equal(result.item.title, "Deep Weaving");
  assert.equal(result.markdown, result.contentText);
  assert.ok(result.contentText.includes("My note"));
  assert.ok(!result.contentText.includes("Trashed"));
  assert.ok(result.contentText.includes("> quoted"));
  assert.ok(result.contentText.includes("- p. 3, highlight"));
  // Everything else on the discovered item is kept.
  assert.equal(result.item.externalId, "zotero:ARTICLE1");
  assert.deepEqual(result.item.metadata, discovered().metadata);
});

test("the returned contentHash equals the hash of the fetched data", async () => {
  const { client } = setup(richLibrary);
  const result = await extractZoteroItem({ client, item: discovered() });
  const objects = [
    article,
    ...(richLibrary.children?.ARTICLE1 ?? []),
    ...(richLibrary.children?.ATTACH01 ?? []),
  ].map((entry) => {
    const parsed = parseItem(entry);
    assert.ok(parsed);
    return parsed;
  });
  const [group] = groupLibrary(objects).parents;
  assert.ok(group);
  assert.equal(
    result.item.contentHash,
    contentHashOf(group, ["Reading / 2024"]),
  );
  assert.notEqual(result.item.contentHash, "stale");
});

test("the scan hash and the extract hash agree for the same library", async () => {
  const children = richLibrary.children ?? {};
  const everything = [
    article,
    ...(children.ARTICLE1 ?? []),
    ...(children.ATTACH01 ?? []),
  ];
  const { client } = setup({
    items: everything,
    children,
    collections: [
      {
        key: "COLL0001",
        version: 1,
        data: { key: "COLL0001", name: "Reading", parentCollection: false },
      },
    ],
  });
  let scanned: ConnectorItem | undefined;
  for await (const page of scanLibrary({
    client,
    libraryType: "user",
    libraryId: "1",
    selectedCollectionKeys: [],
    cursor: null,
  })) {
    scanned = page.items.find(
      (entry) => entry.externalId === "zotero:ARTICLE1",
    );
  }
  assert.ok(scanned, "the scan should discover the article");
  assert.deepEqual(scanned.metadata.collections, ["Reading"]);
  const result = await extractZoteroItem({ client, item: scanned });
  assert.equal(result.item.contentHash, scanned.contentHash);
  assert.equal(result.item.title, scanned.title);
});

test("an invalid itemKey is skipped before any request", async () => {
  for (const itemKey of [
    "short",
    "abcdefgh",
    "ARTICLE1/children",
    "../ARTICLE1",
    "ARTICLE10",
    12345678,
    undefined,
    null,
  ]) {
    const { fake, client } = setup(richLibrary);
    await assert.rejects(
      extractZoteroItem({
        client,
        item: discovered({
          metadata: { itemKey, libraryType: "user", libraryId: "1" },
        }),
      }),
      (error) =>
        error instanceof ConnectorItemSkipError &&
        error.reason === "unreadable",
    );
    assert.equal(fake.requests.length, 0);
  }
});

test("an invalid libraryType or libraryId is skipped before any request", async () => {
  for (const [libraryType, libraryId] of [
    ["team", "1"],
    ["user", 1],
    [undefined, undefined],
  ]) {
    const { fake, client } = setup(richLibrary);
    await assert.rejects(
      extractZoteroItem({
        client,
        item: discovered({
          metadata: { itemKey: "ARTICLE1", libraryType, libraryId },
        }),
      }),
      (error) =>
        error instanceof ConnectorItemSkipError &&
        error.reason === "unreadable",
    );
    assert.equal(fake.requests.length, 0);
  }
});

test("an item too large to read in full is skipped as unreadable", async () => {
  const attachments = Array.from({ length: 60 }, (_, i) =>
    raw(`ATT${String(i).padStart(5, "0")}`, "attachment", {
      parentItem: "ARTICLE1",
      title: `Attachment number ${i}`,
    }),
  );
  const fake = startFakeZotero({
    version: 5,
    items: [article],
    children: { ARTICLE1: attachments },
  });
  const client = createZoteroClient({
    fetch: fake.fetch,
    credential: { secret: KEY },
    libraryPrefix: "users/1",
    sleep: async () => undefined,
    maxResponseBytes: 2_000,
  });
  await assert.rejects(
    extractZoteroItem({ client, item: discovered() }),
    (error) =>
      error instanceof ConnectorItemSkipError && error.reason === "unreadable",
  );
});

test("scan and extract hash alike for many, unknown and over-long collection paths", async () => {
  const collections = Array.from({ length: 120 }, (_, i) => {
    const key = `COLL${String(i).padStart(4, "0")}`;
    return {
      key,
      version: 1,
      data: { key, name: `Collection ${i}`, parentCollection: false },
    };
  });
  collections.push({
    key: "COLLLONG",
    version: 1,
    data: { key: "COLLLONG", name: "L".repeat(2_500), parentCollection: false },
  });
  const memberOf = [
    "UNKNOWN1",
    "COLLLONG",
    ...collections.slice(0, 120).map((c) => c.key),
  ];
  const { client } = setup({
    items: [raw("ARTICLE1", "book", { title: "Many", collections: memberOf })],
    collections,
  });
  let scanned: ConnectorItem | undefined;
  for await (const page of scanLibrary({
    client,
    libraryType: "user",
    libraryId: "1",
    selectedCollectionKeys: [],
    cursor: null,
  })) {
    scanned = page.items.find(
      (entry) => entry.externalId === "zotero:ARTICLE1",
    );
  }
  assert.ok(scanned);
  const stored = scanned.metadata.collections;
  assert.ok(Array.isArray(stored));
  assert.equal(stored.length, 100);
  assert.ok(stored.every((path) => path !== "" && path.length <= 2_000));
  const result = await extractZoteroItem({ client, item: scanned });
  assert.equal(result.item.contentHash, scanned.contentHash);
});

test("an attachment key that is not a Zotero key is never used in a URL", async () => {
  const { fake, client } = setup({
    items: [article],
    children: {
      ARTICLE1: [raw("bad/key", "attachment", { parentItem: "ARTICLE1" })],
    },
  });
  await assert.rejects(
    extractZoteroItem({ client, item: discovered() }),
    (error) =>
      error instanceof ZoteroError && error.code === "ZOTERO_BAD_RESPONSE",
  );
  assert.deepEqual(
    fake.requests.map((request) => request.path),
    ["/users/1/items/ARTICLE1", "/users/1/items/ARTICLE1/children"],
  );
});

test("an item deleted since the scan is skipped as unreadable", async () => {
  const { client } = setup({ items: [] });
  await assert.rejects(
    extractZoteroItem({ client, item: discovered() }),
    (error) =>
      error instanceof ConnectorItemSkipError && error.reason === "unreadable",
  );
});

test("an item trashed since the scan is skipped as unreadable", async () => {
  const { client } = setup({
    items: [raw("ARTICLE1", "book", { title: "T", deleted: 1 })],
  });
  await assert.rejects(
    extractZoteroItem({ client, item: discovered() }),
    (error) =>
      error instanceof ConnectorItemSkipError && error.reason === "unreadable",
  );
});

test("an item that is no longer a top-level item is skipped as unreadable", async () => {
  const { client } = setup({
    items: [raw("ARTICLE1", "attachment", { parentItem: "PARENT01" })],
  });
  await assert.rejects(
    extractZoteroItem({ client, item: discovered() }),
    (error) =>
      error instanceof ConnectorItemSkipError && error.reason === "unreadable",
  );
});

test("other Zotero errors propagate", async () => {
  const { fake, client } = setup(richLibrary);
  fake.failNext({ status: 401 });
  await assert.rejects(
    extractZoteroItem({ client, item: discovered() }),
    (error) =>
      error instanceof ZoteroError && error.code === "ZOTERO_REAUTH_REQUIRED",
  );
});

test("a key without notes access returns an item with no Notes section", async () => {
  const { client } = setup({
    items: [article, raw("ATTACH01", "attachment", { parentItem: "ARTICLE1" })],
    children: {
      ARTICLE1: [
        raw("ATTACH01", "attachment", {
          parentItem: "ARTICLE1",
          title: "P.pdf",
        }),
      ],
    },
  });
  const result = await extractZoteroItem({ client, item: discovered() });
  assert.ok(!result.contentText.includes("## Notes"));
  assert.ok(result.contentText.includes("## Attachments"));
});

test("a standalone note makes no attachment requests", async () => {
  const { fake, client } = setup({
    items: [raw("NOTE0001", "note", { note: "<p>Standalone</p>" })],
  });
  const result = await extractZoteroItem({
    client,
    item: discovered({
      externalId: "zotero:NOTE0001",
      metadata: { itemKey: "NOTE0001", libraryType: "user", libraryId: "1" },
    }),
  });
  assert.equal(result.item.title, "Standalone");
  assert.ok(result.contentText.includes("Standalone"));
  assert.deepEqual(
    fake.requests.map((request) => request.path),
    ["/users/1/items/NOTE0001", "/users/1/items/NOTE0001/children"],
  );
});

test("unparseable child objects fail the extraction", async () => {
  const { client } = setup({
    items: [article],
    children: { ARTICLE1: [{ key: "NOTE0001" } as FakeObject] },
  });
  await assert.rejects(
    extractZoteroItem({ client, item: discovered() }),
    (error) =>
      error instanceof ZoteroError && error.code === "ZOTERO_BAD_RESPONSE",
  );
});

test("missing or hostile collections metadata is treated as no collections", async () => {
  const { client } = setup(richLibrary);
  const result = await extractZoteroItem({
    client,
    item: discovered({
      metadata: {
        itemKey: "ARTICLE1",
        libraryType: "user",
        libraryId: "1",
        collections: "x",
      },
    }),
  });
  assert.ok(!result.contentText.includes("## Collections"));
});
