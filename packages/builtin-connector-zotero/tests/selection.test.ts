import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
} from "@sourceweft/contracts";
import { ZoteroAdapterError } from "../src/adapter";
import {
  API_KEY,
  baseInput,
  harness,
  rawCollection,
  storedCredential,
  userConfig,
} from "./helpers/adapter-fixtures";
import type { FakeObject } from "./helpers/fake-zotero";

const key = (i: number) => `COLL${String(i).padStart(4, "0")}`;

async function browse(
  h: ReturnType<typeof harness>,
  request: Record<string, unknown> = {},
) {
  const result = await h.adapter.executeAction({
    ...baseInput(),
    actionType: "zotero.browse",
    request,
    idempotencyKey: "k",
  });
  return connectorSelectionBrowseResultSchema.parse(result.result);
}

async function describe(
  h: ReturnType<typeof harness>,
  request: Record<string, unknown>,
) {
  const result = await h.adapter.executeAction({
    ...baseInput(),
    actionType: "zotero.describe",
    request,
    idempotencyKey: "k",
  });
  return connectorSelectionDescribeResultSchema.parse(result.result);
}

const isInvalidRequest = (error: unknown) => {
  assert.ok(error instanceof ZoteroAdapterError);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "ZOTERO_INVALID_REQUEST");
  return true;
};

const tree: FakeObject[] = [
  rawCollection("ZEBRA001", "zebra"),
  rawCollection("APPLE001", "Apple"),
  rawCollection("BANANA01", "banana"),
  rawCollection("CHILD001", "Beta", "APPLE001"),
  rawCollection("CHILD002", "alpha", "APPLE001"),
  rawCollection("GRAND001", "Deep", "CHILD001"),
];

test("browse root lists top-level collections sorted case-insensitively", async () => {
  const h = harness({ collections: tree });
  const result = await browse(h);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ["Apple", "banana", "zebra"],
  );
  assert.deepEqual(result.entries[0], {
    id: "APPLE001",
    kind: "collection",
    name: "Apple",
    detail: null,
    selectable: true,
    expandable: true,
    disabledReason: null,
    size: null,
    modifiedAt: null,
  });
  assert.equal(result.entries[1]!.expandable, false);
  assert.equal(result.container, null);
  assert.deepEqual(result.breadcrumbs, []);
  assert.equal(result.cursor, "");
  assert.equal(result.hasMore, false);
  assert.equal(h.closed(), h.opened());
});

test("browse a container lists its subcollections with container and breadcrumbs", async () => {
  const h = harness({ collections: tree });
  const result = await browse(h, { containerId: "CHILD001" });
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ["GRAND001"],
  );
  assert.deepEqual(result.container, {
    id: "CHILD001",
    kind: "collection",
    name: "Beta",
    detail: null,
  });
  assert.deepEqual(result.breadcrumbs, [{ id: "APPLE001", name: "Apple" }]);
  const apple = await browse(h, { containerId: "APPLE001" });
  assert.deepEqual(
    apple.entries.map((entry) => entry.name),
    ["alpha", "Beta"],
  );
  assert.deepEqual(apple.breadcrumbs, []);
  // `containerId: null` is the root.
  assert.equal((await browse(h, { containerId: null })).container, null);
});

test("browse of an empty library returns no entries", async () => {
  const h = harness({ collections: [] });
  const result = await browse(h);
  assert.deepEqual(result.entries, []);
  assert.equal(result.hasMore, false);
  assert.equal(result.cursor, "");
});

test("browse pages more than 500 children with an opaque cursor", async () => {
  const many = Array.from({ length: 1203 }, (_, i) =>
    rawCollection(key(i), `Name ${String(i).padStart(5, "0")}`),
  );
  const h = harness({ collections: many });
  const first = await browse(h);
  assert.equal(first.entries.length, 500);
  assert.equal(first.hasMore, true);
  assert.deepEqual(
    JSON.parse(Buffer.from(first.cursor, "base64url").toString("utf8")),
    { o: 500 },
  );
  const second = await browse(h, { cursor: first.cursor });
  assert.equal(second.entries.length, 500);
  assert.equal(second.entries[0]!.name, "Name 00500");
  assert.equal(second.hasMore, true);
  const third = await browse(h, { cursor: second.cursor });
  assert.equal(third.entries.length, 203);
  assert.equal(third.entries.at(-1)!.name, "Name 01202");
  assert.equal(third.hasMore, false);
  assert.equal(third.cursor, "");
});

