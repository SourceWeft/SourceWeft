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
const DARWIN_BUNDLES = [
  "sourceweft-sandbox-aarch64-apple-darwin.tar.gz",
  "sourceweft-sandbox-x86_64-apple-darwin.tar.gz",
];
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
  // The Linux bundle and every macOS bundle (both architectures) plus their .sig files.
  for (const bundle of [BUNDLE, ...DARWIN_BUNDLES])
    for (const file of [bundle, `${bundle}.sig`]) {
      assert(
        covers(signed.with.files, `release-installers/${file}`),
        `signed release must upload ${file}`,
      );
      assert(
        !covers(candidate.with.files, `release-installers/${file}`),
        `candidate release must not upload ${file}`,
      );
    }
  // The signed body now says local execution runs on both macOS and Linux x86_64 via the
  // downloaded signed runtime; neither body may claim it is macOS-only.
  assert.doesNotMatch(signed.with.body, /currently requires macOS/);
  assert.doesNotMatch(signed.with.body, /requires macOS/);
  assert.match(signed.with.body, /Linux x86_64/);
  assert.match(signed.with.body, /macOS/);
  assert.doesNotMatch(candidate.with.body, /currently requires macOS/);
  assert.doesNotMatch(candidate.with.body, /requires macOS in this release/);
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

