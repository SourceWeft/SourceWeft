#!/usr/bin/env bash
# Manual, disk-backed GiB acceptance. Does not join the default Linux CI suite.
set -euo pipefail
cd "$(dirname "$0")"
case_label=${1:-}
control_mode=independent-poll
case "$case_label" in
  ordinary2g) case_name=ordinary2g; budget=1200; extra=() ;;
  single8g) case_name=single8g; budget=3600; extra=(--privileged) ;;
  ordinary2g-retry) case_name=ordinary2g; budget=1200; extra=(); control_mode=host-retry ;;
  single8g-retry) case_name=single8g; budget=3600; extra=(--privileged); control_mode=host-retry ;;
  *) echo 'usage: test-gib.sh ordinary2g|single8g|ordinary2g-retry|single8g-retry' >&2; exit 2 ;;
esac
image=messense/rust-musl-cross@sha256:ce75e9174325d4fbb3de85c309e2d7ca29f7500169bc4b5d2c611ff7e86d549a
volume=${SWVOL_GIB_VOLUME:-swvol-gib-acceptance}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
log="${SWVOL_GIB_LOG_DIR:-/tmp}/swvol-gib-$case_label-$stamp.log"
container="swvol-gib-$case_name-$$"
exec > >(tee "$log") 2>&1
printf 'GiB acceptance case=%s control=%s seed=0x228003005eed8a71 timeout=%ss volume=%s log=%s\n' "$case_name" "$control_mode" "$budget" "$volume" "$log"
printf 'Builder=%s; target=x86_64-unknown-linux-musl; 2CPU/1GiB/no swap/pids512\n' "$image"
# Compile outside the workload's memory/time budget. Never replace dist or a running daemon.
binary=$(docker run --rm --network none --pids-limit 512 \
  -v "$PWD":/home/rust/src:ro -v swvol-cargo-registry:/root/.cargo/registry \
  -v swvol-target-swvol-x86_64:/target -e CARGO_TARGET_DIR=/target \
  -e "SWVOL_GIB_CASE=$case_name" -w /home/rust/src "$image" bash -c '
    set -euo pipefail
    test "$(rustc --version | cut -d " " -f 2)" = 1.96.1
    cargo test --release --locked --offline --manifest-path swvol/Cargo.toml \
      --target x86_64-unknown-linux-musl --test linux_gib --no-run --message-format=json > /target/gib-build.json
    if [ "$SWVOL_GIB_CASE" = single8g ]; then
      cargo build --release --locked --offline --manifest-path swlazy/Cargo.toml --target x86_64-unknown-linux-musl
    fi
    python3 -c '\''import json
with open("/target/gib-build.json") as source:
    paths = [item["executable"] for line in source if (item := json.loads(line)).get("reason") == "compiler-artifact" and item.get("target", {}).get("name") == "linux_gib" and item.get("executable")]
assert len(paths) == 1, paths
print(paths[0])'\''
  ')
case "$binary" in /target/x86_64-unknown-linux-musl/release/deps/linux_gib-*) ;; *) echo 'No verified GiB test executable from cargo' >&2; exit 1 ;; esac
# Only this task's container is removed on interruption. The named data volume is
# retained on both success and failure for independent oracle/report inspection.
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run --rm --name "$container" --network none --pids-limit 512 \
  --cpus 2 --memory 1g --memory-swap 1g "${extra[@]}" \
  -v "$volume":/gib -v swvol-target-swvol-x86_64:/target:ro \
  -e "SWVOL_GIB_CASE=$case_name" -e "SWVOL_GIB_CONTROL_MODE=$control_mode" -e SWVOL_LAZY_BIN=/target/x86_64-unknown-linux-musl/release/swlazy \
  -w /gib "$image" bash -c '
    set -euo pipefail
    uname -a
    df -B1 /gib
    exec timeout --signal=TERM --kill-after=10 "$1" "$2" \
      --exact gib_disk_roundtrip_crash_increment_and_small_cache --ignored --nocapture
  ' bash "$budget" "$binary"
printf 'PASS: reports and raw files retained in Docker volume %s; see GIB_START base path.\n' "$volume"
