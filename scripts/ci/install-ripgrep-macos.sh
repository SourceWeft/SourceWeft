#!/usr/bin/env bash
# Downloads the pinned official macOS ripgrep release listed in ripgrep-release.json (the
# per-triple `darwin` block) into <dir>, checks its SHA-256 before extracting, asserts the
# binary is a Mach-O executable of the requested architecture and prints its path. The sandbox
# bundle ships this exact binary, so the macOS release legs and the `sandbox-bundle-macos` PR
# job use it rather than an unpinned Homebrew ripgrep (which may be a universal or wrapper
# build). macOS ripgrep links against the stable system libraries, so — unlike the Linux
# bundle, which must be static (install-static-ripgrep.sh) — there is no static-linking check.
#   scripts/ci/install-ripgrep-macos.sh <dir> <rust-triple>
# where <rust-triple> is aarch64-apple-darwin or x86_64-apple-darwin.
set -euo pipefail

dir="${1:?usage: install-ripgrep-macos.sh <dir> <rust-triple>}"
triple="${2:?usage: install-ripgrep-macos.sh <dir> <rust-triple>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
field() {
  node -e 'const r=require(process.argv[1]).darwin[process.argv[2]]; if(!r){console.error("no darwin ripgrep pin for "+process.argv[2]);process.exit(1)} process.stdout.write(r[process.argv[3]])' \
    "$here/ripgrep-release.json" "$triple" "$1"
}
asset="$(field asset)"
sha256="$(field sha256)"
url="$(field url)"

case "$triple" in
  aarch64-apple-darwin) arch="arm64" ;;
  x86_64-apple-darwin) arch="x86_64" ;;
  *) echo "::error::unsupported macOS ripgrep triple: $triple" >&2; exit 1 ;;
esac

mkdir -p "$dir"
curl --fail --silent --show-error --location --retry 3 --output "$dir/$asset" "$url"
# macOS ships `shasum`, not GNU `sha256sum`; verify before extracting.
(cd "$dir" && echo "$sha256  $asset" | shasum -a 256 -c - >&2)
tar -xzf "$dir/$asset" -C "$dir" --strip-components=1 "${asset%.tar.gz}/rg"
chmod 0755 "$dir/rg"

description="$(file -b -L "$dir/rg")"
echo "rg: $description" >&2
case "$description" in
  *"Mach-O 64-bit executable $arch"*) ;;
  *) echo "::error::the bundled ripgrep must be a Mach-O $arch executable, got: $description" >&2; exit 1 ;;
esac
echo "$dir/rg"
