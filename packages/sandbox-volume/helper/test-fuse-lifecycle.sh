#!/usr/bin/env bash
# P0 counterexample experiment. Success means the expected failure was reproduced,
# not that transparent FUSE daemon recovery meets production requirements.
set -euo pipefail
cd "$(dirname "$0")"
image=messense/rust-musl-cross@sha256:ce75e9174325d4fbb3de85c309e2d7ca29f7500169bc4b5d2c611ff7e86d549a
docker run --rm --privileged --tmpfs /test:rw,size=64m \
  -v "$PWD":/home/rust/src:ro -v swvol-cargo-registry:/root/.cargo/registry \
  -v swvol-target-swvol-x86_64:/target -e CARGO_TARGET_DIR=/target \
  -w /home/rust/src "$image" bash -c '
    set -euo pipefail
    test "$(rustc --version | cut -d " " -f 2)" = 1.96.1
    cargo test --locked --offline --manifest-path swlazy/Cargo.toml --target x86_64-unknown-linux-musl \
      --test fuse_lifecycle retained_fd -- --ignored --nocapture
  '
