#!/usr/bin/env bash
# Cross-builds the in-sandbox helper as static musl binaries. Output: helper/dist/<crate>-<arch>.
# Needs Docker; the build output lives on a named Docker volume (a bind-mounted target dir crashes rustc).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
build() {
  local crate="$1" image="$2" triple="$3" arch="$4"
  docker run --rm -v "$PWD/$crate":/home/rust/src -v "$PWD/dist":/dist \
    -v swvol-cargo-registry:/root/.cargo/registry -v "swvol-target-$crate-$arch":/target \
    -e CARGO_TARGET_DIR=/target -w /home/rust/src "$image" \
    sh -c "cargo build --release --target $triple 2>&1 | grep -E '^(error|warning: unused|Finished)' -A6; cp /target/$triple/release/$crate /dist/$crate-$arch"
}
for crate in swvol swlazy; do
  build "$crate" messense/rust-musl-cross:x86_64-musl x86_64-unknown-linux-musl x86_64
  if [ "${SWVOL_ARCHES:-x86_64}" != "x86_64" ]; then
    build "$crate" messense/rust-musl-cross:aarch64-musl aarch64-unknown-linux-musl aarch64
  fi
done
echo "$(cat VERSION)" > dist/VERSION
ls -la dist
