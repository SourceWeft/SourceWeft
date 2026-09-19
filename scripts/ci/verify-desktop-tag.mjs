import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { releaseVersion } from "./verify-release-config.mjs";

const tag = process.env.GITHUB_REF_NAME ?? "";
assert.ok(
  tag.startsWith("ci-package-v") || tag.startsWith("v"),
  "Expected a v* release tag or ci-package-v* verification tag",
);
// Repeat verification without moving an existing tag or changing the app version.
const versionTag = tag.startsWith("ci-package-")
  ? tag.slice("ci-package-".length).replace(/--attempt\.[1-9]\d*$/, "")
  : tag;
const { version } = releaseVersion(versionTag);
const desktop = new URL("../../apps/desktop/", import.meta.url);
for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
  const value = JSON.parse(readFileSync(new URL(file, desktop), "utf8"));
  assert.equal(value.version, version, `${file} must match ${tag}`);
}
const manifest = readFileSync(new URL("src-tauri/Cargo.toml", desktop), "utf8");
const packageSection = manifest.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
assert.equal(
  packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  version,
  "Cargo package version must match the tag",
);
const lock = readFileSync(new URL("src-tauri/Cargo.lock", desktop), "utf8");
assert.equal(
  lock.match(/^name = "sourceweft-desktop"\r?\nversion = "([^"]+)"/m)?.[1],
  version,
  "Cargo lockfile version must match the tag",
);
console.log(`Desktop tag ${tag} matches ${version}.`);
