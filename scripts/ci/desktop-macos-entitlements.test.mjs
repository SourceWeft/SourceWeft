import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tauri = resolve(root, "apps/desktop/src-tauri");
const read = (path) => readFileSync(resolve(tauri, path), "utf8");
const config = JSON.parse(read("tauri.conf.json"));

/** Resources the hardened runtime refuses unless the app declares them, with their purpose string. */
const PROTECTED = [
  {
    entitlement: "com.apple.security.device.audio-input",
    purpose: "NSMicrophoneUsageDescription",
  },
  {
    entitlement: "com.apple.security.device.camera",
    purpose: "NSCameraUsageDescription",
  },
  {
    entitlement: "com.apple.security.personal-information.location",
    purpose: "NSLocationUsageDescription",
  },
];

test("the macOS app is signed with an entitlements file, next to its Info.plist", () => {
  assert.equal(config.bundle.macOS.entitlements, "Entitlements.plist");
  assert.equal(config.bundle.macOS.infoPlist, "Info.plist");
});

test("the microphone is declared for the hardened runtime and explained to the user", () => {
  assert.match(
    read("Entitlements.plist"),
    /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/,
  );
  assert.match(
    read("Info.plist"),
    /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/,
  );
});

test("an entitlement and its purpose string are always added together", () => {
  const entitlements = read("Entitlements.plist");
  const info = read("Info.plist");
  for (const { entitlement, purpose } of PROTECTED) {
    assert.equal(
      entitlements.includes(`<key>${entitlement}</key>`),
      info.includes(`<key>${purpose}</key>`),
      `${entitlement} and ${purpose} must both be present or both be absent`,
    );
  }
});

test("the app does not ask for more than it uses", () => {
  const keys = [
    ...read("Entitlements.plist").matchAll(/<key>([^<]+)<\/key>/g),
  ].map(([, key]) => key);
  assert.deepEqual(keys, ["com.apple.security.device.audio-input"]);
});

test("a macOS build without the microphone entitlement cannot be published", () => {
  const prepare = readFileSync(
    resolve(root, "scripts/ci/prepare-desktop-release.mjs"),
    "utf8",
  );
  assert.match(
    prepare,
    /"--entitlements",\s*"-",\s*"--xml",\s*app/,
    "the release step must read the built app's entitlements",
  );
  assert(prepare.includes("com\\.apple\\.security\\.device\\.audio-input"));
});
