#!/usr/bin/env bash
# Build the existing musl helpers with the pinned, previously verified Rust toolchain.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/VERSION
x86_image=messense/rust-musl-cross@sha256:ce75e9174325d4fbb3de85c309e2d7ca29f7500169bc4b5d2c611ff7e86d549a
arm_image=messense/rust-musl-cross@sha256:ecae5dd62d1c938c14f8071d36c16fa699860aace03bfb5284fb1216474d2643
case "${SWVOL_ARCHES:-x86_64}" in
  x86_64) arches=x86_64 ;;
  aarch64) arches=aarch64 ;;
  x86_64,aarch64) arches='x86_64 aarch64' ;;
  *) echo 'SWVOL_ARCHES must be x86_64, aarch64 or x86_64,aarch64' >&2; exit 2 ;;
esac
IFS=, read -r -a helpers <<< "${SWVOL_HELPERS:-swvol,swlazy,swvol-supervisor}"
for helper in "${helpers[@]}"; do
  case "$helper" in swvol|swlazy|swvol-supervisor) ;; *) echo 'SWVOL_HELPERS contains an unsupported helper' >&2; exit 2 ;; esac
done
build() {
  local crate="$1" image="$2" triple="$3" arch="$4" rust_version="$5"
  # Never leave an earlier successful artifact looking like this build's output.
  rm -f "dist/$crate-$arch" "dist/$crate-$arch.sha256" "dist/$crate-$arch.receipt.json" \
    "dist/$crate-$arch.tmp" "dist/$crate-$arch.sha256.tmp" "dist/$crate-$arch.receipt.json.tmp"
  docker run --rm -v "$PWD":/home/rust/helper:ro -v "$PWD/dist":/dist \
    -v swvol-cargo-registry:/root/.cargo/registry -v "swvol-target-$crate-$arch":/target \
    -e CARGO_TARGET_DIR=/target -e "SWVOL_CRATE=$crate" -e "SWVOL_ARCH=$arch" \
    -e "SWVOL_TARGET=$triple" -e "SWVOL_RUST_VERSION=$rust_version" -e "SWVOL_BUILDER_IMAGE=$image" \
    -w "/home/rust/helper/$crate" "$image" bash -c '
      set -euo pipefail
      actual_rust_version=$(rustc --version | cut -d " " -f 2)
      if [ "$actual_rust_version" != "$SWVOL_RUST_VERSION" ]; then
        printf "helper build: Rust toolchain mismatch: expected %s, actual %s (%s)\n" "$SWVOL_RUST_VERSION" "$actual_rust_version" "$SWVOL_BUILDER_IMAGE" >&2
        exit 1
      fi
      binary="/target/$SWVOL_TARGET/release/$SWVOL_CRATE"
      rm -f "$binary"
      source_hash() {
        { printf "%s\n" Cargo.toml Cargo.lock; find src -type f;
          test ! -d tests || find tests -type f
          test ! -f README.md || printf "%s\n" README.md
          if [ "$SWVOL_CRATE" != swvol-supervisor ]; then printf "%s\n" ../swvol-core/Cargo.toml; find ../swvol-core/src -type f; fi
        } | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d " " -f 1
      }
      before=$(source_hash)
      cargo build --locked --offline --release --target "$SWVOL_TARGET"
      test -x "$binary"
      source_hash=$(source_hash)
      if [ "$source_hash" != "$before" ]; then
        echo "helper source changed during build; refusing to publish an unverifiable artifact" >&2
        exit 1
      fi
      name="$SWVOL_CRATE-$SWVOL_ARCH"
      cp "$binary" "/dist/$name.tmp"
      hash=$(sha256sum "/dist/$name.tmp" | cut -d " " -f 1)
      printf "%s  %s\n" "$hash" "$name" > "/dist/$name.sha256.tmp"
      printf "{\"crate\":\"%s\",\"architecture\":\"%s\",\"target\":\"%s\",\"rustVersion\":\"%s\",\"builderImage\":\"%s\",\"sourceSha256\":\"%s\",\"binarySha256\":\"%s\"}\n" "$SWVOL_CRATE" "$SWVOL_ARCH" "$SWVOL_TARGET" "$SWVOL_RUST_VERSION" "$SWVOL_BUILDER_IMAGE" "$source_hash" "$hash" > "/dist/$name.receipt.json.tmp"
      mv "/dist/$name.tmp" "/dist/$name"
      mv "/dist/$name.sha256.tmp" "/dist/$name.sha256"
      mv "/dist/$name.receipt.json.tmp" "/dist/$name.receipt.json"
    '
}
for arch in $arches; do
  case "$arch" in x86_64) image="$x86_image"; triple=x86_64-unknown-linux-musl; rust_version=1.96.1 ;; aarch64) image="$arm_image"; triple=aarch64-unknown-linux-musl; rust_version=1.95.0 ;; esac
  for crate in "${helpers[@]}"; do build "$crate" "$image" "$triple" "$arch" "$rust_version"; done
done
cp VERSION dist/VERSION
