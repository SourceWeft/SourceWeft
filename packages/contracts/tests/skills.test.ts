import assert from "node:assert/strict";
import test from "node:test";
import {
  listSkillsCatalogQuerySchema,
  skillManifestJsonSchema,
} from "../src/skills";

function manifest(defaultEnabled?: boolean) {
  return {
    slug: "example-skill",
    displayName: "Example Skill",
    version: "1.0.0",
    description: "Example skill manifest.",
    visibility: "restricted" as const,
    categories: [],
    ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
  };
}

test("skill manifest preserves an explicit default selection independently of visibility", () => {
  assert.equal(
    skillManifestJsonSchema.parse(manifest(true)).defaultEnabled,
    true,
  );
  assert.equal(
    skillManifestJsonSchema.parse(manifest(false)).defaultEnabled,
    false,
  );
  assert.equal(
    skillManifestJsonSchema.parse(manifest()).defaultEnabled,
    undefined,
  );
});

test("catalog query defaults to one page of 50 and refuses out-of-range paging", () => {
  assert.deepEqual(listSkillsCatalogQuerySchema.parse({}), { limit: 50 });
  assert.deepEqual(
    listSkillsCatalogQuerySchema.parse({ limit: "100", cursor: "abc", q: " pdf " }),
    { limit: 100, cursor: "abc", q: "pdf" },
  );
  for (const limit of ["0", "101", "1.5", "many"]) {
    assert.equal(listSkillsCatalogQuerySchema.safeParse({ limit }).success, false);
  }
  assert.equal(listSkillsCatalogQuerySchema.safeParse({ cursor: "" }).success, false);
});
