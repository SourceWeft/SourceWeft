import assert from "node:assert/strict";
import test from "node:test";
import { skillManifestJsonSchema } from "../src/skills";

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
