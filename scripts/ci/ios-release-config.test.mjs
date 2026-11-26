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

// The app has no landscape layout. Tauri keeps the tracked Info.plist's own
// keys when it merges the layers, and the project spec regenerates that file,
// so both must say portrait only, with no per-device variant widening it.
test("the app supports portrait only, in the tracked Info.plist and the project spec", () => {
  const info = read(trackedInfo);
  assert.match(
    info,
    /<key>UISupportedInterfaceOrientations<\/key>\s*<array>\s*<string>UIInterfaceOrientationPortrait<\/string>\s*<\/array>/,
  );
  const spec = read(resolve(apple, "project.yml"));
  assert.match(
    spec,
    /\n {8}UISupportedInterfaceOrientations:\n {10}- UIInterfaceOrientationPortrait\n {8}\w/,
  );
  for (const [name, text] of [
    ["Info.plist", info],
    ["project.yml", spec],
    ["Info.ios.plist", read(resolve(tauri, "Info.ios.plist"))],
    ["Info.ios.dev.plist", read(resolve(tauri, "Info.ios.dev.plist"))],
  ]) {
    assert.doesNotMatch(text, /UIInterfaceOrientationLandscape/, name);
    assert.doesNotMatch(text, /UISupportedInterfaceOrientations~/, name);
  }
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

// The Tauri CLI (2.11.4) applies CI signing by editing these settings, and its
// project editor has two faults this layout works around:
// - of the settings it has to add, only the first lands inside the build
//   settings, so the settings the build needs must already be declared;
// - its export step reads the value a declared setting had before the edit, so
//   the two settings the export reads (signing style and the device identity)
//   must not be declared. The style is the first setting it adds.
test("the iOS target declares exactly the signing settings the Tauri CLI can edit in place", () => {
  const project = read(
    resolve(apple, "sourceweft-mobile.xcodeproj/project.pbxproj"),
  );
  const targetConfigs = project
    .split("isa = XCBuildConfiguration;")
    .filter((block) => block.includes("CODE_SIGN_ENTITLEMENTS"));
  assert.equal(targetConfigs.length, 2, "expected debug and release");
  const spec = read(resolve(apple, "project.yml"));
  const line = (key) => (key.includes("[") ? `\t"${key}" = ` : `\t${key} = `);
  for (const key of [
    "CODE_SIGN_IDENTITY",
    "DEVELOPMENT_TEAM",
    "DEVELOPMENT_TEAM[sdk=iphoneos*]",
    "PROVISIONING_PROFILE_SPECIFIER",
    "PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]",
  ]) {
    for (const config of targetConfigs)
      assert(config.includes(line(key)), `${key} is not declared`);
    if (key !== "CODE_SIGN_IDENTITY")
      assert(spec.includes(`${key}: `), `${key} is not in project.yml`);
  }
  for (const key of ["CODE_SIGN_STYLE", "CODE_SIGN_IDENTITY[sdk=iphoneos*]"]) {
    assert(!project.includes(line(key)), `${key} must not be declared`);
    assert(!spec.includes(`${key}: `), `${key} must not be in project.yml`);
  }
});

// With Xcode 26's Metal toolchain installed, TOOLCHAIN_DIR points at the Metal
// toolchain, which has no Swift compatibility libraries. The linker then fails
// on __swift_FORCE_LOAD_$_swiftCompatibility56. DT_TOOLCHAIN_DIR is always the
// default toolchain.
test("Swift library search paths use the default toolchain, not TOOLCHAIN_DIR", () => {
  for (const file of [
    "project.yml",
    "sourceweft-mobile.xcodeproj/project.pbxproj",
  ]) {
    const text = read(resolve(apple, file));
    assert(!/\$\(TOOLCHAIN_DIR\)/.test(text), `${file} uses $(TOOLCHAIN_DIR)`);
    assert(text.includes("$(DT_TOOLCHAIN_DIR)/usr/lib/swift"), file);
  }
});

// WKWebView runs the app's service worker only for app-bound domains, so the
// hosts the app limits navigation to must be exactly the ones it declares.
test("the app-bound domains in Info.ios.plist match the hosts the app binds", () => {
  const plist = read(resolve(tauri, "Info.ios.plist"));
  const declared = [
    ...plist
      .match(/<key>WKAppBoundDomains<\/key>\s*<array>([\s\S]*?)<\/array>/)[1]
      .matchAll(/<string>([^<]+)<\/string>/g),
  ].map(([, host]) => host);
  const bound = [
    ...read(resolve(tauri, "src/lib.rs"))
      .match(/const APP_BOUND_HOSTS: \[&str; \d+\] = \[([^\]]+)\]/)[1]
      .matchAll(/"([^"]+)"/g),
  ].map(([, host]) => host);
  assert.deepEqual(declared, bound);
  assert(bound.includes(new URL(PRODUCTION_ORIGIN).host));
});

