#!/usr/bin/env bash
# Push the SourceWeft sandbox image to Daytona as a snapshot.
#
# Naming convention: sw-YYYYMMDD-NN (pure date + two-digit sequence, e.g.
# sw-20260806-01). The sequence auto-increments per day, so multiple pushes
# on one day stay distinguishable and rollback is always "point
# DAYTONA_SANDBOX_SNAPSHOT at an earlier name".
#
# Every image built from this directory's Dockerfile (2026-08-06 onward)
# pre-creates the /skills skill-staging contract root
# (docs/architecture/sandbox-skill-staging.md), so
# SOURCEWEFT_SANDBOX_SKILL_STAGING_ENABLED may be enabled against any
# snapshot pushed by this script. Snapshots predating 2026-08-06 lack
# /skills and degrade staging (safely) if the flag is on.
#
# Usage:
#   ./push-snapshot.sh                # build from this directory, then push
#   ./push-snapshot.sh IMAGE[:TAG]    # push an existing local image
#
# Resources match the deployed defaults; override via env:
#   SNAPSHOT_CPU=2 SNAPSHOT_MEMORY_GB=2 SNAPSHOT_DISK_GB=5
set -euo pipefail

cd "$(dirname "$0")"

DATE="$(date +%Y%m%d)"
IMAGE="${1:-}"

if [[ -z "$IMAGE" ]]; then
  IMAGE="sourceweft-sandbox:${DATE}"
  echo "Building ${IMAGE} (linux/amd64) from $(pwd)" >&2
  docker build --platform linux/amd64 -t "$IMAGE" .
fi

# Next free sequence number for today, from the existing snapshot names.
# The CLI list needs a login profile; fall back to the REST API when
# DAYTONA_API_KEY/DAYTONA_API_URL are exported (e.g. `set -a; source
# apps/backend/.env`). If neither source answers, start at 01 — a name
# collision then fails the push loudly rather than overwriting anything.
list_snapshot_names() {
  daytona snapshot list 2>/dev/null || true
  if [[ -n "${DAYTONA_API_KEY:-}" && -n "${DAYTONA_API_URL:-}" ]]; then
    curl -sf -H "Authorization: Bearer ${DAYTONA_API_KEY}" \
      "${DAYTONA_API_URL}/snapshots" 2>/dev/null || true
  fi
}
LAST_SEQ="$(list_snapshot_names \
  | grep -oE "sw-${DATE}-[0-9]{2}" \
  | sed "s/sw-${DATE}-//" \
  | sort -n | tail -1 || true)"
SEQ="$(printf '%02d' "$(( 10#${LAST_SEQ:-0} + 1 ))")"
NAME="sw-${DATE}-${SEQ}"

echo "Pushing ${IMAGE} as Daytona snapshot ${NAME}" >&2
daytona snapshot push "$IMAGE" -n "$NAME" \
  --cpu "${SNAPSHOT_CPU:-2}" \
  --memory "${SNAPSHOT_MEMORY_GB:-2}" \
  --disk "${SNAPSHOT_DISK_GB:-5}"

echo "" >&2
echo "Done. To roll out: set DAYTONA_SANDBOX_SNAPSHOT=${NAME}" >&2
