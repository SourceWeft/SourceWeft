import test from "node:test";
import assert from "node:assert/strict";
import {
  releaseVersion,
  requireReleaseUrl,
  validateReleaseConfig,
} from "./verify-release-config.mjs";
const valid = {
  GITHUB_REF_NAME: "v0.1.0",
  NEXT_PUBLIC_API_BASE_URL: "https://api.example.com",
  NEXT_PUBLIC_WEB_BASE_URL: "https://app.example.com",
};
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
test("release requires explicit production URLs", () => {
  for (const value of [
    undefined,
    "",
    "http://api.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://10.0.0.1",
    "https://user:pass@example.com",
    "https://example.com?key=x",
    "https://example.com#x",
  ])
    assert.throws(() => requireReleaseUrl("URL", value));
  assert.equal(
    requireReleaseUrl("URL", "https://api.example.com/base"),
    "https://api.example.com/base",
  );
});
test("desktop versions must match the release tag", () => {
  assert.equal(validateReleaseConfig(valid, ["0.1.0", "0.1.0"]).latest, true);
  assert.throws(
    () => validateReleaseConfig(valid, ["0.0.9"]),
    /does not match/,
  );
  assert.throws(() =>
    validateReleaseConfig({ ...valid, NEXT_PUBLIC_API_BASE_URL: "" }),
  );
});
