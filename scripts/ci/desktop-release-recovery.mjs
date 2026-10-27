import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { digest, filesUnder } from "./desktop-release-artifacts.mjs";
import {
  UPDATE_TARGETS,
  prepareUpdateManifest,
} from "./desktop-update-manifest.mjs";
import { prepareManifest } from "./publish-downloads.mjs";
import {
  publicationTag,
  releaseVersion,
  validateReleaseConfig,
} from "./verify-release-config.mjs";

export const requiredRecoveryChecks = [
  "preflight",
  "quality / Resolve source commit",
  "quality / update-signatures",
  "quality / Lint & Type Check",
  "quality / HTML runtime and complete library",
  "quality / Tests (Node 22.23.2)",
  "quality / Tests (Node 24.18.0)",
  "quality / Docker Build",
  "quality / CLI (ubuntu-latest, Node 20.x)",
  "quality / CLI (macos-latest, Node 24.18.0)",
  "quality / CLI (windows-latest, Node 24.18.0)",
  "quality / native-anydoc / AnyDoc Rust dependency audit",
  ...[
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
  ].map((target) => `quality / native-anydoc / AnyDoc (${target})`),
];

// A release target that ships only the sandbox runtime bundle (the desktop installer is x64-only).
const WINDOWS_ARM64_BUNDLE_TARGET = "aarch64-pc-windows-msvc";

export function validateRecoverySource({
  run,
  jobs,
  artifacts,
  repository,
  tag,
  sha,
}) {
  releaseVersion(tag);
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(run.repository.full_name, repository, "Wrong source repository");
  assert.equal(
    run.path,
    ".github/workflows/release.yml",
    "Wrong source workflow",
  );
  assert.equal(run.event, "push", "Source must be a tag release run");
  assert.equal(run.head_branch, tag, "Source tag mismatch");
  assert.equal(run.head_sha, sha, "Source commit mismatch");
  assert.equal(run.run_attempt, 1, "Ambiguous rerun history is not supported");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "failure");
  const byName = new Map(jobs.map((job) => [job.name, job]));
  assert.equal(byName.size, jobs.length, "Duplicate source jobs");
  assert.deepEqual(
    jobs
      .filter((job) => job.name.startsWith("desktop / build ("))
      .map((job) => job.name.split(", ")[1])
      .sort(),
    Object.keys(UPDATE_TARGETS).sort(),
    "Exact desktop build target set is required",
  );
  for (const name of requiredRecoveryChecks)
    assert.equal(
      byName.get(name)?.conclusion,
      "success",
      `Required check did not pass: ${name}`,
    );
  for (const target of Object.keys(UPDATE_TARGETS)) {
    const matches = jobs.filter(
      (job) =>
        job.name.startsWith("desktop / build (") &&
        job.name.includes(`, ${target},`),
    );
    assert.equal(matches.length, 1, `Missing or duplicate build: ${target}`);
    assert.equal(
      matches[0].conclusion,
      "success",
      `Build did not pass: ${target}`,
    );
  }
  const skipped = new Set([
    "desktop-candidate",
    "quality / Docker Image",
    "quality / Docker Image (${{ matrix.arch }})",
  ]);
  for (const job of jobs) {
    assert.equal(job.status, "completed", "A source job is still running");
    if (job.name === "Build and publish release") continue;
    assert(
      job.conclusion === "success" ||
        (job.conclusion === "skipped" && skipped.has(job.name)),
      `Unexpected source result: ${job.name}`,
    );
  }
  const publisher = byName.get("Build and publish release");
  assert.equal(publisher?.conclusion, "failure");
  assert.deepEqual(
    publisher.steps
      .filter((step) => step.conclusion === "failure")
      .map((step) => step.name),
    ["Prepare fixed-name desktop downloads"],
    "Recovery only supports the alias-preparation failure",
  );
  for (const name of [
    "Build and push image",
    "Verify published images support anonymous installation",
    "Package self-hosting instructions",
    "Download desktop installers",
  ])
    assert.equal(
      publisher.steps.find((step) => step.name === name)?.conclusion,
      "success",
      `Publisher prerequisite did not pass: ${name}`,
    );
  const installers = Object.keys(UPDATE_TARGETS)
    .map((target) => `desktop-release-${target}-${sha}`)
    .sort();
  const selected = artifacts.filter((artifact) =>
    artifact.name.startsWith("desktop-release-"),
  );
  // The aarch64 Windows sandbox runtime bundle has no installer, so it is not an update target;
  // it is built by its own release job and is absent from releases built before it existed.
  // When present it is held to the same rules as every other original artifact.
  const bundleOnly = `desktop-release-${WINDOWS_ARM64_BUNDLE_TARGET}-${sha}`;
  const expected = selected.some((artifact) => artifact.name === bundleOnly)
    ? [...installers, bundleOnly].sort()
    : installers;
  assert.deepEqual(
    selected.map((artifact) => artifact.name).sort(),
    expected,
    "Exact original desktop artifacts are required",
  );
  assert(
    selected.every(
      (artifact) => !artifact.expired && artifact.size_in_bytes > 0,
    ),
    "Original artifacts must be available",
  );
  return expected;
}

