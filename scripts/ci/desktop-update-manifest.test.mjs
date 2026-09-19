import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "./desktop-release-artifacts.mjs";
import {
  UPDATE_TARGETS,
  updateExtension,
  prepareUpdateManifest,
} from "./desktop-update-manifest.mjs";
import { releaseConfig } from "./desktop-release-config.mjs";

const config = { prefix: "", publicBaseUrl: "https://download.sourceweft.com" };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "update-manifest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [target, name] of Object.entries(UPDATE_TARGETS)) {
    const mac = target.endsWith("apple-darwin");
    const filename = `${name}${updateExtension(name)}`;
    const bytes = Buffer.from(`fixture-${target}`);
    await writeFile(join(dir, filename), bytes);
    await writeFile(join(dir, `${filename}.sig`), "dGVzdA==");
    await writeFile(
      join(dir, `desktop-update-${target}.json`),
      JSON.stringify({
        schemaVersion: 1,
        version: "0.2.0",
        target,
        filename,
        distributionSigned: !name.startsWith("linux-"),
        notarized: mac,
        ...(await digest([bytes])),
      }),
    );
  }
  return dir;
}
const prepare = (dir, verifier = async () => {}) =>
  prepareUpdateManifest(
    config,
    dir,
    "v0.2.0",
    "Notes",
    "2026-09-20T00:00:00Z",
    verifier,
  );
test("complete explicitly targeted release generates immutable signed-package references", async (t) => {
  const dir = await fixture(t);
  let verified = 0;
  const prepared = await prepare(dir, async () => {
    verified++;
  });
  assert.equal(verified, 4);
  assert.equal(prepared.uploads.length, 8);
  assert.deepEqual(
    Object.keys(prepared.manifest.platforms).sort(),
    Object.values(UPDATE_TARGETS).sort(),
  );
  assert.equal(prepared.manifest.sourceweft.distribution, "active");
});
test("tampering is rejected before signature verification", async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, "darwin-aarch64.app.tar.gz"), "tampered");
  await assert.rejects(prepare(dir), /mismatch/);
});
test("missing target and missing signature reject partial release", async (t) => {
  const dir = await fixture(t);
  await rm(join(dir, "windows-x86_64.exe.sig"));
  await assert.rejects(prepare(dir), /signature/);
  await rm(join(dir, "desktop-update-x86_64-pc-windows-msvc.json"));
  await assert.rejects(prepare(dir), /configured/);
});
test("signature failures are not ignored", async (t) => {
  const dir = await fixture(t);
  await assert.rejects(
    prepare(dir, async () => {
      throw new Error("Bad signature");
    }),
    /Bad signature/,
  );
});
test("unsigned or wrong-version descriptions fail", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "desktop-update-aarch64-apple-darwin.json");
  const item = JSON.parse(await readFile(path, "utf8"));
  item.distributionSigned = false;
  await writeFile(path, JSON.stringify(item));
  await assert.rejects(prepare(dir), /signing/);
  item.distributionSigned = true;
  item.version = "0.1.0";
  await writeFile(path, JSON.stringify(item));
  await assert.rejects(prepare(dir), /version/);
});
test("release config requires actual signing prerequisites without exposing private values", () => {
  const env = {
    DESKTOP_RELEASE_TARGET: "x86_64-pc-windows-msvc",
    TAURI_UPDATER_PUBLIC_KEY: "public",
    TAURI_SIGNING_PRIVATE_KEY: "secret",
    WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
    WINDOWS_TIMESTAMP_URL: "https://timestamp.example.com",
  };
  const value = releaseConfig(env);
  assert.equal(value.bundle.createUpdaterArtifacts, true);
  assert(!JSON.stringify(value).includes("secret"));
  for (const key of Object.keys(env)) {
    const missing = { ...env };
    delete missing[key];
    assert.throws(() => releaseConfig(missing));
  }
  assert.throws(
    () =>
      releaseConfig({ ...env, DESKTOP_RELEASE_TARGET: "aarch64-apple-darwin" }),
    /APPLE/,
  );
});

test("Linux uses an updater-signed AppImage without claiming Windows or Apple code signing", async (t) => {
  const dir = await fixture(t);
  const prepared = await prepare(dir);
  assert(
    prepared.manifest.platforms["linux-x86_64"].url.endsWith(
      "linux-x86_64.AppImage",
    ),
  );
  const config = releaseConfig({
    DESKTOP_RELEASE_TARGET: "x86_64-unknown-linux-gnu",
    TAURI_UPDATER_PUBLIC_KEY: "public",
    TAURI_SIGNING_PRIVATE_KEY: "private",
  });
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.bundle.windows, undefined);
  assert.equal(config.bundle.macOS, undefined);
  await rm(join(dir, "linux-x86_64.AppImage.sig"));
  await assert.rejects(prepare(dir), /signature/);
});
