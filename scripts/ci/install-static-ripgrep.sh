#!/usr/bin/env bash
# Downloads the pinned official static (musl) ripgrep release listed in ripgrep-release.json
# into <dir>, checks its SHA-256 before extracting, asserts the binary is statically linked and
# prints its path. The sandbox bundle ships this exact binary, so it must not depend on the
# build machine's distribution libraries.
#   scripts/ci/install-static-ripgrep.sh <dir>
set -euo pipefail

dir="${1:?usage: install-static-ripgrep.sh <dir>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
field() { node -e 'process.stdout.write(require(process.argv[1])[process.argv[2]])' "$here/ripgrep-release.json" "$1"; }
asset="$(field asset)"
sha256="$(field sha256)"
url="$(field url)"

mkdir -p "$dir"
curl --fail --silent --show-error --location --retry 3 --output "$dir/$asset" "$url"
(cd "$dir" && echo "$sha256  $asset" | sha256sum -c - >&2)
tar -xzf "$dir/$asset" -C "$dir" --strip-components=1 "${asset%.tar.gz}/rg"
chmod 0755 "$dir/rg"

description="$(file -b "$dir/rg")"
echo "rg: $description" >&2
case "$description" in
  *"statically linked"* | *"static-pie linked"*) ;;
  *) echo "::error::the bundled ripgrep must be statically linked, got: $description" >&2; exit 1 ;;
esac
echo "$dir/rg"
