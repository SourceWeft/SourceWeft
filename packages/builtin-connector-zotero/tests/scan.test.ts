import assert from "node:assert/strict";
import test from "node:test";
import { createZoteroClient } from "../src/client";
import { ZoteroError } from "../src/errors";
import { SHORTCUT_MAX_AGE_MS } from "../src/limits";
import { scanLibrary, type ScanLimits } from "../src/scan";
import {
  startFakeZotero,
  type FakeLibrary,
  type FakeObject,
} from "./helpers/fake-zotero";

const KEY = "abcdEFGH12345678abcdEFGH";
const NOW = 1_700_000_000_000;

const rawCollection = (
  key: string,
  name: string,
  parent: string | false = false,
): FakeObject => ({
  key,
  version: 1,
  data: { key, name, parentCollection: parent },
});

const rawItem = (
  key: string,
  itemType: string,
  data: Record<string, unknown> = {},
): FakeObject => ({
  key,
  version: 1,
  data: { key, version: 1, itemType, ...data },
});

const book = (key: string, collections: string[] = []): FakeObject =>
  rawItem(key, "book", { title: `Title ${key}`, collections });

function manyBooks(count: number): FakeObject[] {
  return Array.from({ length: count }, (_, i) =>
    book(`BOOK${String(i).padStart(4, "0")}`),
  );
}

function setup(library: FakeLibrary) {
  const fake = startFakeZotero({ version: 5, ...library });
  const hooks: { afterRequest?: (count: number) => void } = {};
  let count = 0;
  const hookedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fake.fetch(input, init);
    count += 1;
    hooks.afterRequest?.(count);
    return response;
  }) as typeof fetch;
  const client = createZoteroClient({
    fetch: hookedFetch,
    credential: { secret: KEY },
    libraryPrefix: "users/1",
    sleep: async () => undefined,
  });
  return { fake, client, hooks };
}

type Scan = Parameters<typeof scanLibrary>[0];

async function run(
  client: Scan["client"],
  extra: Partial<Omit<Scan, "client">> = {},
) {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  const pages = [];
  for await (const page of scanLibrary({
    client,
    libraryType: "user",
    libraryId: "1",
    selectedCollectionKeys: [],
    cursor: null,
    now: () => NOW,
    logger: {
      warn: (message, meta) => {
        warnings.push({ message, meta });
      },
    },
    ...extra,
  })) {
    pages.push(page);
  }
  return { pages, warnings };
}

const paths = (fake: { requests: { path: string }[] }) =>
  fake.requests.map((r) => r.path.replace("/users/1/", ""));

const ids = (page: { items: { externalId: string }[] }) =>
  page.items.map((i) => i.externalId).sort();

const INCOMPLETE = {
  items: [],
  deletedExternalIds: [],
  complete: true,
  reconcileMissing: false,
  checkpoint: null,
};

test("a whole-library scan yields one complete page with reconcile and a checkpoint", async () => {
  const { client } = setup({
    version: 5,
    collections: [rawCollection("COLLAAAA", "Thesis")],
    items: [
      book("BOOKAAAA", ["COLLAAAA"]),
      book("BOOKBBBB"),
      rawItem("NOTEAAAA", "note", { note: "<p>hi</p>" }),
    ],
  });
  const { pages } = await run(client);
  assert.equal(pages.length, 1);
  const [page] = pages;
  assert.ok(page);
  assert.equal(page.complete, true);
  assert.equal(page.reconcileMissing, true);
  assert.deepEqual(page.deletedExternalIds, []);
  assert.deepEqual(page.checkpoint, { libraryVersion: 5, checkedAt: NOW });
  assert.deepEqual(ids(page), [
    "zotero:BOOKAAAA",
    "zotero:BOOKBBBB",
    "zotero:NOTEAAAA",
  ]);
  const withPath = page.items.find((i) => i.externalId === "zotero:BOOKAAAA");
  assert.deepEqual(withPath?.metadata.collections, ["Thesis"]);
});

