#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCHEME = "sourceweft";
const BUNDLE_ID = "nicelab.sourceweft";
const APP_NAME = "SourceWeft.app";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const tauriDir = join(desktopDir, "src-tauri");
const targetDir = join(tauriDir, "target");

const shouldRegister = process.argv.includes("--register");
const shouldOpenTest = process.argv.includes("--open-test");

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collectApps(root, depth = 0) {
  if (!existsSync(root) || depth > 8) {
    return [];
  }

  const apps = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }

    if (stat.isDirectory() && entry.endsWith(".app")) {
      apps.push(path);
      continue;
    }

    if (stat.isDirectory()) {
      apps.push(...collectApps(path, depth + 1));
    }
  }

  return apps;
}

function unique(values) {
  return Array.from(new Set(values));
}

function candidateApps() {
  return unique([
    `/Applications/${APP_NAME}`,
    `${process.env.HOME || ""}/Applications/${APP_NAME}`,
    ...collectApps(targetDir),
  ]).filter(Boolean);
}

function readPlistXml(plistPath) {
  const result = run("plutil", ["-convert", "xml1", "-o", "-", plistPath]);
  if (result.status !== 0) {
    return "";
  }

  return result.stdout;
}

function appInfo(appPath) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) {
    return {
      appPath,
      hasBundleId: false,
      hasScheme: false,
      plistPath,
    };
  }

  const plist = readPlistXml(plistPath);
  return {
    appPath,
    hasBundleId: plist.includes(BUNDLE_ID),
    hasScheme: plist.includes(`<string>${SCHEME}</string>`),
    plistPath,
  };
}

function launchServicesDump() {
  if (!existsSync(LSREGISTER)) {
    return "";
  }

  const result = run(LSREGISTER, ["-dump"]);
  return result.status === 0 ? result.stdout : "";
}

function printApp(info) {
  console.log(`- ${info.appPath}`);
  console.log(`  Info.plist: ${existsSync(info.plistPath) ? "found" : "missing"}`);
  console.log(`  Bundle id ${BUNDLE_ID}: ${info.hasBundleId ? "yes" : "no"}`);
  console.log(`  Scheme ${SCHEME}://: ${info.hasScheme ? "yes" : "no"}`);
}

if (process.platform !== "darwin") {
  console.error("This helper is only for macOS Launch Services.");
  process.exit(1);
}

const apps = candidateApps().filter(existsSync).map(appInfo);
const validApps = apps.filter((app) => app.hasScheme);

console.log("SourceWeft deep link check");
console.log("");

if (apps.length === 0) {
  console.log("No SourceWeft.app bundle was found.");
  console.log("");
  console.log("Build one first:");
  console.log("  pnpm --filter @sourceweft/desktop exec tauri build");
  process.exit(1);
}

console.log("App bundles:");
for (const app of apps) {
  printApp(app);
}
console.log("");

if (validApps.length === 0) {
  console.log(`No app bundle declares ${SCHEME}://.`);
  console.log("Check apps/desktop/src-tauri/Info.plist and rebuild the app.");
  process.exit(1);
}

if (shouldRegister) {
  for (const app of validApps) {
    console.log(`Registering ${app.appPath}`);
    const result = run(LSREGISTER, ["-f", app.appPath]);
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout);
      process.exit(result.status || 1);
    }
  }
  console.log("");
}

const dump = launchServicesDump();
const isRegistered =
  dump.toLowerCase().includes(SCHEME) || dump.toLowerCase().includes(BUNDLE_ID);

console.log(
  `Launch Services contains ${SCHEME}/${BUNDLE_ID}: ${
    isRegistered ? "yes" : "no"
  }`,
);
console.log("");

if (!isRegistered) {
  console.log("Register the app bundle:");
  console.log("  pnpm --filter @sourceweft/desktop deeplink:register");
  console.log("");
  console.log("For macOS, Tauri deep links are only reliable for a bundled app.");
  console.log("Install or copy SourceWeft.app into /Applications, then register again.");
  process.exit(1);
}

console.log("Test command:");
console.log(`  open '${SCHEME}://auth/complete?test=1'`);

if (shouldOpenTest) {
  run("open", [`${SCHEME}://auth/complete?test=1`]);
}
