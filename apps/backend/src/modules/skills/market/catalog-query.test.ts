import assert from "node:assert/strict";
import { test } from "vitest";
import {
  NO_SKILL_CATALOG_FILTERS,
  type SkillCatalogCursor,
  boundedCatalogItemMatchesFilters,
  decodeSkillCatalogCursor,
  encodeSkillCatalogCursor,
  escapeLikePattern,
  skillCatalogCursorForRow,
  skillCatalogFiltersExcludeRegistry,
} from "./catalog-query";

// --- cursor ---

const cursors: SkillCatalogCursor[] = [
  { sort: "name", name: "Pdf tools", id: "skill-1" },
  { sort: "popular", installCount: 12, id: "skill-1" },
  { sort: "new", listedAtMicros: "1789300800123456", id: "skill-1" },
  { sort: "stars", repoStars: 4200, id: "skill-1" },
  {
    sort: "recommended",
    verified: true,
    rankScore: 0,
    listedAtMicros: "0",
    id: "skill-1",
  },
];

test("a cursor of every sort survives the round trip, sort included", () => {
  for (const cursor of cursors) {
    assert.deepEqual(
      decodeSkillCatalogCursor(encodeSkillCatalogCursor(cursor)),
      cursor,
    );
  }
});

// The mismatch check in `listCatalog` compares this `sort` with the request's.
test("a decoded cursor names the sort it was made for", () => {
  const popular = decodeSkillCatalogCursor(
    encodeSkillCatalogCursor(cursors[1]!),
  );
  assert.equal(popular?.sort, "popular");
  assert.notEqual(popular?.sort, "recommended");
});

test("the cursor carries listed_at to the microsecond", () => {
  const cursor = skillCatalogCursorForRow("new", {
    definition: {
      id: "skill-1",
      displayName: "Pdf",
      verified: false,
      installCount: 3,
      rankScore: 300,
      repoStars: 0,
    },
    // As the driver hands a bigint back.
    listedAtMicros: "1789300800123456",
  });
  assert.deepEqual(cursor, {
    sort: "new",
    listedAtMicros: "1789300800123456",
    id: "skill-1",
  });
  assert.deepEqual(
    skillCatalogCursorForRow("recommended", {
      definition: {
        id: "skill-1",
        displayName: "Pdf",
        verified: true,
        installCount: 3,
        rankScore: 540,
        repoStars: 10,
      },
      listedAtMicros: 0n,
    }),
    {
      sort: "recommended",
      verified: true,
      rankScore: 540,
      listedAtMicros: "0",
      id: "skill-1",
    },
  );
  assert.deepEqual(
    skillCatalogCursorForRow("stars", {
      definition: {
        id: "skill-1",
        displayName: "Pdf",
        verified: true,
        installCount: 3,
        rankScore: 540,
        repoStars: 10,
      },
      listedAtMicros: 0n,
    }),
    { sort: "stars", repoStars: 10, id: "skill-1" },
  );
});

// The recommended cursor used to carry the install count in the place the rank
// score now goes. Read as a rank cursor it would resume somewhere arbitrary, so
// it is refused and the client starts over.
test("a recommended cursor from before the rank score is refused", () => {
  const old = Buffer.from(
    JSON.stringify(["recommended", true, 3, "0", "skill-1"]),
  ).toString("base64url");
  assert.equal(decodeSkillCatalogCursor(old), null);
});

test("the cursor from before sorts existed still reads, as a name cursor", () => {
  const legacy = Buffer.from(JSON.stringify(["Pdf tools", "skill-1"])).toString(
    "base64url",
  );
  assert.deepEqual(decodeSkillCatalogCursor(legacy), {
    sort: "name",
    name: "Pdf tools",
    id: "skill-1",
  });
});

