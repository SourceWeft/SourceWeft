import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  requiredRecoveryChecks,
  validateRecoverySource,
  validatePublishedImageConfig,
  verifyGithubAssets,
  findReleaseByTag,
} from "./desktop-release-recovery.mjs";
import { publicationTag } from "./verify-release-config.mjs";

test("release lookup includes drafts and published releases without a tag endpoint", async () => {
  for (const draft of [true, false]) {
    const expected = { id: 409410083, tag_name: "v0.3.0-rc.7", draft };
    assert.deepEqual(
      await findReleaseByTag(expected.tag_name, async () => [
        { id: 1, tag_name: "v0.3.0-rc.6", draft: false },
        expected,
      ]),
      expected,
    );
  }
});

test("release lookup paginates and rejects ambiguous drafts across pages", async () => {
  const first = Array.from({ length: 100 }, (_, id) => ({
    id,
    tag_name: `other-${id}`,
  }));
  const expected = { id: 409410083, tag_name: "v0.3.0-rc.7", draft: true };
  const visited = [];
  assert.deepEqual(
    await findReleaseByTag(expected.tag_name, async (page) => {
      visited.push(page);
      return page === 1 ? first : [expected];
    }),
    expected,
  );
  assert.deepEqual(visited, [1, 2]);
  await assert.rejects(
    findReleaseByTag(expected.tag_name, async (page) =>
      page === 1 ? [expected, ...first.slice(1)] : [expected],
    ),
    /Duplicate releases/,
  );
});

test("release lookup distinguishes absent release from API failure", async () => {
  assert.equal(await findReleaseByTag("v0.3.0-rc.7", async () => []), null);
  await assert.rejects(
    findReleaseByTag("v0.3.0-rc.7", async () => {
      throw new Error("GitHub request failed: HTTP 403");
    }),
    /HTTP 403/,
  );
  await assert.rejects(
    findReleaseByTag("v0.3.0-rc.7", async () => ({})),
    /Invalid GitHub release list/,
  );
});

function fixture() {
  const sha = "a".repeat(40);
  const targets = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
  ];
  return {
    repository: "SourceWeft/SourceWeft",
    tag: "v0.3.0-rc.7",
    sha,
    run: {
      repository: { full_name: "SourceWeft/SourceWeft" },
      path: ".github/workflows/release.yml",
      event: "push",
      head_branch: "v0.3.0-rc.7",
      head_sha: sha,
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
    },
    jobs: [
      ...requiredRecoveryChecks,
      ...targets.map((target) => `desktop / build (runner, ${target}, bundle)`),
    ]
      .map((name) => ({ name, status: "completed", conclusion: "success" }))
      .concat({
        name: "Build and publish release",
        status: "completed",
        conclusion: "failure",
        steps: [
          "Build and push image",
          "Verify published images support anonymous installation",
          "Package self-hosting instructions",
          "Download desktop installers",
        ]
          .map((name) => ({ name, conclusion: "success" }))
          .concat({
            name: "Prepare fixed-name desktop downloads",
            conclusion: "failure",
          }),
      }),
    artifacts: targets.map((target) => ({
      name: `desktop-release-${target}-${sha}`,
      expired: false,
      size_in_bytes: 100,
    })),
  };
}

