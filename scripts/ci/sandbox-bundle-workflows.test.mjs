import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../apps/backend/package.json", import.meta.url),
);
const { parse } = require("yaml");
const workflow = async (name) =>
  parse(
    await readFile(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );
const BUNDLE = "sourceweft-sandbox-x86_64-unknown-linux-gnu.tar.gz";
const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "(?:.*/)?")
      .replace(/\*/g, "[^/]*")}$`,
  );
const covers = (files, path) =>
  files
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((glob) => globToRegExp(glob).test(path));

test("release publishes the signed bundle and its signature for signed policies only", async () => {
  const release = (await workflow("release")).jobs.release;
  const signed = release.steps.find((step) => step.id === "github_release");
  const candidate = release.steps.find(
    (step) => step.id === "github_release_candidate",
  );
  for (const file of [BUNDLE, `${BUNDLE}.sig`])
    assert(
      covers(signed.with.files, `release-installers/${file}`),
      `signed release must upload ${file}`,
    );
  for (const file of [BUNDLE, `${BUNDLE}.sig`])
    assert(
      !covers(candidate.with.files, `release-installers/${file}`),
      `candidate release must not upload ${file}`,
    );
  // Both release bodies must stop claiming local execution is macOS-only.
  assert.doesNotMatch(signed.with.body, /currently requires macOS/);
  assert.match(signed.with.body, /Linux x86_64/);
  assert.doesNotMatch(candidate.with.body, /currently requires macOS/);
});

test("recovery publishes the same bundle assets as the original release", async () => {
  const recovery = await workflow("desktop-release-recovery");
  const step = Object.values(recovery.jobs)
    .flatMap((job) => job.steps)
    .find((candidate) => candidate.name?.startsWith("Prepare draft"));
  assert(covers(step.with.files, `release-installers/${BUNDLE}`));
  assert(covers(step.with.files, `release-installers/${BUNDLE}.sig`));
  assert.doesNotMatch(step.with.body, /currently requires macOS/);
});

test("the signed desktop build produces the bundle in the Linux leg only, before the artifact upload", async () => {
  const { jobs } = await workflow("desktop-release");
  const steps = jobs.build.steps;
  const build = steps.findIndex(
    (step) => step.name === "Build, sign and verify the sandbox runtime bundle",
  );
  const upload = steps.findIndex((step) =>
    step.uses?.startsWith("actions/upload-artifact"),
  );
  const installer = steps.findIndex(
    (step) => step.name === "Verify and describe Linux artifacts",
  );
  assert(installer < build && build < upload);
  const setup = steps[build - 1];
  assert.match(setup.uses, /^oven-sh\/setup-bun@/);
  assert.equal(setup.with["bun-version"], "1.4.2");
  for (const step of [setup, steps[build]]) {
    assert.match(step.if, /runner\.os == 'Linux'/);
    assert.match(step.if, /exists != 'true'/);
  }
  const script = steps[build].run;
  for (const part of [
    '--target "$DESKTOP_RELEASE_TARGET"',
    '--rg "$(command -v rg)"',
    "sandbox-bundle.mjs pack",
    "sandbox-bundle.mjs verify ",
    "sandbox-bundle.mjs sign",
    "sandbox-bundle.mjs verify-signature",
    "desktop-release/",
  ])
    assert(script.includes(part), `missing: ${part}`);
  assert(script.indexOf(" sign ") < script.indexOf("verify-signature"));
  assert(
    jobs.build.strategy.matrix.include.some(
      (leg) => leg.target === "x86_64-unknown-linux-gnu",
    ),
  );
});

test("pull-request CI packs, signs and verifies the bundle with a throwaway key only", async () => {
  const text = await readFile(
    new URL("../../.github/workflows/desktop-build.yml", import.meta.url),
    "utf8",
  );
  const { jobs, on } = parse(text);
  const job = jobs["sandbox-bundle"];
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert(on.pull_request.paths.includes("apps/desktop/**"));
  assert(on.pull_request.paths.includes("scripts/ci/sandbox-bundle*.mjs"));
  assert.doesNotMatch(
    JSON.stringify(job),
    /secrets\.|upload-artifact|environment/,
    "no production secrets, environment or artifact upload",
  );
  assert(JSON.stringify(job).includes("tauri signer generate"));
  assert(JSON.stringify(job).includes("sandbox-bundle.mjs verify-signature"));
});