export function validatePublishedImageConfig(config, arch, sha, version) {
  assert.equal(config.architecture, arch, "Image architecture mismatch");
  assert.equal(config.os, "linux");
  assert.equal(
    config.config?.Labels?.["org.opencontainers.image.revision"],
    sha,
    "Image revision mismatch",
  );
  assert.equal(
    config.config?.Labels?.["org.opencontainers.image.version"],
    version,
    "Image version mismatch",
  );
}

export function verifyGithubAssets(assets, expected) {
  for (const file of expected) {
    const matches = assets.filter((asset) => asset.name === file.name);
    assert.equal(
      matches.length,
      1,
      `Missing or duplicate GitHub asset: ${file.name}`,
    );
    assert.equal(matches[0].state, "uploaded");
    assert.equal(
      matches[0].size,
      file.size,
      `GitHub asset size mismatch: ${file.name}`,
    );
    assert.equal(
      matches[0].digest,
      `sha256:${file.sha256}`,
      `GitHub asset digest mismatch: ${file.name}`,
    );
  }
}

// The tag endpoint does not resolve drafts. Authenticated listing includes both
// draft and published releases, so use it consistently before publication.
export async function findReleaseByTag(tag, fetchPage) {
  const matches = [];
  for (let page = 1; ; page++) {
    const releases = await fetchPage(page);
    assert(Array.isArray(releases), "Invalid GitHub release list");
    matches.push(...releases.filter((release) => release.tag_name === tag));
    assert(matches.length <= 1, "Duplicate releases for requested tag");
    if (releases.length < 100) return matches[0] ?? null;
  }
}

async function github(repository, path) {
  assert(process.env.GH_TOKEN, "GH_TOKEN is required");
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert(response.ok, `GitHub request failed: HTTP ${response.status}`);
  return response.json();
}
async function releaseForTag(repository, tag) {
  const release = await findReleaseByTag(tag, (page) =>
    github(repository, `releases?per_page=100&page=${page}`),
  );
  if (!release) return null;
  assert(
    Number.isSafeInteger(release.id) && release.id > 0,
    "Invalid release ID",
  );
  const details = await github(repository, `releases/${release.id}`);
  assert.equal(details.tag_name, tag, "Release tag changed during lookup");
  return details;
}
async function pages(repository, path, key) {
  const result = [];
  for (let page = 1; ; page++) {
    const value = await github(repository, `${path}?per_page=100&page=${page}`);
    result.push(...value[key]);
    if (value[key].length < 100) return result;
  }
}
export async function verifyPublishedImage(repository, tag, sha) {
  const name = repository.toLowerCase();
  const tokenResponse = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:pull`,
    { signal: AbortSignal.timeout(30_000) },
  );
  assert(tokenResponse.ok, "Cannot obtain anonymous registry access");
  const { token } = await tokenResponse.json();
  const get = async (path, expected) => {
    const response = await fetch(`https://ghcr.io/v2/${name}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `Published image unavailable: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(
      actual,
      expected ?? response.headers.get("Docker-Content-Digest"),
      "Registry digest mismatch",
    );
    return { digest: actual, value: JSON.parse(bytes.toString("utf8")) };
  };
  const index = await get(`manifests/${tag}`);
  const platforms = index.value.manifests.filter(
    (item) =>
      item.platform?.os === "linux" && item.platform.architecture !== "unknown",
  );
  assert.deepEqual(
    platforms.map((item) => item.platform.architecture).sort(),
    ["amd64", "arm64"],
    "Both published image architectures are required",
  );
  for (const platform of platforms) {
    const manifest = await get(`manifests/${platform.digest}`, platform.digest);
    const config = await get(
      `blobs/${manifest.value.config.digest}`,
      manifest.value.config.digest,
    );
    validatePublishedImageConfig(
      config.value,
      platform.platform.architecture,
      sha,
      releaseVersion(tag).version,
    );
  }
  return { image: `ghcr.io/${name}`, digest: index.digest };
}

