# Mobile (Tauri)

This directory hosts the SourceWeft mobile shell built with Tauri 2.

- `src/`: mobile frontend bootstrap placeholders
- `src-tauri/`: Rust runtime and Tauri mobile configuration
- `placeholder-dist/`: static fallback used when a bundled frontend has not been wired yet

The app opens the web origin during development, then the mobile native host
redirects to `/auth/sign-in` and routes into `/dashboard` after the Better Auth
session is available. The Tauri `devUrl` intentionally uses
`http://0.0.0.0:3000` and the dev hook starts Next.js with
its default `0.0.0.0` host so iOS devices can load the host machine instead of
trying to resolve `localhost` on the device. Keeping `devUrl` at the origin
root prevents WebView dev chunks from resolving under a nested auth path. For
native projects, run the Tauri mobile init commands from this package after
installing the Android and/or iOS toolchains:

```sh
pnpm --filter @sourceweft/mobile ios
```

When using a physical iPhone, keep the phone and development machine on the same
network and allow the iOS local-network prompt. The generated iOS project
includes `NSAllowsLocalNetworking` for the local HTTP dev server.

On the iOS Simulator, use `ios:sim` instead:

```sh
pnpm --filter @sourceweft/mobile ios:sim
```

It points devUrl at `http://sw.localhost:3000`, which looks odd but is load
bearing on two counts.

`0.0.0.0` does not work. Tauri rewrites that devUrl host to the machine's LAN
address, which the simulator cannot reach: iOS asks for Local Network
permission, `xcrun simctl privacy` has no service to grant it, and the WebView
only ever shows `Failed to request http://<lan-ip>:3000/`. An mDNS `.local` name
resolves to the same LAN address and hits the same wall.

Plain `localhost` does not work either, and the failure is silent. Tauri proxies
the dev server through its own protocol on mobile only —
`PROXY_DEV_SERVER = cfg!(all(dev, mobile))` — whenever the devUrl host is
`localhost` or any IP literal. The WebView then runs on `tauri://localhost`
instead of an http origin, and Next's client never hydrates there: the document
and every chunk load with 200, no JavaScript error is raised, and the app renders
its server HTML and nothing else. Pages that are mostly static (the marketing
home page, dashboard skeletons) look fine, so the breakage only becomes visible
on a page that needs client rendering, such as sign-in. That rewrite also drops
the path, so the start route is lost. `apps/desktop` never hits any of this: the
proxy is off on desktop, so its window loads the real http origin directly.

A host that is neither the literal string `localhost` nor an IP literal skips the
proxy, and macOS resolves `*.localhost` to the loopback address — so
`sw.localhost` keeps the simulator on loopback while loading the web app over
http, exactly like the desktop app does.

The WebView origin is then `http://sw.localhost:3000` rather than
`http://localhost:3000`. Add it to `BETTER_AUTH_TRUSTED_ORIGINS` before testing
sign-in, or auth requests are rejected as untrusted.

For authenticated local testing on a physical device, also expose the backend on
`0.0.0.0:3001` and add the web dev origin to `BETTER_AUTH_TRUSTED_ORIGINS`, for
example `http://192.168.1.20:3000`. The web client falls back to the same host
on port `3001` when it is loaded through a non-localhost development URL.

The mobile host identifies itself through the same native bridge shape as the desktop host: `window.__SOURCEWEFT_NATIVE__`. Check `bridge.kind === "mobile"` or a named capability such as `externalUrl`; avoid branching on browser platform strings for native behavior.

## iOS Generated Project

Tauri generates the iOS project under `src-tauri/gen/apple`. Keep the generated
project source files tracked because this app needs native project configuration
such as `Info.plist`, entitlements, icons, `Podfile`, and `project.yml`.

Do not commit local Xcode/CocoaPods/build output. The root `.gitignore` keeps
`xcuserdata`, `build`, `DerivedData`, `Pods`, `Externals`, IPA, and dSYM outputs
ignored.

Use `APPLE_DEVELOPMENT_TEAM` when running Tauri commands instead of committing a
personal Apple Team ID into the base `tauri.conf.json`:

```sh
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID pnpm exec tauri ios init
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID pnpm run ios
```