test("browse rejects a bad containerId, an unknown container and foreign cursors", async () => {
  const h = harness({ collections: tree });
  for (const request of [
    { containerId: "lowercase" },
    { containerId: 5 },
    { containerId: "NOSUCH01" },
    { cursor: 5 },
    { cursor: "not-base64-json!" },
    { cursor: Buffer.from("{}").toString("base64url") },
    { cursor: Buffer.from('{"o":-1}').toString("base64url") },
    { cursor: Buffer.from('{"o":1.5}').toString("base64url") },
    { cursor: Buffer.from('{"o":"1"}').toString("base64url") },
    { cursor: Buffer.from('{"o":1,"x":2}').toString("base64url") },
    { cursor: Buffer.from('{"o":99999}').toString("base64url") },
    { cursor: Buffer.from("[1]").toString("base64url") },
    { cursor: Buffer.from('{"o":0}').toString("base64") + "=" },
  ]) {
    await assert.rejects(() => browse(h, request), isInvalidRequest);
  }
});

test("browse fails fast on an unreadable collection and on library errors", async () => {
  const bad = harness({
    collections: [{ key: "BROKEN01", version: 1, data: { name: "" } }],
  });
  await assert.rejects(
    () => browse(bad),
    (error: unknown) =>
      error instanceof ZoteroAdapterError &&
      error.code === "ZOTERO_BAD_RESPONSE",
  );
  assert.equal(bad.closed(), bad.opened());
  const denied = harness({ collections: tree });
  denied.fake.failNext({ status: 403 }, 5);
  await assert.rejects(
    () => browse(denied),
    (error: unknown) =>
      error instanceof ZoteroAdapterError &&
      error.code === "ZOTERO_KEY_INSUFFICIENT_ACCESS" &&
      !error.message.includes(API_KEY),
  );
  assert.equal(denied.closed(), denied.opened());
});

test("browse reads the whole collection list across API pages", async () => {
  const many = Array.from({ length: 250 }, (_, i) =>
    rawCollection(key(i), `N${i}`),
  );
  const h = harness({ collections: many });
  const result = await browse(h);
  assert.equal(result.entries.length, 250);
  assert.equal(
    h.fake.requests.filter((r) => r.path.endsWith("/collections")).length,
    3,
  );
});

test("browse with another library's credential requires reauth", async () => {
  const h = harness({ collections: tree });
  await assert.rejects(
    () =>
      h.adapter.executeAction({
        ...baseInput(userConfig(), storedCredential("users/2")),
        actionType: "zotero.browse",
        request: {},
        idempotencyKey: "k",
      }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError &&
      error.code === "ZOTERO_REAUTH_REQUIRED",
  );
  assert.equal(h.fake.requests.length, 0);
});

test("describe answers known, unknown and duplicate ids in request order", async () => {
  const h = harness({ collections: tree });
  const result = await describe(h, {
    ids: ["GRAND001", "NOSUCH01", "APPLE001", "GRAND001"],
  });
  assert.deepEqual(result.items, [
    {
      id: "GRAND001",
      kind: "collection",
      name: "Deep",
      detail: "Apple / Beta / Deep",
      exists: true,
      meta: {},
    },
    {
      id: "NOSUCH01",
      kind: null,
      name: null,
      detail: null,
      exists: false,
      meta: {},
    },
    {
      id: "APPLE001",
      kind: "collection",
      name: "Apple",
      detail: "Apple",
      exists: true,
      meta: {},
    },
    {
      id: "GRAND001",
      kind: "collection",
      name: "Deep",
      detail: "Apple / Beta / Deep",
      exists: true,
      meta: {},
    },
  ]);
  assert.equal(h.closed(), h.opened());
});

test("describe rejects malformed requests", async () => {
  const h = harness({ collections: tree });
  for (const request of [
    {},
    { ids: [] },
    { ids: "APPLE001" },
    { ids: ["lower"] },
    { ids: [5] },
    { ids: Array.from({ length: 51 }, (_, i) => key(i)) },
  ]) {
    await assert.rejects(() => describe(h, request), isInvalidRequest);
  }
});
