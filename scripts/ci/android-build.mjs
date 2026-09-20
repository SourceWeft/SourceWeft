import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
  readdirSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

export const ANDROID_TOOLS = Object.freeze({
  sdk: "36",
  buildTools: "36.0.0",
  ndk: "28.2.13676358",
  rust: "1.94.1",
  target: "aarch64-linux-android",
});
export function syncAndroidIcons(root) {
  const source = join(root, "apps/mobile/src-tauri/icons/android");
  const resources = join(
    root,
    "apps/mobile/src-tauri/gen/android/app/src/main/res",
  );
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(resources, entry), {
      recursive: true,
      force: true,
    });
  }
}
export function androidBuildConfig(mode, env, mobile) {
  assert(
    ["verification", "release"].includes(mode),
    "Choose verification or release explicitly",
  );
  assert.equal(
    mobile.packageVersion,
    mobile.version,
    "Mobile package version must match Tauri",
  );
  assert.equal(
    mobile.rustVersion,
    mobile.version,
    "Mobile Cargo version must match Tauri",
  );
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(mobile.version),
    "Invalid mobile version",
  );
  assert(
    Number.isSafeInteger(mobile.versionCode) &&
      mobile.versionCode > 0 &&
      mobile.versionCode <= 2100000000,
    "Android versionCode must be an explicit positive Play-compatible integer",
  );
  if (mode === "release") {
    for (const name of [
      "ANDROID_KEYSTORE_PATH",
      "ANDROID_STORE_PASSWORD",
      "ANDROID_KEY_ALIAS",
      "ANDROID_KEY_PASSWORD",
    ])
      assert(env[name]?.trim(), `${name} is required for release signing`);
    assert(
      !/^(androiddebugkey|sourceweft-verification)$/i.test(
        env.ANDROID_KEY_ALIAS,
      ),
      "Do not use a verification key for release signing",
    );
  }
  return {
    mode,
    version: mobile.version,
    versionCode: mobile.versionCode,
    applicationId: `nicelab.sourceweft.mobile${mode === "verification" ? ".verification" : ""}`,
    versionName: `${mobile.version}${mode === "verification" ? "-verification" : ""}`,
    args: [
      "--filter",
      "@sourceweft/mobile",
      "exec",
      "tauri",
      "android",
      "build",
      "--ci",
      "--apk",
      ...(mode === "release" ? ["--aab"] : []),
      "--target",
      "aarch64",
    ],
  };
}

export function mobileVersion(root) {
  const config = JSON.parse(
    readFileSync(join(root, "apps/mobile/src-tauri/tauri.conf.json"), "utf8"),
  );
  const pkg = JSON.parse(
    readFileSync(join(root, "apps/mobile/package.json"), "utf8"),
  );
  const cargo = readFileSync(
    join(root, "apps/mobile/src-tauri/Cargo.toml"),
    "utf8",
  );
  const rustVersion = cargo
    .split(/^\[package\]\s*$/m)[1]
    ?.split(/^\[/m)[0]
    ?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert.equal(
    config.identifier,
    "nicelab.sourceweft.mobile",
    "Unexpected Android package identifier",
  );
  return {
    version: config.version,
    packageVersion: pkg.version,
    rustVersion,
    versionCode: config.bundle?.android?.versionCode,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const config = androidBuildConfig(
    process.argv[2],
    process.env,
    mobileVersion(root),
  );
  for (const name of ["ANDROID_HOME", "NDK_HOME", "JAVA_HOME"])
    assert(process.env[name], `${name} is required`);
  assert(
    existsSync(join(process.env.NDK_HOME, "source.properties")),
    "Android NDK is missing",
  );
  const ndkProperties = readFileSync(
    join(process.env.NDK_HOME, "source.properties"),
    "utf8",
  );
  assert(
    ndkProperties.includes(`Pkg.Revision = ${ANDROID_TOOLS.ndk}`),
    "Use the pinned Android NDK",
  );
  assert(
    existsSync(
      join(
        process.env.ANDROID_HOME,
        "platforms",
        `android-${ANDROID_TOOLS.sdk}`,
        "android.jar",
      ),
    ),
    "Android SDK 36 is missing",
  );
  if (config.mode === "release")
    assert(
      existsSync(process.env.ANDROID_KEYSTORE_PATH),
      "Android release keystore is missing",
    );
  const lockPath = join(root, "apps/mobile/src-tauri/Cargo.lock");
  const originalLock = readFileSync(lockPath);
  syncAndroidIcons(root);
  // Arguments are fixed; Windows needs a shell for the pnpm.cmd batch shim.
  // Signing secrets stay in the environment and are never put on argv.
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    config.args,
    {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        SOURCEWEFT_ANDROID_SIGNING_MODE: config.mode,
        RUSTUP_TOOLCHAIN: ANDROID_TOOLS.rust,
      },
    },
  );
  if (result.error) throw result.error;
  const manifestPath = join(
    root,
    "apps/mobile/src-tauri/gen/android/app/src/main/AndroidManifest.xml",
  );
  const manifest = readFileSync(manifestPath, "utf8");
  writeFileSync(
    manifestPath,
    manifest
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd() + "\n",
  );
  assert(
    originalLock.equals(readFileSync(lockPath)),
    "Cargo.lock changed during Android build; review dependency resolution before publishing",
  );
  process.exit(result.status ?? 1);
}
