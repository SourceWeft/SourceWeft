import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const mobile = resolve(root, "apps/mobile");
const tauri = resolve(mobile, "src-tauri");
const apple = resolve(tauri, "gen/apple");
const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
/** The top-level keys of an XML property list, in order. */
const plistKeys = (path) => {
  const keys = [];
  let depth = 0;
  for (const [, close, key] of read(path).matchAll(
    /<(\/)?(?:dict|array)>|<key>([^<]+)<\/key>/g,
  )) {
    if (!key) depth += close ? -1 : 1;
    else if (depth === 1) keys.push(key);
  }
  return keys;
};
const trackedInfo = resolve(apple, "sourceweft-mobile_iOS/Info.plist");
const DEV_ONLY_KEYS = [
  "NSAppTransportSecurity",
  "NSLocalNetworkUsageDescription",
];
const PRODUCTION_ORIGIN = "https://sourceweft.com";

test("the tracked iOS Info.plist and project spec carry no development-only network keys", () => {
  const keys = plistKeys(trackedInfo);
  assert(keys.includes("CFBundleIdentifier"), "Info.plist was not parsed");
  for (const key of DEV_ONLY_KEYS) {
    assert(
      !keys.includes(key),
      `${key} belongs in Info.ios.dev.plist; a development run rewrote the tracked Info.plist, restore it before committing`,
    );
    assert(!read(resolve(apple, "project.yml")).includes(key), key);
  }
});

test("development runs, and only they, merge the development-only keys", () => {
  assert.deepEqual(
    plistKeys(resolve(tauri, "Info.ios.dev.plist")).sort(),
    [...DEV_ONLY_KEYS].sort(),
  );
  const devConfig = "src-tauri/tauri.ios.dev.conf.json";
  assert.equal(
    json(resolve(mobile, devConfig)).bundle.iOS.infoPlist,
    "Info.ios.dev.plist",
  );
  const { scripts } = json(resolve(mobile, "package.json"));
  for (const name of ["ios", "ios:sim"])
    assert(scripts[name].includes(`tauri ios dev -c ${devConfig}`), name);
  assert(!scripts["ios:build"].includes("dev"), "ios:build");
  // Tauri merges tauri.ios.conf.json and Info.ios.plist into every iOS build.
  const always = [
    JSON.stringify(json(resolve(tauri, "tauri.conf.json"))),
    JSON.stringify(json(resolve(tauri, "tauri.ios.conf.json"))),
  ].join("\n");
  assert(!always.includes("Info.ios.dev.plist"));
  for (const key of DEV_ONLY_KEYS)
    assert(!plistKeys(resolve(tauri, "Info.ios.plist")).includes(key), key);
});

test("every iOS build declares its device-capability purposes and export compliance", () => {
  const source = read(resolve(tauri, "Info.ios.plist"));
  const keys = plistKeys(resolve(tauri, "Info.ios.plist"));
  for (const key of [
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSPhotoLibraryAddUsageDescription",
    "NSSpeechRecognitionUsageDescription",
  ]) {
    assert(keys.includes(key), key);
    assert.match(
      source,
      new RegExp(`<key>${key}</key>\\s*<string>SourceWeft [^<]{20,}</string>`),
      `${key} needs a sentence that says what the app uses it for`,
    );
  }
  assert.match(source, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  assert.match(
    source,
    /<key>CFBundleDisplayName<\/key>\s*<string>SourceWeft<\/string>/,
  );
});

test("the production web app may call the native commands on Android and iOS alike", () => {
  const capability = json(resolve(tauri, "capabilities/production-web.json"));
  assert.deepEqual([...capability.platforms].sort(), ["android", "iOS"]);
  assert.deepEqual(capability.remote.urls, [`${PRODUCTION_ORIGIN}/*`]);
  assert.deepEqual(capability.windows, ["main"]);
  // The page gets exactly the commands the local window has.
  assert.deepEqual(
    capability.permissions,
    json(resolve(tauri, "capabilities/main.json")).permissions,
  );
  assert(
    read(resolve(tauri, "src/lib.rs")).includes(
      `Url::parse("${PRODUCTION_ORIGIN}")`,
    ),
    "The capability origin must be the origin release builds load",
  );
});

test("universal links name the same host, app and pages in the app, its entitlements and the website", () => {
  const host = new URL(PRODUCTION_ORIGIN).host;
  const [link, ...others] = json(resolve(tauri, "tauri.ios.conf.json")).plugins[
    "deep-link"
  ].mobile;
  assert.deepEqual(others, []);
  assert.deepEqual(link, {
    scheme: ["https"],
    host,
    pathPrefix: ["/dashboard"],
  });
  assert.match(
    read(
      resolve(
        apple,
        "sourceweft-mobile_iOS/sourceweft-mobile_iOS.entitlements",
      ),
    ),
    new RegExp(
      `<key>com\\.apple\\.developer\\.associated-domains</key>\\s*<array>\\s*<string>applinks:${host.replace(".", "\\.")}</string>\\s*</array>`,
    ),
  );
  const spec = read(resolve(apple, "project.yml"));
  const team = spec.match(/DEVELOPMENT_TEAM: (\w+)/)[1];
  const bundle = spec.match(/PRODUCT_BUNDLE_IDENTIFIER: ([\w.]+)/)[1];
  assert.equal(bundle, json(resolve(tauri, "tauri.conf.json")).identifier);
  const association = json(
    resolve(
      root,
      "apps/web/app/.well-known/apple-app-site-association/association.json",
    ),
  );
  assert.deepEqual(association.applinks.details, [
    {
      appIDs: [`${team}.${bundle}`],
      components: [{ "/": "/dashboard" }, { "/": "/dashboard/*" }],
    },
  ]);
});

test("the first release targets iPhone only, in the project spec and the Xcode project", () => {
  assert.match(
    read(resolve(apple, "project.yml")),
    /TARGETED_DEVICE_FAMILY: "1"\n/,
  );
  const families = [
    ...read(
      resolve(apple, "sourceweft-mobile.xcodeproj/project.pbxproj"),
    ).matchAll(/TARGETED_DEVICE_FAMILY = ([^;]+);/g),
  ].map(([, family]) => family);
  assert.deepEqual(families, ["1", "1"]);
});

test("Sign in with Apple is permitted to the page and entitled in the app", () => {
  for (const name of ["main.json", "production-web.json"])
    assert(
      json(resolve(tauri, "capabilities", name)).permissions.includes(
        "apple-sign-in:default",
      ),
      name,
    );
  assert.match(
    read(
      resolve(
        apple,
        "sourceweft-mobile_iOS/sourceweft-mobile_iOS.entitlements",
      ),
    ),
    /<key>com\.apple\.developer\.applesignin<\/key>\s*<array>\s*<string>Default<\/string>\s*<\/array>/,
  );
  // The plugin is part of this repository, not a third-party crate.
  assert.match(
    read(resolve(tauri, "Cargo.toml")),
    /^tauri-plugin-apple-sign-in = \{ path = "plugins\/apple-sign-in" \}$/m,
  );
});