test("a selected collection includes its subcollections only", async () => {
  const { client } = setup({
    collections: [
      rawCollection("COLLAAAA", "Top"),
      rawCollection("COLLBBBB", "Sub", "COLLAAAA"),
      rawCollection("COLLCCCC", "Other"),
    ],
    items: [
      book("BOOKAAAA", ["COLLAAAA"]),
      book("BOOKBBBB", ["COLLBBBB"]),
      book("BOOKCCCC", ["COLLCCCC"]),
      book("BOOKDDDD"),
    ],
  });
  const { pages } = await run(client, { selectedCollectionKeys: ["COLLAAAA"] });
  assert.deepEqual(ids(pages[0]!), ["zotero:BOOKAAAA", "zotero:BOOKBBBB"]);
  const sub = pages[0]!.items.find((i) => i.externalId === "zotero:BOOKBBBB");
  assert.deepEqual(sub?.metadata.collections, ["Top / Sub"]);
  assert.equal(pages[0]!.reconcileMissing, true);
});

test("a deleted selected collection selects nothing but still reconciles", async () => {
  const { client } = setup({
    collections: [rawCollection("COLLAAAA", "Top")],
    items: [book("BOOKAAAA", ["COLLAAAA"]), book("BOOKBBBB")],
  });
  const { pages } = await run(client, { selectedCollectionKeys: ["GONEGONE"] });
  assert.equal(pages[0]!.items.length, 0);
  assert.equal(pages[0]!.complete, true);
  assert.equal(pages[0]!.reconcileMissing, true);
  assert.deepEqual(pages[0]!.checkpoint, { libraryVersion: 5, checkedAt: NOW });
});

test("a fresh checkpoint takes the shortcut: one request, no collections", async () => {
  const { client, fake } = setup({
    items: [book("BOOKAAAA")],
  });
  const { pages } = await run(client, {
    cursor: { committed: { libraryVersion: 5, checkedAt: NOW - 1_000 } },
  });
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(paths(fake), ["items"]);
  assert.equal(fake.requests[0]!.headers["if-modified-since-version"], "5");
  assert.deepEqual(pages, [
    {
      items: [],
      deletedExternalIds: [],
      complete: true,
      reconcileMissing: false,
      checkpoint: { libraryVersion: 5, checkedAt: NOW - 1_000 },
    },
  ]);
});

test("the shortcut is not taken once the checkpoint is a day old", async () => {
  const { client, fake } = setup({ items: [book("BOOKAAAA")] });
  const { pages } = await run(client, {
    cursor: {
      committed: {
        libraryVersion: 5,
        checkedAt: NOW - SHORTCUT_MAX_AGE_MS,
      },
    },
  });
  assert.ok(
    fake.requests.every((r) => !("if-modified-since-version" in r.headers)),
  );
  assert.deepEqual(paths(fake), ["collections", "items"]);
  assert.equal(pages[0]!.reconcileMissing, true);
  assert.deepEqual(pages[0]!.checkpoint, { libraryVersion: 5, checkedAt: NOW });
});

test("a changed library version falls through to a full scan", async () => {
  const { client, fake } = setup({ version: 8, items: [book("BOOKAAAA")] });
  const { pages } = await run(client, {
    cursor: { committed: { libraryVersion: 5, checkedAt: NOW - 1_000 } },
  });
  assert.equal(fake.requests[0]!.headers["if-modified-since-version"], "5");
  assert.deepEqual(ids(pages[0]!), ["zotero:BOOKAAAA"]);
  assert.equal(pages[0]!.reconcileMissing, true);
  assert.deepEqual(pages[0]!.checkpoint, { libraryVersion: 8, checkedAt: NOW });
  // The first items page is reused as page one of the full scan.
  assert.deepEqual(paths(fake), ["items", "collections"]);
});

