import test from "node:test";
import assert from "node:assert/strict";
import {
  androidBuildConfig,
  mobileVersion,
  syncAndroidIcons,
} from "./android-build.mjs";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = {
  version: "0.1.0",
  packageVersion: "0.1.0",
  rustVersion: "0.1.0",
  versionCode: 1000,
};
test("verification is explicit, ARM64, optimized and separate from the production package", () => {
  const config = androidBuildConfig("verification", {}, version);
  assert.equal(config.applicationId, "nicelab.sourceweft.mobile.verification");
  assert.equal(config.versionName, "0.1.0-verification");
  assert(config.args.includes("--apk"));
  assert(!config.args.includes("--debug"));
  assert.deepEqual(config.args.slice(-2), ["--target", "aarch64"]);
  assert(!config.args.includes("--aab"));
});
test("release never falls back to a verification certificate", () => {
  const env = {
    ANDROID_KEYSTORE_PATH: "/private/release.jks",
    ANDROID_STORE_PASSWORD: "secret",
    ANDROID_KEY_ALIAS: "upload",
    ANDROID_KEY_PASSWORD: "secret-key",
  };
  const config = androidBuildConfig("release", env, version);
  assert(config.args.includes("--apk") && config.args.includes("--aab"));
  assert.equal(config.applicationId, "nicelab.sourceweft.mobile");
  assert(!JSON.stringify(config).includes("secret"));
  for (const key of Object.keys(env)) {
    const missing = { ...env };
    delete missing[key];
    assert.throws(
      () => androidBuildConfig("release", missing, version),
      new RegExp(key),
    );
  }
  assert.throws(
    () =>
      androidBuildConfig(
        "release",
        { ...env, ANDROID_KEY_ALIAS: "AndroidDebugKey" },
        version,
      ),
    /verification key/,
  );
});
test("invalid mode, inconsistent versions and invalid versionCode fail before building", () => {
  assert.throws(() => androidBuildConfig("debug", {}, version));
  assert.throws(() =>
    androidBuildConfig(
      "verification",
      {},
      { ...version, packageVersion: "0.0.0" },
    ),
  );
  for (const code of [0, -1, 1.5, 2100000001, undefined])
    assert.throws(() =>
      androidBuildConfig("verification", {}, { ...version, versionCode: code }),
    );
});
test("repository mobile versions and explicit Android versionCode are consistent", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const config = androidBuildConfig("verification", {}, mobileVersion(root));
  assert(config.version.length > 0);
  assert(config.versionCode > 0);
});

test("build replaces template launcher icons without replacing app themes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sourceweft-android-icons-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "apps/mobile/src-tauri/icons/android/mipmap-hdpi");
  const resources = join(
    root,
    "apps/mobile/src-tauri/gen/android/app/src/main/res",
  );
  mkdirSync(source, { recursive: true });
  mkdirSync(join(resources, "mipmap-hdpi"), { recursive: true });
  mkdirSync(join(resources, "values"));
  writeFileSync(join(source, "ic_launcher.png"), "SourceWeft icon");
  writeFileSync(
    join(resources, "mipmap-hdpi/ic_launcher.png"),
    "template icon",
  );
  writeFileSync(join(resources, "values/themes.xml"), "existing theme");
  syncAndroidIcons(root);
  assert.equal(
    readFileSync(join(resources, "mipmap-hdpi/ic_launcher.png"), "utf8"),
    "SourceWeft icon",
  );
  assert.equal(
    readFileSync(join(resources, "values/themes.xml"), "utf8"),
    "existing theme",
  );
});
