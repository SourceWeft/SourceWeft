#!/usr/bin/env bash
# Release leg for the Windows sandbox runtime bundle of $DESKTOP_RELEASE_TARGET
# (x86_64-pc-windows-msvc or aarch64-pc-windows-msvc), run by the signed desktop release on the
# Windows runner of that architecture, from the repository root, in Git Bash:
#   1. builds the bundle with the pinned ripgrep ($RG_PATH, from install-ripgrep-windows.ps1);
#   2. checks the real executables (architecture, namespaced srt-win, the compiled sidecar's
#      embedded namespace) with verify-windows-bundle.ps1;
#   3. under the `signed` publication policy only, Authenticode-signs srt-sidecar.exe,
#      srt-win.exe and rg.exe with the installer's certificate (WINDOWS_CERTIFICATE_THUMBPRINT,
#      imported by the workflow) and timestamp server (WINDOWS_TIMESTAMP_URL), re-checks them,
#      and rebuilds the manifest over the signed bytes (as the macOS leg does after codesign);
#      the `updater-signed` policy has no certificate and leaves the executables unsigned;
#   4. packs the bundle, minisigns the tarball with the updater key, verifies the signature with
#      the production verifier and copies the tarball and its .sig into desktop-release/.
set -euo pipefail

: "${DESKTOP_RELEASE_TARGET:?DESKTOP_RELEASE_TARGET is required}"
: "${DESKTOP_PUBLICATION_POLICY:?DESKTOP_PUBLICATION_POLICY is required}"
: "${RG_PATH:?RG_PATH (the pinned ripgrep) is required}"
: "${DESKTOP_UPDATE_VERIFIER:?DESKTOP_UPDATE_VERIFIER is required}"

# `pnpm run` doubles every backslash in the arguments it forwards on Windows, so the ripgrep path
# must arrive with forward slashes (install-ripgrep-windows.ps1's caller converts it). Refuse
# anything else instead of rewriting it here: a path that is wrong should fail loudly.
case "$RG_PATH" in
  *\\*) echo "::error::RG_PATH must use forward slashes: $RG_PATH"; exit 1 ;;
esac

bundle_dir=apps/desktop/sandbox-sidecar/dist/bundle
scripts=apps/desktop/sandbox-sidecar/scripts

pnpm --filter @sourceweft/desktop-sandbox-sidecar build -- --target "$DESKTOP_RELEASE_TARGET" --rg "$RG_PATH"
pwsh -NoProfile -File "$scripts/verify-windows-bundle.ps1" "$bundle_dir" "$DESKTOP_RELEASE_TARGET"

if [ "$DESKTOP_PUBLICATION_POLICY" = "signed" ]; then
  : "${WINDOWS_CERTIFICATE_THUMBPRINT:?WINDOWS_CERTIFICATE_THUMBPRINT is required for the signed policy}"
  : "${WINDOWS_TIMESTAMP_URL:?WINDOWS_TIMESTAMP_URL is required for the signed policy}"
  pwsh -NoProfile -File "$scripts/sign-windows.ps1" -BundleDir "$bundle_dir" \
    -Thumbprint "$WINDOWS_CERTIFICATE_THUMBPRINT" -TimestampUrl "$WINDOWS_TIMESTAMP_URL"
  # Signing must leave the executables runnable (the sidecar still reports its namespace).
  pwsh -NoProfile -File "$scripts/verify-windows-bundle.ps1" "$bundle_dir" "$DESKTOP_RELEASE_TARGET"
  # Signing rewrote the executables, so the build-time manifest no longer matches them; rebuild
  # it over the signed files before the tarball is hashed and minisigned.
  pnpm --filter @sourceweft/desktop-sandbox-sidecar build -- --remanifest
fi

# Relative paths: GNU tar reads `D:\...` as a remote host:file.
bundle=sandbox-bundle
rm -rf "$bundle"
node scripts/ci/sandbox-bundle.mjs pack "$bundle_dir" "$bundle"
tarball="$bundle/sourceweft-sandbox-$DESKTOP_RELEASE_TARGET.tar.gz"
node scripts/ci/sandbox-bundle.mjs verify "$tarball"
node scripts/ci/sandbox-bundle.mjs sign "$tarball"
node scripts/ci/sandbox-bundle.mjs verify-signature "$tarball"
mkdir -p desktop-release
cp "$tarball" "$tarball.sig" desktop-release/