test("a null, empty or malformed committed checkpoint never shortcuts", async () => {
  for (const cursor of [
    null,
    undefined,
    { committed: null },
    { committed: {} },
    { committed: { libraryVersion: 5 } },
    { committed: { checkedAt: NOW } },
    { committed: { libraryVersion: 5, checkedAt: NOW + 5_000 } },
  ] as Array<Scan["cursor"]>) {
    const { client, fake } = setup({ items: [book("BOOKAAAA")] });
    const { pages } = await run(client, { cursor });
    assert.ok(
      fake.requests.every((r) => !("if-modified-since-version" in r.headers)),
    );
    assert.equal(pages[0]!.reconcileMissing, true);
  }
});

test("a library version change between pages restarts and then succeeds", async () => {
  const { client, fake, hooks } = setup({
    version: 5,
    items: manyBooks(250),
  });
  // collections + items page 1 are served at v5, then the library moves to v6.
  hooks.afterRequest = (count) => {
    if (count === 2) {
      fake.setVersion(6);
      hooks.afterRequest = undefined;
    }
  };
  const { pages, warnings } = await run(client);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.items.length, 250);
  assert.equal(pages[0]!.reconcileMissing, true);
  assert.deepEqual(pages[0]!.checkpoint, { libraryVersion: 6, checkedAt: NOW });
  assert.equal(warnings.length, 0);
});

test("a library that changes on every attempt ends incomplete without reconcile", async () => {
  const { client, fake, hooks } = setup({
    version: 5,
    items: manyBooks(250),
  });
  let version = 5;
  hooks.afterRequest = (count) => {
    if (count % 2 === 0) fake.setVersion((version += 1));
  };
  const { pages, warnings } = await run(client);
  assert.deepEqual(pages, [INCOMPLETE]);
  assert.deepEqual(warnings, [
    { message: "zotero_scan_incomplete", meta: { reason: "unstable" } },
  ]);
});

test("more objects than MAX_OBJECTS ends incomplete", async () => {
  const { client } = setup({ items: manyBooks(30) });
  const { pages, warnings } = await run(client, {
    limits: { MAX_OBJECTS: 10 },
  });
  assert.deepEqual(pages, [INCOMPLETE]);
  assert.equal(warnings[0]?.meta?.reason, "too_large");
});

test("exactly MAX_OBJECTS objects is still complete", async () => {
  const { client } = setup({
    collections: [rawCollection("COLLAAAA", "Top")],
    items: manyBooks(9),
  });
  const { pages } = await run(client, { limits: { MAX_OBJECTS: 10 } });
  assert.equal(pages[0]!.items.length, 9);
  assert.equal(pages[0]!.reconcileMissing, true);
});

test("more requests than MAX_REQUESTS ends incomplete", async () => {
  const { client, fake } = setup({ items: manyBooks(450) });
  const { pages, warnings } = await run(client, {
    limits: { MAX_REQUESTS: 3 },
  });
  assert.deepEqual(pages, [INCOMPLETE]);
  assert.equal(warnings[0]?.meta?.reason, "too_large");
  assert.equal(fake.requests.length, 3);
});

test("a client-side ZOTERO_TOO_LARGE also ends incomplete", async () => {
  const { client } = setup({ items: [book("BOOKAAAA")] });
  const failing = {
    ...client,
    getPage: async () => {
      throw new ZoteroError("ZOTERO_TOO_LARGE");
    },
  };
  const { pages } = await run(failing);
  assert.deepEqual(pages, [INCOMPLETE]);
});

test("SCAN_TIMEOUT_MS elapsing ends incomplete", async () => {
  const { client } = setup({ items: manyBooks(250) });
  let now = NOW;
  const { pages, warnings } = await run(client, {
    now: () => {
      now += 400;
      return now;
    },
    limits: { SCAN_TIMEOUT_MS: 1_000 },
  });
  assert.deepEqual(pages, [INCOMPLETE]);
  assert.equal(warnings[0]?.meta?.reason, "timeout");
});

test("a server that lies about Total-Results terminates as a bad response", async () => {
  const { client, fake } = setup({ items: manyBooks(30) });
  fake.mutateNext({ "Total-Results": "500" }, 10);
  await assert.rejects(
    run(client),
    (error) =>
      error instanceof ZoteroError && error.code === "ZOTERO_BAD_RESPONSE",
  );
  assert.ok(fake.requests.length <= 10);
});

