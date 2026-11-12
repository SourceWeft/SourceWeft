import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// `tauri build` notarizes and staples SourceWeft.app and Developer ID signs the disk image, but
// it never submits the image itself. Gatekeeper then assesses the downloaded .dmg as
// "Unnotarized Developer ID" even though the app inside passes. This submits the signed image
// with the same Apple credentials the build used, waits for the verdict and staples the ticket,
// so the outermost container a customer downloads is notarized too. It must run before
// prepare-desktop-release.mjs, which hashes the image: stapling rewrites the file.

const CREDENTIALS = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];

function xcrun(args) {
  const result = spawnSync("xcrun", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function listDiskImages(directory) {
  return readdirSync(directory).filter((name) => name.endsWith(".dmg"));
}

export function notarizeDiskImage({
  env = process.env,
  run = xcrun,
  list = listDiskImages,
  log = console.log,
} = {}) {
  const target = env.DESKTOP_RELEASE_TARGET;
  assert(
    target?.endsWith("-apple-darwin"),
    "Disk image notarization requires a macOS DESKTOP_RELEASE_TARGET",
  );
  for (const key of CREDENTIALS)
    assert(env[key]?.trim(), `${key} is required to notarize the disk image`);
  const directory = `apps/desktop/src-tauri/target/${target}/release/bundle/dmg`;
  const images = list(directory);
  assert.equal(images.length, 1, `Expected one .dmg in ${directory}`);
  const image = join(directory, images[0]);
  // Never put these arguments in a message: they carry the app-specific password.
  const credentials = [
    "--apple-id",
    env.APPLE_ID.trim(),
    "--password",
    env.APPLE_PASSWORD.trim(),
    "--team-id",
    env.APPLE_TEAM_ID.trim(),
  ];

  const submitted = run([
    "notarytool",
    "submit",
    image,
    ...credentials,
    "--wait",
    "--timeout",
    "30m",
    "--output-format",
    "json",
  ]);
  assert.equal(
    submitted.status,
    0,
    `Disk image notarization submission failed: ${submitted.stderr}`,
  );
  let verdict;
  try {
    verdict = JSON.parse(submitted.stdout);
  } catch {
    assert.fail("Disk image notarization returned an unreadable result");
  }
  log(
    `Notarizing ${images[0]} finished with status ${verdict.status} for id ${verdict.id}`,
  );
  if (verdict.status !== "Accepted") {
    // The notary log names the rejected file and the reason; it holds no credential.
    if (verdict.id) {
      const details = run(["notarytool", "log", verdict.id, ...credentials]);
      if (details.stdout) log(details.stdout);
    }
    assert.fail(
      `Disk image notarization was not accepted (status ${verdict.status})`,
    );
  }

  for (const action of ["staple", "validate"]) {
    const stapled = run(["stapler", action, image]);
    assert.equal(
      stapled.status,
      0,
      `Disk image stapler ${action} failed: ${stapled.stderr}`,
    );
  }
  return image;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  notarizeDiskImage();