test("recovery accepts only a completed alias failure with original successful checks and all artifacts", () => {
  assert.equal(validateRecoverySource(fixture()).length, 4);
});
for (const [field, value] of [
  ["event", "workflow_dispatch"],
  ["path", ".github/workflows/ci.yml"],
  ["head_branch", "main"],
  ["head_sha", "b".repeat(40)],
  ["run_attempt", 2],
  ["status", "in_progress"],
  ["conclusion", "success"],
]) {
  test(`rejects a wrong source ${field}`, () => {
    const input = fixture();
    input.run[field] = value;
    assert.throws(() => validateRecoverySource(input));
  });
}
test("missing, failed or cancelled checks cannot be bypassed", () => {
  for (const name of [
    "preflight",
    "quality / Docker Build",
    "quality / Tests (Node 22.23.2)",
    "quality / Lint & Type Check",
    "desktop / build (runner, aarch64-apple-darwin, bundle)",
  ]) {
    for (const state of ["missing", "failure", "cancelled", "skipped"]) {
      const input = fixture();
      if (state === "missing")
        input.jobs = input.jobs.filter((job) => job.name !== name);
      else input.jobs.find((job) => job.name === name).conclusion = state;
      assert.throws(() => validateRecoverySource(input), `${name}: ${state}`);
    }
  }
});
test("a different publishing failure, missing image validation or wrong repository is rejected", () => {
  const input = fixture();
  input.jobs.at(-1).steps.at(-1).name = "Upload and verify application updates";
  assert.throws(() => validateRecoverySource(input), /alias-preparation/);
  const noImage = fixture();
  noImage.jobs.at(-1).steps[1].conclusion = "skipped";
  assert.throws(() => validateRecoverySource(noImage), /prerequisite/);
  const foreign = fixture();
  foreign.run.repository.full_name = "other/repository";
  assert.throws(() => validateRecoverySource(foreign), /repository/);
});
test("missing, duplicate, expired and wrong-commit artifacts are rejected", () => {
  for (const kind of ["missing", "duplicate", "expired", "wrong-commit"]) {
    const input = fixture();
    if (kind === "missing") input.artifacts.pop();
    if (kind === "duplicate") input.artifacts.push(input.artifacts[0]);
    if (kind === "expired") input.artifacts[0].expired = true;
    if (kind === "wrong-commit")
      input.artifacts[0].name = input.artifacts[0].name.replace(
        input.sha,
        "b".repeat(40),
      );
    assert.throws(() => validateRecoverySource(input));
  }
});
test("published image must identify the exact release source, architecture and version", () => {
  const config = {
    architecture: "amd64",
    os: "linux",
    config: {
      Labels: {
        "org.opencontainers.image.revision": "a".repeat(40),
        "org.opencontainers.image.version": "0.3.0-rc.7",
      },
    },
  };
  validatePublishedImageConfig(config, "amd64", "a".repeat(40), "0.3.0-rc.7");
  assert.throws(() =>
    validatePublishedImageConfig(config, "arm64", "a".repeat(40), "0.3.0-rc.7"),
  );
  assert.throws(() =>
    validatePublishedImageConfig(config, "amd64", "b".repeat(40), "0.3.0-rc.7"),
  );
  assert.throws(() =>
    validatePublishedImageConfig(config, "amd64", "a".repeat(40), "0.3.0-rc.8"),
  );
});
test("GitHub assets cannot be silently replaced or accepted with different bytes", () => {
  const expected = [
    { name: "installer.exe", size: 100, sha256: "a".repeat(64) },
  ];
  const asset = {
    name: "installer.exe",
    state: "uploaded",
    size: 100,
    digest: `sha256:${"a".repeat(64)}`,
  };
  verifyGithubAssets([asset], expected);
  for (const assets of [
    [],
    [asset, asset],
    [{ ...asset, size: 99 }],
    [{ ...asset, digest: null }],
    [{ ...asset, digest: `sha256:${"b".repeat(64)}` }],
  ])
    assert.throws(() => verifyGithubAssets(assets, expected));
});
test("recovery selects the release explicitly without overwriting GitHub workflow context", () => {
  assert.equal(
    publicationTag({ GITHUB_REF_NAME: "v0.3.0-rc.7" }),
    "v0.3.0-rc.7",
  );
  assert.equal(
    publicationTag({
      GITHUB_REF_NAME: "main",
      DESKTOP_RELEASE_TAG: "v0.3.0-rc.7",
    }),
    "v0.3.0-rc.7",
  );
  assert.throws(() => publicationTag({ GITHUB_REF_NAME: "main" }));
  assert.throws(() =>
    publicationTag({ GITHUB_REF_NAME: "v0.3.0-rc.7", DESKTOP_RELEASE_TAG: "" }),
  );
});
test("manual recovery preserves the tag/image and publishes only after verification", async () => {
  const require = createRequire(
    new URL("../../apps/backend/package.json", import.meta.url),
  );
  const raw = await readFile(
    new URL(
      "../../.github/workflows/desktop-release-recovery.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const workflow = require("yaml").parse(raw);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.jobs.publish.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.publish.environment, "desktop-release");
  assert.equal(
    workflow.concurrency.group,
    "release-refs/tags/${{ inputs.release_tag }}",
  );
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.doesNotMatch(
    raw,
    /docker\/build-push-action|tauri build|git tag|TAURI_SIGNING_PRIVATE_KEY|GITHUB_REF_NAME:/,
  );
  const steps = workflow.jobs.publish.steps;
  const at = (name) => steps.findIndex((step) => step.name === name);
  assert(
    at("Verify immutable source, passed checks, artifacts and existing image") <
      at("Download unchanged original desktop artifacts"),
  );
  assert(
    at("Reverify every original installer and updater signature") <
      at("Prepare draft without overwriting existing assets"),
  );
  assert(at("Verify GitHub asset bytes") < at("Publish verified release"));
  assert(
    at("Upload and verify application updates") <
      at("Publish verified release"),
  );
  assert(
    at("Publish verified release") <
      at("Promote verified update and download channels"),
  );
  assert.equal(
    steps[at("Prepare draft without overwriting existing assets")].with
      .overwrite_files,
    false,
  );
});