test("fatal errors propagate", async () => {
  const cases: Array<[number, string]> = [
    [401, "ZOTERO_REAUTH_REQUIRED"],
    [403, "ZOTERO_KEY_INSUFFICIENT_ACCESS"],
    [404, "ZOTERO_LIBRARY_NOT_FOUND"],
  ];
  for (const [status, code] of cases) {
    const { client, fake } = setup({ items: [book("BOOKAAAA")] });
    fake.failNext({ status });
    await assert.rejects(
      run(client),
      (error) => error instanceof ZoteroError && error.code === code,
    );
  }
  const { client, fake } = setup({ items: [book("BOOKAAAA")] });
  fake.failNext({ status: 400, body: "x" });
  await assert.rejects(run(client), ZoteroError);
});

test("an item fetch failure after collections still propagates", async () => {
  const { client, fake } = setup({ items: [book("BOOKAAAA")] });
  fake.failNext({ status: 401 }, 1, (r) => r.path.endsWith("/items"));
  await assert.rejects(
    run(client),
    (error) =>
      error instanceof ZoteroError && error.code === "ZOTERO_REAUTH_REQUIRED",
  );
});

test("trashed items are not emitted and a later smaller scan returns fewer", async () => {
  const { client, fake } = setup({
    items: [book("BOOKAAAA"), book("BOOKBBBB")],
  });
  const first = await run(client);
  assert.equal(first.pages[0]!.items.length, 2);
  fake.setLibrary({
    version: 6,
    items: [
      book("BOOKAAAA"),
      rawItem("BOOKBBBB", "book", { title: "x", deleted: 1 }),
    ],
  });
  const second = await run(client);
  assert.deepEqual(ids(second.pages[0]!), ["zotero:BOOKAAAA"]);
  assert.equal(second.pages[0]!.reconcileMissing, true);
});

test("a duplicate key in a response is emitted once", async () => {
  const { client } = setup({
    items: [book("BOOKAAAA"), book("BOOKAAAA"), book("BOOKBBBB")],
  });
  const { pages } = await run(client);
  assert.deepEqual(ids(pages[0]!), ["zotero:BOOKAAAA", "zotero:BOOKBBBB"]);
});

test("an object that fails to parse is skipped, not fatal", async () => {
  const { client } = setup({
    items: [
      book("BOOKAAAA"),
      { key: "BROKENXX", version: 1, data: { itemType: 5 } },
    ],
    collections: [{ key: "BADCOLLX", version: 1, data: { name: 3 } }],
  });
  const { pages } = await run(client);
  assert.deepEqual(ids(pages[0]!), ["zotero:BOOKAAAA"]);
  assert.equal(pages[0]!.reconcileMissing, true);
});

test("an empty library is a complete, reconciling scan", async () => {
  const { client } = setup({ items: [] });
  const { pages } = await run(client);
  assert.equal(pages[0]!.items.length, 0);
  assert.equal(pages[0]!.reconcileMissing, true);
  assert.deepEqual(pages[0]!.checkpoint, { libraryVersion: 5, checkedAt: NOW });
});

test("a key without access to the collections list propagates the error", async () => {
  const { client, fake } = setup({ items: [book("BOOKAAAA")] });
  fake.failNext({ status: 403 }, 1, (r) => r.path.endsWith("/collections"));
  await assert.rejects(
    run(client),
    (error) =>
      error instanceof ZoteroError &&
      error.code === "ZOTERO_KEY_INSUFFICIENT_ACCESS",
  );
});

test("limits are overridable per field and default to the package limits", async () => {
  const limits: Partial<ScanLimits> = { MAX_RESTARTS: 0 };
  const { client, fake, hooks } = setup({ items: manyBooks(250) });
  hooks.afterRequest = (count) => {
    if (count === 2) fake.setVersion(9);
  };
  const { pages } = await run(client, { limits });
  assert.deepEqual(pages, [INCOMPLETE]);
});
