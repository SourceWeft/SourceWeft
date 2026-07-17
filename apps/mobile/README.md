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

For authenticated local testing on a physical device, also expose the backend on
`0.0.0.0:3001` and add the web dev origin to `BETTER_AUTH_TRUSTED_ORIGINS`, for
example `http://192.168.1.20:3000`. The web client falls back to the same host
on port `3001` when it is loaded through a non-localhost development URL.

## API base URL

The mobile shell is a Tauri WebView around the web app. It does **not** own an
API client or `VITE_API_BASE_URL`. Runtime API calls use the web app's
`NEXT_PUBLIC_API_BASE_URL` (see `apps/web/lib/api-base-url.ts`). Configure that
on the web package / deployment that the shell loads; do not hardcode API hosts
in `apps/mobile`.

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
