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
const WINDOWS_BUNDLES = [
  "sourceweft-sandbox-x86_64-pc-windows-msvc.tar.gz",
  "sourceweft-sandbox-aarch64-pc-windows-msvc.tar.gz",
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
  for (const bundle of [BUNDLE, ...DARWIN_BUNDLES, ...WINDOWS_BUNDLES])
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
  assert.match(signed.with.body, /Windows/);
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
  for (const windows of WINDOWS_BUNDLES)
    assert(covers(bundle.with.files, `release-installers/x/${windows}`));
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

test("the Windows ripgrep pins are release-shaped and installed through a verify-before-extract script", async () => {
  const pin = JSON.parse(
    await readFile(new URL("./ripgrep-release.json", import.meta.url), "utf8"),
  );
  // The pre-existing keys (Linux top level, darwin block) are consumed by the shell installers
  // and stay as they were; Windows is an additive per-triple block.
  assert.deepEqual(Object.keys(pin), [
    "version",
    "asset",
    "sha256",
    "url",
    "darwin",
    "windows",
  ]);
  assert.deepEqual(Object.keys(pin.windows).sort(), [
    "aarch64-pc-windows-msvc",
    "x86_64-pc-windows-msvc",
  ]);
  const expected = {
    "x86_64-pc-windows-msvc":
      "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
    "aarch64-pc-windows-msvc":
      "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
  };
  for (const [triple, entry] of Object.entries(pin.windows)) {
    assert.equal(entry.sha256, expected[triple]);
    assert.equal(entry.asset, `ripgrep-${pin.version}-${triple}.zip`);
    assert.equal(
      entry.url,
      `https://github.com/BurntSushi/ripgrep/releases/download/${pin.version}/${entry.asset}`,
    );
  }
  const script = await readFile(
    new URL("./install-ripgrep-windows.ps1", import.meta.url),
    "utf8",
  );
  assert.match(script, /Get-FileHash/);
  assert(
    script.indexOf("Get-FileHash") < script.indexOf("ZipFile"),
    "verify before extracting",
  );
  assert.match(script, /0x8664/);
  assert.match(script, /0xAA64/i);
  assert.doesNotMatch(script, /choco|winget|scoop|Invoke-Expression|\biex\b/);
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

const WINDOWS_TARGETS = ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"];
const WINDOWS_SCRIPTS = "apps/desktop/sandbox-sidecar/scripts";

test("pull-request CI builds, runs, throwaway-signs and verifies both Windows bundles natively", async () => {
  const { jobs, on } = await workflow("desktop-build");
  const job = jobs["sandbox-bundle-windows"];
  assert(job, "sandbox-bundle-windows job must exist");
  // The name keeps the other bundle jobs' "Sandbox bundle pack, sign and verify (...)" shape.
  assert.equal(
    job.name,
    "Sandbox bundle pack, sign and verify (Windows ${{ matrix.arch }})",
  );
  assert.equal(job["runs-on"], "${{ matrix.os }}");
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(
    job.strategy.matrix.include.map((leg) => [leg.os, leg.target, leg.arch]),
    [
      ["windows-2025", "x86_64-pc-windows-msvc", "x64"],
      ["windows-11-arm", "aarch64-pc-windows-msvc", "arm64"],
    ],
  );
  const text = JSON.stringify(job);
  assert.doesNotMatch(
    text,
    /secrets\.|upload-artifact|environment|WINDOWS_CERTIFICATE/,
    "no production secrets, certificate, environment or artifact upload",
  );
  assert(text.includes("tauri signer generate"), "throwaway updater key only");
  assert(text.includes("New-SelfSignedCertificate"), "throwaway Authenticode certificate only");

  const setupBun = job.steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun"));
  assert.equal(setupBun.with["bun-version"], "1.4.2");
  const named = (prefix) => job.steps.findIndex((step) => step.name?.startsWith(prefix));
  const order = [
    "Build the signature verifier",
    "Archive tooling unit tests",
    "Sidecar build helper and manifest unit tests",
    "Install the pinned ripgrep",
    "Build the sandbox bundle for the target",
    "Verify the built executables",
    "Authenticode-sign with a throwaway certificate",
    "Pack, sign (throwaway key) and verify",
  ].map(named);
  assert(order.every((index) => index !== -1), `missing step in ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "steps are in build order");

  const run = (prefix) => job.steps[named(prefix)].run;
  // Only the Windows-specific archive tests run on a Windows host (the others need exec bits).
  assert.match(run("Archive tooling unit tests"), /--test-name-pattern="\[Ww\]indows"/);
  assert.match(run("Install the pinned ripgrep"), /install-ripgrep-windows\.ps1/);
  assert.match(run("Install the pinned ripgrep"), /\$env:TARGET/);
  assert.match(run("Build the sandbox bundle"), /--target "\$TARGET" --rg "\$RG_PATH"/);
  // The compiled executables are inspected and run, before and after signing.
  const verify = `${WINDOWS_SCRIPTS}/verify-windows-bundle.ps1`;
  assert(run("Verify the built executables").includes(verify));
  const sign = run("Authenticode-sign with a throwaway certificate");
  assert(sign.includes(`${WINDOWS_SCRIPTS}/sign-windows.ps1`));
  assert.match(sign, /-Throwaway/);
  assert(sign.includes(verify), "signed executables are run again");
  assert(
    sign.indexOf("sign-windows.ps1") < sign.indexOf("verify-windows-bundle.ps1"),
    "sign, then run the signed executables",
  );
  // The manifest is rebuilt over the signed files in bash: in PowerShell `pnpm` can be pnpm.ps1,
  // which swallows the `--` before --remanifest.
  assert.doesNotMatch(sign, /pnpm|--remanifest/);
  const remanifest = named("Re-manifest over the signed executables");
  assert(remanifest > named("Authenticode-sign with a throwaway certificate"));
  assert(remanifest < named("Pack, sign (throwaway key) and verify"));
  assert.equal(job.steps[remanifest].shell, "bash");
  assert.match(job.steps[remanifest].run, /build -- --remanifest/);
  assert.match(sign, /Remove-Item[^\n]*Cert:/, "the throwaway certificate is removed again");
  // Pack/sign/verify exactly as the release does, with a deterministic second pack.
  const pack = run("Pack, sign (throwaway key) and verify");
  for (const part of [
    "sandbox-bundle.mjs pack",
    "sandbox-bundle.mjs verify ",
    "sandbox-bundle.mjs sign",
    "sandbox-bundle.mjs verify-signature",
    "cmp ",
    "sourceweft-sandbox-$TARGET.tar.gz",
  ])
    assert(pack.includes(part), `Windows PR job missing: ${part}`);
  assert(pack.indexOf("mjs pack") < pack.indexOf("mjs verify "));
  assert(pack.indexOf(" sign ") < pack.indexOf("verify-signature"));
  // Verifier is the Windows .exe of the cargo build above.
  assert.match(job.env.DESKTOP_UPDATE_VERIFIER, /sourceweft-update-verifier\.exe$/);

  for (const path of [
    "scripts/ci/install-ripgrep-windows.ps1",
    "scripts/ci/build-sandbox-bundle-windows.sh",
    "scripts/ci/sandbox-bundle*.mjs",
    "apps/desktop/**",
    ".github/workflows/desktop-release.yml",
  ])
    assert(on.pull_request.paths.includes(path), `PR paths miss ${path}`);
});

test("the Windows verify script catches a wrong namespace, architecture or non-namespaced srt-win", async () => {
  const script = await readFile(
    new URL(`../../${WINDOWS_SCRIPTS}/verify-windows-bundle.ps1`, import.meta.url),
    "utf8",
  );
  // The compiled sidecar is executed with the test-only flag and must print exactly `sourceweft`.
  assert.match(script, /& \$sidecar --print-namespace/);
  assert.match(script, /-ne 'sourceweft'/);
  assert.match(script, /\$printed\.Count -ne 1/);
  // PE machine of all three executables, from the target triple.
  assert.match(script, /0x8664/);
  assert.match(script, /0xAA64/i);
  for (const name of ["srt-sidecar.exe", "rg.exe", "srt-win.exe"])
    assert(script.includes(`'${name}'`), `${name} is checked`);
  assert.match(script, /sourceweft-sandbox/);
  // srt-win.exe must equal the SHA-256 pinned for the target (the file the desktop app embeds),
  // read from srt-win-pin.json beside the package.
  assert.match(script, /srt-win-pin\.json/);
  assert.match(script, /Get-FileHash -LiteralPath \(Join-Path \$BundleDir 'srt-win\.exe'\) -Algorithm SHA256/);
  assert.match(script, /\$pin\.srtWin\.\$Triple/);
  assert.match(script, /\$actual -ne \$pinned/);
  // The define the check guards is the one the build passes.
  const manifest = await readFile(
    new URL("../../apps/desktop/sandbox-sidecar/scripts/manifest.ts", import.meta.url),
    "utf8",
  );
  assert(manifest.includes("'__SRT_WIN_NAMESPACE__=\"sourceweft\"'"));
  const main = await readFile(
    new URL("../../apps/desktop/sandbox-sidecar/src/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(main, /--print-namespace/);
});

test("the signing script accepts only the expected certificate and a real timestamp for releases", async () => {
  const script = await readFile(
    new URL(`../../${WINDOWS_SCRIPTS}/sign-windows.ps1`, import.meta.url),
    "utf8",
  );
  // srt-win.exe is NOT signed: signing would change the bytes the desktop app pins and the
  // elevated setup checks.
  assert.match(script, /foreach \(\$name in 'srt-sidecar\.exe', 'rg\.exe'\)/);
  const code = script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(code, /srt-win/, "srt-win.exe is never signed");
  assert.match(script, /deliberately NOT signed/);
  assert.match(script, /'\/fd', 'sha256', '\/sha1', \$Thumbprint/);
  assert.match(script, /'\/tr', \$TimestampUrl, '\/td', 'sha256'/);
  // A release signature must verify as Valid and carry a timestamp; only the throwaway
  // self-signed run may report an untrusted chain.
  assert.match(script, /\$signature\.Status -ne 'Valid'/);
  assert.match(script, /TimeStamperCertificate/);
  assert.match(script, /-notin @\('Valid', 'UnknownError', 'NotTrusted'\)/);
  assert.match(script, /a release signature needs -TimestampUrl/);
});

test("the signed desktop build produces the Windows x64 bundle beside the installer, Authenticode-signed only under the signed policy", async () => {
  const { jobs } = await workflow("desktop-release");
  const steps = jobs.build.steps;
  assert(
    jobs.build.strategy.matrix.include.some(
      (leg) => leg.target === "x86_64-pc-windows-msvc" && leg.os.startsWith("windows"),
    ),
  );
  const upload = steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact"));
  const rg = steps.findIndex((step) => step.id === "ripgrep_windows");
  const bundle = steps.findIndex(
    (step) => step.name === "Build, sign and verify the sandbox runtime bundle (Windows)",
  );
  const importCert = steps.findIndex((step) => step.name === "Import Windows signing certificate");
  const verifier = steps.findIndex((step) => step.name === "Build signature verifier");
  assert(importCert !== -1 && verifier !== -1 && rg !== -1 && bundle !== -1);
  assert(importCert < bundle && verifier < bundle && rg < bundle && bundle < upload);
  for (const index of [rg, bundle]) {
    assert.match(steps[index].if, /runner\.os == 'Windows'/);
    assert.match(steps[index].if, /exists != 'true'/);
  }
  assert.match(steps[rg].run, /install-ripgrep-windows\.ps1/);
  assert.match(steps[rg].run, /\$env:DESKTOP_RELEASE_TARGET/);
  const leg = steps[bundle];
  assert.equal(leg.shell, "bash");
  assert.match(leg.env.DESKTOP_UPDATE_VERIFIER, /sourceweft-update-verifier\.exe$/);
  assert.equal(leg.env.RG_PATH, "${{ steps.ripgrep_windows.outputs.path }}");
  assert.match(leg.run, /build-sandbox-bundle-windows\.sh/);
  assert.doesNotMatch(JSON.stringify(leg), /secrets\./);
  // Bun is set up on Windows too.
  const setup = steps.find(
    (step) => step.uses?.startsWith("oven-sh/setup-bun") && /runner\.os == 'macOS'/.test(step.if ?? ""),
  );
  assert.match(setup.if, /runner\.os == 'Windows'/);
  assert.equal(setup.with["bun-version"], "1.4.2");
});

test("the Windows release script signs before packing under `signed` only, then re-manifests, packs, minisigns and verifies", async () => {
  // Comments (the header names every tool) are not part of what runs.
  const script = (
    await readFile(
      new URL("./build-sandbox-bundle-windows.sh", import.meta.url),
      "utf8",
    )
  )
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const at = (part) => {
    const index = script.indexOf(part);
    assert(index !== -1, `script missing: ${part}`);
    return index;
  };
  assert.match(script, /set -euo pipefail/);
  const order = [
    'build -- --target "$DESKTOP_RELEASE_TARGET" --rg "$RG_PATH"',
    "verify-windows-bundle.ps1",
    '[ "$DESKTOP_PUBLICATION_POLICY" = "signed" ]',
    "sign-windows.ps1",
    "--remanifest",
    "sandbox-bundle.mjs pack",
    "sandbox-bundle.mjs verify ",
    "sandbox-bundle.mjs sign",
    "sandbox-bundle.mjs verify-signature",
    "desktop-release/",
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // The installer's own certificate inputs, a timestamp, and a re-run of the executables after
  // signing; the unsigned policy never touches a certificate.
  assert.match(script, /-Thumbprint "\$WINDOWS_CERTIFICATE_THUMBPRINT" -TimestampUrl "\$WINDOWS_TIMESTAMP_URL"/);
  assert.match(script, /WINDOWS_CERTIFICATE_THUMBPRINT:\?/);
  assert.equal(script.split("verify-windows-bundle.ps1").length - 1, 2);
  const unsigned = script.slice(0, at('[ "$DESKTOP_PUBLICATION_POLICY" = "signed" ]'));
  assert.doesNotMatch(unsigned, /sign-windows|--remanifest/);
  assert.doesNotMatch(script, /secrets\./);
});

test("the Windows arm64 bundle has its own release job: native runner, no installer, same artifact naming", async () => {
  const { jobs } = await workflow("desktop-release");
  const job = jobs["sandbox-bundle-windows-arm64"];
  assert(job, "sandbox-bundle-windows-arm64 job must exist");
  assert.equal(job["runs-on"], "windows-11-arm");
  assert.equal(job.environment, "desktop-release");
  // Not a `build` leg: the recovery check requires the exact installer target set there.
  assert(!jobs.build.strategy.matrix.include.some((leg) => leg.target === "aarch64-pc-windows-msvc"));
  assert.equal(job.env.DESKTOP_RELEASE_TARGET, "aarch64-pc-windows-msvc");
  assert.equal(job.env.DESKTOP_PUBLICATION_POLICY, "${{ inputs.publication_policy }}");
  assert.match(job.env.WINDOWS_TIMESTAMP_URL, /publication_policy == 'signed'/);
  const text = JSON.stringify(job.steps);
  // No installer, no updater package, no prepare-desktop-release. The signing configuration is
  // validated exactly as the installer legs do, in the mode for a target that has no installer.
  assert.doesNotMatch(text, /tauri build|prepare-desktop-release/);
  const named = (name) => job.steps.findIndex((step) => step.name === name);
  const cert = named("Import Windows signing certificate");
  const rg = job.steps.findIndex((step) => step.id === "ripgrep_windows");
  const build = named("Build, sign and verify the sandbox runtime bundle (Windows)");
  const upload = job.steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact"));
  const validate = named("Validate release signing configuration");
  assert(cert !== -1 && rg !== -1 && build !== -1 && upload !== -1 && validate !== -1);
  assert(cert < build && rg < build && build < upload);
  assert(cert < validate && validate < build, "validated after the certificate import, before the build");
  assert.equal(
    job.steps[validate].run,
    "node scripts/ci/desktop-release-config.mjs --bundle-only",
    "the release-config check runs without writing an installer config",
  );
  assert.match(job.steps[validate].if, /exists != 'true'/);
  assert.match(job.steps[cert].if, /publication_policy == 'signed'/);
  assert.match(job.steps[build].run, /build-sandbox-bundle-windows\.sh/);
  assert.match(job.env.DESKTOP_UPDATE_VERIFIER, /\.exe$/);
  // A rerun reuses the artifact, named like every other leg's so one download pattern gets it.
  assert(job.steps.some((step) => step.run === "node scripts/ci/reuse-desktop-release.mjs"));
  assert.equal(
    job.steps[upload].with.name,
    "desktop-release-${{ env.DESKTOP_RELEASE_TARGET }}-${{ github.sha }}",
  );
  assert.equal(job.steps[upload].with.path, "desktop-release/*");
  const setupBun = job.steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun"));
  assert.equal(setupBun.with["bun-version"], "1.4.2");
  for (const target of WINDOWS_TARGETS)
    assert.match(
      await readFile(new URL("./ripgrep-release.json", import.meta.url), "utf8"),
      new RegExp(target),
    );
});

test("no backslash reaches pnpm: the ripgrep path is handed off with forward slashes", async () => {
  // `pnpm run` re-escapes backslashes in forwarded arguments on Windows (CI run for PR #423:
  // D:\\a\\_temp\\ripgrep\\rg.exe reached bun doubled and copyfile failed with ENOENT).
  const steps = [
    ...(await workflow("desktop-build")).jobs["sandbox-bundle-windows"].steps,
    ...Object.values((await workflow("desktop-release")).jobs).flatMap((job) => job.steps),
  ].filter((step) => /install-ripgrep-windows\.ps1/.test(step.run ?? ""));
  assert.equal(steps.length, 3, "PR job, release x64 leg, release arm64 job");
  for (const step of steps)
    assert.match(step.run, /"path=\$\(\$rg\.Replace\('\\', '\/'\)\)" >> \$env:GITHUB_OUTPUT/);
  const script = await readFile(
    new URL("./build-sandbox-bundle-windows.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /RG_PATH must use forward slashes/);
  // The PR job's updater key directory is a D:/... path as well.
  const pack = (await workflow("desktop-build")).jobs["sandbox-bundle-windows"].steps.find((step) =>
    step.name?.startsWith("Pack, sign (throwaway key)"),
  ).run;
  assert.match(pack, /cygpath -m "\$RUNNER_TEMP"/);
});

test("the Windows real-sandbox job installs upstream first, drives the real launcher, runs both shells and guards the runs", async () => {
  const wf = await workflow("desktop-build");
  const job = wf.jobs["windows-sandbox"];
  assert(job, "windows-sandbox job must exist");
  assert.equal(job["timeout-minutes"], 90);
  assert.deepEqual(
    job.strategy.matrix.include.map((leg) => [leg.os, leg.target]),
    [
      ["windows-2025", "x86_64-pc-windows-msvc"],
      ["windows-11-arm", "aarch64-pc-windows-msvc"],
    ],
  );
  assert.equal(job.strategy["fail-fast"], false);
  const named = (prefix) => job.steps.findIndex((step) => step.name?.startsWith(prefix));
  const upstream = named("Install the UPSTREAM default sandbox-runtime first");
  const hosts = named("Add the hosts-file entries");
  const prebuild = named("Pre-build the real-sandbox test binary");
  const suite = named("Real-sandbox suite (");
  const guard = named("Guard - every test ran");
  const hide = named("Hide Git Bash");
  const second = named("Shell-matrix tests again under Windows PowerShell");
  const restore = named("Restore Git Bash");
  const coexist = named("Both installs are still present");
  const secrets = named("Real Credential Manager round trip");
  const final = named("Uninstall ours, check the upstream install is untouched");
  const cleanup = named("Cleanup (");
  for (const index of [upstream, hosts, prebuild, suite, guard, hide, second, restore, coexist, secrets, final, cleanup])
    assert.notEqual(index, -1);
  assert(upstream < suite && hosts < suite && prebuild < suite);
  assert(suite < guard && guard < hide && hide < second && second < restore && restore < coexist);
  assert(coexist < final);
  // The suite runs one test at a time, includes the ignored tests, and poisons the proxy
  // variables only after the binary has been compiled.
  assert.match(job.steps[prebuild].run, /--test windows_sandbox --no-run/);
  assert.match(job.steps[suite].run, /--test windows_sandbox -- --include-ignored --test-threads=1/);
  assert.equal(job.steps[suite].env.HTTP_PROXY, "http://127.0.0.1:9");
  assert.equal(job.steps[suite].env.HTTPS_PROXY, "http://127.0.0.1:9");
  assert.match(job.steps[second].run, /shells_/);
  // With Git's bash.exe hidden, `bash` on PATH is the WSL launcher: the PowerShell pass and the
  // steps around it must not depend on bash resolving.
  assert.equal(job.steps[second].shell, "pwsh");
  for (const index of [hide, restore, cleanup]) assert.equal(job.steps[index].shell, "pwsh");
  assert.match(job.steps[second].run, /Select-String/);
  // A hung suite step is bounded so the always-run steps and the log upload still happen.
  assert.equal(job.steps[suite]["timeout-minutes"], 45);
  assert.equal(job.steps[second]["timeout-minutes"], 35);
  // The upstream install is the plain default one: its executable's own `install`, no names.
  const script = await readFile(new URL("./windows-sandbox-coexist.ps1", import.meta.url), "utf8");
  const code = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.match(code, /sandbox-runtime@\$Version/);
  assert.match(code, /Run-Checked \$exe @\('install'\)/);
  assert.doesNotMatch(code, /--sandbox-user|--sublayer-guid|--proxy-port-range|--force/);
  assert.match(job.steps[upstream].run, /install-upstream .* -Version 0\.0\.81/);
  // Cleanup always runs; Git Bash is restored even when the second pass fails.
  assert.match(job.steps[cleanup].if, /always\(\)/);
  assert.match(job.steps[restore].if, /always\(\)/);
  // The Credential Manager guard fails on the no-store skip phrase, like the Linux job's.
  assert.match(job.steps[secrets].run, /has no usable Credential Manager/);
  // Both new files are PR triggers (the test file is covered by apps/desktop/**).
  assert(wf.on.pull_request.paths.includes("scripts/ci/windows-sandbox*.ps1"));
  assert(wf.on.pull_request.paths.includes("apps/desktop/**"));
});
