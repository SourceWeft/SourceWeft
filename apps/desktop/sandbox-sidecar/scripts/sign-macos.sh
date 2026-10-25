#!/usr/bin/env bash
# Signs the macOS sandbox sidecar bundle in place.
#
#   scripts/sign-macos.sh <bundle-dir> [identity]
#
# <bundle-dir> is the output of `bun run scripts/build.ts` (`dist/bundle`):
#   srt-sidecar          Bun --compile executable; JavaScriptCore needs the allow-jit entitlement
#                        under the hardened runtime, so it is signed with entitlements.plist
#   rg                   ripgrep; signed with the hardened runtime and NO entitlements
#   srt-proxy-agent.jar  data, left unsigned
# [identity] defaults to `-` (ad-hoc). A Developer ID identity also gets `--timestamp`
# (a secure timestamp is required for notarization; ad-hoc signatures cannot carry one).
#
# Why re-signing is required: `bun build --compile` ad-hoc signs the executable at build time,
# and any later modification of the binary (copying it through a tool that rewrites it,
# stripping, patching) invalidates that signature, so it must be signed again afterwards. The
# build-time signature also lacks the hardened runtime that distribution requires.
#
# Why allow-jit: signed with the hardened runtime but without `com.apple.security.cs.allow-jit`
# the sidecar still starts, but the kernel refuses JavaScriptCore's executable-memory (MAP_JIT)
# region and the engine silently falls back to its interpreter (about 7x more CPU on a hot loop,
# measured with Bun 1.4.2). tests/macos_signing.rs asserts the JIT region is present with the
# entitlement and absent without it. No other entitlement is needed or granted.
#
# WHAT PLAN 2's RELEASE JOB MUST DO FOR DISTRIBUTION (UNVERIFIED in this repository: it needs
# Apple credentials, a Developer ID Application certificate and a notarytool profile, none of
# which exist in the session that wrote this script):
#   1. Sign with the Developer ID Application identity, e.g.
#        scripts/sign-macos.sh dist/bundle "Developer ID Application: <Team> (<TEAMID>)"
#      This applies the hardened runtime (`--options runtime`) and `--timestamp`.
#   2. Notarize: zip the signed binaries (`ditto -c -k --keepParent`) and run
#        xcrun notarytool submit <zip> --keychain-profile <profile> --wait
#      A bare Mach-O binary cannot be stapled (`xcrun stapler` only handles app bundles, disk
#      images and installer packages), so Gatekeeper finds the ticket online instead.
#   3. Gatekeeper only evaluates files that carry the quarantine attribute. A download the
#      desktop app performs itself (no com.apple.quarantine xattr) does not trigger Gatekeeper,
#      but notarization is still the requirement for any quarantined or manually distributed
#      copy of the bundle.
# Only the ad-hoc path (identity `-`) is exercised and verified here.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "sign-macos.sh: refusing to run on $(uname -s); it signs macOS binaries with codesign" >&2
  exit 1
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: sign-macos.sh <bundle-dir> [identity]" >&2
  exit 2
fi

bundle="$1"
identity="${2:--}"
entitlements="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/entitlements.plist"

for file in srt-sidecar rg; do
  if [[ ! -f "$bundle/$file" ]]; then
    echo "sign-macos.sh: $bundle/$file not found" >&2
    exit 1
  fi
done
if [[ ! -f "$entitlements" ]]; then
  echo "sign-macos.sh: $entitlements not found" >&2
  exit 1
fi

timestamp=()
if [[ "$identity" != "-" ]]; then
  timestamp=(--timestamp)
fi

codesign --force --options runtime ${timestamp[@]+"${timestamp[@]}"} \
  --entitlements "$entitlements" --sign "$identity" "$bundle/srt-sidecar"
codesign --force --options runtime ${timestamp[@]+"${timestamp[@]}"} \
  --sign "$identity" "$bundle/rg"

for file in srt-sidecar rg; do
  codesign --verify --strict --verbose=2 "$bundle/$file"
done

echo "entitlements of srt-sidecar:"
codesign -d --entitlements - --xml "$bundle/srt-sidecar" 2>/dev/null | plutil -p -
echo "entitlements of rg:"
rg_entitlements="$(codesign -d --entitlements - --xml "$bundle/rg" 2>/dev/null || true)"
if [[ -n "$rg_entitlements" ]]; then
  printf '%s' "$rg_entitlements" | plutil -p -
else
  echo "(none)"
fi