async function output(values) {
  assert(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const mode = process.argv[2];
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(repository ?? "", /^[\w.-]+\/[\w.-]+$/);
  const tag = publicationTag();
  if (mode === "preflight") {
    assert.equal(
      process.env.GITHUB_REF,
      "refs/heads/main",
      "Recovery must run from reviewed main",
    );
    const runId = process.env.RECOVERY_RUN_ID;
    assert.match(runId ?? "", /^[1-9][0-9]*$/);
    const sha = execFileSync(
      "git",
      ["rev-parse", `refs/tags/${tag}^{commit}`],
      { encoding: "utf8" },
    ).trim();
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
    const run = await github(repository, `actions/runs/${runId}`);
    const jobs = await pages(repository, `actions/runs/${runId}/jobs`, "jobs");
    const artifacts = await pages(
      repository,
      `actions/runs/${runId}/artifacts`,
      "artifacts",
    );
    const names = validateRecoverySource({
      run,
      jobs,
      artifacts,
      repository,
      tag,
      sha,
    });
    const metadataPath = `apps/web/content/changelog/${tag}.json`;
    const source = execFileSync("git", ["show", `${sha}:${metadataPath}`], {
      encoding: "utf8",
    });
    const metadata = JSON.parse(source);
    assert.equal(metadata.tag, tag);
    const config = validateReleaseConfig({ GITHUB_REF_NAME: tag }, metadata);
    assert(
      ["signed", "updater-signed"].includes(config.desktopPolicy),
      "Recovery requires updater-signed artifacts",
    );
    const image = await verifyPublishedImage(repository, tag, sha);
    const release = await releaseForTag(repository, tag);
    await mkdir("output/recovery", { recursive: true });
    // Notes must come from the immutable release source, not later maintenance commits.
    await writeFile(metadataPath, source);
    await writeFile(
      "output/recovery/source.json",
      JSON.stringify({ runId, tag, sha, artifactNames: names, image }, null, 2),
    );
    await output({
      tag,
      sha,
      policy: config.desktopPolicy,
      prerelease: config.githubPrerelease,
      published: Boolean(release && !release.draft),
      image_digest: image.digest,
    });
    console.log(
      `Verified original checks, four artifacts and published image for ${tag} at ${sha}. No rebuild or tag mutation.`,
    );
  } else if (mode === "verify-packages") {
    const config = {
      prefix: "",
      publicBaseUrl: "https://download.sourceweft.com",
    };
    await prepareManifest(
      config,
      "release-installers",
      tag,
      repository,
      process.env.DESKTOP_PUBLICATION_POLICY,
    );
    await prepareUpdateManifest(
      config,
      "release-installers",
      tag,
      await readFile(process.env.UPDATE_NOTES_FILE, "utf8"),
      process.env.UPDATE_PUB_DATE,
      undefined,
      process.env.DESKTOP_PUBLICATION_POLICY,
    );
    console.log(
      "Original installer hashes and all updater signatures verified.",
    );
  } else if (mode === "verify-github") {
    const release = await releaseForTag(repository, tag);
    assert(release, "Expected uploaded release draft or published release");
    const files = [
      ...(await filesUnder("release-installers")),
      ...(await filesUnder("release-download-aliases")),
      `sourceweft-selfhost-${tag}.tar.gz`,
    ].filter((file) =>
      /\.(dmg|exe|AppImage|deb|app\.tar\.gz|sig|tar\.gz)$/.test(file),
    );
    const expected = await Promise.all(
      files.map(async (file) => ({
        name: basename(file),
        ...(await digest(createReadStream(file))),
      })),
    );
    assert.equal(
      new Set(expected.map((item) => item.name)).size,
      expected.length,
      "Duplicate upload names",
    );
    verifyGithubAssets(release.assets, expected);
    await output({ release_id: release.id });
    console.log(
      "GitHub asset bytes match the original verified files and deterministic aliases.",
    );
  } else
    throw new Error("Expected preflight, verify-packages or verify-github");
}