test("recovery attaches the .deb only when the original artifacts have one, and verifies it", async () => {
  const recovery = await workflow("desktop-release-recovery");
  const steps = Object.values(recovery.jobs).flatMap((job) => job.steps);
  const installers = steps.find((step) =>
    step.name?.startsWith("Prepare draft"),
  );
  const deb = steps.find((step) =>
    step.name?.startsWith("Attach the Linux .deb"),
  );
  assert(!covers(installers.with.files, "release-installers/x/SourceWeft.deb"));
  assert.match(
    deb.if,
    /hashFiles\('release-installers\/\*\*\/\*\.deb'\) != ''/,
  );
  assert.match(deb.if, /published != 'true'/);
  assert.equal(deb.with.fail_on_unmatched_files, true);
  assert.equal(deb.with.overwrite_files, false);
  assert.equal(deb.with.draft, true);
  assert.equal(deb.with.tag_name, installers.with.tag_name);
  assert.equal(deb.with.body, undefined, "must not rewrite the release body");
  assert(covers(deb.with.files, "release-installers/x/SourceWeft.deb"));
  assert(steps.indexOf(installers) < steps.indexOf(deb));
  assert(
    steps.indexOf(deb) < steps.findIndex((step) => step.id === "assets"),
    "assets are verified after the .deb is attached",
  );
  const script = await readFile(
    new URL("./desktop-release-recovery.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    script,
    /\(dmg\|exe\|AppImage\|deb\|/,
    "verify-github covers .deb",
  );
});

test("deb-install removal checks use `test ! -e` and the ownership check accepts numeric owners", async () => {
  const steps = (await workflow("desktop-build")).jobs["deb-install"].steps;
  const runs = steps.map((step) => step.run ?? "").join("\n");
  assert.doesNotMatch(
    runs,
    /^\s*! test /m,
    "bash -e ignores a negated command",
  );
  assert.match(runs, /test ! -e \/opt\/sourceweft\/libexec\/bwrap/);
  assert.match(runs, /\(root\/root\|0\/0\)/);
  assert.doesNotMatch(runs, /gnome-keyring|dbus-x11/);
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
    (step) =>
      step.name === "Build, sign and verify the sandbox runtime bundle (Linux)",
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

test("the signed desktop build produces the Linux and both macOS bundles, each signed before packing, before the artifact upload", async () => {
  const { jobs } = await workflow("desktop-release");
  const steps = jobs.build.steps;
  const linux = steps.findIndex(
    (step) =>
      step.name === "Build, sign and verify the sandbox runtime bundle (Linux)",
  );
  const mac = steps.findIndex(
    (step) =>
      step.name === "Build, sign and verify the sandbox runtime bundle (macOS)",
  );
  const upload = steps.findIndex((step) =>
    step.uses?.startsWith("actions/upload-artifact"),
  );
  assert(linux !== -1 && mac !== -1);
  assert(linux < upload && mac < upload);

  // One setup-bun before the bundle steps, gated on Linux OR macOS.
  const setup = steps.find(
    (step) =>
      step.uses?.startsWith("oven-sh/setup-bun") &&
      /runner\.os == 'macOS'/.test(step.if ?? ""),
  );
  assert(setup, "a setup-bun step must run on macOS");
  assert.equal(setup.with["bun-version"], "1.4.2");
  assert.match(setup.if, /runner\.os == 'Linux' \|\| runner\.os == 'macOS'/);
  assert.match(setup.if, /exists != 'true'/);

  // The Linux leg: static ripgrep, pack/sign/verify, no codesign.
  const linuxStep = steps[linux];
  assert.match(linuxStep.if, /runner\.os == 'Linux'/);
  assert.match(linuxStep.if, /exists != 'true'/);
  for (const part of [
    "install-static-ripgrep.sh",
    '--target "$DESKTOP_RELEASE_TARGET"',
    "sandbox-bundle.mjs pack",
    "sandbox-bundle.mjs verify ",
    "sandbox-bundle.mjs sign",
    "sandbox-bundle.mjs verify-signature",
    "desktop-release/",
  ])
    assert(linuxStep.run.includes(part), `linux leg missing: ${part}`);

  // The macOS leg: mac ripgrep, codesign BEFORE packing, remanifest, pack/sign/verify.
  const macStep = steps[mac];
  assert.match(macStep.if, /runner\.os == 'macOS'/);
  assert.match(macStep.if, /exists != 'true'/);
  for (const part of [
    "install-ripgrep-macos.sh",
    '--target "$DESKTOP_RELEASE_TARGET"',
    "scripts/sign-macos.sh",
    "--remanifest",
    "sandbox-bundle.mjs pack",
    "sandbox-bundle.mjs verify ",
    "sandbox-bundle.mjs sign",
    "sandbox-bundle.mjs verify-signature",
    "desktop-release/",
  ])
    assert(macStep.run.includes(part), `macOS leg missing: ${part}`);
  // Code-signing and the re-manifest happen before the tarball is packed/hashed/minisigned.
  assert(macStep.run.indexOf("sign-macos.sh") < macStep.run.indexOf("mjs pack"));
  assert(macStep.run.indexOf("--remanifest") < macStep.run.indexOf("mjs pack"));
  assert(
    macStep.run.indexOf(" sign ") < macStep.run.indexOf("verify-signature"),
  );
  // Developer ID in `signed`, ad-hoc in `updater-signed`, same secrets as the installers.
  assert.match(macStep.run, /DESKTOP_PUBLICATION_POLICY" = "signed"/);
  assert.match(macStep.run, /identity="\$APPLE_SIGNING_IDENTITY"/);
  assert.match(macStep.run, /identity="-"/);

  // The Developer ID certificate import reuses the installer's Apple secrets and runs only for
  // the signed policy, before the macOS bundle step.
  const importStep = steps.find((step) =>
    step.name?.startsWith("Import the Developer ID certificate"),
  );
  assert(importStep);
  assert.match(importStep.if, /runner\.os == 'macOS'/);
  assert.match(importStep.if, /publication_policy == 'signed'/);
  assert(steps.indexOf(importStep) < mac);
  assert.doesNotMatch(JSON.stringify(macStep), /secrets\./);

  // Both macOS targets are built by the matrix (as the installers are).
  for (const target of [
    "x86_64-unknown-linux-gnu",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
  ])
    assert(
      jobs.build.strategy.matrix.include.some((leg) => leg.target === target),
      `matrix missing ${target}`,
    );
});

test("the macOS release leg uses the pinned macOS ripgrep, not brew", async () => {
  const pin = JSON.parse(
    await readFile(new URL("./ripgrep-release.json", import.meta.url), "utf8"),
  );
  for (const triple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const entry = pin.darwin[triple];
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.asset, `ripgrep-${pin.version}-${triple}.tar.gz`);
    assert.equal(
      entry.url,
      `https://github.com/BurntSushi/ripgrep/releases/download/${pin.version}/${entry.asset}`,
    );
  }
  const script = await readFile(
    new URL("./install-ripgrep-macos.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /shasum -a 256 -c/);
  assert(
    script.indexOf("shasum -a 256 -c") < script.indexOf("tar -xzf"),
    "verify before extracting",
  );
  assert.match(script, /Mach-O 64-bit executable/);
  assert.doesNotMatch(script, /brew install/);
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

test("pull-request CI also packs, ad-hoc signs and verifies both macOS bundles with a throwaway key only", async () => {
  const { jobs } = parse(
    await readFile(
      new URL("../../.github/workflows/desktop-build.yml", import.meta.url),
      "utf8",
    ),
  );
  const job = jobs["sandbox-bundle-macos"];
  assert(job, "sandbox-bundle-macos job must exist");
  assert.equal(job["runs-on"], "macos-14");
  const text = JSON.stringify(job);
  assert.doesNotMatch(
    text,
    /secrets\.|upload-artifact|environment|APPLE_/,
    "no production secrets, Apple credentials, environment or artifact upload",
  );
  assert(text.includes("tauri signer generate"), "throwaway key only");
  const run = job.steps.find((step) =>
    step.name?.startsWith("Build, ad-hoc sign, pack and verify both macOS"),
  ).run;
  // Both architectures are built, the arm64 natively and the x86_64 cross-compiled here.
  assert.match(run, /aarch64-apple-darwin x86_64-apple-darwin/);
  // Ad-hoc code-sign (identity `-`) before packing, then re-manifest over the signed files.
  assert(run.indexOf("sign-macos.sh") < run.indexOf("mjs pack"));
  assert(run.indexOf("--remanifest") < run.indexOf("mjs pack"));
  for (const part of [
    "install-ripgrep-macos.sh",
    "sign-macos.sh apps/desktop/sandbox-sidecar/dist/bundle -",
    "sandbox-bundle.mjs verify ",
    "sandbox-bundle.mjs verify-signature",
    "cmp ",
  ])
    assert(run.includes(part), `macOS PR job missing: ${part}`);
  // The darwin unit tests (file set + cross-arch target) run here too.
  assert(
    job.steps.some((step) => (step.run ?? "").includes("sandbox-bundle.test.mjs")),
  );
});
