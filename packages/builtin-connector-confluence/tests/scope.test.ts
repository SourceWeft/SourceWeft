import assert from "node:assert/strict";
import test from "node:test";
import { resolvePageScope, type ScopePage } from "../src/scope";

/** A current page with the given id, space and parent. */
function page(
  id: string,
  opts: { spaceId?: string | null; parentId?: string | null; status?: string } = {},
): ScopePage {
  return {
    id,
    spaceId: opts.spaceId ?? null,
    parentId: opts.parentId ?? null,
    status: opts.status ?? "current",
  };
}

/** A lookup backed by a fixed page store that records the id lists it was asked
 * for, so a test can assert how many levels were fetched and with which ids. */
function lookup(store: ScopePage[]) {
  const byId = new Map(store.map((p) => [p.id, p]));
  const calls: string[][] = [];
  const getPagesByIds = async (ids: string[]): Promise<ScopePage[]> => {
    calls.push(ids);
    return ids.map((id) => byId.get(id)).filter((p): p is ScopePage => p !== undefined);
  };
  return { getPagesByIds, calls };
}

const NO_LOOKUP = async (): Promise<ScopePage[]> => {
  throw new Error("the parent chain should not be walked");
};

test("a page in a selected space is in scope without a lookup", async () => {
  const result = await resolvePageScope({
    pages: [page("1", { spaceId: "900" })],
    selectedSpaceIds: new Set(["900"]),
    selectedPageIds: new Set(),
    getPagesByIds: NO_LOOKUP,
  });
  assert.deepEqual([...result], ["1"]);
});

test("a selected page id is in scope without a lookup", async () => {
  const result = await resolvePageScope({
    pages: [page("5", { spaceId: "901", parentId: "4" })],
    selectedSpaceIds: new Set(),
    selectedPageIds: new Set(["5"]),
    getPagesByIds: NO_LOOKUP,
  });
  assert.deepEqual([...result], ["5"]);
});

test("a page under a selected ancestor is in scope", async () => {
  const { getPagesByIds, calls } = lookup([
    page("20", { parentId: "10" }),
    page("10", { parentId: null }), // 10 is the selected ancestor
  ]);
  const result = await resolvePageScope({
    pages: [page("30", { spaceId: "901", parentId: "20" })],
    selectedSpaceIds: new Set(),
    selectedPageIds: new Set(["10"]),
    getPagesByIds,
  });
  assert.deepEqual([...result], ["30"]);
  assert.deepEqual(calls, [["20"], ["10"]]);
});

test("a page whose parent does not resolve is out of scope", async () => {
  const { getPagesByIds } = lookup([]); // the parent is not returned
  const result = await resolvePageScope({
    pages: [page("31", { spaceId: "901", parentId: "21" })],
    selectedSpaceIds: new Set(["900"]),
    selectedPageIds: new Set(["999"]),
    getPagesByIds,
  });
  assert.deepEqual([...result], []);
});

test("a page whose parent is not current is out of scope", async () => {
  const { getPagesByIds } = lookup([
    page("22", { parentId: "999", status: "archived" }),
  ]);
  const result = await resolvePageScope({
    pages: [page("32", { spaceId: "901", parentId: "22" })],
    selectedSpaceIds: new Set(),
    selectedPageIds: new Set(["999"]),
    getPagesByIds,
  });
  assert.deepEqual([...result], []);
});

test("a page with an unrelated parent chain is out of scope", async () => {
  const { getPagesByIds } = lookup([
    page("23", { parentId: "24" }),
    page("24", { parentId: null }), // root, not selected
  ]);
  const result = await resolvePageScope({
    pages: [page("33", { spaceId: "901", parentId: "23" })],
    selectedSpaceIds: new Set(["900"]),
    selectedPageIds: new Set(["777"]),
    getPagesByIds,
  });
  assert.deepEqual([...result], []);
});

test("a non-current page is out of scope even in a selected space", async () => {
  const result = await resolvePageScope({
    pages: [page("40", { spaceId: "900", status: "trashed" })],
    selectedSpaceIds: new Set(["900"]),
    selectedPageIds: new Set(),
    getPagesByIds: NO_LOOKUP,
  });
  assert.deepEqual([...result], []);
});

test("a page with no parent and no selection match is out of scope", async () => {
  const result = await resolvePageScope({
    pages: [page("41", { spaceId: "901", parentId: null })],
    selectedSpaceIds: new Set(["900"]),
    selectedPageIds: new Set(["1"]),
    getPagesByIds: NO_LOOKUP,
  });
  assert.deepEqual([...result], []);
});

test("a parent cycle is out of scope", async () => {
  const { getPagesByIds } = lookup([
    page("50", { parentId: "51" }),
    page("51", { parentId: "50" }),
  ]);
  const result = await resolvePageScope({
    pages: [page("52", { spaceId: "901", parentId: "50" })],
    selectedSpaceIds: new Set(),
    selectedPageIds: new Set(["999"]),
    getPagesByIds,
  });
  assert.deepEqual([...result], []);
});

test("a selected ancestor at depth 25 is in scope but depth 26 is not", async () => {
  // A straight chain child -> 1001 -> 1002 -> ... where 100N.parentId = 100(N+1).
  const chain: ScopePage[] = [];
  for (let i = 1; i <= 40; i += 1) {
    chain.push(page(String(1000 + i), { parentId: String(1000 + i + 1) }));
  }
  const atDepth = async (selectedDepth: number) => {
    const { getPagesByIds } = lookup(chain);
    const result = await resolvePageScope({
      pages: [page("child", { spaceId: "901", parentId: "1001" })],
      selectedSpaceIds: new Set(),
      selectedPageIds: new Set([String(1000 + selectedDepth)]),
      getPagesByIds,
    });
    return [...result];
  };
  // Depth 25 is reached on the 25th level; depth 26 is one level too deep.
  assert.deepEqual(await atDepth(25), ["child"]);
  assert.deepEqual(await atDepth(26), []);
});

test("parents are fetched level by level in one request per level", async () => {
  const { getPagesByIds, calls } = lookup([
    page("41", { parentId: "61" }),
    page("51", { parentId: "71" }),
    page("61", { parentId: null }), // selected at the second level
    page("71", { parentId: null }), // selected at the second level
  ]);
  const result = await resolvePageScope({
    pages: [
      page("31", { spaceId: "901", parentId: "41" }),
      page("32", { spaceId: "901", parentId: "51" }),
    ],
    selectedSpaceIds: new Set(),
    selectedPageIds: new Set(["61", "71"]),
    getPagesByIds,
  });
  assert.deepEqual([...result].sort(), ["31", "32"]);
  // Both pending pages' parents travel together: one request per level.
  assert.deepEqual(calls, [["41", "51"], ["61", "71"]]);
});

test("a shared parent id is fetched only once", async () => {
  const { getPagesByIds, calls } = lookup([
    page("80", { parentId: null }), // selected ancestor for both
  ]);
  const result = await resolvePageScope({
    pages: [
      page("33", { spaceId: "901", parentId: "80" }),
      page("34", { spaceId: "901", parentId: "80" }),
    ],
    selectedSpaceIds: new Set(),
    selectedPageIds: new Set(["80"]),
    getPagesByIds,
  });
  assert.deepEqual([...result].sort(), ["33", "34"]);
  assert.deepEqual(calls, [["80"]]);
});
