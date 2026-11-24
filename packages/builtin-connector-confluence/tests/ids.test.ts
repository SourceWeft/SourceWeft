import assert from "node:assert/strict";
import test from "node:test";
import { AtlassianApiError } from "@sourceweft/atlassian-client";
import {
  pageItemId,
  parseConfluenceSelection,
  parsePageId,
  parseSiteId,
  parseSpaceId,
  scopeBySite,
  siteItemId,
  spaceItemId,
} from "../src/ids";

const CLOUD_ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLOUD_ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

test("space ids round trip through spaceItemId/parseSpaceId", () => {
  const id = spaceItemId(CLOUD_ID_A, "98304");
  assert.equal(id, `space:${CLOUD_ID_A}:98304`);
  assert.deepEqual(parseSpaceId(id), { cloudId: CLOUD_ID_A, id: "98304" });
});

test("page ids round trip through pageItemId/parsePageId", () => {
  const id = pageItemId(CLOUD_ID_A, "123456");
  assert.equal(id, `page:${CLOUD_ID_A}:123456`);
  assert.deepEqual(parsePageId(id), { cloudId: CLOUD_ID_A, id: "123456" });
});

test("site ids round trip through siteItemId/parseSiteId", () => {
  const id = siteItemId(CLOUD_ID_A);
  assert.equal(id, `site:${CLOUD_ID_A}`);
  assert.equal(parseSiteId(id), CLOUD_ID_A);
});

test("each parser rejects other kinds, malformed cloud ids, non-numeric ids and upper-case cloud ids", () => {
  assert.equal(parseSpaceId("space:x:1"), null);
  assert.equal(parseSpaceId(`space:${CLOUD_ID_A}:abc`), null);
  assert.equal(parseSpaceId(`page:${CLOUD_ID_A}:1`), null);
  assert.equal(parseSpaceId(`space:${CLOUD_ID_A.toUpperCase()}:1`), null);
  assert.equal(parsePageId("page:x:1"), null);
  assert.equal(parsePageId(`page:${CLOUD_ID_A}:abc`), null);
  assert.equal(parsePageId(`space:${CLOUD_ID_A}:1`), null);
  assert.equal(parsePageId(`page:${CLOUD_ID_A.toUpperCase()}:1`), null);
  assert.equal(parseSiteId("site:x"), null);
  assert.equal(parseSiteId(`space:${CLOUD_ID_A}:1`), null);
  assert.equal(parseSiteId(`site:${CLOUD_ID_A.toUpperCase()}`), null);
});

function assertInvalidSelection(fn: () => unknown) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AtlassianApiError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONFLUENCE_INVALID_SELECTION");
    return true;
  });
}

test("parseConfluenceSelection returns an empty list when nothing is stored", () => {
  assert.deepEqual(parseConfluenceSelection({}), []);
  assert.deepEqual(parseConfluenceSelection({ items: [] }), []);
});

test("parseConfluenceSelection accepts a mix of spaces and pages", () => {
  assert.deepEqual(
    parseConfluenceSelection({
      items: [
        { id: spaceItemId(CLOUD_ID_A, "1"), kind: "space" },
        { id: pageItemId(CLOUD_ID_B, "22"), kind: "page" },
      ],
    }),
    [
      { kind: "space", cloudId: CLOUD_ID_A, id: "1" },
      { kind: "page", cloudId: CLOUD_ID_B, id: "22" },
    ],
  );
});

test("parseConfluenceSelection rejects a non-array, a non-object entry and a missing id", () => {
  assertInvalidSelection(() => parseConfluenceSelection({ items: "x" }));
  assertInvalidSelection(() => parseConfluenceSelection({ items: {} }));
  assertInvalidSelection(() => parseConfluenceSelection({ items: [null] }));
  assertInvalidSelection(() => parseConfluenceSelection({ items: ["space"] }));
  assertInvalidSelection(() =>
    parseConfluenceSelection({ items: [{ kind: "space" }] }),
  );
});

test("parseConfluenceSelection rejects the site kind and any other kind", () => {
  assertInvalidSelection(() =>
    parseConfluenceSelection({
      items: [{ id: siteItemId(CLOUD_ID_A), kind: "site" }],
    }),
  );
  assertInvalidSelection(() =>
    parseConfluenceSelection({
      items: [{ id: spaceItemId(CLOUD_ID_A, "1"), kind: "project" }],
    }),
  );
  assertInvalidSelection(() =>
    parseConfluenceSelection({
      items: [{ id: spaceItemId(CLOUD_ID_A, "1") }],
    }),
  );
});

test("parseConfluenceSelection rejects a kind that does not match the id prefix", () => {
  assertInvalidSelection(() =>
    parseConfluenceSelection({
      items: [{ id: pageItemId(CLOUD_ID_A, "1"), kind: "space" }],
    }),
  );
  assertInvalidSelection(() =>
    parseConfluenceSelection({
      items: [{ id: spaceItemId(CLOUD_ID_A, "1"), kind: "page" }],
    }),
  );
});

test("parseConfluenceSelection rejects malformed ids and an upper-case cloud id", () => {
  assertInvalidSelection(() =>
    parseConfluenceSelection({ items: [{ id: "space:x:1", kind: "space" }] }),
  );
  assertInvalidSelection(() =>
    parseConfluenceSelection({
      items: [{ id: `page:${CLOUD_ID_A}:abc`, kind: "page" }],
    }),
  );
  assertInvalidSelection(() =>
    parseConfluenceSelection({
      items: [{ id: `page:${CLOUD_ID_A.toUpperCase()}:1`, kind: "page" }],
    }),
  );
});

test("parseConfluenceSelection rejects duplicate ids", () => {
  const id = spaceItemId(CLOUD_ID_A, "1");
  assertInvalidSelection(() =>
    parseConfluenceSelection({
      items: [
        { id, kind: "space" },
        { id, kind: "space" },
      ],
    }),
  );
});

test("parseConfluenceSelection rejects more than 100 items and accepts exactly 100", () => {
  const items = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: pageItemId(CLOUD_ID_A, String(index + 1)),
      kind: "page",
    }));
  assertInvalidSelection(() => parseConfluenceSelection({ items: items(101) }));
  assert.equal(parseConfluenceSelection({ items: items(100) }).length, 100);
});

test("scopeBySite groups space and page ids per site, sorted by cloud id", () => {
  const selection = parseConfluenceSelection({
    items: [
      { id: spaceItemId(CLOUD_ID_B, "2"), kind: "space" },
      { id: spaceItemId(CLOUD_ID_A, "1"), kind: "space" },
      { id: pageItemId(CLOUD_ID_A, "30"), kind: "page" },
      { id: pageItemId(CLOUD_ID_A, "31"), kind: "page" },
      { id: pageItemId(CLOUD_ID_B, "40"), kind: "page" },
    ],
  });
  const grouped = scopeBySite(selection);
  assert.deepEqual([...grouped.keys()], [CLOUD_ID_A, CLOUD_ID_B]);
  assert.deepEqual(grouped.get(CLOUD_ID_A), {
    spaceIds: ["1"],
    pageIds: ["30", "31"],
  });
  assert.deepEqual(grouped.get(CLOUD_ID_B), {
    spaceIds: ["2"],
    pageIds: ["40"],
  });
});

test("scopeBySite gives a site holding only pages an empty space list", () => {
  const selection = parseConfluenceSelection({
    items: [{ id: pageItemId(CLOUD_ID_A, "5"), kind: "page" }],
  });
  assert.deepEqual(scopeBySite(selection).get(CLOUD_ID_A), {
    spaceIds: [],
    pageIds: ["5"],
  });
});
