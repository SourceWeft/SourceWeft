#!/usr/bin/env node
// iOS CI helpers for .github/workflows/ios-build.yml. Each subcommand does one
// step and fails loudly; nothing falls back to another certificate, profile or
// key when a credential is missing.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE_ID = "nicelab.sourceweft.mobile";
export const TEAM_ID = "PBML833M58";
// The oldest iOS the app installs on. tauri.conf.json, project.yml, the Xcode
// project and the Podfile declare the same version.
export const MINIMUM_IOS_VERSION = "15.0";
export const REQUIRED_TESTFLIGHT_SECRETS = [
  "IOS_DIST_CERT_P12_BASE64",
  "IOS_DIST_CERT_PASSWORD",
  "IOS_PROVISIONING_PROFILE_BASE64",
  "APP_STORE_CONNECT_KEY_ID",
  "APP_STORE_CONNECT_ISSUER_ID",
  "APP_STORE_CONNECT_PRIVATE_KEY_BASE64",
];
const DEV_ONLY_PLIST_KEYS = [
  "NSAllowsLocalNetworking",
  "NSLocalNetworkUsageDescription",
];

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const apple = resolve(root, "apps/mobile/src-tauri/gen/apple");
const work = process.env.RUNNER_TEMP || tmpdir();
const keychain = join(work, "sourceweft-ios-signing.keychain-db");
const keychainPassword = `${process.pid}-${Date.now()}`;
const p12Path = join(work, "sourceweft-ios-dist.p12");
const profileDir = join(
  homedir(),
  "Library/MobileDevice/Provisioning Profiles",
);
const keyDir = join(homedir(), ".private_keys");

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    ...options,
  }).trim();

