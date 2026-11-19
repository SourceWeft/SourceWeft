import assert from "node:assert/strict";
import test from "node:test";
import type { AtlassianSite } from "../src/resources";
import {
  CURSOR_MAX_LENGTH,
  MAX_FANOUT_SITES,
  buildSitesNote,
  groupBySite,
  pickAccessibleSites,
  siteHost,
} from "../src/sites";

function cloudId(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
}

function site(n: number, scopes: string[] = ["read:x"]): AtlassianSite {
  return {
    cloudId: cloudId(n),
    url: `https://site${n}.atlassian.net`,
    name: `Site ${n}`,
    scopes,
  };
}

const hasScope = (s: AtlassianSite) => s.scopes.includes("read:x");

test("constants", () => {
  assert.equal(MAX_FANOUT_SITES, 5);
  assert.equal(CURSOR_MAX_LENGTH, 4096);
});

test("siteHost returns the host, or an empty string when unparseable", () => {
  assert.equal(siteHost("https://example.atlassian.net/wiki"), "example.atlassian.net");
  assert.equal(siteHost("not a url"), "");
  assert.equal(siteHost(""), "");
});

test("groupBySite groups entries by cloud id with keys ascending", () => {
  const grouped = groupBySite([
    { cloudId: cloudId(3), n: 1 },
    { cloudId: cloudId(1), n: 2 },
    { cloudId: cloudId(3), n: 3 },
    { cloudId: cloudId(2), n: 4 },
  ]);
  assert.deepEqual([...grouped.keys()], [cloudId(1), cloudId(2), cloudId(3)]);
  assert.deepEqual(
    grouped.get(cloudId(3))?.map((entry) => entry.n),
    [1, 3],
  );
});

test("groupBySite of nothing is empty", () => {
  assert.equal(groupBySite([]).size, 0);
});

test("pickAccessibleSites keeps sites with the scope, in ascending order", () => {
  const grouped = new Map([
    [cloudId(1), "a"],
    [cloudId(2), "b"],
  ]);
  const result = pickAccessibleSites({
    sites: [site(2), site(1)],
    grouped,
    hasScope,
  });
  assert.deepEqual(
    result.kept.map((entry) => [entry.cloudId, entry.site.name, entry.value]),
    [
      [cloudId(1), "Site 1", "a"],
      [cloudId(2), "Site 2", "b"],
    ],
  );
  assert.deepEqual(result.inaccessible, []);
  assert.equal(result.overflowCount, 0);
});

test("pickAccessibleSites treats a site without the scope as inaccessible", () => {
  const grouped = new Map([
    [cloudId(1), 1],
    [cloudId(2), 2],
  ]);
  const result = pickAccessibleSites({
    sites: [site(1, ["read:other"]), site(2)],
    grouped,
    hasScope,
  });
  assert.deepEqual(result.kept.map((entry) => entry.cloudId), [cloudId(2)]);
  assert.deepEqual(result.inaccessible, [cloudId(1)]);
  assert.equal(result.overflowCount, 0);
});

test("pickAccessibleSites lists selected sites that are not accessible at all", () => {
  const grouped = new Map([
    [cloudId(1), 1],
    [cloudId(9), 9],
  ]);
  const result = pickAccessibleSites({ sites: [site(1)], grouped, hasScope });
  assert.deepEqual(result.inaccessible, [cloudId(9)]);
});

test("pickAccessibleSites caps at MAX_FANOUT_SITES and counts the overflow", () => {
  const ids = [1, 2, 3, 4, 5, 6, 7];
  const grouped = new Map(ids.map((n) => [cloudId(n), n] as const));
  const result = pickAccessibleSites({
    sites: ids.map((n) => site(n)),
    grouped,
    hasScope,
  });
  assert.deepEqual(
    result.kept.map((entry) => entry.cloudId),
    ids.slice(0, MAX_FANOUT_SITES).map(cloudId),
  );
  assert.equal(result.overflowCount, 2);
  assert.deepEqual(result.inaccessible, []);
});

test("pickAccessibleSites does not count an inaccessible site against the cap", () => {
  const ids = [1, 2, 3, 4, 5, 6];
  const grouped = new Map(ids.map((n) => [cloudId(n), n] as const));
  const result = pickAccessibleSites({
    // Site 1 is gone, so five accessible sites remain and none overflow.
    sites: ids.slice(1).map((n) => site(n)),
    grouped,
    hasScope,
  });
  assert.equal(result.kept.length, 5);
  assert.equal(result.overflowCount, 0);
  assert.deepEqual(result.inaccessible, [cloudId(1)]);
});

test("pickAccessibleSites with nothing reachable returns an empty kept list", () => {
  const result = pickAccessibleSites({
    sites: [],
    grouped: new Map([[cloudId(1), 1]]),
    hasScope,
  });
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.inaccessible, [cloudId(1)]);
});

test("buildSitesNote reports unreachable sites alone", () => {
  assert.equal(
    buildSitesNote(["Site 1"], 0),
    "1 selected site can no longer be accessed: Site 1.",
  );
  assert.equal(
    buildSitesNote(["A", "B"], 0),
    "2 selected sites can no longer be accessed: A, B.",
  );
});

test("buildSitesNote reports the overflow alone", () => {
  assert.equal(
    buildSitesNote([], 3),
    "Only the first 5 selected sites are searched; 3 more were not.",
  );
});

test("buildSitesNote joins both facts, and is undefined when nothing was dropped", () => {
  assert.equal(
    buildSitesNote(["Site 1"], 2),
    "1 selected site can no longer be accessed: Site 1. Only the first 5 selected sites are searched; 2 more were not.",
  );
  assert.equal(buildSitesNote([], 0), undefined);
});
