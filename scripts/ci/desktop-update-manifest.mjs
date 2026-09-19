import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import { digest, filesUnder } from "./desktop-release-artifacts.mjs";
import { releaseVersion } from "./verify-release-config.mjs";

export const MAX_UPDATE_SIZE = 512 * 1024 * 1024;
export const UPDATE_TARGETS = Object.freeze({
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
  "x86_64-pc-windows-msvc": "windows-x86_64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
});
export function updateExtension(target) {
  assert(
    Object.values(UPDATE_TARGETS).includes(target),
    "Unsupported update target",
  );
  return target.startsWith("darwin-")
    ? ".app.tar.gz"
    : target.startsWith("linux-")
      ? ".AppImage"
      : ".exe";
}
export const channelKey = (config, channel) => {
  assert(["stable", "preview"].includes(channel), "Invalid update channel");
  return [config.prefix, `updates/${channel}.json`].filter(Boolean).join("/");
};
export const updateUrl = (config, key) =>
  `${config.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;

export function validateUpdateManifest(value, config, channel) {
  assert(value && typeof value === "object", "Invalid update manifest");
  const { prerelease } = releaseVersion(`v${value.version}`);
  assert(
    channel !== "stable" || !prerelease,
    "Stable cannot contain a prerelease",
  );
  assert(
    typeof value.notes === "string" && value.notes.length <= 65536,
    "Invalid release notes",
  );
  assert(
    typeof value.pub_date === "string" &&
      /^\d{4}-\d\d-\d\dT/.test(value.pub_date) &&
      Number.isFinite(Date.parse(value.pub_date)) &&
      new Date(value.pub_date).toISOString().replace(".000Z", "Z") ===
        value.pub_date,
    "Invalid publication date",
  );
  assert.deepEqual(
    Object.keys(value.platforms ?? {}).sort(),
    Object.values(UPDATE_TARGETS).sort(),
    "All configured update targets are required",
  );
  for (const [target, item] of Object.entries(value.platforms)) {
    const url = new URL(item.url);
    const root = updateUrl(
      config,
      [config.prefix, `releases/v${value.version}/`].filter(Boolean).join("/"),
    );
    assert(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.href.startsWith(root),
      "Update URL must use the immutable release prefix",
    );
    assert(
      url.pathname.endsWith(updateExtension(target)),
      "Wrong update package type",
    );
    assert(
      typeof item.signature === "string" &&
        item.signature.length > 0 &&
        item.signature.length <= 8192 &&
        /^[A-Za-z0-9+/=]+$/.test(item.signature),
      "Invalid updater signature",
    );
  }
  const control = value.sourceweft;
  assert(control?.schemaVersion === 1, "Unsupported update control schema");
  assert(
    ["active", "paused", "withdrawn"].includes(control.distribution),
    "Invalid distribution state",
  );
  assert(
    Number.isSafeInteger(control.revision) && control.revision >= 1,
    "Invalid distribution revision",
  );
  assert(
    typeof control.reason === "string" && control.reason.length <= 2000,
    "Invalid distribution reason",
  );
  return value;
}

export function verifyUpdateSignature(
  path,
  signaturePath,
  publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY,
) {
  assert(publicKey?.trim(), "TAURI_UPDATER_PUBLIC_KEY is required");
  const executable = process.env.DESKTOP_UPDATE_VERIFIER;
  assert(
    executable,
    "DESKTOP_UPDATE_VERIFIER is required; build scripts/ci/update-verifier first",
  );
  const result = spawnSync(executable, [path, signaturePath], {
    env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: publicKey },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `Update signature verification failed: ${result.stderr?.trim()}`,
  );
}

export async function prepareUpdateManifest(
  config,
  directory,
  tag,
  notes,
  pubDate,
  verify = verifyUpdateSignature,
) {
  const { version } = releaseVersion(tag);
  const files = await filesUnder(directory);
  const descriptions = files.filter((path) =>
    /^desktop-update-.+\.json$/.test(basename(path)),
  );
  assert.equal(
    descriptions.length,
    Object.keys(UPDATE_TARGETS).length,
    "All configured release descriptions are required",
  );
  const platforms = {};
  const uploads = [];
  for (const path of descriptions) {
    const item = JSON.parse(await readFile(path, "utf8"));
    const target = UPDATE_TARGETS[item.target];
    assert(target && !platforms[target], "Invalid or duplicate update target");
    assert.equal(item.schemaVersion, 1);
    assert.equal(item.version, version, "Update version differs from tag");
    assert.equal(
      item.distributionSigned,
      !target.startsWith("linux-"),
      "Platform distribution-signing declaration is incorrect",
    );
    assert.equal(
      item.notarized,
      target.startsWith("darwin-"),
      "macOS release must be notarized",
    );
    assert(
      typeof item.filename === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.filename),
      "Unsafe update filename",
    );
    const matches = files.filter((file) => basename(file) === item.filename);
    assert.equal(matches.length, 1, "Missing or duplicate update package");
    const signatures = files.filter(
      (file) => basename(file) === `${item.filename}.sig`,
    );
    assert.equal(signatures.length, 1, "Missing or duplicate update signature");
    const actual = await digest(createReadStream(matches[0]));
    assert(
      actual.size > 0 && actual.size <= MAX_UPDATE_SIZE,
      "Update exceeds allowed package size",
    );
    assert.equal(actual.size, item.size, "Update size mismatch");
    assert.equal(actual.sha256, item.sha256, "Update digest mismatch");
    await verify(matches[0], signatures[0]);
    const signature = (await readFile(signatures[0], "utf8")).trim();
    const key = [config.prefix, `releases/${tag}/${item.filename}`]
      .filter(Boolean)
      .join("/");
    platforms[target] = { url: updateUrl(config, key), signature };
    uploads.push({
      path: matches[0],
      key,
      artifact: { ...actual, url: updateUrl(config, key) },
      signaturePath: signatures[0],
    });
    const sigDigest = await digest(createReadStream(signatures[0]));
    uploads.push({
      path: signatures[0],
      key: `${key}.sig`,
      artifact: { ...sigDigest, url: updateUrl(config, `${key}.sig`) },
    });
  }
  const manifest = validateUpdateManifest(
    {
      version,
      notes,
      pub_date: pubDate,
      platforms,
      sourceweft: {
        schemaVersion: 1,
        distribution: "active",
        revision: 1,
        reason: "",
      },
    },
    config,
  );
  return { manifest, uploads };
}
