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

### CI and TestFlight

`.github/workflows/ios-build.yml` has two jobs:

- **Pull requests and pushes to `main`** that touch the mobile app build the app
  for the iOS simulator without signing, and upload the `.app` as an artifact.
  No Apple credential is read.
- **Manual dispatch with `mode: testflight`** runs in the `ios-testflight`
  environment, signs an App Store build and uploads it to TestFlight with
  `xcrun altool`. It needs these environment secrets; a missing one stops the
  run before anything is signed:

  - `IOS_DIST_CERT_P12_BASE64` and `IOS_DIST_CERT_PASSWORD`: the Apple
    Distribution certificate, exported as a `.p12` and base64-encoded.
  - `IOS_PROVISIONING_PROFILE_BASE64`: the App Store provisioning profile for
    `nicelab.sourceweft.mobile`, base64-encoded.
  - `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID` and
    `APP_STORE_CONNECT_PRIVATE_KEY_BASE64`: an App Store Connect API key, with
    the `.p8` base64-encoded.

The helper `scripts/ci/ios-build.mjs` checks the bundle identifier, team,
development-only keys and export-compliance flag of each app it verifies. It
uses only the credentials above and never falls back to another certificate,
profile or key.

## Android packaging

Android APK/AAB builds, pinned toolchains, signing inputs and CI verification are
documented in [Android packaging](../../scripts/ci/README.android.md). The Android
native project is now tracked; review any reinitialization diff before replacing
its signing or manifest configuration.

## Google Sign-In

Mobile Google sign-in uses `tauri-plugin-google-auth` to collect Google tokens
with the native flow, then passes the returned ID token to Better Auth so
SourceWeft keeps using the existing cookie/session layer. Each platform signs in
with its own Google OAuth client, and the backend must accept each one as a
token audience.

Android: create an Android OAuth client for package `nicelab.sourceweft.mobile`
plus SHA-1, and a Web OAuth client. The app signs in with the Web client id,
which the shared web runtime provides and the backend accepts:

```sh
NEXT_PUBLIC_GOOGLE_MOBILE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
AUTH_GOOGLE_MOBILE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
```

iOS: create an OAuth client of type iOS for bundle id
`nicelab.sourceweft.mobile`. Only the backend is configured; it accepts the
client and hands its id to the app through `/v1/auth/config`:

```sh
AUTH_GOOGLE_IOS_CLIENT_ID=your-ios-client-id.apps.googleusercontent.com
```

The iOS flow runs in the system's web authentication session, which receives
the callback itself, so no URL scheme is registered in `Info.plist`. (The
deep-link plugin removes `CFBundleURLTypes` on every build anyway.)

Both variables only take effect while the Google web client
(`AUTH_GOOGLE_SIGNIN_WEB_CLIENT_ID` and its secret) is configured.

## Sign in with Apple

The iOS app offers Sign in with Apple through the in-repo plugin
`src-tauri/plugins/apple-sign-in`. It shows the system sheet and returns the
identity token Apple issues for this app; the page sends that token to Better
Auth, which verifies it against Apple's keys with the bundle id as the
audience. The page generates a random nonce for every attempt, gives Apple its
SHA-256, and gives the backend the nonce itself, so a token issued for another
request is refused.

Backend:

```sh
AUTH_APPLE_APP_BUNDLE_ID=nicelab.sourceweft.mobile
```

Apple Developer portal: the App ID needs the Sign In with Apple capability. The
entitlement `com.apple.developer.applesignin` is in the tracked entitlements
file.

There is no client secret, so Apple sign-in exists in the iOS app only; the
browser redirect flow is not configured and no web page offers it.

Which buttons the sign-in view shows is decided in
`apps/web/lib/mobile-sign-in-methods.ts`. On iOS, Google is shown only next to
Sign in with Apple: the App Store requires an app that offers a third-party
sign-in to offer Sign in with Apple as well.

Not done yet: revoking the person's Apple tokens when they delete their
account, which Apple requires before an App Store release. It needs the
authorization code exchange and a Sign in with Apple key.

## What the iOS app does not sell, and what it asks first

The page learns which app it runs in from the bridge: `window.__SOURCEWEFT_NATIVE__`
carries `platform` (`ios` or `android`). `apps/web/lib/native-host.ts` reads it,
also from inside the sheets the mobile app opens, and answers one question for
the rest of the web app: may anything be sold here (`usePurchasesAllowed`).
Nothing branches on the browser's user agent.

In the iOS app the answer is no. The App Store allows digital purchases only
through in-app purchase and forbids pointing people to another way to pay, so:

- `useDeploymentCapabilities` reports checkout and top-ups as unavailable. Every
  purchase control already hangs off those two flags, so the upgrade, manage
  billing and top-up controls disappear without knowing about hosts.
- The Billing settings tab is hidden; Usage stays, read-only.
- `/dashboard/billing/checkout` does not start a payment.
- Paid team creation is not offered, and the free team dialog never stands in
  for it.
- Links to the pricing page are not followed, not even into a sheet.

A mobile app that has not said which platform it runs on is treated like the
iOS app until it answers. Android, the desktop app and browsers are unchanged.
When adding a purchase surface, read the capabilities or `usePurchasesAllowed`;
do not add a second gate.

Before the dashboard is shown, the iOS app asks the person to agree to their
chat content being sent to third-party AI model providers
(`app/dashboard/_components/ai-data-consent-gate.tsx`). The App Store requires
that disclosure and explicit permission. Nothing behind the dialog is mounted
until they agree; declining signs them out. The agreement is recorded per
account in the device's storage only, so a reinstall or another device asks
again. The Privacy Policy the dialog links to must name where the data goes.

## Native project setup

```sh
pnpm --filter @sourceweft/mobile tauri android init
pnpm --filter @sourceweft/mobile tauri ios init
```

Then use:

```sh
pnpm --filter @sourceweft/mobile android
pnpm --filter @sourceweft/mobile ios
```