test("anything that is not a catalog cursor decodes to null", () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const bad of [
    "not-a-cursor",
    encode({ sort: "name" }),
    encode([]),
    encode(["name", "Pdf"]).slice(0, -3),
    encode(["trending", 1, "skill-1"]),
    encode(["name", "Pdf", ""]),
    encode(["name", 3, "skill-1"]),
    encode(["popular", "12", "skill-1"]),
    encode(["popular", -1, "skill-1"]),
    encode(["popular", 1.5, "skill-1"]),
    encode(["popular", 2 ** 31, "skill-1"]),
    encode(["popular", 1, "skill-1", "extra"]),
    // Would reach PostgreSQL as a failed ::bigint cast otherwise.
    encode(["new", "yesterday", "skill-1"]),
    encode(["new", "1; drop table skills", "skill-1"]),
    encode(["new", 1789300800123456, "skill-1"]),
    encode(["recommended", "rank", "true", 1, "0", "skill-1"]),
    encode(["recommended", "rank", true, 1, "0"]),
    encode(["recommended", "installs", true, 1, "0", "skill-1"]),
    encode(["recommended", "rank", true, -1, "0", "skill-1"]),
    encode(["stars", "12", "skill-1"]),
    encode(["stars", -1, "skill-1"]),
  ]) {
    assert.equal(decodeSkillCatalogCursor(bad), null, bad);
  }
});

// --- LIKE escaping ---

test("what a search term holds of LIKE's syntax is made literal", () => {
  assert.equal(escapeLikePattern("pdf"), "pdf");
  assert.equal(escapeLikePattern("100%"), "100\\%");
  assert.equal(escapeLikePattern("snake_case"), "snake\\_case");
  // The backslash first of all, or it would escape the caller's own wildcard.
  assert.equal(escapeLikePattern("C:\\tmp"), "C:\\\\tmp");
  assert.equal(escapeLikePattern("\\%_"), "\\\\\\%\\_");
  assert.equal(escapeLikePattern("费曼 学习法"), "费曼 学习法");
});

// --- the bounded part of the catalog under the market filters ---

const alwaysOnBuiltin = {
  sourceType: "builtin",
  installable: false,
  enabledWorkspaceSkillId: null,
};
const managedBuiltin = {
  sourceType: "builtin",
  installable: true,
  enabledWorkspaceSkillId: null,
};
const ownInstalled = {
  sourceType: "workspace_custom",
  installable: true,
  enabledWorkspaceSkillId: "ws-skill-1",
};
const teamNotInstalled = {
  sourceType: "team_custom",
  installable: true,
  enabledWorkspaceSkillId: null,
};
const bounded = [
  alwaysOnBuiltin,
  managedBuiltin,
  ownInstalled,
  teamNotInstalled,
];
const kept = (filters: Partial<typeof NO_SKILL_CATALOG_FILTERS>) =>
  bounded.filter((item) =>
    boundedCatalogItemMatchesFilters(item, {
      ...NO_SKILL_CATALOG_FILTERS,
      ...filters,
    }),
  );

test("with no filter every bounded item is kept", () => {
  assert.deepEqual(kept({}), bounded);
});

test("trust=builtin keeps only ours; verified and community are market terms", () => {
  assert.deepEqual(kept({ trust: "builtin" }), [
    alwaysOnBuiltin,
    managedBuiltin,
  ]);
  assert.deepEqual(kept({ trust: "verified" }), []);
  assert.deepEqual(kept({ trust: "community" }), []);
});

test("bounded items have no market category or capability to match", () => {
  assert.deepEqual(kept({ category: "documents-office" }), []);
  assert.deepEqual(kept({ capability: "prompt-only" }), []);
  assert.deepEqual(kept({ capability: "executable" }), []);
  assert.deepEqual(
    kept({ trust: "builtin", category: "documents-office" }),
    [],
  );
});

test("installed: an install row, or an always-on builtin, which is in every workspace", () => {
  assert.deepEqual(kept({ installed: "installed" }), [
    alwaysOnBuiltin,
    ownInstalled,
  ]);
  assert.deepEqual(kept({ installed: "not_installed" }), [
    managedBuiltin,
    teamNotInstalled,
  ]);
  assert.deepEqual(kept({ trust: "builtin", installed: "not_installed" }), [
    managedBuiltin,
  ]);
});

test("only trust=builtin rules the registry out before it is queried", () => {
  assert.equal(
    skillCatalogFiltersExcludeRegistry({
      ...NO_SKILL_CATALOG_FILTERS,
      trust: "builtin",
    }),
    true,
  );
  for (const trust of ["all", "verified", "community"] as const) {
    assert.equal(
      skillCatalogFiltersExcludeRegistry({
        ...NO_SKILL_CATALOG_FILTERS,
        trust,
      }),
      false,
    );
  }
});
