import test from "node:test";
import assert from "node:assert/strict";
import {
  releaseVersion,
  validateReleaseConfig,
} from "./verify-release-config.mjs";
test("only stable versions can update latest", () => {
  assert.equal(releaseVersion("v0.1.0").latest, true);
  for (const tag of ["v0.1.0-rc.1", "v1.0.0-beta", "v2.1.0-0"]) {
    assert.deepEqual(releaseVersion(tag), {
      version: tag.slice(1),
      latest: false,
      prerelease: true,
    });
  }
});
test("invalid release tags are rejected", () => {
  for (const tag of [
    "vlatest",
    "v1.2",
    "v01.2.3",
    "v1.2.3-01",
    "v1.2.3+build",
    "v1.2.3\nlatest=true",
    "v1.2.3\n",
  ])
    assert.throws(() => releaseVersion(tag));
});
test("universal image release does not require publisher URLs or a desktop version", () => {
  assert.equal(
    validateReleaseConfig({ GITHUB_REF_NAME: "v0.2.0" }).latest,
    true,
  );
});
