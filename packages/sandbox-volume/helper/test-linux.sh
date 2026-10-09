#!/usr/bin/env bash
# Reproducible Linux acceptance using the same pinned builder as helper/build.sh.
# --with-fuse explicitly enables both FUSE and supervisor namespace acceptance.
set -euo pipefail
cd "$(dirname "$0")"
with_fuse=0
case "${1:-}" in
  '') ;;
  --with-fuse) with_fuse=1 ;;
  *) echo 'usage: test-linux.sh [--with-fuse]' >&2; exit 2 ;;
esac
image=messense/rust-musl-cross@sha256:ce75e9174325d4fbb3de85c309e2d7ca29f7500169bc4b5d2c611ff7e86d549a
native_image=messense/rust-musl-cross@sha256:ecae5dd62d1c938c14f8071d36c16fa699860aace03bfb5284fb1216474d2643
capabilities=()
if [ "$with_fuse" = 1 ]; then
  # The pinned builders and native kernel-I/O acceptance require an ARM64 host.
  # Refuse QEMU syscall emulation rather than report its ENOSYS as acceptance.
  case "$(docker info --format '{{.Architecture}}')" in
    aarch64|arm64) ;;
    *) echo "Native AIO acceptance requires an ARM64 Docker host; no emulated fallback." >&2; exit 1 ;;
  esac
  capabilities+=(--privileged --tmpfs /test:rw,size=512m)
fi
docker run --rm --network none --pids-limit 512 "${capabilities[@]}" --tmpfs /enospc:rw,size=8m \
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
    cargo test --locked --offline --manifest-path swvol-supervisor/Cargo.toml --target x86_64-unknown-linux-musl
    SWVOL_TEST_ROOT=/enospc cargo test --locked --offline --manifest-path swvol/Cargo.toml \
      --target x86_64-unknown-linux-musl --test linux_durability real_enospc -- --ignored --nocapture
    if [ "$SWVOL_RUN_FUSE" = 1 ]; then
      test -c /dev/fuse
      SWVOL_TEST_ROOT=/test cargo test --locked --offline --manifest-path swvol/Cargo.toml \
        --target x86_64-unknown-linux-musl --test linux_durability signed_timestamp_boundaries_roundtrip_and_out_of_range_never_confirm -- --ignored --nocapture
      cargo test --locked --offline --manifest-path swlazy/Cargo.toml --target x86_64-unknown-linux-musl \
        --test formal_fuse -- --ignored --nocapture
      echo "Supervisor x86_64: 21 namespace/security cases; AIO assigned to the mandatory native phase below."
      cargo test --locked --offline --manifest-path swvol-supervisor/Cargo.toml --target x86_64-unknown-linux-musl \
        --test linux_supervisor -- --ignored --nocapture \
        --skip diagnostic_kernel_pause_does_not_claim_pending_native_aio_is_quiescent
    else
      echo "FUSE and supervisor namespace acceptance NOT RUN; rerun test-linux.sh --with-fuse on a capable Docker host."
    fi
  '

if [ "$with_fuse" = 1 ]; then
  echo "Supervisor native aarch64: mandatory kernel AIO counterexample; supervisor and C workload both musl."
  docker run --rm --privileged --network none --pids-limit 512 --memory 768m --cpus 2 \
    -v "$PWD":/home/rust/src:ro \
    -v swvol-cargo-registry:/root/.cargo/registry \
    -v swvol-target-supervisor-aarch64:/target \
    -e CARGO_TARGET_DIR=/target -w /home/rust/src "$native_image" bash -c '
      set -euo pipefail
      test "$(uname -m)" = aarch64
      test "$(rustc --version | cut -d " " -f 2)" = 1.95.0
      aarch64-unknown-linux-musl-gcc -dumpmachine
      cargo test --locked --offline --manifest-path swvol-supervisor/Cargo.toml \
        --target aarch64-unknown-linux-musl --test linux_supervisor \
        diagnostic_kernel_pause_does_not_claim_pending_native_aio_is_quiescent -- --ignored --nocapture
    '
fi