test("the launch image uses the splash page's background, defined for light and dark", () => {
  const storyboard = read(resolve(apple, "LaunchScreen.storyboard"));
  assert.match(
    storyboard,
    /<color key="backgroundColor" name="LaunchBackground"\/>/,
  );
  const colors = json(
    resolve(apple, "Assets.xcassets/LaunchBackground.colorset/Contents.json"),
  ).colors;
  const hex = ({ color: { components: c } }) =>
    "#" +
    [c.red, c.green, c.blue]
      .map((v) =>
        Math.round(Number(v) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const light = colors.find((entry) => !entry.appearances);
  const dark = colors.find((entry) => entry.appearances?.[0]?.value === "dark");
  const splash = read(resolve(mobile, "placeholder-dist/splash.html"));
  assert.match(splash, new RegExp(`--bg: ${hex(light)};`));
  assert.match(
    splash,
    new RegExp(`prefers-color-scheme: dark\\)[^}]*--bg: ${hex(dark)};`),
  );
});

// The Google Sign-In SDK refuses to start unless the app registers its iOS
// OAuth client, reversed, as a URL scheme. The client is the one the API
// returns as nativeSignIn.googleIosClientId for sourceweft.com.
test("Google Sign-In's reversed iOS client is a registered URL scheme", () => {
  const plist = read(resolve(tauri, "Info.ios.plist"));
  const types = plist.match(
    /<key>CFBundleURLTypes<\/key>\s*<array>([\s\S]*?)<\/array>\s*<key>/,
  )?.[1];
  assert(types, "Info.ios.plist declares no CFBundleURLTypes");
  assert.match(
    types,
    /<string>com\.googleusercontent\.apps\.\d+-[a-z0-9]+<\/string>/,
  );
});

// iOS renders the launch image with other safe-area insets than the running
// app (about 44 top and 0 bottom on an iPhone 16 Pro, against 62 and 34), so a
// wordmark centred in the safe area jumped 8pt when the app took over. The span
// the wordmark is centred in is tied to the screen instead: 28pt below its top
// (62 - 34, the web view's offset on Dynamic Island iPhones) down to its bottom.
test("the launch wordmark is placed from the screen, not the safe area", () => {
  const storyboard = read(resolve(apple, "LaunchScreen.storyboard"));
  const constraint = (id) =>
    storyboard.match(new RegExp(`<constraint [^>]*id="${id}"/>`))?.[0] ?? "";
  assert.match(constraint("Sp1-Top-Cn1"), /secondItem="5EZ-qb-Rvc"/);
  assert.match(constraint("Sp1-Top-Cn1"), /constant="28"/);
  assert.match(constraint("Sp1-Bot-Cn1"), /secondItem="5EZ-qb-Rvc"/);
  assert.match(constraint("Cy1-Lb-Sw1"), /secondItem="Sp1-Ar-Ea1"/);
  assert.doesNotMatch(
    constraint("Sp1-Top-Cn1") + constraint("Sp1-Bot-Cn1"),
    /vDu-zF-Fre/,
  );
});

// The launch image, the splash page and the web cover show the same text
// wordmark, with no image, so the hand-over between them does not change.
test("the launch image, splash and web cover show the same text wordmark", () => {
  const storyboard = read(resolve(apple, "LaunchScreen.storyboard"));
  assert.match(storyboard, /<label [^>]*text="SourceWeft"/);
  assert.doesNotMatch(storyboard, /<imageView /);
  assert.match(
    read(resolve(root, "apps/mobile/placeholder-dist/splash.html")),
    /<div class="mark">SourceWeft<\/div>/,
  );
  assert.match(
    read(resolve(root, "apps/web/app/_components/mobile-launch-cover.tsx")),
    /content: "SourceWeft"/,
  );
});