const requireEnv = (names) => {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets for the ios-testflight environment: ${missing.join(", ")}`,
    );
  }
};

const findFiles = (dir, predicate) => {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (predicate(path, entry)) found.push(path);
    if (entry.isDirectory() && !entry.name.endsWith(".app"))
      found.push(...findFiles(path, predicate));
  }
  return found;
};

const plistValue = (plist, key) =>
  run("plutil", ["-extract", key, "raw", "-o", "-", plist]);
const plistKeys = (plist) => {
  const json = JSON.parse(
    run("plutil", ["-convert", "json", "-o", "-", plist]),
  );
  return Object.keys(json);
};

export const verifyAppBundle = (appPath, { signed }) => {
  const info = join(appPath, "Info.plist");
  if (!existsSync(info)) throw new Error(`${appPath} has no Info.plist`);
  const bundleId = plistValue(info, "CFBundleIdentifier");
  if (bundleId !== BUNDLE_ID)
    throw new Error(`Bundle id is ${bundleId}, expected ${BUNDLE_ID}`);
  const keys = plistKeys(info);
  const leaked = DEV_ONLY_PLIST_KEYS.filter((key) => keys.includes(key));
  if (leaked.length > 0)
    throw new Error(
      `Development-only keys in the release bundle: ${leaked.join(", ")}`,
    );
  if (!keys.includes("ITSAppUsesNonExemptEncryption"))
    throw new Error("Export-compliance flag is missing");
  const minimum = plistValue(info, "MinimumOSVersion");
  if (minimum !== MINIMUM_IOS_VERSION)
    throw new Error(
      `Minimum iOS version is ${minimum}, expected ${MINIMUM_IOS_VERSION}`,
    );
  if (signed && !existsSync(join(appPath, "embedded.mobileprovision"))) {
    throw new Error("The signed app has no embedded provisioning profile");
  }
  return { bundleId, signed };
};

const subcommands = {
  "check-testflight-secrets"() {
    requireEnv(REQUIRED_TESTFLIGHT_SECRETS);
  },

  "install-signing"() {
    requireEnv(REQUIRED_TESTFLIGHT_SECRETS);
    writeFileSync(
      p12Path,
      Buffer.from(process.env.IOS_DIST_CERT_P12_BASE64, "base64"),
      { mode: 0o600 },
    );
    run("security", ["create-keychain", "-p", keychainPassword, keychain]);
    run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
    run("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    run("security", [
      "import",
      p12Path,
      "-k",
      keychain,
      "-P",
      process.env.IOS_DIST_CERT_PASSWORD,
      "-T",
      "/usr/bin/codesign",
      "-T",
      "/usr/bin/security",
    ]);
    run("security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      keychainPassword,
      keychain,
    ]);
    run("security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      keychain,
      join(homedir(), "Library/Keychains/login.keychain-db"),
    ]);
    run("security", ["default-keychain", "-s", keychain]);

    const profileTmp = join(work, "sourceweft-ios.mobileprovision");
    writeFileSync(
      profileTmp,
      Buffer.from(process.env.IOS_PROVISIONING_PROFILE_BASE64, "base64"),
    );
    const plistTmp = join(work, "sourceweft-ios-profile.plist");
    writeFileSync(plistTmp, run("security", ["cms", "-D", "-i", profileTmp]));
    const uuid = run("plutil", [
      "-extract",
      "UUID",
      "raw",
      "-o",
      "-",
      plistTmp,
    ]);
    const appId = run("plutil", [
      "-extract",
      "Entitlements.application-identifier",
      "raw",
      "-o",
      "-",
      plistTmp,
    ]);
    rmSync(plistTmp, { force: true });
    if (appId !== `${TEAM_ID}.${BUNDLE_ID}`) {
      throw new Error(
        `Provisioning profile is for ${appId}, expected ${TEAM_ID}.${BUNDLE_ID}`,
      );
    }
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, `${uuid}.mobileprovision`),
      Buffer.from(process.env.IOS_PROVISIONING_PROFILE_BASE64, "base64"),
    );

    mkdirSync(keyDir, { recursive: true });
    const keyPath = join(
      keyDir,
      `AuthKey_${process.env.APP_STORE_CONNECT_KEY_ID}.p8`,
    );
    writeFileSync(
      keyPath,
      Buffer.from(process.env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64, "base64"),
      { mode: 0o600 },
    );
    chmodSync(keyPath, 0o600);
    rmSync(profileTmp, { force: true });
  },

  "verify-simulator-app"() {
    const apps = findFiles(
      join(apple, "build"),
      (path) => path.endsWith(".app") && statSync(path).isDirectory(),
    );
    if (apps.length === 0)
      throw new Error("No simulator .app bundle was built");
    for (const app of apps) verifyAppBundle(app, { signed: false });
    console.log(`Verified ${apps.length} simulator app bundle(s)`);
  },

  "verify-ipa"() {
    const ipas = findFiles(join(apple, "build"), (path) =>
      path.endsWith(".ipa"),
    );
    if (ipas.length !== 1)
      throw new Error(`Expected exactly one IPA, found ${ipas.length}`);
    const extract = join(work, "sourceweft-ios-ipa");
    rmSync(extract, { recursive: true, force: true });
    mkdirSync(extract, { recursive: true });
    run("unzip", ["-q", ipas[0], "-d", extract]);
    const [app] = findFiles(join(extract, "Payload"), (path) =>
      path.endsWith(".app"),
    );
    if (!app) throw new Error("The IPA has no Payload/*.app");
    verifyAppBundle(app, { signed: true });
    rmSync(extract, { recursive: true, force: true });
    console.log(`Verified ${ipas[0]}`);
  },

  "upload-testflight"() {
    requireEnv(REQUIRED_TESTFLIGHT_SECRETS);
    const [ipa] = findFiles(join(apple, "build"), (path) =>
      path.endsWith(".ipa"),
    );
    run("xcrun", [
      "altool",
      "--upload-app",
      "-f",
      ipa,
      "-t",
      "ios",
      "--apiKey",
      process.env.APP_STORE_CONNECT_KEY_ID,
      "--apiIssuer",
      process.env.APP_STORE_CONNECT_ISSUER_ID,
    ]);
  },

  "remove-signing"() {
    // The keychain may never have been created when an earlier step failed.
    try {
      run("security", ["delete-keychain", keychain]);
    } catch {
      // Nothing to delete.
    }
    rmSync(p12Path, { force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (existsSync(profileDir)) {
      for (const file of readdirSync(profileDir)) {
        if (file.endsWith(".mobileprovision"))
          rmSync(join(profileDir, file), { force: true });
      }
    }
  },
};

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const name = process.argv[2];
  if (!subcommands[name]) {
    console.error(
      `Usage: ios-build.mjs <${Object.keys(subcommands).join("|")}>`,
    );
    process.exit(2);
  }
  try {
    subcommands[name]();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
