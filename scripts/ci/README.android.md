# Android packaging

Android uses the existing `apps/mobile` Tauri shell. It is independently versioned
from the desktop app and does not use the desktop updater or desktop signatures.
The current target is ARM64 (`arm64-v8a`), Android 7/API 24 or later.

## Native project and tools

The generated project is tracked under `apps/mobile/src-tauri/gen/android`.
Keep the wrapper, Gradle/Kotlin source, manifest, resources and icons in Git.
Do not run `tauri android init` over this project without reviewing the native
signing configuration and authentication intent filter. Build outputs, JNI
libraries, machine paths, generated Tauri Gradle files and keystores are ignored.

Pinned tools: Java 21, Rust 1.94.1, Android SDK 36, build-tools 36.0.0 (plus 35.0.0
for AGP library modules) and NDK
28.2.13676358. NDK r28 and the artifact checks enforce 16 KiB native page support.
Install `aarch64-linux-android` for the selected Rust toolchain and set
`JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` before building. Fetch locked dependencies:

```sh
rustup target add --toolchain 1.94.1 aarch64-linux-android
cargo fetch --locked --manifest-path apps/mobile/src-tauri/Cargo.toml
```

The build wrapper rejects inconsistent package/Tauri/Cargo versions, missing
tools and a changed Cargo lockfile. `bundle.android.versionCode` is explicit and
must increase for every published Android build, including successive RCs.

## Verification APK

```sh
pnpm --filter @sourceweft/mobile android:verify
python3 scripts/ci/android-artifacts.py verification
```

This is an optimized release-profile build so it opens `https://sourceweft.com`,
not the development server. It deliberately uses Android's test certificate and
the separate package `nicelab.sourceweft.mobile.verification`, with a
`-verification` version-name suffix. It is not a production release and cannot
replace the official app. CI debug keys may differ between runs; uninstall the
previous verification app if Android rejects a certificate mismatch.

The `Android package verification` workflow runs on mobile-related PRs and pushes
to `main`/`codex/**`, and supports manual dispatch. Verification needs no release
signing secrets. Artifacts and `android-manifest.json` are uploaded to the run.
No Google Play or website publication is performed.

## Signed APK and AAB

Create a protected `android-release` environment. Configure:

- `ANDROID_KEYSTORE_BASE64`: single-line base64 of the long-lived JKS/PKCS12 keystore.
- `ANDROID_STORE_PASSWORD`: keystore password.
- `ANDROID_KEY_ALIAS`: signing-key alias.
- `ANDROID_KEY_PASSWORD`: private-key password.

Manually dispatch the Android workflow with mode `release`. The temporary keystore
is private, outside the repository, and removed after the job. A release requires
every signing input; it never falls back to test signing. Public certificates are
self-managed on Android; preserve the keystore and backups to retain upgrade
compatibility. Play App Signing/enrollment is a separate operation.

For local release builds, set `ANDROID_KEYSTORE_PATH` and the other three signing
variables, then run:

```sh
pnpm --filter @sourceweft/mobile android:release
python3 scripts/ci/android-artifacts.py release
```

Outputs are under `output/android/<mode>`. Verification covers APK signatures,
package/version, non-debuggable release mode, ARM64 libraries, ELF 16 KiB page
alignment and APK zip alignment. AAB outputs additionally pass JAR signature
verification using the configured keystore and native-library checks. Receipts
contain hashes and the public certificate fingerprint, never signing passwords
or the keystore itself.

## Authentication and device validation

Android's production-origin capability allows the mobile bridge on the trusted
SourceWeft web origin. The Android activity accepts the existing
`sourceweft://auth/...` callback. Native Google sign-in still requires OAuth
configuration: register the correct application ID and certificate SHA-1 in an
Android OAuth client, and use the matching Web client/audience described in
`apps/mobile/README.md`. Verification and release identities differ.

Successful packaging does not certify physical-device login, Google OAuth, WebView
behavior or in-place upgrades. Verify those on a device before distributing a
production build. This workflow does not enable desktop-style local execution
or automatic APK replacement.

References: [Tauri Android builds](https://v2.tauri.app/distribute/google-play/),
[Android signing](https://v2.tauri.app/distribute/sign/android/).
