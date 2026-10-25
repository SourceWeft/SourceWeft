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

test("recovery attaches the bundle only when the original artifacts have one", async () => {
  const recovery = await workflow("desktop-release-recovery");
  const steps = Object.values(recovery.jobs).flatMap((job) => job.steps);
  const installers = steps.find((step) =>
    step.name?.startsWith("Prepare draft"),
  );
  const bundle = steps.find((step) =>
    step.name?.startsWith("Attach the sandbox runtime bundle"),
  );
  // Installers stay strict and no longer require the bundle (releases built before it exist).
  assert.equal(installers.with.fail_on_unmatched_files, true);
  assert(!covers(installers.with.files, `release-installers/${BUNDLE}`));
  assert(covers(installers.with.files, `release-installers/${BUNDLE}.sig`));
  assert.doesNotMatch(installers.with.body, /currently requires macOS/);
  // The bundle has its own step, gated on the file existing, strict once it runs.
  assert.match(
    bundle.if,
    /hashFiles\('release-installers\/\*\*\/sourceweft-sandbox-\*\.tar\.gz'\) != ''/,
  );
  assert.match(bundle.if, /published != 'true'/);
  assert.equal(bundle.with.fail_on_unmatched_files, true);
  assert.equal(bundle.with.overwrite_files, false);
  assert.equal(bundle.with.draft, true);
  assert.equal(bundle.with.tag_name, installers.with.tag_name);
  assert.equal(
    bundle.with.body,
    undefined,
    "must not rewrite the release body",
  );
  assert(covers(bundle.with.files, `release-installers/${BUNDLE}`));
  assert(steps.indexOf(installers) < steps.indexOf(bundle));
  assert(
    steps.indexOf(bundle) < steps.findIndex((step) => step.id === "assets"),
    "assets are verified after the bundle is attached",
  );
});

test("both bundle builds use the one pinned static ripgrep and never apt", async () => {
  const pin = JSON.parse(
    await readFile(new URL("./ripgrep-release.json", import.meta.url), "utf8"),
  );
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    pin.asset,
    `ripgrep-${pin.version}-x86_64-unknown-linux-musl.tar.gz`,
  );
  assert.equal(
    pin.url,
    `https://github.com/BurntSushi/ripgrep/releases/download/${pin.version}/${pin.asset}`,
  );
  const script = await readFile(
    new URL("./install-static-ripgrep.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /sha256sum -c/);
  assert(
    script.indexOf("sha256sum -c") < script.indexOf("tar -xzf"),
    "verify before extracting",
  );
  assert.match(script, /static-pie linked/);
  const release = (await workflow("desktop-release")).jobs.build.steps.find(
    (step) => step.name === "Build, sign and verify the sandbox runtime bundle",
  );
  const pr = (await workflow("desktop-build")).jobs["sandbox-bundle"].steps;
  const install = pr.find((step) => step.id === "ripgrep");
  for (const run of [release.run, install.run])
    assert.match(run, /install-static-ripgrep\.sh/);
  assert.match(release.run, /--rg "\$rg"/);
  assert.match(
    pr.find((step) => step.name?.startsWith("Build the sandbox bundle")).run,
    /--rg "\$\{\{ steps\.ripgrep\.outputs\.path \}\}"/,
  );
  assert.match(install.run, /readelf -lW "\$rg" \| grep -q INTERP/);
  assert(
    pr.indexOf(install) <
      pr.findIndex((step) => step.name?.startsWith("Build the sandbox bundle")),
  );
  for (const step of [release, ...pr])
    assert.doesNotMatch(
      step.run ?? "",
      /apt-get install[^\n]*ripgrep|command -v rg/,
    );
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
    '--rg "$rg"',
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
