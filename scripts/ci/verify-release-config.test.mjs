import test from "node:test";
import assert from "node:assert/strict";
import {
  releaseVersion,
  validateReleaseConfig,
} from "./verify-release-config.mjs";
test("only stable versions can update latest", () => {
  assert.equal(releaseVersion("v0.1.0").latest, true);
  for (const tag of ["v0.1.0-rc.1", "v0.2.0-rc.1", "v1.0.0-beta", "v2.1.0-0"]) {
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

test("GitHub release flag can be disabled without promoting an RC to stable", () => {
  assert.deepEqual(
    validateReleaseConfig(
      { GITHUB_REF_NAME: "v0.3.0-rc.1" },
      { githubPrerelease: false },
    ),
    {
      version: "0.3.0-rc.1",
      prerelease: true,
      latest: false,
      githubPrerelease: false,
      desktopPolicy: "signed",
    },
  );
  assert.equal(releaseVersion("v0.3.0-rc.1").prerelease, true);
});

test("unsigned installers require an explicit candidate policy and stay off stable/latest", () => {
  const result = validateReleaseConfig(
    { GITHUB_REF_NAME: "v0.3.0-rc.1" },
    {
      githubPrerelease: false,
      desktopPublicationPolicy: "candidate",
    },
  );
  assert.equal(result.desktopPolicy, "candidate");
  assert.equal(result.githubPrerelease, false);
  assert.equal(result.prerelease, true);
  assert.equal(result.latest, false);
  assert.equal(
    validateReleaseConfig({ GITHUB_REF_NAME: "v0.3.0-rc.2" }).desktopPolicy,
    "signed",
  );
  assert.throws(
    () =>
      validateReleaseConfig(
        { GITHUB_REF_NAME: "v0.3.0" },
        {
          desktopPublicationPolicy: "candidate",
        },
      ),
    /require a semver prerelease/,
  );
  for (const desktopPublicationPolicy of [
    "unsigned",
    "",
    true,
    null,
    undefined,
  ]) {
    assert.throws(
      () =>
        validateReleaseConfig(
          { GITHUB_REF_NAME: "v0.3.0-rc.1" },
          {
            desktopPublicationPolicy,
          },
        ),
      /must be signed or candidate/,
    );
  }
});

test("GitHub release flag defaults to semver and rejects malformed overrides", () => {
  assert.equal(
    validateReleaseConfig({ GITHUB_REF_NAME: "v0.3.0-rc.2" }).githubPrerelease,
    true,
  );
  assert.equal(
    validateReleaseConfig({ GITHUB_REF_NAME: "v0.3.0" }).githubPrerelease,
    false,
  );
  for (const githubPrerelease of ["false", 0, null, undefined]) {
    assert.throws(
      () =>
        validateReleaseConfig(
          { GITHUB_REF_NAME: "v0.3.0-rc.1" },
          { githubPrerelease },
        ),
      /must be a boolean/,
    );
  }
});
