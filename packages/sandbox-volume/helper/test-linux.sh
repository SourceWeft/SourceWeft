#!/usr/bin/env bash
# Reproducible Linux acceptance using the same pinned builder as helper/build.sh.
# --with-fuse explicitly grants an isolated container FUSE/mount capabilities.
set -euo pipefail
cd "$(dirname "$0")"
with_fuse=0
case "${1:-}" in
  '') ;;
  --with-fuse) with_fuse=1 ;;
  *) echo 'usage: test-linux.sh [--with-fuse]' >&2; exit 2 ;;
esac
image=messense/rust-musl-cross@sha256:ce75e9174325d4fbb3de85c309e2d7ca29f7500169bc4b5d2c611ff7e86d549a
capabilities=()
if [ "$with_fuse" = 1 ]; then
  capabilities+=(--privileged --tmpfs /test:rw,size=512m)
fi
docker run --rm "${capabilities[@]}" --tmpfs /enospc:rw,size=8m \
  -v "$PWD":/home/rust/src:ro \
  -v swvol-cargo-registry:/root/.cargo/registry \
  -v swvol-target-swvol-x86_64:/target \
  -e CARGO_TARGET_DIR=/target -e "SWVOL_RUN_FUSE=$with_fuse" \
  -e SWVOL_SYNC_BIN=/target/x86_64-unknown-linux-musl/debug/swvol \
  -w /home/rust/src "$image" bash -c '
    set -euo pipefail
    test "$(rustc --version | cut -d " " -f 2)" = 1.96.1
    cargo test --locked --offline --manifest-path swvol-core/Cargo.toml --target x86_64-unknown-linux-musl
    cargo test --locked --offline --manifest-path swvol/Cargo.toml --target x86_64-unknown-linux-musl
    cargo test --locked --offline --manifest-path swlazy/Cargo.toml --target x86_64-unknown-linux-musl
    SWVOL_TEST_ROOT=/enospc cargo test --locked --offline --manifest-path swvol/Cargo.toml \
      --target x86_64-unknown-linux-musl --test linux_durability real_enospc -- --ignored --nocapture
    if [ "$SWVOL_RUN_FUSE" = 1 ]; then
      test -c /dev/fuse
      cargo test --locked --offline --manifest-path swlazy/Cargo.toml --target x86_64-unknown-linux-musl \
        --test formal_fuse -- --ignored --nocapture
    else
      echo "FUSE mount acceptance NOT RUN; rerun test-linux.sh --with-fuse on a FUSE-capable Docker host."
    fi
  '