If `project.yml` or the generated Xcode project captures your local Team ID,
review that diff before committing a public branch.

## iOS release configuration

Release builds load `https://sourceweft.com`. `capabilities/production-web.json`
lets that origin call the native commands on Android and iOS; without it the
page gets the bridge object but every call is refused.

The first release targets iPhone only (`TARGETED_DEVICE_FAMILY` is `1` in
`project.yml` and the Xcode project). iPad support can be added later, but a
released app cannot drop a device family.

### Info.plist layers

Tauri rewrites `gen/apple/sourceweft-mobile_iOS/Info.plist` on every iOS build
and development run: it merges the files below into it, key by key at the top
level, and saves the result.

- `src-tauri/Info.ios.plist` is merged into every iOS build. It holds what a
  release needs: the display name, the purpose strings for camera, microphone,
  speech recognition and saving to the photo library, and the export-compliance
  flag. Add a purpose string here before the web app starts using another
  device capability; iOS ends the app when a capability is requested without
  one.
- `src-tauri/Info.ios.dev.plist` holds the keys only a development run needs:
  the App Transport Security exceptions for the local HTTP dev server and the
  local-network prompt text. Only the `ios` and `ios:sim` scripts merge it,
  through `src-tauri/tauri.ios.dev.conf.json`.

A development run therefore leaves the tracked `Info.plist` modified, with the
development-only keys in it. Restore it before committing or building a release
from the same checkout:

```sh
git restore apps/mobile/src-tauri/gen/apple/sourceweft-mobile_iOS/Info.plist
```

`scripts/ci/ios-release-config.test.mjs` fails while those keys are in the
tracked file.

### Universal links

A link to `https://sourceweft.com/dashboard` or a page below it opens the app
at that page. Four places must agree, and the same test checks them:

- `src-tauri/tauri.ios.conf.json`: the deep-link host and path. The plugin
  writes the host into the entitlements as `applinks:sourceweft.com`.
- `apps/web/app/.well-known/apple-app-site-association`: the file the website
  serves, naming the app (`<Team ID>.<bundle id>`) and the pages.
- `src-tauri/src/lib.rs`, `universal_link_target`: the app opens only those
  pages; any other deep link is handed to the page as an event.
- The App ID in the Apple Developer portal must have the Associated Domains
  capability, or signing fails.

Sign-in pages are deliberately not associated, so a link from outside the app
cannot drive its sign-in flow. iOS fetches the association file through Apple's
CDN, so it must be reachable without a redirect or a bot challenge.

`tauri.conf.json` still carries the placeholder deep-link host for Android;
`tauri.ios.conf.json` replaces it for iOS only.

### App Store export

`ExportOptions.plist` stays `debugging`, which is what development needs. An
App Store or TestFlight build passes the method on the command line, and Tauri
merges it into a temporary copy:

```sh
pnpm --filter @sourceweft/mobile exec tauri ios build --export-method app-store-connect
```

Signing credentials and the TestFlight upload are not automated yet.

## Android packaging

Android APK/AAB builds, pinned toolchains, signing inputs and CI verification are
documented in [Android packaging](../../scripts/ci/README.android.md). The Android
native project is now tracked; review any reinitialization diff before replacing
its signing or manifest configuration.

## Google Sign-In

Mobile Google sign-in uses `tauri-plugin-google-auth` to collect Google tokens
with the native SDK, then passes the returned ID token to Better Auth so
SourceWeft keeps using the existing cookie/session layer.

Configure the shared web runtime with:

```sh
NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
```

The backend must accept the same token audience:

```sh
AUTH_GOOGLE_MOBILE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
```

Platform setup still needs to be applied after generating native projects:

- iOS: create an iOS OAuth client for bundle id `nicelab.sourceweft.mobile` and
  add the reversed client id to `Info.plist` `CFBundleURLTypes`.
- Android native flow: create both an Android OAuth client for package
  `nicelab.sourceweft.mobile` plus SHA-1, and a Web OAuth client; pass the Web
  client id as `NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID`.

```sh
pnpm --filter @sourceweft/mobile tauri android init
pnpm --filter @sourceweft/mobile tauri ios init
```

Then use:

```sh
pnpm --filter @sourceweft/mobile android
pnpm --filter @sourceweft/mobile ios
```
